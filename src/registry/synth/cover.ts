import type { ChannelInput, DeviceInput, VirtualEntity } from '../types';
import { STATE_OFF, STATE_ON, STATE_UNAVAILABLE, STATE_UNKNOWN } from '../types';
import { baseEntity, isUsable, readChannel, toBoolState, type Values } from './common';

/**
 * The two steady Cover states this synth can derive on its own. blinds/
 * blindButtons/gate (type-detector 6.0.1's typePatterns.js) have no "state"
 * channel at all -- opening/closing are transient, movement-direction
 * states nothing detected here can prove, so this synth never emits them,
 * only the two states Home Assistant core itself computes from a resolved
 * position (0 -> closed, otherwise -> open; confirmed against the
 * firmware's own fallback_icon(), which keys off exactly "closed" as a
 * resolved cover state -- src/types/cover/renderer.cpp:148).
 */
const STATE_OPEN = 'open';
const STATE_CLOSED = 'closed';

/**
 * Reads a numeric channel safely. Number('') and Number('  ') are both 0
 * and finite, so a blank reading must resolve to undefined ("unknown"),
 * never a confident zero-percent (fully closed) position. Also -- load-
 * bearing for gate, see isGate below -- String(true)/String(false) are
 * "true"/"false", and Number(...) of either is NaN, so this same guard
 * rejects a boolean channel's value without any detectorType branching.
 * Mirrors climate.ts's readNumber, which guards the identical blank trap.
 */
function readNumber(device: DeviceInput, name: string, values: Values): number | undefined {
  const read = readChannel(device, name, values);
  if (!read || !isUsable(read.value)) return undefined;
  const raw = read.value.val;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : undefined;
}

/** Reads a boolean-shaped channel as a real tri-state -- never a guessed default. */
function readBool(device: DeviceInput, name: string, values: Values): boolean | undefined {
  const read = readChannel(device, name, values);
  if (!read || !isUsable(read.value)) return undefined;
  const state = toBoolState(read.value.val);
  if (state === STATE_ON) return true;
  if (state === STATE_OFF) return false;
  return undefined;
}

/**
 * Position, preferring live feedback over the last commanded target -- the
 * same precedence switch.ts and light.ts already use for their own
 * ACTUAL/SET pairs ("ACTUAL is real feedback and wins over the last command
 * written to SET").
 */
function readPosition(device: DeviceInput, actualName: string, setName: string, values: Values): number | undefined {
  return readNumber(device, actualName, values) ?? readNumber(device, setName, values);
}

function setWritable(writable: Record<string, boolean>, role: string, channel: ChannelInput | undefined): void {
  if (channel) writable[role] = channel.write === true;
}

/**
 * blinds/blindButtons/gate: three type-detector types share this one
 * domain. `blind` requires SET (position); `blindButtons` requires
 * STOP/OPEN/CLOSE and has no position channel at all; `gate` requires SET
 * too, but -- verified directly against the installed @iobroker/
 * type-detector 6.0.1 typePatterns.js -- gate's SET is `type:
 * StateType.Boolean` (role switch(.gate)?), a plain open/close toggle, NOT
 * a percentage the way blind's SET (role level.blind, StateType.Number) is.
 * A position-shaped assumption applied uniformly to SET would grant
 * SET_POSITION on a channel that only ever accepts true/false.
 * readPosition/readNumber already refuse a boolean value on their own
 * (String(true/false) is not numeric), but `writable.position` still needs
 * the explicit isGate guard below: write===true is otherwise
 * indistinguishable from blind's real position channel.
 *
 * Unlike climate's thermostat (no required channel at all) and airCondition
 * (MODE only), every detector pattern in this domain has a real required
 * channel, so a `cover`-domain DeviceInput is always structurally
 * synthesisable -- mapControlToDevice already returns null before this
 * point for a control left with zero channels after IGNORED_CHANNELS
 * filtering (none of SET/STOP/OPEN/CLOSE are ignored), and none of the
 * three patterns can match with only optional channels present. So, unlike
 * synthClimate, this returns VirtualEntity rather than VirtualEntity | null:
 * there is no reachable "detected but nothing usable" case to guard against,
 * and an unreachable null branch would be untestable dead code.
 *
 * Firmware acceptance check (the climate-side lesson this comment answers
 * for cover): docs/contract-climate-cover.md and a direct read of
 * src/types/cover/renderer.cpp's parse_cover_payload confirm cover has NO
 * equivalent to climate's field-presence validity gate. `out.valid = true`
 * is set unconditionally for any payload that is syntactically valid JSON
 * (renderer.cpp:141, after the whole parse, no OR-list of required fields),
 * and even the non-JSON fallback path accepts any non-empty trimmed string
 * (renderer.cpp:92). The only ways a payload is dropped are a null/empty
 * payload (renderer.cpp:83) or a JSON-parse failure combined with an empty
 * trimmed fallback string (renderer.cpp:87-91) -- neither is a field-content
 * check. So there is no firmware-side acceptance rule for synthCover to
 * mirror with a null return.
 */
