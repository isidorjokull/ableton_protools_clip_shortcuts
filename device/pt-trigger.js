// pt-trigger.js — companion script for pt-clip-shortcuts.amxd
//
// Reads Live's arrangement edit position and calls the extension's loopback
// endpoint, which trims the clip under it.
//
// This device exists because of two hard limits in the Extensions SDK:
// it has no keybinding API (Live's Key Map only targets on-screen controls, so
// a live.text button is the only mappable thing available), and Song exposes
// no selection getter — but the Live Object Model, which Max can read, has
// both. So Max supplies what the SDK cannot see.
//
// Pro Tools model: the edit cursor decides where the trim lands, and the
// selected track decides which clip. Those are:
//   live_set view selected_track   -> the track
//   live_set current_song_time     -> the insert marker, in beats
//
// Outlet 0: the URL, to [maxurl]
// Outlet 1: a status string, for [print]
// Outlet 2: "set 0", back into the button, to clear its latch (see below)

autowatch = 1;
outlets = 3;

// Must match the extension: see src/server/listener.ts DEFAULT_PORT.
var PORT = 17818;

// Any registered command id works. The object argument overrides it, so one
// script drives every button:
//   [js pt-trigger.js pt-clip-shortcuts.trimStart]
//   [js pt-trigger.js pt-clip-shortcuts.trimEnd]
// jsarguments[0] is the script name, so the first real argument is [1].
var COMMAND = "pt-clip-shortcuts.trimStart";
if (typeof jsarguments !== "undefined" && jsarguments.length > 1) {
  COMMAND = jsarguments[1];
}

// The button is a two-state parameter (Int, 0..1 - parameter_type 1 is Int,
// NOT enum; see parameters.maxref.xml). Live's Key Map flips that value on
// each key press rather than sending a momentary press, so the parameter
// LATCHES: press once and it sits at 1.
//
// That is why the button is mode 1 (toggle) rather than mode 0. In button mode
// live.text emits only the transition to non-zero, so the 1->0 press produced
// no output at all and the shortcut worked every other time. live.text.maxref
// documents toggle mode as sending 1 out the left outlet for any non-zero and
// 0 for a zero - both edges - so every press now reaches this script.
//
// Two consequences handled below:
//   - fire on ANY value, because half the presses arrive as a 0;
//   - after firing, push "set 0" back into the button. `set` is documented as
//     "Toggle the state without sending output", so it clears the latch (the
//     button stops looking stuck) without re-entering this script. Firing does
//     not depend on it working: if the reset does not reach Live's copy of the
//     parameter, the next press simply arrives as a 0 and fires anyway.
var DEBOUNCE_MS = 120;
var lastFire = 0;

function triggered(shape) {
  post("[PT] button sent " + shape + "\n");
  var now = new Date().getTime();
  // Always clear the latch, even when the message is debounced away, so the
  // button never stays lit.
  outlet(2, "set", 0);
  if (now - lastFire < DEBOUNCE_MS) {
    post("[PT] debounced (" + (now - lastFire) + "ms since last fire)\n");
    return;
  }
  lastFire = now;
  fire();
}

function bang() {
  triggered("bang");
}

function msg_int(v) {
  triggered("int " + v);
}

function msg_float(v) {
  triggered("float " + v);
}

// Any other message from the button (e.g. its label symbol) also triggers;
// `command` and `port` below have their own handlers and take precedence.
function anything() {
  triggered("message " + messagename);
}

// Optional overrides from the patcher, e.g. [; pt port 17819]
function command(id) {
  if (id) {
    COMMAND = id;
    post("[PT] command set to " + COMMAND + "\n");
  }
}

function port(p) {
  if (p > 0) {
    PORT = p;
    post("[PT] port set to " + PORT + "\n");
  }
}

function fire() {
  var trackPath = selectedTrackPath();
  if (trackPath === null) return;

  var time = songTime();
  if (time === null) return;

  // %20 rather than spaces or commas: a Max symbol containing either can be
  // split into separate atoms on its way to [maxurl]. The extension decodes it.
  var url =
    "http://127.0.0.1:" + PORT + "/cmd?id=" + COMMAND +
    "&path=" + trackPath.replace(/ /g, "%20") +
    "&time=" + time.toFixed(6);

  post("[PT] GET " + url + "\n");
  // maxurl needs a method, not a bare symbol: a bare URL gives
  // "maxurl: doesn't understand ...".
  outlet(0, "get", url);
}

/** "live_set tracks N" for the selected track, or null (with a report). */
function selectedTrackPath() {
  var api;
  try {
    api = new LiveAPI("live_set view selected_track");
  } catch (e) {
    report("LiveAPI failed: " + e);
    return null;
  }
  // An unresolved path reports id 0.
  if (!api || !api.id || parseInt(api.id, 10) === 0) {
    report("no track selected");
    return null;
  }
  var path = api.unquotedpath; // e.g. live_set tracks 7
  // Return and main tracks hold no arrangement clips, and their paths are
  // live_set return_tracks N / live_set master_track.
  if (!path || path.indexOf("live_set tracks") !== 0) {
    report("select a regular track (got: " + path + ")");
    return null;
  }
  return path;
}

/** The arrangement insert marker in beats, or null (with a report). */
function songTime() {
  var song;
  try {
    song = new LiveAPI("live_set");
  } catch (e) {
    report("LiveAPI failed: " + e);
    return null;
  }
  // LiveAPI.get always returns an array, even for a single float. Checked by
  // shape rather than `instanceof Array`, which is false across JS realms and
  // would make the test harness disagree with Max.
  var raw = song.get("current_song_time");
  var time = parseFloat(raw && typeof raw === "object" && raw.length ? raw[0] : raw);
  if (isNaN(time) || time < 0) {
    report("could not read current_song_time");
    return null;
  }
  return time;
}

function report(msg) {
  post("[PT] " + msg + "\n");
  outlet(1, msg);
}
