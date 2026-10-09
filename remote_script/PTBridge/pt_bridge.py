# PT Bridge — Python side of the pt-clip-shortcuts handshake.
#
# The Extensions SDK cannot write clip fades or automation, and neither can
# Max for Live (the M4L LOM has no AutomationEnvelope class). This remote
# script is the only Live API surface that can, so it acts as the fade engine.
#
# Handshake (mirrors src/bridge/protocol.ts in the extension):
#   * The SDK writes a fade payload into the macros of an Audio Effect Rack
#     named "PT Bridge" on the Main track, then bumps the "Trigger" macro
#     (a wrapping 0..127 counter). Macro slot i is rack parameter i + 1.
#   * This script listens to the Trigger macro. On a change it decodes the
#     other macros and applies the fade as a clip volume-automation ramp.
#   * Beat positions are hi/lo encoded (beats = hi * 128 + lo) because rack
#     macros are clamped to 0..127.
#
# Clips are identified by (track index, arrangement start time in beats).

from __future__ import absolute_import, print_function

from _Framework.ControlSurface import ControlSurface

BRIDGE_DEVICE_NAME = "PT Bridge"
BEAT_BASE = 128.0
MACRO_MAX = 127
NO_TRACK_B = MACRO_MAX
CLIP_MATCH_EPSILON = 0.01

# Protocol slots, in macro order (slot i -> rack parameter i + 1).
SLOT_PT_MODE = 0
SLOT_FADE_TYPE = 1
SLOT_TRACK_INDEX = 2
SLOT_CLIP_START_HI = 3
SLOT_CLIP_START_LO = 4
SLOT_RANGE_START_HI = 5
SLOT_RANGE_START_LO = 6
SLOT_RANGE_END_HI = 7
SLOT_RANGE_END_LO = 8
SLOT_TRACK_INDEX_B = 9
SLOT_CLIP_START_B_HI = 10
SLOT_CLIP_START_B_LO = 11
SLOT_TRIGGER = 12
SLOT_COUNT = 13

FADE_IN = 0
FADE_OUT = 1
CROSSFADE = 2

# Number of automation steps used to approximate a linear ramp.
RAMP_STEPS = 24


