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
 * bearing for a toggle-kind SET, see setChannelKind below -- String(true)/
 * String(false) are "true"/"false", and Number(...) of either is NaN, so
 * this same guard rejects a boolean channel's value without any
 * detectorType branching. Mirrors climate.ts's readNumber, which guards the
 * identical blank trap.
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

type SetChannelKind = 'position' | 'toggle';

/**
 * Ruling 28 (task 6 fix round 1). Decides whether the SET channel is a
 * settable 0-100 position or a plain open/close toggle from the channel's
 * own recorded `type` -- real ioBroker object metadata, copied onto
 * ChannelInput by detector.ts's mapControlToDevice from ObjectMeta.type,
 * and authoritative whenever present -- never from detectorType or the
 * channel's name. This matters beyond gate: overrides.ts can force `domain`
 * to 'cover' on a device detected as something else entirely (e.g. a plain
 * socket) without touching its channels or detectorType at all
 * (overrides.ts:25-30 spreads `...device` and only replaces
 * `name`/`domain`), so a detectorType check alone would see a non-'gate'
 * detectorType and wrongly grant a numeric position write on a boolean
 * on/off channel.
 *
 * Only when the type is genuinely unknown (a channel built without real
 * metadata) does this fall back to what the matched detector pattern
 * itself guarantees -- gate's SET is always boolean, blind's is always
 * numeric -- the same "trust real metadata first, fall back to pattern
 * shape only when it is silent" reasoning climate.ts's own untyped
 * channels already use. blindButtons never reaches the fallback at all: it
 * has no SET channel, so this returns undefined before detectorType is
 * even consulted.
 */
function setChannelKind(device: DeviceInput): SetChannelKind | undefined {
  const channel = device.channels.set;
  if (!channel) return undefined;
  if (channel.type === 'boolean') return 'toggle';
  if (channel.type === 'number') return 'position';
  return device.detectorType === 'gate' ? 'toggle' : 'position';
}

