# Pro Tools-style Clip Shortcuts for Ableton Live

Pro Tools-style clip editing, exposed as arrangement context menu actions via
the Ableton Extensions SDK (1.0.0-beta.0):

| Key | Action | Implementation |
| --- | ------ | -------------- |
| a | Trim clip start to selection | Extension (pure SDK) |
| s | Trim clip end to selection | Extension (pure SDK) |
| d | Fade in: clip start → selection | Bridge handshake |
| f | Fade / crossfade over selection | Bridge handshake |
| g | Fade out: selection → clip end | Bridge handshake |

## Architecture: why there are three pieces

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

## Development

```
npm run build:dev   # typecheck + dev bundle
npm test            # vitest — protocol, bridge, and fake-host e2e tests
npm start           # run against Live (Developer Mode must be on)
npm run package     # produce the .ablx
```

`tests/extension.test.ts` drives the real SDK and the real `activate()`
against a fake Extension Host, covering the full handshake end to end.

Extension logs appear in Live's `Preferences/.../ExtensionHost.txt`; remote
script logs (`PTBridge: …`) in `Log.txt` next to it.

## Known limitations

- Fades are volume-automation ramps inside the clip, not Live's native clip
  fade handles (those aren't exposed by any scripting API). They move with
  the clip and are fully undoable.
- MIDI clips: trims work; fades are skipped (no meaningful gain to automate).
- The `f` crossfade needs a clip junction inside the time selection; with a
  selection inside a single clip it falls back to fading the touched edge.
- Keyboard keys a/s/d/f/g can't be bound directly by the SDK (no keyboard
  API in 1.0.0) — actions live in the arrangement right-click menu instead.
