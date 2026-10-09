# Plan: Pro Tools-style Clip Editing Shortcuts for Ableton Live

> **Revision (2026-07-05) — implemented, with one architecture change.**
> The M4L companion (Phases 2–4 as written) is unbuildable: the M4L LOM has no
> `AutomationEnvelope` class and no clip fade properties, so an M4L device can
> clear clip automation but never create it. The companion is instead a
> **Python Remote Script** (`remote_script/PTBridge/`) — the only Live API that
> can write clip automation — plus a plain **Audio Effect Rack named
> "PT Bridge"** on the Main track whose macros carry the handshake payload
> (macros are 0..127, so beat times are hi/lo encoded). Also corrected from the
> SDK's actual surface: `Song.mainTrack` (not `masterTrack`); there is no
> `Clip.id`, so clips are identified by (track index, arrangement start time).
> The handshake protocol itself is unchanged: write payload params, then bump a
> wrapping Trigger counter last. See README.md for the current architecture.

## Goal

Build keyboard-driven clip editing shortcuts for Ableton Live via the Extensions SDK v1.0.0-beta.0, with an M4L companion device on the master channel for fade operations that the SDK cannot perform directly.

## Architecture

```
User right-clicks in Arrangement
  → SDK extension (context menu command)
    → a/s: pure SDK via Track.clearClipsInRange()
    → d/f/g: DeviceParameter.setValue() on M4L device
      → M4L device (on Master Channel) observes param change
        → full LOM access via live.object/live.set
          → clip.gain envelope manipulation
```

## Constraint
- **Toggle mode (Toggle between normal shortcuts and Pro Tools shortcuts):** To avoid clashing with Live's existing preset shortcuts, all Pro Tools shortcut actions will be toggleable. The toggle state will be stored in the user's M4L device (a "PT Mode" toggle parameter). When PT Mode is OFF, the SDK will simply ignore the right-click context menu commands (or present a "PT Mode is off" message). This allows the user to toggle between normal Live shortcuts and Pro Tools shortcuts without restarting Live. The toggle state persists with the Live set (since it lives on the M4L device).

## Key Insight
- M4L device lives on **Master Channel** — one device, any clip, keeps it simple
- SDK discovers M4L device by name on `Song.masterTrack.devices`
- Fade payload: clip UID + time range → M4L translates to LOM calls

## Phases

### Phase 1: Scaffold + a/s trimming (pure SDK)

**1a — Project scaffold**
- `manifest.json` — extension metadata, command IDs
- `tsconfig.json` — TypeScript config targeting ES2020
- `build.ts` — esbuild bundler config (TypeScript → CJS → single `dist/extension.js`)
- `src/extension.ts` — entry point with `activate()`

**1b — `a` command (trim clip start to selection)**
- Find all clips whose time range contains the selection start point
- Call `Track.clearClipsInRange(clipStart, selectionStart)` to trim
- Invert the operation: `clearClipsInRange(selectionStart, clipEnd)` to remove content *after* the selection start (i.e., trim the clip start to the selection)
- Wait — need to think about this. `clearClipsInRange` removes content within the range. To trim the clip *start* to the selection, we want to keep only the part from selection to clip end. That means removing content from clip start to selection start. So: `clearClipsInRange(selectionStart, clipEnd)` removes content *after* selection, keeping only content before selection. No, we want the opposite.
- Let me re-read `clearClipsInRange` behavior...

Actually, `clearClipsInRange(start, end)` removes content from clips that overlap the range. It doesn't remove the clips — it clears the time range within clips. So:
- **a (clip start → selection):** We want to remove content from clip start to selection start. That's `clearClipsInRange(clipStart, selectionStart)` which removes the portion from clip start to selection start. This effectively trims the clip start to the selection point.
- **s (selection → clip end):** Remove content from selection end to clip end. That's `clearClipsInRange(selectionEnd, clipEnd)`.

- Find clips containing the selection point by iterating tracks and checking clip start/end times
- Wrap in `withinTransaction` for undo support

**1c — `s` command (trim clip end to selection)**
- Find clips containing the selection end point
- Call `clearClipsInRange(selectionEnd, clipEnd)`
- Same pattern as `a`

**1d — Context menu registration**
- Register both commands under:
  - `AudioTrack.ArrangementSelection`
  - `MidiTrack.ArrangementSelection`
- Labels: "Pro Tools: Trim Clip Start to Selection (a)" / "Pro Tools: Trim Clip End to Selection (s)"

**1e — Toggle integration**
- Even before M4L is built, add a `getPTModeState()` stub that always returns `true`
- This makes the toggle architecture easy to add later

### Phase 2: M4L bridge protocol

**2a — Define parameter mapping**
- M4L device exposes 4 parameters:
  - `PT_Mode` (0/1 toggle) — enables/disables all handlers
  - `Fade_In_Param` — composite float: encodes clip_uid + start_time + end_time
  - `Fade_Out_Param` — same format
  - `Crossfade_Param` — same format
- Encoding: since DeviceParameter is a float 0.0–1.0, we need a strategy. Float64 gives ~53 bits of precision. We can pack: clip_uid (32 bits) + start_time (fixed-point, 16 bits) + end_time (fixed-point, 16 bits) into a 64-bit float. Or simpler: use an integer-like scale (0 to 127 or 0 to 65535) for rapid parameter updates.