export function synthCover(device: DeviceInput, entityId: string, values: Values): VirtualEntity {
  const isGate = device.detectorType === 'gate';
  const { source, channelMeta, lastChanged, friendly } = baseEntity(device, entityId, values);
  const attributes: Record<string, unknown> = { ...friendly };
  const writable: Record<string, boolean> = {};

  // current_position/current_tilt_position: undefined stays undefined,
  // never defaulted to 0. The firmware INFERS SET_POSITION/tilt support
  // purely from whether these keys are present in a published payload
  // (docs/contract-climate-cover.md's "supported_features" section) --
  // fabricating either here would later advertise a control on a device
  // that has none. 0 is a legitimate closed position and is kept as-is.
  const currentPosition = readPosition(device, 'actual', 'set', values);
  if (currentPosition !== undefined) attributes.current_position = currentPosition;

  const currentTilt = readPosition(device, 'tilt_actual', 'tilt_set', values);
  if (currentTilt !== undefined) attributes.current_tilt_position = currentTilt;

  if (!isGate) setWritable(writable, 'position', device.channels.set);
  setWritable(writable, 'open', device.channels.open);
  setWritable(writable, 'close', device.channels.close);
  setWritable(writable, 'stop', device.channels.stop);
  setWritable(writable, 'tilt_position', device.channels.tilt_set);
  setWritable(writable, 'tilt_open', device.channels.tilt_open);
  setWritable(writable, 'tilt_close', device.channels.tilt_close);
  setWritable(writable, 'tilt_stop', device.channels.tilt_stop);

  // gate has no separate OPEN/CLOSE channels at all (verified against
  // typePatterns.js: its states are SET/ACTUAL/STOP/OPENED/CLOSED only) --
  // its one boolean SET *is* the open/close command, so that is what a
  // gate's open/close writability must point at, or a detected gate would
  // render as a cover tile with nothing on it that can ever be pressed.
  if (isGate) {
    setWritable(writable, 'open', device.channels.set);
    setWritable(writable, 'close', device.channels.set);
  }

  // state: derived, never read from a channel that doesn't exist (none of
  // the three patterns has one). Precedence: a real position wins first (0
  // -> closed, matching HA core's own CoverEntity.state derivation), then
  // gate's two dedicated presence contacts ("a gate can also stand between
  // fully open and fully closed" -- typePatterns.js's own comment on
  // OPENED/CLOSED), then gate's boolean SET read back as a plain toggle.
  let state: string | undefined;
  if (currentPosition !== undefined) {
    state = currentPosition === 0 ? STATE_CLOSED : STATE_OPEN;
  } else {
    const closed = readBool(device, 'closed', values);
    const opened = readBool(device, 'opened', values);
    if (closed === true) state = STATE_CLOSED;
    else if (opened === true) state = STATE_OPEN;
    else {
      const toggled = readBool(device, 'set', values);
      if (toggled === true) state = STATE_OPEN;
      else if (toggled === false) state = STATE_CLOSED;
    }
  }

  // available mirrors climate's rule but cannot reuse its attribute-count
  // shortcut: gate's opened/closed contacts inform `state` without ever
  // becoming attributes of their own (Home Assistant's Cover entity has no
  // public attribute for them), so an explicit signal list is used instead.
  const available = currentPosition !== undefined || currentTilt !== undefined || state !== undefined;

  return {
    entityId,
    domain: 'cover',
    source,
    state: state ?? (available ? STATE_UNKNOWN : STATE_UNAVAILABLE),
    attributes,
    available,
    lastChanged,
    writable,
    channelMeta,
  };
}
