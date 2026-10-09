/**
 * End-to-end test of the extension against a fake Extension Host.
 *
 * This drives the real SDK (initialize, object registry, DeviceParameter…)
 * and the real activate() — only the host-side DataModel/Commands/Ui modules
 * are faked. It verifies the full lifecycle Live would run: activation,
 * context menu registration, command invocation with an ArrangementSelection,
 * trims via clearClipsInRange, and the complete fade handshake against the
 * "PT Bridge" rack (payload macros written, trigger bumped last).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActivationContext, Handle } from "@ableton-extensions/sdk";
import { get as httpGet } from "node:http";
import { activate } from "../src/extension.js";
import { FadeType, SLOTS, decodeBeats } from "../src/bridge/protocol.js";

// -- fake host ---------------------------------------------------------------

interface FakeObject {
  className: string;
  name?: string;
  startTime?: number;
  endTime?: number;
  tracks?: Handle[];
  mainTrack?: Handle;
  clips?: Handle[];
  devices?: Handle[];
  parameters?: Handle[];
  value?: number;
}

function makeHost() {
  const objects = new Map<bigint, FakeObject>();
  let nextId = 1n;
  const add = (obj: FakeObject): Handle => {
    const id = nextId++;
    objects.set(id, obj);
    return { id };
  };
  const get = (handle: Handle): FakeObject => {
    const obj = objects.get(handle.id);
    if (!obj) throw new Error(`unknown handle ${handle.id}`);
    return obj;
  };

  // Arrangement: one audio track with two adjacent clips [0,8) and [8,16).
  const clipA = add({ className: "AudioClip", name: "Take A", startTime: 0, endTime: 8 });
  const clipB = add({ className: "AudioClip", name: "Take B", startTime: 8, endTime: 16 });
  const track = add({ className: "AudioTrack", name: "Audio 1", clips: [clipA, clipB] });

  // Main track with a factory-named 16-macro "PT Bridge" rack.
  const rackParams: Handle[] = [add({ className: "DeviceParameter", name: "Device On", value: 1 })];
  for (let i = 1; i <= 16; i++) {
    rackParams.push(add({ className: "DeviceParameter", name: `Macro ${i}`, value: 0 }));
  }
  get(rackParams[1]).value = 127; // Macro 1 = PT Mode, default on
  const rack = add({ className: "Device", name: "PT Bridge", parameters: rackParams });
  const mainTrack = add({ className: "AudioTrack", name: "Main", devices: [rack] });

  const song = add({ className: "Song", tracks: [track], mainTrack });
  const root = add({ className: "Application" });

  const clearCalls: { track: bigint; start: number; end: number }[] = [];
  const paramWrites: { name: string; value: number }[] = [];
  const commands = new Map<string, (...args: unknown[]) => void>();
  const menuActions: { scope: string; title: string; commandId: string }[] = [];

  const dataModel = {
    getObjectIsOfClass: (h: Handle, className: string) => get(h).className === className,
    getObjectCanonicalParent: () => null,
    getRoot: () => root,
    rootGetSong: () => song,
    songGetTracks: (h: Handle) => get(h).tracks ?? [],
    songGetMainTrack: (h: Handle) => get(h).mainTrack!,
    trackGetName: (h: Handle) => get(h).name ?? "",
    trackGetArrangementClips: (h: Handle) => get(h).clips ?? [],
    trackGetDevices: (h: Handle) => get(h).devices ?? [],
    trackClearClipsInRange: (
      h: Handle,
      start: number,
      end: number,
      onResult: () => void,
    ) => {
      clearCalls.push({ track: h.id, start, end });
      onResult();
    },
    withinTransaction: <T>(fn: () => T): T => fn(),
    clipGetName: (h: Handle) => get(h).name ?? "",
    clipGetStartTime: (h: Handle) => get(h).startTime!,
    clipGetEndTime: (h: Handle) => get(h).endTime!,
    deviceGetName: (h: Handle) => get(h).name ?? "",
    deviceGetParameters: (h: Handle) => get(h).parameters ?? [],
    deviceParameterGetName: (h: Handle) => get(h).name ?? "",
    deviceParameterGetInternalValue: (h: Handle, onResult: (v: number) => void) =>
      onResult(get(h).value ?? 0),
    deviceParameterSetInternalValue: (
      h: Handle,
      value: number,
      onResult: () => void,
    ) => {
      get(h).value = value;
      paramWrites.push({ name: get(h).name!, value });
      onResult();
    },
  };

  const api = {
    commands: {
      registerCommand: (id: string, cb: (...args: unknown[]) => void) => commands.set(id, cb),
      executeCommand: (id: string, ...args: unknown[]) => commands.get(id)!(...args),
    },
    dataModel,
    environment: {},
    resources: {},
    ui: {
      registerContextMenuAction: (
        scope: string,
        title: string,
        commandId: string,
        onRegisterSuccessful: (unregister: (done: () => void) => void) => void,
      ) => {
        menuActions.push({ scope, title, commandId });
        onRegisterSuccessful((done) => done());
      },
    },
  };

  const activation = {
    hostApiVersion: "1.0.0",
    initializeExtensionHost: () => api,
  } as unknown as ActivationContext;

  const macroValue = (slot: (typeof SLOTS)[number]) =>
    get(rackParams[SLOTS.indexOf(slot) + 1]).value!;

  return {
    activation,
    trackHandle: track,
    clearCalls,
    paramWrites,
    menuActions,
    commands,
    macroValue,
    setMacro: (slot: (typeof SLOTS)[number], value: number) => {
      get(rackParams[SLOTS.indexOf(slot) + 1]).value = value;
    },
  };
}

type Host = ReturnType<typeof makeHost>;

function invoke(host: Host, commandId: string, start: number, end: number) {
  host.commands.get(commandId)!({
    time_selection_start: start,
    time_selection_end: end,
    selected_lanes: [host.trackHandle],
  });
  // Command handlers are async; everything in the fake host resolves in
  // microtasks, so one macrotask flush settles the whole chain.
  return new Promise((resolve) => setImmediate(resolve));
}

// -- tests --------------------------------------------------------------------

describe("extension against a fake Extension Host", () => {
  let host: Host;

  beforeEach(() => {
    host = makeHost();
    activate(host.activation, { endpointPort: false });
  });

  it("registers all five actions in both arrangement scopes", () => {
    expect(host.menuActions).toHaveLength(10);
    const scopes = new Set(host.menuActions.map((a) => a.scope));
    expect(scopes).toEqual(
      new Set(["AudioTrack.ArrangementSelection", "MidiTrack.ArrangementSelection"]),
    );
  });

  it("a: trims clip start to the selection start", async () => {
    await invoke(host, "pt-clip-shortcuts.trimStart", 2, 6);
    expect(host.clearCalls).toEqual([{ track: host.trackHandle.id, start: 0, end: 2 }]);
  });

  it("s: trims clip end to the selection end", async () => {
    await invoke(host, "pt-clip-shortcuts.trimEnd", 2, 6);
    expect(host.clearCalls).toEqual([{ track: host.trackHandle.id, start: 6, end: 8 }]);
  });

  it("d: runs the full fade-in handshake against the bridge rack", async () => {
    await invoke(host, "pt-clip-shortcuts.fadeIn", 4, 4);

    // Trigger must be bumped exactly once, as the final write.
    const triggerWrites = host.paramWrites.filter((w) => w.name === "Macro 13");
    expect(triggerWrites).toEqual([{ name: "Macro 13", value: 1 }]);
    expect(host.paramWrites[host.paramWrites.length - 1].name).toBe("Macro 13");

    expect(host.macroValue("Fade Type")).toBe(FadeType.FadeIn);
    expect(host.macroValue("Track Index")).toBe(0);
    const rangeEnd = decodeBeats(
      host.macroValue("Range End Hi"),
      host.macroValue("Range End Lo"),
    );
    expect(rangeEnd).toBeCloseTo(4, 9);
  });

  it("g: sends a fade-out payload from the selection to the clip end", async () => {
    await invoke(host, "pt-clip-shortcuts.fadeOut", 12, 12);
    expect(host.macroValue("Fade Type")).toBe(FadeType.FadeOut);
    const rangeStart = decodeBeats(
      host.macroValue("Range Start Hi"),
      host.macroValue("Range Start Lo"),
    );
    const rangeEnd = decodeBeats(
      host.macroValue("Range End Hi"),
      host.macroValue("Range End Lo"),
    );
    expect(rangeStart).toBeCloseTo(12, 9);
    expect(rangeEnd).toBeCloseTo(16, 9);
    expect(host.macroValue("Trigger")).toBe(1);
  });

  it("f: detects the clip junction and sends a crossfade payload", async () => {
    await invoke(host, "pt-clip-shortcuts.crossfade", 6, 10);
    expect(host.macroValue("Fade Type")).toBe(FadeType.Crossfade);
    const clipStartA = decodeBeats(
      host.macroValue("Clip Start Hi"),
      host.macroValue("Clip Start Lo"),
    );
    const clipStartB = decodeBeats(
      host.macroValue("Clip Start B Hi"),
      host.macroValue("Clip Start B Lo"),
    );
    expect(clipStartA).toBeCloseTo(0, 9);
    expect(clipStartB).toBeCloseTo(8, 9);
    expect(host.macroValue("Track Index B")).toBe(0);
  });

  it("gates every fade on PT Mode without touching the payload macros", async () => {
    host.setMacro("PT Mode", 0);
    await invoke(host, "pt-clip-shortcuts.fadeIn", 4, 4);
    expect(host.paramWrites).toEqual([]);
    expect(host.macroValue("Trigger")).toBe(0);
  });

  it("trims still work when the bridge rack is missing (pure SDK path)", async () => {
    // Fades need the rack; trims must not.
    const bare = makeHost();
    activate(bare.activation);
    await invoke(bare, "pt-clip-shortcuts.trimStart", 3, 3);
    expect(bare.clearCalls).toHaveLength(1);
  });
});

// -- the loopback endpoint, over a real socket --------------------------------

/** A bare http.get: no Origin header, exactly like [maxurl] and curl. */
function fetchJson(port: number, path: string) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    httpGet({ host: "127.0.0.1", port, path }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as Record<string, unknown> }),
      );
    }).on("error", reject);
  });
}

