/**
 * Helpers for working with the ArrangementSelection payload Live passes to
 * context menu commands registered on *.ArrangementSelection scopes.
 */
import {
  ArrangementSelection,
  DataModelObject,
  ExtensionContext,
  Track,
} from "@ableton-extensions/sdk";

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

export function resolveSelection(
  context: ExtensionContext<"1.0.0">,
  selection: ArrangementSelection,
): ResolvedSelection {
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
