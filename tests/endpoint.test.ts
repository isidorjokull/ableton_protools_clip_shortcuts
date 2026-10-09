/**
 * Contract tests for the loopback command endpoint's request handling.
 * No sockets, no Live — just the pure request → response mapping.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetInFlight,
  handleCommandRequest,
  parseTrackPath,
  type Dispatcher,
  type Target,
} from "../src/server/endpoint.js";
import type { PointSelection } from "../src/utils/selection.js";

const NO_HEADERS: Record<string, string | undefined> = {};

function makeDeps(overrides: Partial<Dispatcher> = {}) {
  const calls: { id: string; selection: PointSelection }[] = [];
  const deps: Dispatcher = {
    isRegistered: (id) => id === "pt.trimStart",
    resolveTarget: (trackIndex, time): Target | null =>
      trackIndex === 0 ? { trackIndex, trackName: "Audio 1", clipName: "Take 3", time } : null,
    execute: (id, selection) => {
      calls.push({ id, selection });
    },
    ...overrides,
  };
  return { deps, calls };
}

const GET = (url: string, deps: Dispatcher, token?: string) =>
  handleCommandRequest(url, NO_HEADERS, deps, token);

describe("parseTrackPath", () => {
  it("reads the track index from a canonical LOM path", () => {
    expect(parseTrackPath("live_set tracks 7")).toBe(7);
  });

  it("ignores anything after the track, so a clip path also works", () => {
    expect(parseTrackPath("live_set tracks 7 arrangement_clips 2")).toBe(7);
  });

  it("accepts commas and plus signs, which Max may send instead of spaces", () => {
    expect(parseTrackPath("live_set,tracks,3")).toBe(3);
    expect(parseTrackPath("live_set+tracks+3")).toBe(3);
  });

  it("strips the quotes LiveAPI.path would add", () => {
    expect(parseTrackPath('"live_set tracks 1"')).toBe(1);
  });

  it("rejects tracks that hold no arrangement clips", () => {
    expect(parseTrackPath("live_set return_tracks 0")).toBeNull();
    expect(parseTrackPath("live_set master_track")).toBeNull();
    expect(parseTrackPath("live_set view detail_clip")).toBeNull();
  });
});

describe("handleCommandRequest", () => {
  beforeEach(__resetInFlight);

  it("dispatches a point selection built from track and time", async () => {
    const { deps, calls } = makeDeps();
    const res = await GET("/cmd?id=pt.trimStart&track=0&time=12.5", deps);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, clip: "Take 3", time: 12.5 });
    expect(calls).toEqual([
      { id: "pt.trimStart", selection: { pt_track: 0, pt_time: 12.5 } },
    ]);
  });

  it("accepts the LOM path the Max device sends", async () => {
    const { deps, calls } = makeDeps();
    const res = await GET("/cmd?id=pt.trimStart&path=live_set%20tracks%200&time=4", deps);
    expect(res.status).toBe(200);
    expect(calls[0].selection).toEqual({ pt_track: 0, pt_time: 4 });
  });

  it("refuses an unregistered command id without dispatching", async () => {
    const { deps, calls } = makeDeps();
    const res = await GET("/cmd?id=pt.nope&track=0&time=4", deps);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("unknown command id");
    expect(calls).toHaveLength(0);
  });

  it("rejects a missing or negative time", async () => {
    const { deps } = makeDeps();
    expect((await GET("/cmd?id=pt.trimStart&track=0", deps)).status).toBe(400);
    expect((await GET("/cmd?id=pt.trimStart&track=0&time=-1", deps)).status).toBe(400);
    expect((await GET("/cmd?id=pt.trimStart&track=0&time=abc", deps)).status).toBe(400);
  });

  it("rejects a malformed track", async () => {
    const { deps } = makeDeps();
    expect((await GET("/cmd?id=pt.trimStart&track=x&time=4", deps)).status).toBe(400);
    expect((await GET("/cmd?id=pt.trimStart&path=live_set%20foo&time=4", deps)).status).toBe(400);
  });

  it("404s when no clip sits under the cursor", async () => {
    const { deps, calls } = makeDeps();
    const res = await GET("/cmd?id=pt.trimStart&track=9&time=4", deps);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("404s an unknown endpoint", async () => {
    const { deps } = makeDeps();
    expect((await GET("/other?id=pt.trimStart", deps)).status).toBe(404);
  });

  it("rejects any request carrying an Origin header", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleCommandRequest(
      "/cmd?id=pt.trimStart&track=0&time=4",
      { origin: "https://example.com" },
      deps,
    );
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("enforces the token when one is configured", async () => {
    const { deps } = makeDeps();
    expect((await GET("/cmd?id=pt.trimStart&track=0&time=4", deps, "s3cret")).status).toBe(403);
    expect(
      (await GET("/cmd?id=pt.trimStart&track=0&time=4&token=s3cret", deps, "s3cret")).status,
    ).toBe(200);
  });

  it("refuses a concurrent dispatch rather than stacking edits", async () => {
    let release!: () => void;
    const started = new Promise<void>((r) => (release = r));
    let blocked!: () => void;
    const holding = new Promise<void>((r) => (blocked = r));
    const { deps } = makeDeps({
      execute: () => {
        blocked();
        return started;
      },
    });

    const first = GET("/cmd?id=pt.trimStart&track=0&time=4", deps);
    await holding;
    const second = await GET("/cmd?id=pt.trimStart&track=0&time=4", deps);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("busy");

    release();
    expect((await first).status).toBe(200);
  });

  it("releases the guard after a command throws, and reports 500", async () => {
    const { deps } = makeDeps({
      execute: () => {
        throw new Error("boom");
      },
    });
    const res = await GET("/cmd?id=pt.trimStart&track=0&time=4", deps);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("boom");

    const { deps: ok } = makeDeps();
    expect((await GET("/cmd?id=pt.trimStart&track=0&time=4", ok)).status).toBe(200);
  });

  it("works without a global URL, as in the Extension Host", async () => {
    const g = globalThis as { URL?: unknown };
    const saved = g.URL;
    delete g.URL;
    try {
      const { deps } = makeDeps();
      expect((await GET("/cmd?id=pt.trimStart&track=0&time=4", deps)).status).toBe(200);
    } finally {
      g.URL = saved;
    }
  });
});
