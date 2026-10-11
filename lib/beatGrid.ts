/**
 * Beat grid analysis and beat-grid math.
 *
 * Pure module with no imports so it runs unchanged in the analysis worker, the React UI and
 * Node's built-in test runner (`npm test`).
 *
 * Model (same concept Mixxx uses for constant-tempo tracks): a grid is one tempo plus the time
 * of a reference beat. Beat n sits at `firstBeatSec + n * 60 / bpm`.
 *
 * Analysis pipeline (independent implementation; see docs/DJ_MIXER_LEARNING_GUIDE.md):
 *   1. Onset envelope: how sharply loudness rises every ~2.7 ms (kick band weighted highest).
 *   2. Coarse tempo: autocorrelation of the envelope over the allowed BPM range, nudged
 *      toward common dance tempos by a log-normal prior.
 *   3. Refinement + phase: fold the whole track's envelope at candidate beat periods into a
 *      phase histogram. The sharpest histogram wins, and its peak is the beat phase.
 */

export interface BeatGrid {
  /** Tempo at pitch 0, in beats per minute. */
  bpm: number;
  /** Time of the first beat at or after 0 s: 0 <= firstBeatSec < 60 / bpm. */
  firstBeatSec: number;
}

export interface BeatGridAnalysis extends BeatGrid {
  /** 0..1, how strongly onsets concentrate at a single beat phase. */
  confidence: number;
}

export interface BeatGridAnalysisOptions {
  minBpm?: number;
  maxBpm?: number;
}

/** Bump when the analysis changes enough that stored grids should be recomputed. */
export const BEAT_GRID_VERSION = 2;

/**
 * Below this confidence the track probably has no single steady tempo (live drummers, tempo
 * drift, sparse beats), so a constant grid is only approximate. Calibration (2026-10-11):
 * steady real tracks scored 0.15-0.29, drifting ones 0.03-0.06, white noise 0.01-0.09,
 * synthetic steady beats 0.74-0.87. See docs/IMPLEMENTATION_LOG.md.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.12;

export const isLowConfidenceGrid = (grid: { confidence: number }) => grid.confidence < LOW_CONFIDENCE_THRESHOLD;

const DEFAULT_MIN_BPM = 70;
const DEFAULT_MAX_BPM = 180;
/** Centre and width (in octaves) of the tempo prior used to break half/double ambiguity. */
const PRIOR_CENTER_BPM = 120;
const PRIOR_WIDTH_OCTAVES = 1;
/** Envelope frame rate target. The hop is the nearest power of two (128 samples at 44.1/48 kHz). */
const TARGET_FRAME_RATE_HZ = 375;
/** Kick-drum band used for the weighted onset function. */
const LOW_BAND_HZ = 150;
const LOW_BAND_WEIGHT = 0.6;
/** Amplitude compression before differencing, so quiet passages still contribute. */
const COMPRESSION = 1000;
const PHASE_BINS = 96;
/** Integer BPMs win when they score within this fraction of the best fractional candidate. */
const INTEGER_SNAP_TOLERANCE = 0.98;
const MIN_ANALYSIS_BEATS = 8;

// ─── Grid math ──────────────────────────────────────────────────────────────────

export const beatPeriodSec = (bpm: number) => 60 / bpm;

/** Fractional beat index at `time` (0 = first beat, negative before it). */
export function beatIndexAt(time: number, grid: BeatGrid): number {
  return (time - grid.firstBeatSec) / beatPeriodSec(grid.bpm);
}

export function beatTimeAt(index: number, grid: BeatGrid): number {
  return grid.firstBeatSec + index * beatPeriodSec(grid.bpm);
}

/** Position within the current beat, in [0, 1). */
export function beatPhase(time: number, grid: BeatGrid): number {
  const index = beatIndexAt(time, grid);
  return index - Math.floor(index);
}

export function nearestBeatTime(time: number, grid: BeatGrid): number {
  return beatTimeAt(Math.round(beatIndexAt(time, grid)), grid);
}

/**
 * Where a quantized loop of `beats` length should start when triggered at `time`.
 * Loops of a beat or longer start on the closest beat, which can be just ahead of the playhead.
 * Shorter loops start on the closest sub-division of the current beat, so a 1/2-beat loop
 * pressed late in a beat covers its second half.
 */
export function quantizedLoopStart(time: number, grid: BeatGrid, beats: number): number {
  if (beats >= 1) return nearestBeatTime(time, grid);
  const index = beatIndexAt(time, grid);
  return beatTimeAt(Math.round(index / beats) * beats, grid);
}

/** The tempo you hear: file BPM scaled by the pitch fader. */
export function effectiveBpm(fileBpm: number, pitchPercent: number): number {
  return fileBpm * (1 + pitchPercent / 100);
}

