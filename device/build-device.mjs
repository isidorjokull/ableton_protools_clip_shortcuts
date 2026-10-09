// Builds device/pt-clip-shortcuts.amxd from Live's own empty Max Audio Effect.
//
// .amxd container layout (reverse-engineered from Live's factory devices and
// verified by parsing them back):
//
//   'ampf' LE32(4) 'aaaa' 'meta' LE32(4) LE32(0) 'ptch' LE32(len) <patcher JSON>
//
// Live's "Max Audio Effect.amxd" stores its patcher as plain JSON in the ptch
// chunk, so no compression or embedded-resource directory is needed.
//
// Run: node device/build-device.mjs
// Override the template with LIVE_MAX_DEVICES=/path/to/Max\ Devices

import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));

const TEMPLATE_CANDIDATES = [
  process.env.LIVE_MAX_DEVICES && join(process.env.LIVE_MAX_DEVICES, "Max Audio Effect.amxd"),
  "/Applications/Ableton Live 12 Beta.app/Contents/App-Resources/Misc/Max Devices/Max Audio Effect.amxd",
  "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Misc/Max Devices/Max Audio Effect.amxd",
].filter(Boolean);

const TEMPLATE = TEMPLATE_CANDIDATES.find((p) => existsSync(p));
if (!TEMPLATE) {
  console.error(
    "No Max Audio Effect.amxd template found. Tried:\n  " + TEMPLATE_CANDIDATES.join("\n  "),
  );
  process.exit(1);
}

/** Reads the patcher JSON out of an .amxd. */
function readPatcher(file) {
  const buf = readFileSync(file);
  if (buf.subarray(0, 4).toString() !== "ampf") throw new Error("not an .amxd");
  const ptchLen = buf.readUInt32LE(28);
  let start = 32;
  if (buf.subarray(32, 36).toString() === "mx@c") start = 48; // marker + 12-byte header
  return JSON.parse(buf.subarray(start, 32 + ptchLen).toString("utf8").replace(/\0+$/, ""));
}

/** Wraps patcher JSON back into an .amxd container. */
function writeAmxd(file, patcher) {
  const json = Buffer.from(JSON.stringify(patcher, null, "\t"), "utf8");
  const head = Buffer.alloc(32);
  head.write("ampf", 0);
  head.writeUInt32LE(4, 4);
  head.write("aaaa", 8);
  head.write("meta", 12);
  head.writeUInt32LE(4, 16);
  head.writeUInt32LE(0, 20); // device type, as Live's empty audio effect uses
  head.write("ptch", 24);
  head.writeUInt32LE(json.length, 28);
  writeFileSync(file, Buffer.concat([head, json]));
  return json.length;
}

const p = readPatcher(TEMPLATE).patcher;

// Keep only the audio passthrough (plugin~ -> plugout~); drop the placeholder
// comments that tell you to build your effect here.
p.boxes = p.boxes.filter((b) => ["obj-1", "obj-2"].includes(b.box.id));
p.lines = p.lines.filter(
  (l) =>
    ["obj-1", "obj-2"].includes(l.patchline.source[0]) &&
    ["obj-1", "obj-2"].includes(l.patchline.destination[0]),
);

const box = (o) => p.boxes.push({ box: o });
const connect = (src, outlet, dst, inlet = 0) =>
  p.lines.push({ patchline: { destination: [dst, inlet], source: [src, outlet] } });

