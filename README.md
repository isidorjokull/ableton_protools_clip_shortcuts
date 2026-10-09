# Pro Tools-style Clip Shortcuts for Ableton Live

Pro Tools-style clip editing via the Ableton Extensions SDK (1.0.0-beta.0),
reachable both from the arrangement right-click menu and from a mappable
Max for Live button (so the actions can live on a key or a Stream Deck):

| Key | Action | Implementation |
| --- | ------ | -------------- |
| a | Trim clip start to selection | Extension (pure SDK) |
| s | Trim clip end to selection | Extension (pure SDK) |
| d | Fade in: clip start → selection | Bridge handshake |
| f | Fade / crossfade over selection | Bridge handshake |
| g | Fade out: selection → clip end | Bridge handshake |

## Triggering from a key: the trigger device

The SDK has no keybinding API, Live's Key Map only targets **on-screen
controls** (never menu items), and `Song` exposes no selection getter — so the
extension can neither be invoked by a key nor see what you selected. A Max for
Live device solves both at once: its `live.text` button *is* a mappable
on-screen control, and Max can read the Live Object Model.

```
key / Stream Deck  ──(Live Key Map / MIDI Map)──▶  [live.text button]
                                                         │
                             device/pt-trigger.js  ──▶  [js] reads the LOM:
                               live_set view selected_track  (which track)
                               live_set current_song_time    (the edit cursor)
                                                         │
                                       [maxurl] GET http://127.0.0.1:17818/cmd
                                                         ▼
                                    extension's loopback endpoint (src/server/)
                                      → executeCommand(id, {pt_track, pt_time})
```

That is the Pro Tools model exactly: the **selected track** picks the clip, the
**edit cursor** picks the trim point.

### Why the buttons are toggles (`mode: 1`)

Counter-intuitive, and the opposite of what a momentary button looks like it
should be. **Live's Key Map does not send a momentary press** — it flips the
button's two-state parameter, so consecutive presses arrive as 1, 0, 1, 0…
(`parameter_type: 1` is *Int*, not Enum — the type order in
`parameters.maxref.xml` is Float, Int, Enum, Blob — so with `parameter_mmax: 1`
each button is an Int 0..1 value that Live latches.)

In `mode: 0` (button) `live.text` emits only the transition to non-zero, so the
1→0 press produced **no output at all**: the shortcut fired every *other* press
and the button sat lit at 1, looking stuck. `mode: 1` (toggle) is documented in
`live.text.maxref.xml` to emit on both edges, so `pt-trigger.js` fires on any
value and then pushes `set 0` back into the button to clear the latch — `set`
"toggles the state without sending output", so it cannot re-enter the script.
Firing does not depend on that reset landing: if it doesn't, the next press
just arrives as a 0 and fires anyway.

`tests/trigger.test.ts` pins this by running the script in a vm sandbox with
fake Max globals and asserting a 1, 0, 1 sequence produces three requests.

### Endpoint

```
GET /cmd?id=<commandId>&track=<n>&time=<beats>
GET /cmd?id=<commandId>&path=live_set%20tracks%20<n>&time=<beats>
```

| Status | Meaning |
| --- | --- |
| `200 {ok:true,…}` | Dispatched; body names the track and clip |
| `400` | Unknown command id, or unparseable track/time |
| `403` | `Origin` header present, or bad token |
| `404` | Unknown endpoint, or no clip under the cursor |
| `409 {error:"busy"}` | Single-flight guard (a held-down key) |
| `500` | The command threw |

Bound to `127.0.0.1` only, and a port conflict is never fatal — it logs and the
context-menu actions keep working. `PT_CLIP_PORT` overrides the port (17818 by
default; the CDP extension uses 17817). Any request carrying an `Origin` header
is refused, which blocks a web page the user happens to visit from driving it.
The set of dispatchable ids is built as commands register, so an unregistered
string never reaches `executeCommand`.

Test it without Max — this is the single most useful check, because if curl
works and the button doesn't, the fault is in the patch:

```bash
curl -s "http://127.0.0.1:17818/cmd?id=pt-clip-shortcuts.trimStart&track=0&time=4"
lsof -nP -iTCP:17818 -sTCP:LISTEN     # must show 127.0.0.1, never *
```

## Architecture: why there are four pieces

The Extensions SDK cannot touch clip gain, fades, or automation. The Max for
Live LOM can't either — it has no `AutomationEnvelope` class, so an M4L device
can *clear* clip automation but never create it (this invalidated the original
M4L plan in `PLAN.md`). The only Live API that can write clip automation is
the **Python Remote Script API** (what Push uses), so fades are delegated to a
remote script through a parameter handshake:

