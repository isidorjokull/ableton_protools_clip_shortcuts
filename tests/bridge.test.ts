/**
 * Handshake tests: run the SDK-side bridge against a fake rack device and
 * assert the exact wire behavior the Python remote script depends on.
 */
import { describe, expect, it } from "vitest";
import {
  Bridge,
  BridgeNotFoundError,
  BridgeParamError,
  DeviceLike,
  mapSlots,
} from "../src/bridge/bridge.js";
import {
  BRIDGE_DEVICE_NAME,
  FadeType,
  MACRO_MAX,
  MAX_BEATS,
  NO_TRACK_B,
  SLOTS,
  TRIGGER_MODULO,
  decodeBeats,
  encodeBeats,
  nextTrigger,
} from "../src/bridge/protocol.js";

class FakeParam {
  writes: number[] = [];
  constructor(
    readonly name: string,
    public value = 0,
    /** Test hook: log of (paramName, value) in global write order. */
    private log?: [string, number][],
  ) {}
  async getValue(): Promise<number> {
    return this.value;
  }
  async setValue(value: number): Promise<void> {
    // Simulate the host confirming asynchronously, like the real Extension Host.
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.value = value;
    this.writes.push(value);
    this.log?.push([this.name, value]);
  }
}

/** A 16-macro Audio Effect Rack with factory parameter names. */
function fakeRack(overrides: { name?: string; macros?: number; ptMode?: number } = {}) {
  const log: [string, number][] = [];
  const params = [new FakeParam("Device On", 1, log)];
  for (let i = 1; i <= (overrides.macros ?? 16); i++) {
    params.push(new FakeParam(`Macro ${i}`, 0, log));
  }
  // Macro 1 is the PT Mode slot; default it to "on".
  params[1].value = overrides.ptMode ?? MACRO_MAX;
  const device: DeviceLike = {
    name: overrides.name ?? BRIDGE_DEVICE_NAME,
    parameters: params,
  };
  return { device, params, log };
}

/** Reads a slot's last written value from the write log. */
function slotValue(log: [string, number][], slot: (typeof SLOTS)[number]): number | undefined {
  const macroName = `Macro ${SLOTS.indexOf(slot) + 1}`;
  return Object.fromEntries(log)[macroName];
}

const payload = {
  fadeType: FadeType.FadeIn,
  trackIndex: 3,
  clipStart: 16,
  rangeStart: 16,
  rangeEnd: 20.5,
};

describe("beat-time hi/lo encoding", () => {
  it("round-trips whole and fractional beat positions", () => {
    for (const beats of [0, 1, 127.999, 128, 500.25, 16000.125, MAX_BEATS]) {
      const [hi, lo] = encodeBeats(beats);
      expect(hi).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(MACRO_MAX);
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(lo).toBeLessThan(128.0001);
      expect(decodeBeats(hi, lo)).toBeCloseTo(beats, 9);
    }
  });

  it("rejects positions outside the encodable range", () => {
    expect(() => encodeBeats(-1)).toThrow(RangeError);
    expect(() => encodeBeats(MAX_BEATS + 1)).toThrow(RangeError);
  });

  it("survives a slightly denormalised hi value coming back from Live", () => {
    expect(decodeBeats(3.0000002, 4.5)).toBeCloseTo(3 * 128 + 4.5, 9);
  });
});

describe("Bridge.discover", () => {
  it("finds the rack by name among other devices", () => {
    const { device } = fakeRack();
    const decoy: DeviceLike = { name: "EQ Eight", parameters: [] };
    expect(() => Bridge.discover({ devices: [decoy, device] })).not.toThrow();
  });

  it("throws BridgeNotFoundError when the rack is absent", () => {
    expect(() => Bridge.discover({ devices: [] })).toThrow(BridgeNotFoundError);
  });

  it("throws BridgeParamError when the rack has too few macros", () => {
    const { device } = fakeRack({ macros: 8 });
    expect(() => Bridge.discover({ devices: [device] })).toThrow(BridgeParamError);
  });
});

