import { analyzeBeatGrid } from '@/lib/beatGrid';

export interface AnalysisRequest {
  id: string;
  channelData: Float32Array;
  sampleRate: number;
  duration: number;
}

export interface AnalysisResponse {
  id: string;
  bpm: number;
  /** Time of the first beat in seconds, or null when no grid could be found (BPM is then the default). */
  firstBeatSec: number | null;
  /** 0..1 grid confidence (0 when no grid was found). */
  confidence: number;
  duration: number;
  overviewPeaks: Float32Array;
  error: string | null;
}

const DEFAULT_BPM = 120;

const computeOverviewPeaks = (samples: Float32Array, size: number) => {
  const total = samples.length;
  const peaks = new Float32Array(size);
  const segmentSize = Math.max(1, Math.floor(total / size));

  for (let i = 0; i < size; i++) {
    const start = i * segmentSize;
    if (start >= total) {
      peaks[i] = 0;
      continue;
    }
    const end = i === size - 1 ? total : Math.min(total, start + segmentSize);
    let max = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(samples[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
  }

  return peaks;
};

const handleAnalyze = (request: AnalysisRequest): AnalysisResponse => {
  const overviewPeaks = computeOverviewPeaks(request.channelData, 500);
  const grid = analyzeBeatGrid(request.channelData, request.sampleRate);

  return {
    id: request.id,
    bpm: grid?.bpm ?? DEFAULT_BPM,
    firstBeatSec: grid?.firstBeatSec ?? null,
    confidence: grid?.confidence ?? 0,
    duration: request.duration,
    overviewPeaks,
    error: null,
  };
};

const ctx = globalThis as any;

ctx.onmessage = async (event: MessageEvent<AnalysisRequest>) => {
  const request = event.data;
  try {
    if (!request.channelData || typeof request.sampleRate !== 'number' || typeof request.duration !== 'number') {
      throw new Error('Invalid analysis request: expected channelData, sampleRate, duration.');
    }

    const response = handleAnalyze(request);
    ctx.postMessage(response, [response.overviewPeaks.buffer]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const response: AnalysisResponse = {
      id: request?.id ?? 'unknown',
      bpm: DEFAULT_BPM,
      firstBeatSec: null,
      confidence: 0,
      duration: request?.duration ?? 0,
      overviewPeaks: new Float32Array(500),
      error: message,
    };
    ctx.postMessage(response);
  }
};
