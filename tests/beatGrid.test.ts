import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeBeatGrid,
  beatIndexAt,
  beatPhase,
  computeSyncPitchPercent,
  effectiveBpm,
  formatBpm,
  isLowConfidenceGrid,
  nearestBeatTime,
  quantizedLoopStart,
  type BeatGrid,
} from '../lib/beatGrid.ts';

// ─── Synthetic audio ────────────────────────────────────────────────────────────

const SAMPLE_RATE = 44100;

/** Deterministic PRNG (mulberry32) so noisy fixtures are identical on every run. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Fixture {
  bpm: number;
  firstBeatSec: number;
  durationSec: number;
  /** 'click' = 5 ms noise click per beat; 'house' = kick on beats + quieter hats on off-beats + noise. */
  style: 'click' | 'house';
}

function renderFixture({ bpm, firstBeatSec, durationSec, style }: Fixture): Float32Array {
  const random = makeRandom(Math.round(bpm * 1000 + firstBeatSec * 1e6));
  const out = new Float32Array(Math.round(durationSec * SAMPLE_RATE));
  const period = 60 / bpm;

  const addKick = (start: number) => {
    const length = Math.round(0.18 * SAMPLE_RATE);
    let phase = 0;
    for (let i = 0; i < length && start + i < out.length; i++) {
      const t = i / SAMPLE_RATE;
      phase += (2 * Math.PI * (50 + 70 * Math.exp(-t / 0.03))) / SAMPLE_RATE; // pitch-dropping kick
      out[start + i] += 0.8 * Math.exp(-t / 0.06) * Math.sin(phase);
    }
  };
  const addNoiseBurst = (start: number, seconds: number, gain: number, decay: number) => {
    const length = Math.round(seconds * SAMPLE_RATE);
    for (let i = 0; i < length && start + i < out.length; i++) {
      out[start + i] += gain * Math.exp(-i / (decay * SAMPLE_RATE)) * (random() * 2 - 1);
    }
  };

  for (let beat = 0; ; beat++) {
    const time = firstBeatSec + beat * period;
    if (time >= durationSec) break;
    const start = Math.round(time * SAMPLE_RATE);
    if (style === 'click') {
      addNoiseBurst(start, 0.005, 0.9, 0.002);
    } else {
      addKick(start);
      const offbeat = Math.round((time + period / 2) * SAMPLE_RATE);
      addNoiseBurst(offbeat, 0.03, 0.25, 0.008);
    }
  }
  if (style === 'house') {
    for (let i = 0; i < out.length; i++) out[i] += 0.01 * (random() * 2 - 1);
  }
  return out;
}

/** Phase difference between two grids' first beats, wrapped to the shortest distance (seconds). */
function phaseErrorSec(actualFirstBeat: number, expectedFirstBeat: number, bpm: number) {
  const period = 60 / bpm;
  const diff = (((actualFirstBeat - expectedFirstBeat) % period) + period) % period;
  return Math.min(diff, period - diff);
}

function assertGrid(fixture: Fixture, options?: { minBpm?: number; maxBpm?: number }) {
  const grid = analyzeBeatGrid(renderFixture(fixture), SAMPLE_RATE, options);
  assert.ok(grid, 'expected a grid');
  assert.ok(
    Math.abs(grid.bpm - fixture.bpm) <= 0.05,
    `bpm ${grid.bpm} should be within 0.05 of ${fixture.bpm}`,
  );
  const error = phaseErrorSec(grid.firstBeatSec, fixture.firstBeatSec, fixture.bpm);
  assert.ok(error <= 0.01, `first beat ${grid.firstBeatSec}s is ${(error * 1000).toFixed(1)} ms from ${fixture.firstBeatSec}s`);
  assert.ok(grid.firstBeatSec >= 0 && grid.firstBeatSec < 60 / grid.bpm, 'first beat must lie inside the first period');
  return grid;
}

// ─── Analysis ───────────────────────────────────────────────────────────────────

test('120 BPM click track with an offset first beat', () => {
  assertGrid({ bpm: 120, firstBeatSec: 0.25, durationSec: 30, style: 'click' });
});

test('128 BPM house pattern: grid lands on kicks, not off-beat hats', () => {
  const grid = assertGrid({ bpm: 128, firstBeatSec: 0.37, durationSec: 60, style: 'house' });
  assert.ok(grid.confidence > 0.3, `confidence ${grid.confidence} should be clearly above chance`);
  assert.equal(isLowConfidenceGrid(grid), false);
});