describe("mapSlots", () => {
  it("prefers macros renamed to the protocol slot names", () => {
    const params = [
      new FakeParam("Device On"),
      // Renamed macros, deliberately shuffled so position cannot match.
      ...[...SLOTS].reverse().map((slot) => new FakeParam(slot)),
    ];
    const slots = mapSlots(params);
    expect(slots.get("Trigger")!.name).toBe("Trigger");
    expect(slots.get("PT Mode")!.name).toBe("PT Mode");
  });

  it("falls back to factory macro names in slot order", () => {
    const { device } = fakeRack();
    const slots = mapSlots(device.parameters);
    expect(slots.get("PT Mode")!.name).toBe("Macro 1");
    expect(slots.get("Trigger")!.name).toBe("Macro 13");
  });

  it("falls back to parameter position for unrecognised names", () => {
    const params = [
      new FakeParam("Device On"),
      ...SLOTS.map((_, i) => new FakeParam(`Weird ${i}`)),
    ];
    const slots = mapSlots(params);
    expect(slots.get("PT Mode")!.name).toBe("Weird 0");
    expect(slots.get("Trigger")!.name).toBe(`Weird ${SLOTS.length - 1}`);
  });
});

describe("PT Mode gate", () => {
  it("reports on/off from the macro value", async () => {
    const on = Bridge.discover({ devices: [fakeRack({ ptMode: MACRO_MAX }).device] });
    const off = Bridge.discover({ devices: [fakeRack({ ptMode: 0 }).device] });
    expect(await on.isPtModeOn()).toBe(true);
    expect(await off.isPtModeOn()).toBe(false);
  });
});

describe("sendFade handshake", () => {
  it("writes every payload macro and bumps the trigger last", async () => {
    const { device, log } = fakeRack();
    const bridge = Bridge.discover({ devices: [device] });

    await bridge.sendFade(payload);

    const triggerMacro = `Macro ${SLOTS.indexOf("Trigger") + 1}`;
    const names = log.map(([name]) => name);
    // Trigger must be the very last write — the Python script reads the other
    // macros when the trigger changes, so an early trigger races the payload.
    expect(names[names.length - 1]).toBe(triggerMacro);
    expect(names.slice(0, -1)).not.toContain(triggerMacro);

    expect(slotValue(log, "Fade Type")).toBe(FadeType.FadeIn);
    expect(slotValue(log, "Track Index")).toBe(3);
    const clipStart = decodeBeats(slotValue(log, "Clip Start Hi")!, slotValue(log, "Clip Start Lo")!);
    const rangeEnd = decodeBeats(slotValue(log, "Range End Hi")!, slotValue(log, "Range End Lo")!);
    expect(clipStart).toBeCloseTo(16, 9);
    expect(rangeEnd).toBeCloseTo(20.5, 9);
    expect(slotValue(log, "Track Index B")).toBe(NO_TRACK_B); // unused for a plain fade
  });

  it("increments the trigger on every send so back-to-back fades all fire", async () => {
    const { device, params } = fakeRack();
    const bridge = Bridge.discover({ devices: [device] });
    const trigger = params[SLOTS.indexOf("Trigger") + 1];

    await bridge.sendFade(payload);
    await bridge.sendFade(payload);
    await bridge.sendFade(payload);

    expect(trigger.writes).toEqual([1, 2, 3]);
  });

  it("issues every macro write inside a single transaction", async () => {
    const { device, log } = fakeRack();
    let transactions = 0;
    let writesAtOpen = -1;
    const bridge = Bridge.discover({ devices: [device] }, (fn) => {
      transactions++;
      writesAtOpen = log.length;
      return fn();
    });

    await bridge.sendFade(payload);

    // One undo step for the whole payload, opened before any write landed.
    expect(transactions).toBe(1);
    expect(writesAtOpen).toBe(0);
    expect(log.length).toBe(SLOTS.length - 1); // every slot except read-only PT Mode
  });

  it("wraps the trigger counter within the macro range", () => {
    expect(nextTrigger(TRIGGER_MODULO - 1)).toBe(0);
    expect(nextTrigger(0)).toBe(1);
    // Live may return a slightly denormalised float for an int-style macro.
    expect(nextTrigger(41.0000001)).toBe(42);
  });

  it("carries both clips for a crossfade", async () => {
    const { device, log } = fakeRack();
    const bridge = Bridge.discover({ devices: [device] });
    await bridge.sendFade({
      fadeType: FadeType.Crossfade,
      trackIndex: 2,
      clipStart: 8,
      rangeStart: 15,
      rangeEnd: 17,
      trackIndexB: 2,
      clipStartB: 16,
    });
    expect(slotValue(log, "Fade Type")).toBe(FadeType.Crossfade);
    expect(slotValue(log, "Track Index B")).toBe(2);
    const clipStartB = decodeBeats(
      slotValue(log, "Clip Start B Hi")!,
      slotValue(log, "Clip Start B Lo")!,
    );
    expect(clipStartB).toBeCloseTo(16, 9);
  });
});
