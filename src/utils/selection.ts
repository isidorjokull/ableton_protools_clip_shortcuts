/**
 * Helpers for working with the two shapes a command can be invoked with:
 *
 *  - `ArrangementSelection` — what Live passes to a context menu command
 *    registered on a *.ArrangementSelection scope.
 *  - `PointSelection` — what the loopback endpoint passes (see src/server/),
 *    because an HTTP caller has no Handle and Live's selection is invisible to
 *    the SDK. The Max device reads the LOM and sends a track index plus the
 *    arrangement insert marker; that collapses to a zero-width selection.
 *
 * Both resolve to the same `ResolvedSelection`, so every command body is
 * written once and works from either door.
 */
import {
  ArrangementSelection,
  DataModelObject,
  ExtensionContext,
  Track,
} from "@ableton-extensions/sdk";

/**
 * A zero-width selection: one track index into Song.tracks, plus a time in
 * beats. Snake_case mirrors ArrangementSelection so the two are obviously
 * siblings, and the field names are distinct enough to discriminate on.
 */
export interface PointSelection {
  pt_track: number;
  pt_time: number;
}

export interface ResolvedSelection {
  /** Selection (or insert point when start === end), in beats. */
  start: number;
  end: number;
  /** Tracks whose lanes are part of the selection. */
  tracks: Track<"1.0.0">[];
}

/** Runtime shape-check: Live hands the selection as an untyped command arg. */
export function isArrangementSelection(arg: unknown): arg is ArrangementSelection {
  const sel = arg as ArrangementSelection;
  return (
    typeof sel === "object" &&
    sel !== null &&
    typeof sel.time_selection_start === "number" &&
    typeof sel.time_selection_end === "number" &&
    Array.isArray(sel.selected_lanes)
  );
}

/** Runtime shape-check for the endpoint's synthetic selection. */
export function isPointSelection(arg: unknown): arg is PointSelection {
  const sel = arg as PointSelection;
  return (
    typeof sel === "object" &&
    sel !== null &&
    typeof sel.pt_track === "number" &&
    typeof sel.pt_time === "number"
  );
}

/** True for either shape — what a command handler guards on. */
export function isSelection(arg: unknown): arg is ArrangementSelection | PointSelection {
  return isArrangementSelection(arg) || isPointSelection(arg);
}

export function resolveSelection(
  context: ExtensionContext<"1.0.0">,
  selection: ArrangementSelection | PointSelection,
): ResolvedSelection {
  if (isPointSelection(selection)) {
    const track = context.application.song.tracks[selection.pt_track];
    return {
      start: selection.pt_time,
      end: selection.pt_time,
      tracks: track ? [track] : [],
    };
  }

  const tracks: Track<"1.0.0">[] = [];
  for (const handle of selection.selected_lanes) {
    // Lanes can be tracks or take lanes; fades/trims only apply to tracks.
    const obj = context.getObjectFromHandle(handle, DataModelObject);
    if (obj instanceof Track) {
      tracks.push(obj);
    }
  }
  return {
    start: Math.min(selection.time_selection_start, selection.time_selection_end),
    end: Math.max(selection.time_selection_start, selection.time_selection_end),
    tracks,
  };
}

/** Index of `track` within Song.tracks, or -1 (needed for the bridge payload). */
export function trackIndex(
  allTracks: Track<"1.0.0">[],
  track: Track<"1.0.0">,
): number {
  return allTracks.findIndex((t) => t.handle.id === track.handle.id);
}