// One button per command.
//
// mode 1 (toggle), NOT mode 0 (momentary), and that is deliberate. The mapped
// parameter is an Int with range 0..1 (parameter_type 1 is Int — the type
// order in parameters.maxref.xml is Float, Int, Enum, Blob — so the
// parameter_enum below is decorative). Live's Key Map FLIPS that value on each
// press instead of sending a momentary press, so it latches at 1. In mode 0
// live.text emits only the transition to non-zero, which made every second
// press do nothing and left the button lit. Toggle mode is documented to emit
// on both edges, and pt-trigger.js fires on any value and pushes "set 0" back
// to clear the latch.
//
// Each button gets its own js instance with the command id as an object
// argument, so one script drives all of them. Adding the fade commands later
// is one more entry here.
const buttons = [
  {
    id: "obj-10", js: "obj-12", y: 180.0, py: 10.0,
    label: "Trim Start  (a)",
    command: "pt-clip-shortcuts.trimStart",
    longname: "PT Trim Start", shortname: "PT Start",
    info: "Trims the start of the clip under the edit cursor, on the selected track, up to the cursor.",
  },
  {
    id: "obj-20", js: "obj-22", y: 245.0, py: 40.0,
    label: "Trim End  (s)",
    command: "pt-clip-shortcuts.trimEnd",
    longname: "PT Trim End", shortname: "PT End",
    info: "Trims the end of the clip under the edit cursor, on the selected track, back to the cursor.",
  },
];

for (const b of buttons) {
  box({
    maxclass: "live.text",
    id: b.id,
    numinlets: 1,
    numoutlets: 2,
    outlettype: ["", ""],
    mode: 1, // see the note above — toggle, so BOTH key-press edges reach the script
    parameter_enable: 1,
    presentation: 1,
    patching_rect: [48.0, b.y, 110.0, 25.0],
    presentation_rect: [10.0, b.py, 110.0, 25.0],
    text: b.label,
    texton: b.label,
    automation: "Trigger",
    automationon: "Trigger",
    fontsize: 11.0,
    saved_attribute_attributes: {
      valueof: {
        parameter_enum: ["Trigger", "Trigger"],
        // Live requires parameter names to be unique within a device.
        parameter_longname: b.longname,
        parameter_shortname: b.shortname,
        parameter_mmax: 1.0,
        parameter_type: 1,
        parameter_modmode: 0,
        // Deliberately off: an initial value would fire the trigger on load and
        // run the command every time the device instantiates.
        parameter_initial_enable: 0,
        parameter_linknames: 1,
        parameter_info:
          b.info + " Map it to a key (Key Map) or a Stream Deck button (MIDI Map).",
      },
    },
  });

  box({
    maxclass: "newobj", id: b.js, text: `js pt-trigger.js ${b.command}`,
    numinlets: 1, numoutlets: 3, outlettype: ["", "", ""],
    patching_rect: [48.0, b.y + 30, 240.0, 22.0], fontsize: 11.0,
  });

  // Straight to the script — no [sel 1]. A momentary live.text click sends a
  // BANG, which a value filter silently swallows; the script debounces instead,
  // so it works whichever shape the button emits.
  connect(b.id, 0, b.js);
  connect(b.js, 0, "obj-13"); // URL    -> maxurl (shared)
  connect(b.js, 1, "obj-14"); // status -> console (shared)
  connect(b.js, 2, b.id);     // "set 0" -> back into the button, clearing the latch
}

// maxurl has 2 outlets, not 3. A wrong count silently drops patchlines.
box({
  maxclass: "newobj", id: "obj-13", text: "maxurl", numinlets: 1, numoutlets: 2,
  outlettype: ["", ""], patching_rect: [48.0, 370.0, 55.0, 22.0], fontsize: 11.0,
});

box({
  maxclass: "newobj", id: "obj-14", text: "print PT", numinlets: 1, numoutlets: 0,
  patching_rect: [48.0, 405.0, 65.0, 22.0], fontsize: 11.0,
});

connect("obj-13", 0, "obj-14"); // reply -> console

p.openinpresentation = 1;
p.devicewidth = 130.0;
p.rect = [236.0, 105.0, 520.0, 470.0];
p.description = "Pro Tools-style clip trims on the selected track at the edit cursor";
p.tags = "pt-clip-shortcuts";
p.dependency_cache = [];

const out = join(here, "pt-clip-shortcuts.amxd");
const len = writeAmxd(out, { patcher: p });

// Round-trip: read our own file back and confirm it parses and is wired.
const back = readPatcher(out).patcher;
const byId = new Map(back.boxes.map((b) => [b.box.id, b.box]));
const btns = back.boxes.filter((b) => b.box.maxclass === "live.text").map((b) => b.box);

