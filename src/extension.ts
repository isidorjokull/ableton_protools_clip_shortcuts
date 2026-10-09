/**
 * Pro Tools-style clip editing shortcuts for Ableton Live.
 *
 *   a — trim clip start to selection      (pure SDK)
 *   s — trim clip end to selection        (pure SDK)
 *   d — fade in: clip start → selection   (via bridge rack)
 *   f — fade/crossfade over selection     (via bridge rack)
 *   g — fade out: selection → clip end    (via bridge rack)
 *
 * The commands are exposed as arrangement-selection context menu actions.
 * Fades are gated by the "PT Mode" toggle on the "PT Bridge" rack on the
 * Main track; a Python remote script applies the fades (state persists with the Set).
 */
import { ActivationContext, initialize } from "@ableton-extensions/sdk";
import {
  buildCrossfadePayloads,
  buildFadeInPayloads,
  buildFadeOutPayloads,
  sendPayloads,
} from "./commands/fades.js";
import { trimEndToSelection, trimStartToSelection } from "./commands/trim.js";
import { Bridge, BridgeNotFoundError } from "./bridge/bridge.js";
import { isArrangementSelection, resolveSelection } from "./utils/selection.js";

const EXT = "pt-clip-shortcuts";

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");
  const song = context.application.song;

  type FadeBuilder =
    | typeof buildFadeInPayloads
    | typeof buildFadeOutPayloads
    | typeof buildCrossfadePayloads;

  function registerSelectionCommand(
    commandId: string,
    handler: (selectionArg: unknown) => Promise<void>,
  ) {
    context.commands.registerCommand(commandId, (...args: unknown[]) => {
      handler(args[0]).catch((error) => {
        console.error(`${commandId} failed:`, error);
      });
    });
  }

  registerSelectionCommand(`${EXT}.trimStart`, async (arg) => {
    if (!isArrangementSelection(arg)) return;
    const trimmed = await trimStartToSelection(context, resolveSelection(context, arg));
    console.log(`trimStart: trimmed ${trimmed} clip(s)`);
  });

  registerSelectionCommand(`${EXT}.trimEnd`, async (arg) => {
    if (!isArrangementSelection(arg)) return;
    const trimmed = await trimEndToSelection(context, resolveSelection(context, arg));
    console.log(`trimEnd: trimmed ${trimmed} clip(s)`);
  });

  function registerFadeCommand(commandId: string, build: FadeBuilder) {
    registerSelectionCommand(commandId, async (arg) => {
      if (!isArrangementSelection(arg)) return;
      const selection = resolveSelection(context, arg);
      let bridge: Bridge;
      try {
        bridge = Bridge.discover(song.mainTrack);
      } catch (error) {
        if (error instanceof BridgeNotFoundError) {
          console.warn(error.message);
          return;
        }
        throw error;
      }
      if (!(await bridge.isPtModeOn())) {
        console.log("PT Mode is off — enable it on the PT Bridge device.");
        return;
      }
      const payloads = build(song.tracks, selection);
      if (payloads.length === 0) {
        console.log(`${commandId}: no audio clip at the selection`);
        return;
      }
      await sendPayloads(bridge, payloads);
      console.log(`${commandId}: sent ${payloads.length} fade payload(s) to PT Bridge`);
    });
  }

  registerFadeCommand(`${EXT}.fadeIn`, buildFadeInPayloads);
  registerFadeCommand(`${EXT}.fadeOut`, buildFadeOutPayloads);
  registerFadeCommand(`${EXT}.crossfade`, buildCrossfadePayloads);

  const actions: [string, string][] = [
    ["Pro Tools: Trim Clip Start to Selection (a)", `${EXT}.trimStart`],
    ["Pro Tools: Trim Clip End to Selection (s)", `${EXT}.trimEnd`],
    ["Pro Tools: Fade In to Selection (d)", `${EXT}.fadeIn`],
    ["Pro Tools: Fade over Selection (f)", `${EXT}.crossfade`],
    ["Pro Tools: Fade Out from Selection (g)", `${EXT}.fadeOut`],
  ];
  for (const scope of ["AudioTrack.ArrangementSelection", "MidiTrack.ArrangementSelection"] as const) {
    for (const [title, commandId] of actions) {
      context.ui.registerContextMenuAction(scope, title, commandId).catch((error) => {
        console.error(`Failed to register "${title}" in ${scope}:`, error);
      });
    }
  }

  console.log(`${EXT} activated`);
}
