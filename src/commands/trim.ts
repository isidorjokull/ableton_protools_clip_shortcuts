/**
 * "a" / "s" — Pro Tools-style trims, implemented purely with the SDK.
 *
 * a: trim clip start to the selection start (removes clip content before it).
 * s: trim clip end to the selection end (removes clip content after it).
 *
 * clearClipsInRange truncates clips overlapping the range boundary rather than
 * deleting them, which is exactly a trim when the range is clamped to one
 * clip's extent.
 */
import { ExtensionContext } from "@ableton-extensions/sdk";
import { BEAT_EPSILON, clipAtTime } from "../utils/clip_utils.js";
import { ResolvedSelection } from "../utils/selection.js";

export async function trimStartToSelection(
  context: ExtensionContext<"1.0.0">,
  selection: ResolvedSelection,
): Promise<number> {
  return trim(context, selection, "start");
}

export async function trimEndToSelection(
  context: ExtensionContext<"1.0.0">,
  selection: ResolvedSelection,
): Promise<number> {
  return trim(context, selection, "end");
}

async function trim(
  context: ExtensionContext<"1.0.0">,
  selection: ResolvedSelection,
  edge: "start" | "end",
): Promise<number> {
  const point = edge === "start" ? selection.start : selection.end;
  const cuts: { track: ResolvedSelection["tracks"][number]; range: [number, number] }[] = [];
  for (const track of selection.tracks) {
    const clip = clipAtTime(track.arrangementClips, point);
    if (!clip) {
      continue;
    }
    const [rangeStart, rangeEnd] =
      edge === "start" ? [clip.startTime, point] : [point, clip.endTime];
    if (rangeEnd - rangeStart <= BEAT_EPSILON) {
      continue; // point sits exactly on the clip edge — nothing to trim
    }
    cuts.push({ track, range: [rangeStart, rangeEnd] });
  }
  if (cuts.length > 0) {
    // Mutations must start inside the transaction callback so the whole
    // multi-track trim collapses into a single undo step.
    await context.withinTransaction(() =>
      Promise.all(cuts.map(({ track, range }) => track.clearClipsInRange(...range))),
    );
  }
  return cuts.length;
}