/**
 * blinds/blindButtons/gate: three type-detector types share this one
 * domain. `blind` requires SET (position); `blindButtons` requires
 * STOP/OPEN/CLOSE and has no position channel at all; `gate` requires SET
 * too, but -- verified directly against the installed @iobroker/
 * type-detector 6.0.1 typePatterns.js -- gate's SET is `type:
 * StateType.Boolean` (role switch(.gate)?), a plain open/close toggle, NOT
 * a percentage the way blind's SET (role level.blind, StateType.Number) is.
 *
 * Gate's optional ACTUAL, by contrast, IS `type: StateType.Number` (role
 * value.(position|gate)?) -- real position telemetry Home Assistant keeps
 * distinct from being able to SET one (Ruling 27, task 6 fix round 1): the
 * firmware only infers SET_POSITION from current_position's presence when
 * the publisher omits supported_features entirely --
 * src/types/cover/renderer.cpp:124-136 is an if/else, so an explicit
 * supported_features is used exactly as given, with no inference layered
 * on top -- and task 7 always emits an explicit supported_features derived
 * from `writable`. So current_position is read from ACTUAL/SET the same
 * way for every detectorType, gate included: it is `writable.position`,
 * never current_position, that must stay unset for a toggle-kind SET.
 *
 * Ruling 28 (see setChannelKind) is what keeps that split correct: the
 * toggle-vs-position decision is keyed on the SET channel's own recorded
 * type, not on detectorType, so it holds under a forced domain override
 * too. It is also what keeps a numeric SET out of the boolean-toggle
 * fallback in the state derivation below -- readBool('set', ...) is only
 * ever attempted when the type decision says 'toggle', so a numeric SET
 * holding a stray NaN (toBoolState treats a NaN number as truthy, NaN !==
 * 0) can never produce a fabricated state.
 *
 * Like climate's thermostat (one of SET/SET_HEATING/SET_COOLING) and
 * airCondition (that plus MODE), every detector pattern in this domain has a
 * real required channel, so a naturally-detected `cover`-domain DeviceInput
 * is always structurally synthesisable -- mapControlToDevice already returns null
 * before this point for a control left with zero channels after
 * IGNORED_CHANNELS filtering (none of SET/STOP/OPEN/CLOSE are ignored), and
 * none of the three patterns can match with only optional channels present.
 * This holds under a forced override too: overrides.ts never touches
 * channels, so a device forced into this domain still carries whatever
 * channels its own real detection produced, and the toggle-vs-position
 * split above is resolved from each channel's own type rather than from
 * detectorType, so it never depends on the device actually being a natural
 * blind/blindButtons/gate. So, unlike synthClimate, this returns
 * VirtualEntity rather than VirtualEntity | null: there is no reachable
 * "detected but nothing usable" case to guard against, and an unreachable
 * null branch would be untestable dead code.
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
  const setKind = setChannelKind(device);
  const { source, channelMeta, lastChanged, friendly } = baseEntity(device, entityId, values);
  const attributes: Record<string, unknown> = { ...friendly };
  const writable: Record<string, boolean> = {};

  // current_position/current_tilt_position: undefined stays undefined,
  // never defaulted to 0, and read the same way regardless of setKind -- a
  // gate's numeric ACTUAL is real position telemetry (Ruling 27) and is
  // kept even though its SET cannot set an exact position; readNumber
  // already refuses a non-numeric (e.g. boolean) SET value on its own, so
  // this never fabricates a position from a toggle. 0 is a legitimate
  // closed position and is kept as-is, distinct from absent.
  const currentPosition = readPosition(device, 'actual', 'set', values);
  if (currentPosition !== undefined) attributes.current_position = currentPosition;

  const currentTilt = readPosition(device, 'tilt_actual', 'tilt_set', values);
  if (currentTilt !== undefined) attributes.current_tilt_position = currentTilt;

  if (setKind === 'position') setWritable(writable, 'position', device.channels.set);
  setWritable(writable, 'open', device.channels.open);
  setWritable(writable, 'close', device.channels.close);
  setWritable(writable, 'stop', device.channels.stop);
  setWritable(writable, 'tilt_position', device.channels.tilt_set);
  setWritable(writable, 'tilt_open', device.channels.tilt_open);
  setWritable(writable, 'tilt_close', device.channels.tilt_close);
  setWritable(writable, 'tilt_stop', device.channels.tilt_stop);

  // A toggle-kind SET (gate, or any other device whose SET is genuinely
  // boolean -- Ruling 28) has no separate OPEN/CLOSE channels of its own
  // (verified against typePatterns.js for gate specifically: its states are
  // SET/ACTUAL/STOP/OPENED/CLOSED only) -- the one boolean SET channel *is*
  // the open/close command, so that is what open/close writability must
  // point at, or the tile would render with nothing on it that can ever be
  // pressed.
  if (setKind === 'toggle') {
    setWritable(writable, 'open', device.channels.set);
    setWritable(writable, 'close', device.channels.set);
  }

  // state: derived, never read from a channel that doesn't exist (none of
  // the three patterns has one). Precedence: a real position wins first (0
  // -> closed, matching HA core's own CoverEntity.state derivation), then
  // gate's two dedicated presence contacts ("a gate can also stand between
  // fully open and fully closed" -- typePatterns.js's own comment on
  // OPENED/CLOSED), then -- only for a genuine toggle-kind SET (Ruling 28)
  // -- that SET read back as a plain on/off. Gating the last branch on
  // setKind is load-bearing, not cosmetic: without it, a numeric SET
  // holding garbage (e.g. NaN) would fall into the toggle branch and report
  // a fabricated 'open', since toBoolState treats a NaN number as truthy.
  let state: string | undefined;
  if (currentPosition !== undefined) {
    state = currentPosition === 0 ? STATE_CLOSED : STATE_OPEN;
  } else {
    const closed = readBool(device, 'closed', values);
    const opened = readBool(device, 'opened', values);
    if (closed === true) state = STATE_CLOSED;
    else if (opened === true) state = STATE_OPEN;
    else if (setKind === 'toggle') {
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