```
right-click in Arrangement → context menu action
  → extension (this repo, dist/extension.js)
     a/s: Track.clearClipsInRange()             — done, pure SDK
     d/f/g: write payload into the macros of an
            Audio Effect Rack "PT Bridge" on the
            Main track, then bump the Trigger macro
       → PTBridge remote script observes Trigger
          → resolves clip via (track index, clip start beats)
          → writes a volume-automation ramp into the clip
```

The handshake protocol lives in `src/bridge/protocol.ts` and is mirrored by
`remote_script/PTBridge/pt_bridge.py`. Rack macros are clamped to 0..127, so
beat positions are hi/lo split (`beats = hi * 128 + lo`); the Trigger macro is
a wrapping counter and always the **last** write, so the script never sees a
half-written payload.

## Setup

0. **SDK (building from source only)** — the Ableton Extensions SDK beta is not
   bundled in this repo. Download `extensions-sdk-1.0.0-beta.0` from Ableton and
   unpack it into the repo root (`package.json` installs the SDK and CLI from the
   `.tgz` files inside it), then run `npm install`. Not needed if you just use the
   prebuilt `.ablx`.
1. **Extension** — either:
   - drop `pt-clip-shortcuts-1.0.0.ablx` onto Live's Settings → Extensions
     page, or
   - enable Developer Mode there and run `npm start` in this repo (needs
     `.env` with `EXTENSION_HOST_PATH`, already written for Live 12 Beta).
2. **Bridge rack** — add an empty **Audio Effect Rack** to the **Main track**,
   rename the device to exactly `PT Bridge`, and make sure it has 16 macros
   (⌘-click the macro count buttons). No macro renaming needed — slots are
   resolved by position/factory names. Macro 1 is the **PT Mode** toggle:
   fades only fire while it's ≥ 64.
3. **Remote script** — `remote_script/PTBridge/` is installed to
   `~/Music/Ableton/User Library/Remote Scripts/PTBridge`. Select **PTBridge**
   as a Control Surface in Settings → Link/Tempo/MIDI (input/output: None).
4. **Trigger device** (only needed for keyboard/Stream Deck triggering) — copy
   **both** `device/pt-clip-shortcuts.amxd` and `device/pt-trigger.js` into the
   same folder (e.g. `~/Music/Ableton/User Library/Presets/Audio Effects/Max
   Audio Effect/`); `js` finds the script in the device's own folder. Drop the
   device on any track, then use Live's **Key Map** (or MIDI Map for a Stream
   Deck) on its *Trim Start* / *Trim End* buttons. Run `npm run device` to
   rebuild it.

## Development

```
npm run build:dev   # typecheck + dev bundle
npm test            # vitest — protocol, bridge, and fake-host e2e tests
npm start           # run against Live (Developer Mode must be on)
npm run package     # produce the .ablx
npm run device      # rebuild + lint device/pt-clip-shortcuts.amxd
```

`tests/extension.test.ts` drives the real SDK and the real `activate()`
against a fake Extension Host, covering the full handshake end to end — and
the loopback endpoint over a real socket on an ephemeral port.
`tests/endpoint.test.ts` covers the request contract, including the fact that
`URL` is **not a global** in the Extension Host (`new URL(...)` throws there,
so `src/server/endpoint.ts` imports it from `"url"`).

`npm run device` regenerates the `.amxd` and lints the patcher: Max silently
drops a patchline that references a missing box or an out-of-range port, so the
build asserts every line, `mode: 0` on each button, unique
`parameter_longname`s, no `parameter_initial_enable`, and that each button
connects **directly** to its `js` object (a value filter would swallow the
button's bang).

Extension logs appear in Live's `Preferences/.../ExtensionHost.txt`; remote
script logs (`PTBridge: …`) in `Log.txt` next to it.

## Known limitations

- Fades are volume-automation ramps inside the clip, not Live's native clip
  fade handles (those aren't exposed by any scripting API). They move with
  the clip and are fully undoable.
- Undo: a trim (a/s) is one undo step, even across several tracks. A fade
  (d/f/g) is two per track: first the fade ramp, then the PT Bridge macro
  writes that carried it (inaudible). Press Cmd+Z twice to fully revert a
  fade.
- MIDI clips: trims work; fades are skipped (no meaningful gain to automate).
- The `f` crossfade needs a clip junction inside the time selection; with a
  selection inside a single clip it falls back to fading the touched edge.
- Keyboard keys a/s/d/f/g can't be bound directly by the SDK (no keyboard
  API in 1.0.0) — bind them to the trigger device's buttons via Live's Key Map.
- Trims are **inward only**: they shorten a clip to the cursor. Extending a
  clip boundary outward is not possible — `Clip.startTime` / `startMarker` are
  getters, and `Track` offers only `clearClipsInRange` / `deleteClip`.
- The endpoint targets **one** track (Live's LOM exposes a single
  `selected_track`), whereas the context menu trims every selected lane.
- Anything interactive must be tested from a **packaged install**: under the
  SDK beta, `extensions-cli run` tears the host down on a ~10s deadline.
