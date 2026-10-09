/**
 * Pro Tools-style clip editing shortcuts for Ableton Live.
 *
 *   a — trim clip start to selection      (pure SDK)
 *   s — trim clip end to selection        (pure SDK)
 *   d — fade in: clip start → selection   (via bridge rack)
 *   f — fade/crossfade over selection     (via bridge rack)
 *   g — fade out: selection → clip end    (via bridge rack)
 *
 * Every command is reachable two ways:
 *
 *   1. An arrangement-selection context menu action (Live passes the
 *      ArrangementSelection).
 *   2. A loopback HTTP endpoint (src/server/), which a Max for Live button
 *      calls with the selected track and the arrangement insert marker it
 *      reads from the LOM. That is what makes a keyboard shortcut possible:
 *      the SDK has no keybinding API, and Live's Key Map only targets
 *      on-screen controls, never menu items.
 *
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
import { isSelection, resolveSelection } from "./utils/selection.js";
import { createDispatcher } from "./server/dispatcher.js";
import {
  portFromEnv,
  startCommandEndpoint,
  type CommandEndpoint,
} from "./server/listener.js";

const EXT = "pt-clip-shortcuts";

export interface ActivateOptions {
  /**
   * Port for the loopback endpoint. `false` disables it entirely — tests want
   * the commands without a socket, and activating twice in one process would
   * otherwise collide on the port. Live never passes this.
   */
  endpointPort?: number | false | undefined;
  /** When set, endpoint requests must carry a matching `token=` param. */
  token?: string | undefined;
}

export interface ActivateResult {
  /** Null when the endpoint is disabled; resolves to null on a port conflict. */
  endpoint: Promise<CommandEndpoint | null> | null;
}

export function activate(
  activation: ActivationContext,
  options: ActivateOptions = {},
): ActivateResult {
  const context = initialize(activation, "1.0.0");
  const song = context.application.song;

  type FadeBuilder =
    | typeof buildFadeInPayloads
    | typeof buildFadeOutPayloads
    | typeof buildCrossfadePayloads;

  // Built as commands register, so the endpoint can validate an incoming id
  // against what actually exists rather than against a hand-kept list.
  const registered = new Set<string>();

  function registerSelectionCommand(
    commandId: string,
    handler: (selectionArg: unknown) => Promise<void>,
  ) {
    registered.add(commandId);
    context.commands.registerCommand(commandId, (...args: unknown[]) => {
      handler(args[0]).catch((error) => {
        console.error(`${commandId} failed:`, error);
      });
    });
  }

  registerSelectionCommand(`${EXT}.trimStart`, async (arg) => {
    if (!isSelection(arg)) return;
    const trimmed = await trimStartToSelection(context, resolveSelection(context, arg));
    console.log(`trimStart: trimmed ${trimmed} clip(s)`);
  });

  registerSelectionCommand(`${EXT}.trimEnd`, async (arg) => {
    if (!isSelection(arg)) return;
    const trimmed = await trimEndToSelection(context, resolveSelection(context, arg));
    console.log(`trimEnd: trimmed ${trimmed} clip(s)`);
  });

  function registerFadeCommand(commandId: string, build: FadeBuilder) {
    registerSelectionCommand(commandId, async (arg) => {
      if (!isSelection(arg)) return;
      const selection = resolveSelection(context, arg);
      let bridge: Bridge;
      try {
        bridge = Bridge.discover(song.mainTrack, (fn) => context.withinTransaction(fn));
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

  const dispatcher = createDispatcher(
    {
      application: { song },
      executeCommand: (id, selection) => context.commands.executeCommand(id, selection),
    },
    registered,
  );
  // A port conflict resolves to null and is only logged, so the context-menu
  // actions above stay usable either way.
  const endpoint =
    options.endpointPort === false
      ? null
      : startCommandEndpoint(dispatcher, {
          port: options.endpointPort ?? portFromEnv(process.env),
          token: options.token ?? process.env["PT_CLIP_TOKEN"] ?? undefined,
        });

  console.log(`${EXT} activated`);
  return { endpoint };
}