/**
 * Pitch (percent) the follower needs so its effective tempo matches the leader's effective tempo.
 * Ratios beyond √2 are folded by octaves, so 87 BPM follows 174 BPM at half tempo instead of +100 %.
 * Returns null when either BPM is unusable.
 */
export function computeSyncPitchPercent(
  followerBpm: number,
  leaderBpm: number,
  leaderPitchPercent: number,
): number | null {
  if (!(followerBpm > 0) || !(leaderBpm > 0) || !Number.isFinite(leaderPitchPercent)) return null;
  let ratio = effectiveBpm(leaderBpm, leaderPitchPercent) / followerBpm;
  if (!(ratio > 0) || !Number.isFinite(ratio)) return null;
  while (ratio > Math.SQRT2) ratio /= 2;
  while (ratio < Math.SQRT1_2) ratio *= 2;
  return (ratio - 1) * 100;
}

/** Display format: "128" for whole numbers, otherwise one decimal ("93.5"). */
export function formatBpm(bpm: number): string {
  const rounded = Math.round(bpm * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// ─── Analysis ───────────────────────────────────────────────────────────────────

export function onsetHopSize(sampleRate: number): number {
  return Math.max(32, 2 ** Math.round(Math.log2(sampleRate / TARGET_FRAME_RATE_HZ)));
}

/**
 * Onset strength per hop: the positive change in compressed RMS, mixing a low (kick) band
 * with the full band. Frame `f` covers samples [f * hop, (f + 1) * hop).
 */
export function computeOnsetEnvelope(samples: Float32Array, sampleRate: number, hopSize: number): Float32Array {
  const frameCount = Math.floor(samples.length / hopSize);
  const envelope = new Float32Array(frameCount);
  const lowAlpha = 1 - Math.exp((-2 * Math.PI * LOW_BAND_HZ) / sampleRate);
  const compress = (meanSquare: number) => Math.log1p(COMPRESSION * Math.sqrt(meanSquare));

  let low = 0;
  let prevLow = 0;
  let prevFull = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    let lowEnergy = 0;
    let fullEnergy = 0;
    const end = (frame + 1) * hopSize;
    for (let i = frame * hopSize; i < end; i++) {
      const x = samples[i];
      low += lowAlpha * (x - low);
      lowEnergy += low * low;
      fullEnergy += x * x;
    }
    const lowLevel = compress(lowEnergy / hopSize);
    const fullLevel = compress(fullEnergy / hopSize);
    envelope[frame] =
      LOW_BAND_WEIGHT * Math.max(0, lowLevel - prevLow) +
      (1 - LOW_BAND_WEIGHT) * Math.max(0, fullLevel - prevFull);
    prevLow = lowLevel;
    prevFull = fullLevel;
  }
  return envelope;
}

const tempoPrior = (bpm: number) => {
  const octaves = Math.log2(bpm / PRIOR_CENTER_BPM) / PRIOR_WIDTH_OCTAVES;
  return Math.exp(-0.5 * octaves * octaves);
};

/** Vertex offset (-0.5..0.5) of the parabola through three equally spaced points. */
const parabolicOffset = (left: number, center: number, right: number) => {
  const denominator = left - 2 * center + right;
  if (denominator === 0) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denominator));
};

function estimateCoarseBpm(envelope: Float32Array, frameRate: number, minBpm: number, maxBpm: number): number | null {
  const n = envelope.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += envelope[i];
  mean /= n;
  const centered = new Float32Array(n);
  for (let i = 0; i < n; i++) centered[i] = envelope[i] - mean;

  const minLag = Math.max(2, Math.floor((60 * frameRate) / maxBpm) - 1);
  const maxLag = Math.min(n - 2, Math.ceil((60 * frameRate) / minBpm) + 1);
  if (maxLag <= minLag + 2) return null;

  const scores = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += centered[i] * centered[i + lag];
    scores[lag] = (sum / (n - lag)) * tempoPrior((60 * frameRate) / lag);
  }

  let bestLag = -1;
  let bestScore = 0;
  for (let lag = minLag + 1; lag <= maxLag; lag++) {
    const bpm = (60 * frameRate) / lag;
    if (bpm < minBpm || bpm > maxBpm) continue;
    if (scores[lag] > bestScore && scores[lag] >= scores[lag - 1] && scores[lag] >= scores[lag + 1]) {
      bestScore = scores[lag];
      bestLag = lag;
    }
  }
  if (bestLag < 0) return null;
  const refinedLag = bestLag + parabolicOffset(scores[bestLag - 1], scores[bestLag], scores[bestLag + 1]);
  return (60 * frameRate) / refinedLag;
}

interface PhaseFit {
  bpm: number;
  /** Peak score: smoothed histogram maximum divided by total envelope weight. */
  score: number;
  /** Beat phase in frames, in [0, periodFrames). */
  phaseFrames: number;
}

interface BpmSearch {
  best: PhaseFit;
  /** Mean score over every candidate searched: the "no steady beat" baseline for this track. */
  meanScore: number;
}

