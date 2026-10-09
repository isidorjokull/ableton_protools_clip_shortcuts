/**
 * Adapts the SDK context to the Dispatcher the endpoint depends on.
 *
 * The narrow structural type keeps this unit-testable without an Extension
 * Host, and keeps the endpoint free of SDK imports.
 */
import { clipAtTime } from "../utils/clip_utils.js";
import type { PointSelection } from "../utils/selection.js";
import type { Dispatcher, Target } from "./endpoint.js";

export interface SdkLike {
  application: {
    song: {
      tracks: ReadonlyArray<{
        name: string;
        arrangementClips: ReadonlyArray<{ name: string; startTime: number; endTime: number }>;
      }>;
    };
  };
  executeCommand(id: string, selection: PointSelection): void;
}

export function createDispatcher(sdk: SdkLike, registered: ReadonlySet<string>): Dispatcher {
  return {
    isRegistered: (id) => registered.has(id),

    resolveTarget(trackIndex: number, time: number): Target | null {
      const track = sdk.application.song.tracks[trackIndex];
      if (!track) return null;
      // Reading arrangementClips crosses into the host, so read it once.
      const clip = clipAtTime([...track.arrangementClips], time);
      if (!clip) return null;
      return { trackIndex, trackName: track.name, clipName: clip.name, time };
    },

    execute(id: string, selection: PointSelection): void {
      sdk.executeCommand(id, selection);
    },
  };
}
