/**
 * Pure range math over clip-like objects, kept free of SDK imports so it can
 * be unit-tested without an Extension Host.
 */
export interface ClipRange {
  startTime: number;
  endTime: number;
}

/** Tolerance for beat-time comparisons (Live stores beats as doubles). */
export const BEAT_EPSILON = 1e-6;

/** The clip whose [startTime, endTime) range contains `time`, or null. */
export function clipAtTime<T extends ClipRange>(clips: T[], time: number): T | null {
  for (const clip of clips) {
    if (
      clip.startTime - BEAT_EPSILON <= time &&
      time < clip.endTime - BEAT_EPSILON
    ) {
      return clip;
    }
  }
  return null;
}

/** All clips overlapping the [start, end) range. */
export function clipsInRange<T extends ClipRange>(clips: T[], start: number, end: number): T[] {
  return clips.filter(
    (clip) => clip.startTime < end - BEAT_EPSILON && clip.endTime > start + BEAT_EPSILON,
  );
}

/**
 * An adjacent clip boundary inside [start, end): clip A ends where (or before)
 * clip B starts, with both edges inside the range. This is the Pro Tools
 * crossfade case ("f" over a clip junction).
 */
export function boundaryInRange<T extends ClipRange>(
  clips: T[],
  start: number,
  end: number,
): { outgoing: T; incoming: T } | null {
  const sorted = [...clips].sort((a, b) => a.startTime - b.startTime);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const edgeInside =
      a.endTime > start + BEAT_EPSILON &&
      b.startTime < end - BEAT_EPSILON &&
      a.endTime <= end + BEAT_EPSILON &&
      b.startTime >= start - BEAT_EPSILON;
    if (edgeInside && b.startTime - a.endTime <= BEAT_EPSILON + 1e-3) {
      return { outgoing: a, incoming: b };
    }
  }
  return null;
}