class PTBridge(ControlSurface):
    def __init__(self, c_instance):
        super(PTBridge, self).__init__(c_instance)
        self._trigger_param = None
        self._slots = []
        with self.component_guard():
            self._main_track = self.song().master_track
            self._main_track.add_devices_listener(self._rescan_bridge)
            self._rescan_bridge()
            self.log_message("PTBridge: ready")

    def disconnect(self):
        self._unbind_trigger()
        if self._main_track and self._main_track.devices_has_listener(self._rescan_bridge):
            self._main_track.remove_devices_listener(self._rescan_bridge)
        super(PTBridge, self).disconnect()

    # -- discovery ---------------------------------------------------------

    def _rescan_bridge(self):
        self._unbind_trigger()
        self._slots = []
        device = None
        for candidate in self._main_track.devices:
            if candidate.name == BRIDGE_DEVICE_NAME:
                device = candidate
                break
        if device is None:
            self.log_message("PTBridge: no '%s' rack on the Main track" % BRIDGE_DEVICE_NAME)
            return
        params = list(device.parameters)
        if len(params) < SLOT_COUNT + 1:
            self.log_message(
                "PTBridge: '%s' has only %d parameters, need %d macros"
                % (BRIDGE_DEVICE_NAME, len(params), SLOT_COUNT)
            )
            return
        # Parameter 0 is "Device On"; macros follow in order.
        self._slots = params[1 : SLOT_COUNT + 1]
        self._trigger_param = self._slots[SLOT_TRIGGER]
        self._trigger_param.add_value_listener(self._on_trigger)
        self.log_message("PTBridge: bound to '%s'" % BRIDGE_DEVICE_NAME)

    def _unbind_trigger(self):
        if self._trigger_param is not None:
            if self._trigger_param.value_has_listener(self._on_trigger):
                self._trigger_param.remove_value_listener(self._on_trigger)
            self._trigger_param = None

    # -- handshake ---------------------------------------------------------

    def _on_trigger(self):
        # Live forbids mutating the document from inside a notification
        # callback, so defer the actual fade by one scheduler tick.
        self.schedule_message(1, self._execute_payload)

    def _slot(self, index):
        return self._slots[index].value

    def _beats(self, hi_slot, lo_slot):
        return round(self._slot(hi_slot)) * BEAT_BASE + self._slot(lo_slot)

    def _execute_payload(self):
        if not self._slots:
            return
        if self._slot(SLOT_PT_MODE) < MACRO_MAX / 2.0:
            self.log_message("PTBridge: trigger ignored, PT Mode is off")
            return
        fade_type = int(round(self._slot(SLOT_FADE_TYPE)))
        track_index = int(round(self._slot(SLOT_TRACK_INDEX)))
        clip_start = self._beats(SLOT_CLIP_START_HI, SLOT_CLIP_START_LO)
        range_start = self._beats(SLOT_RANGE_START_HI, SLOT_RANGE_START_LO)
        range_end = self._beats(SLOT_RANGE_END_HI, SLOT_RANGE_END_LO)
        try:
            if fade_type == FADE_IN:
                self._apply_fade(track_index, clip_start, range_start, range_end, rising=True)
            elif fade_type == FADE_OUT:
                self._apply_fade(track_index, clip_start, range_start, range_end, rising=False)
            elif fade_type == CROSSFADE:
                track_b = int(round(self._slot(SLOT_TRACK_INDEX_B)))
                clip_b = self._beats(SLOT_CLIP_START_B_HI, SLOT_CLIP_START_B_LO)
                clip_a = self._find_clip(track_index, clip_start)
                self._apply_fade(track_index, clip_start, range_start, clip_a.end_time, rising=False)
                if track_b != NO_TRACK_B:
                    self._apply_fade(track_b, clip_b, clip_b, range_end, rising=True)
            else:
                self.log_message("PTBridge: unknown fade type %d" % fade_type)
        except Exception as exc:  # keep the script alive; surface the cause
            self.log_message("PTBridge: fade failed: %r" % exc)

    # -- fade engine -------------------------------------------------------

    def _find_clip(self, track_index, clip_start):
        track = list(self.song().tracks)[track_index]
        for clip in track.arrangement_clips:
            if abs(clip.start_time - clip_start) < CLIP_MATCH_EPSILON:
                return clip
        raise RuntimeError(
            "no arrangement clip at beat %s on track %d" % (clip_start, track_index)
        )

    def _apply_fade(self, track_index, clip_start, range_start, range_end, rising):
        if range_end - range_start <= 0:
            return
        track = list(self.song().tracks)[track_index]
        clip = self._find_clip(track_index, clip_start)
        volume = track.mixer_device.volume
        envelope = self._envelope_for(clip, volume)
        if envelope is None:
            self.log_message("PTBridge: cannot create a volume envelope on this Live version")
            return
        target = volume.value
        # Envelope times are relative to the clip's own timeline, matching
        # what Push writes when editing clip automation.
        rel_start = range_start - clip.start_time + clip.start_marker
        rel_end = range_end - clip.start_time + clip.start_marker
        span = rel_end - rel_start
        step = span / float(RAMP_STEPS)
        for i in range(RAMP_STEPS):
            progress = (i + 0.5) / float(RAMP_STEPS)
            level = target * (progress if rising else 1.0 - progress)
            envelope.insert_step(rel_start + i * step, step, level)
        self.log_message(
            "PTBridge: %s applied on track %d clip @%s, beats %s..%s"
            % ("fade-in" if rising else "fade-out", track_index, clip_start, range_start, range_end)
        )

    def _envelope_for(self, clip, parameter):
        envelope = None
        if hasattr(clip, "automation_envelope"):
            envelope = clip.automation_envelope(parameter)
        if envelope is None and hasattr(clip, "create_automation_envelope"):
            envelope = clip.create_automation_envelope(parameter)
        return envelope
