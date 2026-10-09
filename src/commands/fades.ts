/**
 * "d" / "f" / "g" — fades, delegated to the bridge (rack + Python remote script) because the SDK has no
 * access to clip gain or fades.
 *
 * d: fade-in from clip start to the selection point.
 * g: fade-out from the selection point to clip end.
 * f: fade over the time selection — at a clip junction this crossfades the
 *    outgoing and incoming clips; inside a single clip it applies both a
 *    fade-in at the selection start edge and fade-out at the end edge of the
 *    selection relative to the clip (Pro Tools "fade to selection" behavior
 *    is approximated by fading across the junction).
 */
import { AudioClip, Track } from "@ableton-extensions/sdk";
import { Bridge } from "../bridge/bridge.js";
import { FadePayload, FadeType } from "../bridge/protocol.js";
import { BEAT_EPSILON, boundaryInRange, clipAtTime } from "../utils/clip_utils.js";
import { ResolvedSelection, trackIndex } from "../utils/selection.js";

/** Fades only make sense for audio clips — MIDI has no clip gain in the LOM. */
function audioClipAt(track: Track<"1.0.0">, time: number): AudioClip<"1.0.0"> | null {
  const clip = clipAtTime(track.arrangementClips, time);
  return clip instanceof AudioClip ? clip : null;
}

export function buildFadeInPayloads(
  allTracks: Track<"1.0.0">[],
  selection: ResolvedSelection,
): FadePayload[] {
  const payloads: FadePayload[] = [];
  for (const track of selection.tracks) {
    // Pro Tools "D": fade from clip start to the selection point. Prefer the
    // selection end so a range selection fades across the whole range.
    const clip = audioClipAt(track, selection.end) ?? audioClipAt(track, selection.start);
    if (!clip) {
      continue;
    }
    const point = clipContains(clip, selection.end) ? selection.end : selection.start;
    if (point - clip.startTime <= BEAT_EPSILON) {
      continue;
    }
    payloads.push({
      fadeType: FadeType.FadeIn,
      trackIndex: trackIndex(allTracks, track),
      clipStart: clip.startTime,
      rangeStart: clip.startTime,
      rangeEnd: point,
    });
  }
  return payloads;
}

export function buildFadeOutPayloads(
  allTracks: Track<"1.0.0">[],
  selection: ResolvedSelection,
): FadePayload[] {
  const payloads: FadePayload[] = [];
  for (const track of selection.tracks) {
    const clip = audioClipAt(track, selection.start) ?? audioClipAt(track, selection.end);
    if (!clip) {
      continue;
    }
    const point = clipContains(clip, selection.start) ? selection.start : selection.end;
    if (clip.endTime - point <= BEAT_EPSILON) {
      continue;
    }
    payloads.push({
      fadeType: FadeType.FadeOut,
      trackIndex: trackIndex(allTracks, track),
      clipStart: clip.startTime,
      rangeStart: point,
      rangeEnd: clip.endTime,
    });
  }
  return payloads;
}

export function buildCrossfadePayloads(
  allTracks: Track<"1.0.0">[],
  selection: ResolvedSelection,
): FadePayload[] {
  const payloads: FadePayload[] = [];
  for (const track of selection.tracks) {
    const index = trackIndex(allTracks, track);
    const clips = track.arrangementClips.filter(
      (c): c is AudioClip<"1.0.0"> => c instanceof AudioClip,
    );
    const boundary = boundaryInRange(clips, selection.start, selection.end);
    if (boundary) {
      // Clip junction inside the selection → true crossfade.
      payloads.push({
        fadeType: FadeType.Crossfade,
        trackIndex: index,
        clipStart: boundary.outgoing.startTime,
        rangeStart: selection.start,
        rangeEnd: selection.end,
        trackIndexB: index,
        clipStartB: boundary.incoming.startTime,
      });
      continue;
    }
    // No junction: selection touching a single clip's edges → fade the edges.
    const clip = clipAtTime(clips, selection.start) ?? clipAtTime(clips, selection.end);
    if (!clip) {
      continue;
    }
    if (selection.start - clip.startTime <= BEAT_EPSILON) {
      payloads.push({
        fadeType: FadeType.FadeIn,
        trackIndex: index,
        clipStart: clip.startTime,
        rangeStart: clip.startTime,
        rangeEnd: Math.min(selection.end, clip.endTime),
      });
    } else if (clip.endTime - selection.end <= BEAT_EPSILON) {
      payloads.push({
        fadeType: FadeType.FadeOut,
        trackIndex: index,
        clipStart: clip.startTime,
        rangeStart: Math.max(selection.start, clip.startTime),
        rangeEnd: clip.endTime,
      });
    }
  }
  return payloads;
}

function clipContains(clip: { startTime: number; endTime: number }, time: number): boolean {
  return clip.startTime - BEAT_EPSILON <= time && time < clip.endTime - BEAT_EPSILON;
}

/** Commits payloads to the bridge one at a time (each is its own handshake). */
export async function sendPayloads(bridge: Bridge, payloads: FadePayload[]): Promise<void> {
  for (const payload of payloads) {
    await bridge.sendFade(payload);
  }
}
