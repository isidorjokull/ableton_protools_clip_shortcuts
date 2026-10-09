/**
 * The SDK ↔ companion handshake protocol.
 *
 * The SDK cannot touch clip gain or fades, and the Max for Live LOM cannot
 * *create* automation envelopes either (it only exposes clear_envelope /
 * clear_all_envelopes — there is no AutomationEnvelope class in the M4L API).
 * The only Live API that can write clip fades/automation is the Python Remote
 * Script API, so the companion is a Remote Script ("PTBridge").
 *
 * The shared, writable surface between the SDK and the script is a device's
 * parameters. The bridge device is a plain Audio Effect Rack named "PT Bridge"
 * on the Main track: its macros are DeviceParameters the SDK can write and the
 * script can observe. The payload is spread across macros and committed by
 * bumping a trigger counter — the script reacts to the trigger change, reads
 * the other macros, and performs the fade through the full Live API.
 *
 * Rack macros have a fixed 0..127 range, so beat positions are split into a
 * hi/lo macro pair: beats = hi * 128 + lo, with the fraction carried by lo.
 *
 * Clips are identified by (track index, clip start time in beats): SDK handles
 * are opaque host IDs with no meaning to the Python side, but a track index +
 * arrangement start time resolves unambiguously in both APIs.
 */

/** Name of the bridge rack the SDK looks for on the Main track. */
export const BRIDGE_DEVICE_NAME = "PT Bridge";

/** Rack macros run 0..127. */
export const MACRO_MAX = 127;

/** Base for the hi/lo beat-time encoding (hi counts blocks of 128 beats). */
export const BEAT_BASE = 128;

/** Largest encodable beat position: hi and lo must each fit in 0..127. */
export const MAX_BEATS = MACRO_MAX * BEAT_BASE + MACRO_MAX;

export enum FadeType {
  FadeIn = 0,
  FadeOut = 1,
  Crossfade = 2,
}

/**
 * Protocol slots in macro order. Slot i lives on rack macro i+1 (the rack's
 * parameter 0 is "Device On"). Names are what a user would rename the macros
 * to; discovery falls back to default "Macro N" names and then to parameter
 * position, so renaming is optional.
 */
export const SLOTS = [
  "PT Mode", //        0: 0..127 toggle — < 64 disables every fade shortcut
  "Fade Type", //      1: FadeType discriminator
  "Track Index", //    2: index of the (first) clip's track within Song.tracks
  "Clip Start Hi", //  3: clip arrangement start, hi block
  "Clip Start Lo", //  4: clip arrangement start, lo + fraction
  "Range Start Hi", // 5: fade range start
  "Range Start Lo", // 6
  "Range End Hi", //   7: fade range end
  "Range End Lo", //   8
  "Track Index B", //  9: crossfade incoming clip's track (127 = unused)
  "Clip Start B Hi", //10: crossfade incoming clip start
  "Clip Start B Lo", //11
  "Trigger", //       12: commit counter — SDK bumps it after writing 0..11
] as const;

export type SlotName = (typeof SLOTS)[number];

export const SLOT = Object.fromEntries(SLOTS.map((name, i) => [name, i])) as Record<
  SlotName,
  number
>;

/** Sentinel for "no second clip" in the Track Index B slot. */
export const NO_TRACK_B = MACRO_MAX;

/** The trigger counter wraps within the macro range. */
export const TRIGGER_MODULO = MACRO_MAX + 1;

export interface FadePayload {
  fadeType: FadeType;
  trackIndex: number;
  clipStart: number;
  rangeStart: number;
  rangeEnd: number;
  /** Crossfade only. */
  trackIndexB?: number;
  /** Crossfade only. */
  clipStartB?: number;
}

/** Minimal shape of an SDK DeviceParameter, kept abstract for testing. */
export interface ParamLike {
  readonly name: string;
  getValue(): Promise<number>;
  setValue(value: number): Promise<void>;
}

/** Splits a beat position into the (hi, lo) macro pair. */
export function encodeBeats(beats: number): [number, number] {
  if (beats < 0 || beats > MAX_BEATS) {
    throw new RangeError(
      `Beat position ${beats} outside the encodable range 0..${MAX_BEATS}`,
    );
  }
  const hi = Math.floor(beats / BEAT_BASE);
  return [hi, beats - hi * BEAT_BASE];
}

/** Inverse of encodeBeats — the Python side mirrors this. */
export function decodeBeats(hi: number, lo: number): number {
  return Math.round(hi) * BEAT_BASE + lo;
}

/**
 * Orders the payload as (slot, value) writes. The Trigger slot is
 * intentionally absent — it must be written last, by the bridge.
 */
export function payloadWrites(payload: FadePayload): [SlotName, number][] {
  const [clipHi, clipLo] = encodeBeats(payload.clipStart);
  const [startHi, startLo] = encodeBeats(payload.rangeStart);
  const [endHi, endLo] = encodeBeats(payload.rangeEnd);
  const [bHi, bLo] = encodeBeats(payload.clipStartB ?? 0);
  return [
    ["Fade Type", payload.fadeType],
    ["Track Index", payload.trackIndex],
    ["Clip Start Hi", clipHi],
    ["Clip Start Lo", clipLo],
    ["Range Start Hi", startHi],
    ["Range Start Lo", startLo],
    ["Range End Hi", endHi],
    ["Range End Lo", endLo],
    ["Track Index B", payload.trackIndexB ?? NO_TRACK_B],
    ["Clip Start B Hi", bHi],
    ["Clip Start B Lo", bLo],
  ];
}

/** Next trigger value after `current`, wrapping within [0, TRIGGER_MODULO). */
export function nextTrigger(current: number): number {
  return (Math.round(current) + 1) % TRIGGER_MODULO;
}
