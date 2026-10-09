/**
 * SDK side of the handshake: discovers the "PT Bridge" rack on the Main track,
 * gates on its "PT Mode" macro, and commits fade payloads to its macros.
 */
import {
  BRIDGE_DEVICE_NAME,
  FadePayload,
  MACRO_MAX,
  ParamLike,
  SLOT,
  SLOTS,
  SlotName,
  nextTrigger,
  payloadWrites,
} from "./protocol.js";

/** Minimal shape of an SDK Device, kept abstract for testing. */
export interface DeviceLike {
  readonly name: string;
  readonly parameters: ParamLike[];
}

export interface TrackLike {
  readonly devices: DeviceLike[];
}

export class BridgeNotFoundError extends Error {
  constructor() {
    super(
      `Bridge device "${BRIDGE_DEVICE_NAME}" not found on the Main track. ` +
        `Add an Audio Effect Rack there, name it "${BRIDGE_DEVICE_NAME}", ` +
        `and give it 16 macros.`,
    );
  }
}

export class BridgeParamError extends Error {
  constructor(detail: string) {
    super(`Bridge device "${BRIDGE_DEVICE_NAME}": ${detail}`);
  }
}

/**
 * Maps protocol slots onto the rack's parameters. Tries, in order:
 * 1. macros renamed to the protocol slot names ("PT Mode", "Trigger", …),
 * 2. default macro names ("Macro 1" … "Macro 13"),
 * 3. parameter position (parameter 0 is "Device On", so slot i → param i+1).
 */
export function mapSlots(parameters: ParamLike[]): Map<SlotName, ParamLike> {
  const byName = new Map(parameters.map((p) => [p.name, p]));

  const named = new Map<SlotName, ParamLike>();
  for (const slot of SLOTS) {
    const param = byName.get(slot);
    if (param) {
      named.set(slot, param);
    }
  }
  if (named.size === SLOTS.length) {
    return named;
  }

  const byMacro = new Map<SlotName, ParamLike>();
  for (const slot of SLOTS) {
    const param = byName.get(`Macro ${SLOT[slot] + 1}`);
    if (param) {
      byMacro.set(slot, param);
    }
  }
  if (byMacro.size === SLOTS.length) {
    return byMacro;
  }

  if (parameters.length >= SLOTS.length + 1) {
    return new Map(SLOTS.map((slot) => [slot, parameters[SLOT[slot] + 1]]));
  }

  throw new BridgeParamError(
    `expected ${SLOTS.length} macros (found ${parameters.length - 1} parameters); ` +
      `use a 16-macro Audio Effect Rack`,
  );
}

/** Same contract as the SDK's `withinTransaction`: synchronous callback. */
export type Transact = <T>(fn: () => T) => T;

export class Bridge {
  private constructor(
    private slots: Map<SlotName, ParamLike>,
    private transact: Transact,
  ) {}

  /**
   * Finds the bridge rack on the given (Main) track and maps its macros.
   * Discovery runs fresh per command rather than being cached at activation:
   * the user can add or remove the rack at any time, and stale handles throw
   * once the underlying device is deleted.
   *
   * `transact` groups writes into one undo step; pass the SDK's
   * `withinTransaction`. The default runs writes ungrouped.
   */
  static discover(mainTrack: TrackLike, transact: Transact = (fn) => fn()): Bridge {
    const device = mainTrack.devices.find((d) => d.name === BRIDGE_DEVICE_NAME);
    if (!device) {
      throw new BridgeNotFoundError();
    }
    return new Bridge(mapSlots(device.parameters), transact);
  }

  private param(slot: SlotName): ParamLike {
    const param = this.slots.get(slot);
    if (!param) {
      throw new BridgeParamError(`missing macro for slot "${slot}"`);
    }
    return param;
  }

  /** Reads the "PT Mode" macro — off means all fade shortcuts no-op. */
  async isPtModeOn(): Promise<boolean> {
    const value = await this.param("PT Mode").getValue();
    return value >= MACRO_MAX / 2;
  }

  /**
   * The handshake commit: write every payload macro, then bump the trigger
   * counter, all inside one transaction so the macro writes cost the user a
   * single undo step instead of one per macro.
   *
   * A transaction callback can't await, so the trigger is read up front and
   * the writes are issued synchronously in order with the trigger last. The
   * host applies them in call order, and the Python script defers its read by
   * a scheduler tick, so it never observes a half-written payload.
   */
  async sendFade(payload: FadePayload): Promise<void> {
    const trigger = this.param("Trigger");
    const next = nextTrigger(await trigger.getValue());
    const writes: [ParamLike, number][] = payloadWrites(payload).map(
      ([slot, value]) => [this.param(slot), value],
    );
    writes.push([trigger, next]);
    await this.transact(() => Promise.all(writes.map(([param, value]) => param.setValue(value))));
  }
}