function fitPhase(envelope: Float32Array, frameRate: number, bpm: number, histogram: Float64Array): PhaseFit {
  const periodFrames = (60 * frameRate) / bpm;
  const bins = histogram.length;
  histogram.fill(0);
  let total = 0;
  for (let frame = 0; frame < envelope.length; frame++) {
    const value = envelope[frame];
    if (value <= 0) continue;
    total += value;
    const cycles = frame / periodFrames;
    const position = (cycles - Math.floor(cycles)) * bins;
    const lower = Math.floor(position);
    const fraction = position - lower;
    histogram[lower % bins] += value * (1 - fraction);
    histogram[(lower + 1) % bins] += value * fraction;
  }

  let peakBin = 0;
  let peak = -Infinity;
  const smoothed = (bin: number) =>
    0.5 * histogram[(bin + bins - 1) % bins] + histogram[bin] + 0.5 * histogram[(bin + 1) % bins];
  for (let bin = 0; bin < bins; bin++) {
    const value = smoothed(bin);
    if (value > peak) {
      peak = value;
      peakBin = bin;
    }
  }
  const offset = parabolicOffset(
    smoothed((peakBin + bins - 1) % bins),
    peak,
    smoothed((peakBin + 1) % bins),
  );
  const phaseBins = (peakBin + offset + bins) % bins;
  return {
    bpm,
    score: total > 0 ? peak / total : 0,
    phaseFrames: (phaseBins / bins) * periodFrames,
  };
}

function searchBpm(
  envelope: Float32Array,
  frameRate: number,
  center: number,
  span: number,
  step: number,
  minBpm: number,
  maxBpm: number,
  histogram: Float64Array,
): BpmSearch | null {
  let best: PhaseFit | null = null;
  let scoreSum = 0;
  let count = 0;
  const lo = Math.max(minBpm * 0.97, center - span);
  const hi = Math.min(maxBpm * 1.03, center + span);
  for (let bpm = lo; bpm <= hi + 1e-9; bpm += step) {
    const fit = fitPhase(envelope, frameRate, bpm, histogram);
    scoreSum += fit.score;
    count++;
    if (!best || fit.score > best.score) best = fit;
  }
  return best ? { best, meanScore: scoreSum / count } : null;
}

/**
 * Estimate a constant-tempo beat grid from mono samples. Returns null for silence or
 * clips too short to hold several beats.
 */
export function analyzeBeatGrid(
  samples: Float32Array,
  sampleRate: number,
  options: BeatGridAnalysisOptions = {},
): BeatGridAnalysis | null {
  const minBpm = options.minBpm ?? DEFAULT_MIN_BPM;
  const maxBpm = options.maxBpm ?? DEFAULT_MAX_BPM;
  if (!(sampleRate > 0) || samples.length < sampleRate * (60 / minBpm) * MIN_ANALYSIS_BEATS) return null;

  const hop = onsetHopSize(sampleRate);
  const frameRate = sampleRate / hop;
  const envelope = computeOnsetEnvelope(samples, sampleRate, hop);

  let energy = 0;
  for (let i = 0; i < envelope.length; i++) energy += envelope[i];
  if (energy < 1e-6) return null;

  const coarse = estimateCoarseBpm(envelope, frameRate, minBpm, maxBpm);
  if (coarse === null) return null;

  const histogram = new Float64Array(PHASE_BINS);
  const wide = searchBpm(envelope, frameRate, coarse, 1.5, 0.05, minBpm, maxBpm, histogram);
  if (!wide) return null;
  let best = searchBpm(envelope, frameRate, wide.best.bpm, 0.06, 0.005, minBpm, maxBpm, histogram)?.best ?? wide.best;

  const integerBpm = Math.round(best.bpm);
  if (Math.abs(integerBpm - best.bpm) < 0.25) {
    const integerFit = fitPhase(envelope, frameRate, integerBpm, histogram);
    if (integerFit.score >= best.score * INTEGER_SNAP_TOLERANCE) best = integerFit;
  }

  // A rise detected in frame f happened somewhere inside it; use the frame centre.
  const periodSec = beatPeriodSec(best.bpm);
  const phaseSec = (best.phaseFrames + 0.5) / frameRate;
  const firstBeatSec = ((phaseSec % periodSec) + periodSec) % periodSec;

  // Contrast against nearby wrong tempos, which smear the phase histogram. A steady beat stands far
  // above that baseline; noise or a drifting tempo barely does.
  const confidence = best.score > 0 ? Math.max(0, Math.min(1, 1 - wide.meanScore / best.score)) : 0;

  return {
    bpm: Math.round(best.bpm * 1000) / 1000,
    firstBeatSec: Math.round(firstBeatSec * 10000) / 10000,
    confidence: Math.round(confidence * 1000) / 1000,
  };
}
