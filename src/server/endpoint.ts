/**
 * Request handling for the loopback command endpoint — pure logic, no sockets,
 * so the whole contract is unit-testable without Live or a listening port.
 *
 *   GET /cmd?id=<commandId>&track=<n>&time=<beats>
 *   GET /cmd?id=<commandId>&path=live_set%20tracks%20<n>&time=<beats>
 *
 * Why this exists: the Extensions SDK can only be triggered from a context
 * menu, and Song exposes no selection getter. A Max for Live device can read
 * both (LOM) and reach a loopback socket, so it supplies the track and the
 * arrangement insert marker that a context-menu ArrangementSelection would
 * otherwise carry. See device/ and docs in the README.
 */
// Imported rather than taken from globalThis: the Extension Host does not
// expose URL as a global, so `new URL(...)` throws "URL is not defined" there
// even though node and tsx provide it. Covered by a test that deletes it.
import { URL } from "url";
import type { PointSelection } from "../utils/selection.js";

/** What the endpoint found under the cursor, for the JSON response. */
export interface Target {
  trackIndex: number;
  trackName: string;
  clipName: string;
  time: number;
}

export interface Dispatcher {
  /** True if `id` is a command actually registered with Live. */
  isRegistered(id: string): boolean;
  /** The clip under `time` on `trackIndex`, or null if there is none. */
  resolveTarget(trackIndex: number, time: number): Target | null;
  /**
   * Invoke the command with a synthetic point selection. May return a promise;
   * the single-flight guard is held until it settles.
   */
  execute(id: string, selection: PointSelection): void | Promise<void>;
}

export interface CommandResponse {
  status: number;
  body: { ok: boolean; [k: string]: unknown };
}

/**
 * Pulls the track index out of a Live Object Model canonical path, e.g.
 * "live_set tracks 7" or "live_set tracks 7 arrangement_clips 0".
 *
 * Parsing lives here rather than in the Max patch on purpose: Max string
 * handling is awkward to test, whereas this is covered by unit tests. The
 * device forwards LiveAPI.unquotedpath verbatim.
 *
 * Returns null for return/main tracks — they hold no arrangement clips.
 */
export function parseTrackPath(raw: string): number | null {
  // Spaces, commas or plus signs all separate: Max can send whichever avoids
  // URL-encoding trouble.
  const parts = raw
    .trim()
    .replace(/^"|"$/g, "")
    .trim()
    .split(/[\s,+]+/)
    .filter((p) => p !== "");
  if (parts[0] !== "live_set" || parts[1] !== "tracks") return null;
  return toIndex(parts[2] ?? null);
}

/** Parses a non-negative integer, or null if absent/malformed. */
function toIndex(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Parses a non-negative finite beat time, or null. */
function toBeats(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Single-flight guard. Holding a key down repeats it, and a command that opens
 * a modal blocks until the user dismisses it; refusing concurrent dispatches
 * stops repeats from stacking edits (or dialogs) on top of each other.
 */
let inFlight = false;

/** Test seam: reset the guard between cases. */
export function __resetInFlight(): void {
  inFlight = false;
}

export async function handleCommandRequest(
  url: string,
  headers: Record<string, string | undefined>,
  deps: Dispatcher,
  token?: string,
): Promise<CommandResponse> {
  // A browser fetch/XHR always sets Origin, so this blocks a web page the user
  // happens to visit from driving the endpoint, while leaving [maxurl] and
  // curl unaffected.
  if (headers["origin"] !== undefined) {
    return { status: 403, body: { ok: false, error: "origin not allowed" } };
  }

  const parsed = new URL(url, "http://127.0.0.1");
  if (parsed.pathname !== "/cmd") {
    return { status: 404, body: { ok: false, error: "unknown endpoint" } };
  }
  const q = parsed.searchParams;

  if (token !== undefined && q.get("token") !== token) {
    return { status: 403, body: { ok: false, error: "bad token" } };
  }

  const id = q.get("id") ?? "";
  if (!deps.isRegistered(id)) {
    return { status: 400, body: { ok: false, error: `unknown command id: ${id}` } };
  }

  // `path` is what the Max device sends (LiveAPI.unquotedpath, verbatim);
  // `track` stays supported for curl and Stream Deck use.
  const rawPath = q.get("path");
  const trackIndex = rawPath !== null ? parseTrackPath(rawPath) : toIndex(q.get("track"));
  if (trackIndex === null) {
    return {
      status: 400,
      body: {
        ok: false,
        error:
          rawPath !== null
            ? `unparseable track path: ${rawPath}`
            : "track must be a non-negative integer",
      },
    };
  }

  const time = toBeats(q.get("time"));
  if (time === null) {
    return { status: 400, body: { ok: false, error: "time must be a non-negative number of beats" } };
  }

  const target = deps.resolveTarget(trackIndex, time);
  if (!target) {
    return { status: 404, body: { ok: false, error: "no clip at that time on that track" } };
  }

  if (inFlight) return { status: 409, body: { ok: false, error: "busy" } };

  inFlight = true;
  try {
    await deps.execute(id, { pt_track: trackIndex, pt_time: time });
    return {
      status: 200,
      body: { ok: true, id, track: target.trackName, clip: target.clipName, time },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 500, body: { ok: false, error: msg } };
  } finally {
    inFlight = false;
  }
}
