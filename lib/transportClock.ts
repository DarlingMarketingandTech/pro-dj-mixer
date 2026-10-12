/**
 * Transport clock: where a deck's playhead is at any audio-context time, computed rather than
 * polled. Pure module with no imports, so it runs in the engine and in Node tests (`npm test`).
 *
 * A deck's motion is a sequence of segments. Each segment starts at an anchor (context time,
 * track position, rate) and the rate either stays put or glides toward a target exactly the way
 * Web Audio's `AudioParam.setTargetAtTime` does:
 *
 *   rate(t)     = target + (rate0 - target) * e^(-dt / tau)
 *   position(t) = position0 + target * dt + (rate0 - target) * tau * (1 - e^(-dt / tau))
 *
 * (the second line is the integral of the first). Any change (play, pause, seek, new rate, loop)
 * starts a new segment anchored at the current computed position and rate, so time never jumps.
 */

export interface TransportLoop {
  start: number;
  end: number;
}

export interface TransportSegment {
  /** Audio-context time when this segment begins (playback may be scheduled slightly ahead). */
  contextTime: number;
  /** Track position (seconds) at `contextTime`. */
  position: number;
  /** Playback rate at `contextTime`. */
  rate: number;
  /** Rate the playhead glides toward; equal to `rate` for a step change. */
  targetRate: number;
  /** setTargetAtTime time constant in seconds; 0 means the rate is already at its target. */
  tau: number;
  playing: boolean;
  /** Track length used to clamp the position; Infinity when unknown. */
  duration: number;
  /** Native loop region (AudioBufferSourceNode.loop) the playhead wraps inside, if any. */
  loop: TransportLoop | null;
}

export const createStoppedSegment = (position = 0, duration = Infinity): TransportSegment => ({
  contextTime: 0,
  position,
  rate: 1,
  targetRate: 1,
  tau: 0,
  playing: false,
  duration,
  loop: null,
});

/** Instantaneous playback rate at context time `t`. */
export function rateAt(segment: TransportSegment, t: number): number {
  if (!segment.playing) return 0;
  const dt = Math.max(0, t - segment.contextTime);
  if (segment.tau <= 0 || segment.rate === segment.targetRate) return segment.targetRate;
  return segment.targetRate + (segment.rate - segment.targetRate) * Math.exp(-dt / segment.tau);
}

/** Track seconds advanced between the segment start and `t` (before looping and clamping). */
function travelled(segment: TransportSegment, dt: number): number {
  if (segment.tau <= 0 || segment.rate === segment.targetRate) return segment.targetRate * dt;
  const glide = (segment.rate - segment.targetRate) * segment.tau * (1 - Math.exp(-dt / segment.tau));
  return segment.targetRate * dt + glide;
}

/** Playhead position (track seconds) at context time `t`. */
export function positionAt(segment: TransportSegment, t: number): number {
  if (!segment.playing) return clampPosition(segment.position, segment.duration);
  const dt = Math.max(0, t - segment.contextTime);
  let position = segment.position + travelled(segment, dt);
  const loop = segment.loop;
  if (loop && loop.end > loop.start && position >= loop.end) {
    const length = loop.end - loop.start;
    position = loop.start + ((position - loop.start) % length);
  }
  return clampPosition(position, segment.duration);
}

const clampPosition = (position: number, duration: number) =>
  Math.max(0, Math.min(position, Number.isFinite(duration) ? duration : position));

/** Start (or restart) playback from `position` at context time `startAt`. */
export function startSegment(
  previous: TransportSegment,
  position: number,
  rate: number,
  startAt: number,
  loop: TransportLoop | null = null,
): TransportSegment {
  return { ...previous, contextTime: startAt, position, rate, targetRate: rate, tau: 0, playing: true, loop };
}

/** Stop, freezing the playhead where it is at `t` (or at an explicit position). */
export function stopSegment(previous: TransportSegment, t: number, position?: number): TransportSegment {
  return {
    ...previous,
    contextTime: t,
    position: position ?? positionAt(previous, t),
    rate: previous.targetRate,
    tau: 0,
    playing: false,
    loop: null,
  };
}

/** Begin gliding toward `targetRate` at context time `t` (mirrors setTargetAtTime(target, t, tau)). */
export function retargetSegment(
  previous: TransportSegment,
  t: number,
  targetRate: number,
  tau: number,
): TransportSegment {
  if (!previous.playing) return { ...previous, rate: targetRate, targetRate, tau: 0 };
  return {
    ...previous,
    contextTime: t,
    position: positionAt(previous, t),
    rate: rateAt(previous, t),
    targetRate,
    tau: Math.max(0, tau),
  };
}

/** Jump to `position` while keeping the play state (paused seek, or an instant playing seek). */
export function seekSegment(previous: TransportSegment, position: number, at: number): TransportSegment {
  return { ...previous, contextTime: at, position, rate: previous.targetRate, tau: 0, loop: null };
}