console.log(`template: ${TEMPLATE}`);
console.log(`wrote ${out}`);
console.log(`  patcher JSON: ${len} bytes, ${back.boxes.length} boxes, ${back.lines.length} lines`);
for (const btn of btns) {
  const v = btn.saved_attribute_attributes.valueof;
  const jsId = back.lines.find((l) => l.patchline.source[0] === btn.id)?.patchline.destination[0];
  console.log(
    `  button "${btn.text}": mode=${btn.mode} param="${v.parameter_longname}" -> ${
      jsId ? byId.get(jsId)?.text : "(unwired)"
    }`,
  );
}

// Lint the wiring. Max silently drops a patchline that references a missing box
// or an out-of-range inlet/outlet, so the device would load looking fine and do
// nothing. This is the closest check available without opening Max.
const problems = [];
for (const { patchline } of back.lines) {
  const [sid, sout] = patchline.source;
  const [did, din] = patchline.destination;
  const s = byId.get(sid);
  const d = byId.get(did);
  if (!s) problems.push(`line from missing box ${sid}`);
  if (!d) problems.push(`line to missing box ${did}`);
  if (s && sout >= (s.numoutlets ?? 0)) problems.push(`${sid} outlet ${sout} >= numoutlets ${s.numoutlets}`);
  if (d && din >= (d.numinlets ?? 0)) problems.push(`${did} inlet ${din} >= numinlets ${d.numinlets}`);
}
for (const b of back.boxes) {
  if (JSON.stringify(b.box).includes("null")) problems.push(`${b.box.id} contains a null value`);
}
// Live needs unique parameter names within a device, and a toggle would latch
// instead of firing once per press.
const names = new Set();
for (const btn of btns) {
  const v = btn.saved_attribute_attributes?.valueof ?? {};
  if (btn.mode !== 1) {
    problems.push(
      `${btn.id} mode=${btn.mode} (expected 1 = toggle, so both Key Map edges reach the script)`,
    );
  }
  if (!v.parameter_longname) problems.push(`${btn.id} has no parameter_longname`);
  if (names.has(v.parameter_longname)) problems.push(`duplicate parameter_longname "${v.parameter_longname}"`);
  names.add(v.parameter_longname);
  if (v.parameter_initial_enable) problems.push(`${btn.id} would fire on load (parameter_initial_enable)`);
  // A momentary live.text click sends a BANG, so any filter between the button
  // and the script swallows it and the device goes silent.
  const dest = back.lines.find((l) => l.patchline.source[0] === btn.id)?.patchline.destination[0];
  const destBox = dest ? byId.get(dest) : undefined;
  if (!destBox) problems.push(`${btn.id} ("${btn.text}") is not connected to anything`);
  else if (!String(destBox.text ?? "").startsWith("js ")) {
    problems.push(
      `${btn.id} ("${btn.text}") feeds "${destBox.text}" instead of the js object — a value filter drops the bang`,
    );
  }
  // Without the reset line the button stays latched at 1 after a key press and
  // sits there looking stuck.
  const reset = back.lines.find(
    (l) => l.patchline.destination[0] === btn.id && l.patchline.source[1] === 2,
  );
  if (!reset) problems.push(`${btn.id} ("${btn.text}") has no "set 0" reset line back from its js object`);
}
// Every js object must carry a command argument, or it silently defaults, and
// the script it names must actually ship beside the device.
for (const b of back.boxes) {
  const t = b.box.text ?? "";
  if (!t.startsWith("js ")) continue;
  const parts = t.split(/\s+/);
  if (parts.length < 3) problems.push(`${b.box.id} has no command argument: "${t}"`);
  if (!existsSync(join(here, parts[1]))) {
    problems.push(`${b.box.id} names ${parts[1]}, which is not beside the device`);
  }
}
if (problems.length) {
  console.error("WIRING PROBLEMS:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`  wiring lint: all ${back.lines.length} patchlines reference valid boxes and ports`);
