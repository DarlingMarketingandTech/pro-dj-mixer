import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStoppedSegment,
  positionAt,
  rateAt,
  retargetSegment,
  seekSegment,
  startSegment,
  stopSegment,
  type TransportSegment,
} from '../lib/transportClock.ts';

const close = (actual: number, expected: number, tolerance: number, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} != ${expected} (±${tolerance})`);

/** Brute-force reference: integrate the setTargetAtTime rate curve with tiny Euler steps. */
function integrate(segment: TransportSegment, t: number, step = 1e-6) {
  let position = segment.position;
  for (let time = segment.contextTime; time < t; time += step) position += rateAt(segment, time) * step;
  return position;
}

test('constant rate: position advances at the rate, and not before a scheduled start', () => {
  const s = startSegment(createStoppedSegment(), 5, 1.1, 10);
  close(positionAt(s, 12), 5 + 2.2, 1e-12);
  assert.equal(positionAt(s, 9.999), 5, 'scheduled-ahead start holds the start position');
});

test('setTargetAtTime glide matches numerical integration', () => {
  const playing = startSegment(createStoppedSegment(), 30, 1.0, 0);
  const gliding = retargetSegment(playing, 1, 0.9, 0.01); // pitch -10 % with a 10 ms time constant
  for (const t of [1.001, 1.01, 1.05, 1.2]) close(positionAt(gliding, t), integrate(gliding, t), 2e-6, `t=${t}`);
  close(rateAt(gliding, 1.2), 0.9, 1e-6, 'rate settles on the target');
  // Compared with an instant step the glide is ahead by (1.0 - 0.9) * tau = 1 ms once settled.
  close(positionAt(gliding, 2) - (31 + 0.9 * 1), 0.1 * 0.01, 1e-9, 'settled lead');
});

test('retargeting mid-glide is continuous in position and rate', () => {
  const a = retargetSegment(startSegment(createStoppedSegment(), 0, 1, 0), 0.5, 1.08, 0.02);
  const b = retargetSegment(a, 0.51, 0.95, 0.02);
  close(positionAt(b, 0.51), positionAt(a, 0.51), 1e-12, 'position');
  close(rateAt(b, 0.51), rateAt(a, 0.51), 1e-12, 'rate');
  close(positionAt(b, 0.7), integrate(b, 0.7), 2e-6, 'after second glide');
});

test('native loop region wraps the playhead', () => {
  const s = startSegment(createStoppedSegment(), 2, 1, 0, { start: 2, end: 2.5 });
  close(positionAt(s, 1.3), 2.3, 1e-9);
  close(positionAt(s, 0.49), 2.49, 1e-9);
});

test('position is clamped to the track', () => {
  const s = startSegment(createStoppedSegment(0, 10), 9, 1, 0);
  assert.equal(positionAt(s, 5), 10);
});

test('stop freezes, seek moves, and a stopped deck reports rate 0', () => {
  const playing = startSegment(createStoppedSegment(), 0, 1.05, 0);
  const stopped = stopSegment(playing, 2);
  close(positionAt(stopped, 50), 2.1, 1e-12);
  assert.equal(rateAt(stopped, 50), 0);
  assert.equal(positionAt(seekSegment(stopped, 42, 3), 99), 42);
  const playingSeek = seekSegment(playing, 7, 4);
  close(positionAt(playingSeek, 5), 7 + 1.05, 1e-12);
});