Better approach: Use multiple parameters to avoid precision loss:
  - `Fade_ClipUID` (int-like float)
  - `Fade_StartBeat` (float)
  - `Fade_EndBeat` (float)
  - `Fade_Trigger` (0→1 pulse triggers the fade)
  
This way, SDK writes all params, then sets trigger → M4L reads and executes.

**2b — Payload format**
- Clip UID: SDK exposes `Clip.id` (a string) — may need to map to LOM clip IDs
- We'll pass `Clip.id` from SDK → M4L, and M4L uses `live.object` to find the matching clip
- Time range: beats (float), matching Live's time representation

**2c — Protocol flow**
1. SDK iterates tracks → finds clips at selection → builds payload
2. SDK writes `Fade_ClipUID`, `Fade_StartBeat`, `Fade_EndBeat` to M4L device
3. SDK sets `Fade_Trigger = 1`, waits one frame, sets `Fade_Trigger = 0`
4. M4L's `live.observer` on trigger fires → reads the other params
5. M4L uses `live.object` `set("clip.gain", ...)` or gain envelope to create fade

### Phase 3: M4L companion device

**3a — Max patcher skeleton (`.amxd`)**
- `live.observer` on each SDK parameter
- Trigger detection (rising edge: 0→1)
- Param reading and decoding

**3b — Fade-in implementation (`d`)**
- Given clip ID and time range (clip start → selection point)
- `live.object` on that clip → `set("gain_envelope", ...)` or manipulate `clip.gain`
- Fade shape: linear ramp or equal-power curve

**3c — Fade-out implementation (`g`)**
- Time range: selection point → clip end
- Same gain manipulation, reversed curve

**3d — Crossfade implementation (`f`)**
- Overlapping clip case: two clips on different tracks (or same track, overlapping)
- Adjust gain on both clips
- Crossfade curve option: equal-power

### Phase 4: Wire SDK d/f/g

**4a — Device discovery**
- On activate, iterate `Song.masterTrack.devices` → find device by name (e.g., "PT Mode")
- Cache device reference + parameter references

**4b — `d` command handler**
- Find clip at selection → compute `Fade_ClipUID`, `Fade_StartBeat`, `Fade_EndBeat`
- Write params to M4L device → trigger

**4c — `f` command handler**
- Find overlapping clips at selection bounds
- Write both clip IDs + time ranges to M4L → trigger crossfade

**4d — `g` command handler**
- Same as `d` but from selection to clip end

**4e — Toggle integration**
- Read `PT_Mode` from M4L device param before executing any command
- If PT_Mode == 0, show small feedback (or silently ignore)
- All commands check toggle state first

### Phase 5: Bundle, test, iterate

**5a — Build and bundle**
- `npm run build` → esbuild → `dist/extension.js`
- Set `devMode: true` in manifest.json for local development

**5b — Install extension**
- Copy `dist/` to Ableton's `Resources/Extensions/` directory
- Restart Live
- Verify context menu items appear on arrangement clips

**5c — Test a/s**
- Test with single clip, multiple overlapping clips, MIDI clips, edge cases
- Undo behavior (should be within a single transaction)

**5d — Test with M4L device**
- Add M4L patcher to master channel
- Test d/f/g with various clip arrangements

### Phase 6: Polish & distribution

**6a — Error handling**
- No clip at selection → show feedback or silently ignore
- M4L device not found → friendly message
- PT Mode off → clear indicator

**6b — Edge cases**
- Multiple clips overlapping the selection
- Clips exactly at selection boundary
- Clips shorter than the fade range
- Warped vs unwarped audio clips
- MIDI clips (no gain envelope in LOM for MIDI — fades would be different or blocked)

**6c — Packaging**
- Bundle SDK extension + M4L `.amxd` device together
- Provide setup instructions (drop M4L on master, install extension)

## Files

```
ableton_protools_clip_shortcuts/
├── PLAN.md                          # this file
├── instructions.txt                 # original spec
├── package.json                     # npm scripts, esbuild dep
├── tsconfig.json                    # TypeScript config
├── build.ts                         # esbuild config
├── manifest.json                    # extension manifest
├── src/
│   ├── extension.ts                 # entry point, activation
│   ├── commands/
│   │   ├── trim_start.ts            # "a" command
│   │   ├── trim_end.ts              # "s" command
│   │   ├── fade_in.ts               # "d" command (M4L)
│   │   ├── fade_out.ts              # "g" command (M4L)
│   │   ├── crossfade.ts             # "f" command (M4L)
│   │   └── toggle.ts                # toggle state management
│   ├── m4l/
│   │   ├── discovery.ts             # find M4L device on master track
│   │   ├── protocol.ts              # param encoding/decoding
│   │   └── feedback.ts              # device state reading
│   └── utils/
│       ├── clip_utils.ts            # clip finding, range math
│       ├── selection.ts             # arrangement selection helpers
│       └── transaction.ts           # withinTransaction wrapper
├── m4l/
│   ├── pt_mode.amxd                 # M4L companion device
│   └── pt_mode.maxpat               # source patcher
└── dist/                            # built extension output
    └── extension.js
```