test('white noise is flagged as a low-confidence grid', () => {
  // A good PRNG matters: a plain LCG has periodic bit patterns that read as a fake ~84 BPM beat.
  for (const seconds of [30, 120]) {
    const random = makeRandom(seconds);
    const noise = new Float32Array(SAMPLE_RATE * seconds).map(() => random() * 2 - 1);
    const grid = analyzeBeatGrid(noise, SAMPLE_RATE);
    assert.ok(grid === null || isLowConfidenceGrid(grid), `${seconds}s of noise produced a confident grid: ${JSON.stringify(grid)}`);
  }
});

test('fractional tempo (93.5 BPM) is not rounded to an integer', () => {
  assertGrid({ bpm: 93.5, firstBeatSec: 0.1, durationSec: 60, style: 'house' });
});

test('174 BPM: exact within a drum & bass range, octave-equivalent with defaults', () => {
  assertGrid({ bpm: 174, firstBeatSec: 0.05, durationSec: 40, style: 'house' }, { minBpm: 120, maxBpm: 200 });
  const grid = analyzeBeatGrid(
    renderFixture({ bpm: 174, firstBeatSec: 0.05, durationSec: 40, style: 'house' }),
    SAMPLE_RATE,
  );
  assert.ok(grid);
  const octaveError = Math.min(Math.abs(grid.bpm - 174), Math.abs(grid.bpm - 87));
  assert.ok(octaveError <= 0.05, `default-range bpm ${grid.bpm} should be 174 or 87`);
});

test('silence and very short clips produce no grid', () => {
  assert.equal(analyzeBeatGrid(new Float32Array(SAMPLE_RATE * 20), SAMPLE_RATE), null);
  assert.equal(analyzeBeatGrid(renderFixture({ bpm: 120, firstBeatSec: 0, durationSec: 2, style: 'click' }), SAMPLE_RATE), null);
});

// ─── Grid math ──────────────────────────────────────────────────────────────────

const grid120: BeatGrid = { bpm: 120, firstBeatSec: 0.2 }; // beats at 0.2, 0.7, 1.2, ...

test('beat index and phase are measured from the first beat', () => {
  assert.equal(beatIndexAt(0.2, grid120), 0);
  assert.equal(beatIndexAt(1.2, grid120), 2);
  assert.ok(Math.abs(beatPhase(0.45, grid120) - 0.5) < 1e-9);
  assert.ok(Math.abs(beatPhase(0.1, grid120) - 0.8) < 1e-9, 'before the first beat the phase still wraps into [0,1)');
});

test('nearest beat snaps to the grid, not to multiples of the period from 0:00', () => {
  assert.ok(Math.abs(nearestBeatTime(0.9, grid120) - 0.7) < 1e-9);
  assert.ok(Math.abs(nearestBeatTime(1.0, grid120) - 1.2) < 1e-9);
});

test('quantized loop start follows Mixxx semantics', () => {
  // >= 1 beat: closest beat, even if slightly ahead of the playhead.
  assert.ok(Math.abs(quantizedLoopStart(1.0, grid120, 4) - 1.2) < 1e-9);
  // 1/2 beat pressed 60 % into a beat (0.2 + 0.3) loops the second half of that beat.
  assert.ok(Math.abs(quantizedLoopStart(0.5, grid120, 0.5) - 0.45) < 1e-9);
  // 1/4 beat pressed 10 % into a beat starts on the beat itself.
  assert.ok(Math.abs(quantizedLoopStart(0.25, grid120, 0.25) - 0.2) < 1e-9);
});

test('effective BPM applies the pitch fader', () => {
  assert.equal(effectiveBpm(125, 0), 125);
  assert.ok(Math.abs(effectiveBpm(125, 4) - 130) < 1e-9);
});

test('sync pitch matches the leader tempo you actually hear', () => {
  const close = (actual: number | null, expected: number) =>
    assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
  close(computeSyncPitchPercent(125, 125, 0), 0);
  close(computeSyncPitchPercent(124, 128, 0), (128 / 124 - 1) * 100);
  // Leader pitched +4 %: 125 BPM plays at 130, so a 130 BPM follower needs 0 %.
  close(computeSyncPitchPercent(130, 125, 4), 0);
  // Half/double tempo: 87 follows 174 at 0 %, 140 follows 70 at 0 %.
  close(computeSyncPitchPercent(87, 174, 0), 0);
  close(computeSyncPitchPercent(140, 70, 0), 0);
  assert.equal(computeSyncPitchPercent(0, 128, 0), null);
  assert.equal(computeSyncPitchPercent(128, Number.NaN, 0), null);
});

test('BPM display format', () => {
  assert.equal(formatBpm(128), '128');
  assert.equal(formatBpm(127.996), '128');
  assert.equal(formatBpm(93.5), '93.5');
  assert.equal(formatBpm(174.04), '174');
});
