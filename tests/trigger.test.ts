/**
 * Drives device/pt-trigger.js — the Max [js] script — in a vm sandbox with
 * fake Max globals (LiveAPI, outlet, post) and a controllable clock.
 *
 * The bug this guards against: Live's Key Map does not send a momentary press.
 * It FLIPS the button's two-state parameter, so consecutive presses arrive as
 * 1, 0, 1, 0… In live.text's button mode (mode 0) the 1→0 edge produced no
 * output at all, so the shortcut fired on every second press and the button
 * sat latched at 1 looking stuck. Every press must fire, whichever edge it is.
 */
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const SCRIPT = readFileSync(new URL("../device/pt-trigger.js", import.meta.url), "utf8");

interface Sandbox {
  bang(): void;
  msg_int(v: number): void;
  msg_float(v: number): void;
  [k: string]: unknown;
}

function loadTrigger(opts: { trackPath?: string; trackId?: string; songTime?: number } = {}) {
  const outlets: unknown[][] = [];
  const posts: string[] = [];
  let now = 100_000;

  const sandbox: Record<string, unknown> = {
    autowatch: 0,
    outlets: 0,
    messagename: "sym",
    jsarguments: ["pt-trigger.js", "pt-clip-shortcuts.trimStart"],
    post: (s: string) => posts.push(s),
    outlet: (...args: unknown[]) => outlets.push(args),
    // Only getTime is used by the script; a controllable clock lets the
    // debounce be tested without real waiting.
    Date: function () {
      return { getTime: () => now };
    },
    LiveAPI: function (this: Record<string, unknown>, path: string) {
      if (path === "live_set view selected_track") {
        this.id = opts.trackId ?? "5";
        this.unquotedpath = opts.trackPath ?? "live_set tracks 2";
      } else if (path === "live_set") {
        this.id = "1";
        this.get = (prop: string) =>
          prop === "current_song_time" ? [opts.songTime ?? 8.25] : [];
      } else {
        this.id = "0";
      }
    },
  };

  createContext(sandbox);
  runInContext(SCRIPT, sandbox);

  return {
    api: sandbox as unknown as Sandbox,
    outlets,
    posts,
    advance: (ms: number) => (now += ms),
    /** The URLs actually sent to [maxurl]. */
    urls: () => outlets.filter((o) => o[0] === 0 && o[1] === "get").map((o) => String(o[2])),
    resets: () => outlets.filter((o) => o[0] === 2 && o[1] === "set"),
  };
}

describe("pt-trigger.js", () => {
  it("declares the three outlets the patcher wires", () => {
    const t = loadTrigger();
    expect(t.api.outlets).toBe(3);
  });

  it("builds the endpoint URL from the selected track and the edit cursor", () => {
    const t = loadTrigger({ trackPath: "live_set tracks 7", songTime: 12.5 });
    t.api.msg_int(1);
    expect(t.urls()).toEqual([
      "http://127.0.0.1:17818/cmd?id=pt-clip-shortcuts.trimStart" +
        "&path=live_set%20tracks%207&time=12.500000",
    ]);
  });

  it("fires on BOTH key-press edges — the every-other-press bug", () => {
    const t = loadTrigger();
    // What Live's Key Map actually delivers across three presses of the key.
    t.api.msg_int(1);
    t.advance(1000);
    t.api.msg_int(0);
    t.advance(1000);
    t.api.msg_int(1);
    expect(t.urls()).toHaveLength(3);
  });

  it("clears the button's latch after every message, so it never looks stuck", () => {
    const t = loadTrigger();
    t.api.msg_int(1);
    expect(t.resets()).toEqual([[2, "set", 0]]);
    // Even a debounced message resets, or a swallowed press would leave it lit.
    t.api.msg_int(0);
    expect(t.resets()).toHaveLength(2);
  });

  it("never re-enters itself: the reset is `set`, which produces no output", () => {
    const t = loadTrigger();
    t.api.msg_int(1);
    // A bare 0 would come back through msg_int and fire again.
    for (const o of t.resets()) expect(o[1]).toBe("set");
  });

  it("debounces a key repeat but not a deliberate second press", () => {
    const t = loadTrigger();
    t.api.msg_int(1);
    t.advance(30);
    t.api.msg_int(0);
    expect(t.urls()).toHaveLength(1);
    t.advance(500);
    t.api.msg_int(1);
    expect(t.urls()).toHaveLength(2);
  });

  it("also accepts a mouse click, which sends a bang", () => {
    const t = loadTrigger();
    t.api.bang();
    expect(t.urls()).toHaveLength(1);
  });

  it("refuses tracks that hold no arrangement clips, without calling the endpoint", () => {
    const t = loadTrigger({ trackPath: "live_set master_track" });
    t.api.msg_int(1);
    expect(t.urls()).toEqual([]);
    expect(t.posts.join("")).toContain("select a regular track");
  });

  it("reports an unresolved selection (LiveAPI id 0) instead of firing", () => {
    const t = loadTrigger({ trackId: "0" });
    t.api.msg_int(1);
    expect(t.urls()).toEqual([]);
    expect(t.posts.join("")).toContain("no track selected");
  });
});