describe("loopback command endpoint", () => {
  let host: Host;
  let port: number;
  let address: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    host = makeHost();
    // Port 0 = an ephemeral port, so the suite never collides with a running Live.
    const { endpoint } = activate(host.activation, { endpointPort: 0 });
    const server = await endpoint!;
    if (!server) throw new Error("endpoint failed to bind");
    port = server.port;
    address = server.address;
    close = server.close;
  });

  afterEach(() => close());

  it("binds loopback only — nothing on the network may reach this", () => {
    // A LAN-reachable bind would report 0.0.0.0 here.
    expect(address).toBe("127.0.0.1");
    expect(port).toBeGreaterThan(0);
  });

  it("trims a clip start to the cursor, end to end", async () => {
    const res = await fetchJson(port, "/cmd?id=pt-clip-shortcuts.trimStart&track=0&time=2");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, track: "Audio 1", clip: "Take A", time: 2 });

    await new Promise((r) => setImmediate(r));
    expect(host.clearCalls).toEqual([{ track: host.trackHandle.id, start: 0, end: 2 }]);
  });

  it("trims a clip end to the cursor, end to end", async () => {
    const res = await fetchJson(port, "/cmd?id=pt-clip-shortcuts.trimEnd&track=0&time=6");
    expect(res.status).toBe(200);

    await new Promise((r) => setImmediate(r));
    expect(host.clearCalls).toEqual([{ track: host.trackHandle.id, start: 6, end: 8 }]);
  });

  it("accepts the LOM path the Max device sends", async () => {
    const res = await fetchJson(
      port,
      "/cmd?id=pt-clip-shortcuts.trimStart&path=live_set%20tracks%200&time=3",
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(host.clearCalls).toEqual([{ track: host.trackHandle.id, start: 0, end: 3 }]);
  });

  it("404s when the cursor sits past the last clip, changing nothing", async () => {
    const res = await fetchJson(port, "/cmd?id=pt-clip-shortcuts.trimStart&track=0&time=99");
    expect(res.status).toBe(404);
    await new Promise((r) => setImmediate(r));
    expect(host.clearCalls).toEqual([]);
  });

  it("reports an unregistered id distinctly from a missing clip", async () => {
    // The recipe from the spec: probe registration without executing by aiming
    // at a track that does not exist.
    const bad = await fetchJson(port, "/cmd?id=pt-clip-shortcuts.nope&track=99&time=4");
    expect(bad.body.error).toContain("unknown command id");
    const good = await fetchJson(port, "/cmd?id=pt-clip-shortcuts.trimStart&track=99&time=4");
    expect(good.body.error).toContain("no clip");
  });
});
