import type { ChannelInput, DeviceInput, VirtualEntity } from '../types';
import { STATE_UNAVAILABLE, STATE_UNKNOWN } from '../types';
import {
  acceptsLabels,
  baseEntity,
  encodeChannelValue,
  isUsable,
  readChannel,
  roleCodec,
  toBoolState,
  type Values,
} from './common';

/**
 * Channels that can make the firmware's own payload-acceptance check pass.
 * tile_renderer.cpp's parse_climate_payload only sets `valid` when the
 * result carries `!available`, a non-empty hvac_mode/hvac_action, or one of
 * the has_current_temperature/has_target_temperature/has_current_humidity/
 * has_target_humidity/has_target_range flags (tile_renderer.cpp:2297-2300);
 * anything else is dropped outright, cache untouched. SPEED, SPEED_LEVEL,
 * SWING, SWING_TOGGLE, POWER and BOOST are real synth attributes but none of
 * them can ever satisfy that check on their own (fan_mode/swing_mode/
 * swing_horizontal_mode/power/boost are not in the firmware's OR-list at
 * all), so a device with only one of those would always publish a payload
 * the firmware discards -- not a climate entity in the wire-format sense,
 * whatever ioBroker calls it (review round 1, M6).
 *
 * type-detector 6.0.1 detects neither climate type without a setpoint
 * (thermostat requires one of SET/SET_HEATING/SET_COOLING, airCondition that
 * plus MODE; docs/contract-iobroker-types.md), but the dependency is ^6.0.1
 * and a later minor could relax that, and a domain override can make any
 * device climate. So a device may still have none of these configured;
 * returning null here rather than an entity with nothing behind it is the
 * same defence as before, just drawn at the boundary the firmware enforces.
 */
const VALIDITY_CHANNELS = ['set', 'set_heating', 'set_cooling', 'actual', 'humidity', 'mode', 'working_mode'] as const;

/**
 * Reads a numeric channel safely. Number('') and Number('  ') are both 0 and
 * finite, so a blank reading must resolve to undefined ("unknown"), never to
 * a confident zero-degree setpoint or zero-percent humidity on a wall panel.
 * Mirrors light.ts's readNumber, which guards the identical trap for
 * brightness; every numeric climate channel (SET, SET_HEATING, SET_COOLING,
 * ACTUAL, HUMIDITY, SPEED_LEVEL) goes through this.
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

/**
 * Reads a channel that carries a named state (MODE, WORKING_MODE, SPEED, the
 * numeric SWING): decodes through the channel's own ioBroker `states` map
 * when the admin configured one, otherwise falls back to the raw value. type-
 * detector declares these channels as Number-or-String, so a blank string
 * must resolve to undefined rather than an empty label — the same rule
 * readNumber applies to the purely numeric channels.
 */
function readEnum(device: DeviceInput, name: string, values: Values): string | undefined {
  const read = readChannel(device, name, values);
  if (!read || !isUsable(read.value)) return undefined;
  const raw = read.value.val;
  const states = read.channel.states;
  if (states) {
    const label = states[String(raw)];
    if (label !== undefined) return label;
  }
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text ? text : undefined;
  }
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : undefined;
  return undefined;
}

/** Reads a boolean-ish channel (POWER, BOOST, the boolean SWING toggle) as on/off. */
function readBoolAttr(device: DeviceInput, name: string, values: Values): string | undefined {
  const read = readChannel(device, name, values);
  return read && isUsable(read.value) ? toBoolState(read.value.val) : undefined;
}

function setWritable(writable: Record<string, boolean>, role: string, channel: ChannelInput | undefined): void {
  if (channel) writable[role] = channel.write === true;
}

/**
 * Ruling 36: a label role (hvac_mode, fan_mode, swing_mode) is writable only
 * when a label command can land -- the channel is writable AND takes labels
 * at all (acceptsLabels, Ruling 33), judged on the codec the dispatcher
 * encodes with (roleCodec). protocol/climate.ts derives supported_features
 * from `writable`, so a control is advertised exactly when it is commandable.
 */
function setLabelWritable(writable: Record<string, boolean>, role: string, channel: ChannelInput | undefined): void {
  if (channel) writable[role] = channel.write === true && acceptsLabels(roleCodec(role, channel));
}

/**
 * The firmware's fixed control-name tables, read from HomeTiles (read-only
 * repo) src/tiles/runtime/tile_renderer.cpp, the code that turns a published
 * array into a button mask: climate_modes_mask :2029-2047,
 * climate_fan_modes_mask :2073-2093, climate_swing_modes_mask :2095-2114 (the
 * same names as the mask enums in src/types/climate/state.h:45-53, 99-110,
 * 125-131). A name matches only exactly, after trim+lowercase
 * (climate_normalize_modes :2019-2027); anything else is silently dropped.
 *
 * The fourth table, swing_horizontal (:2116-2136, state.h:145-153: off/on/
 * left/center/right/swing/wide), is reduced to off/on below: this role's only
 * channel is the boolean SWING toggle, and commands.ts's requireOnOff carries
 * nothing else. There is no preset list: no synth reads a preset channel
 * (neither the thermostat nor the airCondition pattern has one), so nothing
 * can back it.
 */
const HVAC_MODE_NAMES = ['off', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only'] as const;
const FAN_MODE_NAMES = ['auto', 'low', 'medium', 'high', 'on', 'off', 'top', 'middle', 'focus', 'diffuse'] as const;
const SWING_MODE_NAMES = ['off', 'on', 'vertical', 'horizontal', 'both'] as const;

/**
 * The firmware names a panel can send back for a readEnum-decoded role
 * (hvac_mode from MODE, fan_mode from SPEED/SPEED_LEVEL, swing_mode from the
 * numeric SWING) and have land as that channel's exact native value:
 *
 * - read-only or absent: none. Every button would send a command the
 *   dispatcher refuses.
 * - codec not number/string: none. The codec is roleCodec's, the one the
 *   dispatcher encodes with. An untyped MODE has no fixed pattern type, so
 *   the type it would be written as is a guess; mixed has no single native
 *   type; boolean decodes through toBoolState, not labels.
 * - otherwise: exactly the names encodeChannelValue, the function the
 *   dispatcher itself calls, can reverse. By construction that excludes a
 *   channel with no states map (Rulings 30/33: no firmware name is a number,
 *   and a string channel refuses every label), a label two states share
 *   case-insensitively, and a key the type cannot hold.
 */
function enumModes(role: string, channel: ChannelInput | undefined, names: readonly string[]): string[] {
  const codec = roleCodec(role, channel);
  if (channel?.write !== true || (codec?.type !== 'number' && codec?.type !== 'string')) return [];
  return names.filter((name) => encodeChannelValue(codec, name) !== undefined);
}

export function synthClimate(device: DeviceInput, entityId: string, values: Values): VirtualEntity | null {
  // The trap: type-detector 6.0.1 requires a setpoint for both climate types,
  // but a later ^6 minor or a domain override need not, so a device may have
  // nothing among the roles below. Returning null here — rather than an
  // "unavailable" entity — means no hollow tile is ever registered for it.
  // Narrowed to VALIDITY_CHANNELS (review round 1, M6): a device exposing
  // only SPEED/SPEED_LEVEL/SWING/SWING_TOGGLE/POWER/BOOST would previously
  // have synthesised anyway, then published a payload the firmware always
  // rejects as invalid.
  if (!VALIDITY_CHANNELS.some((name) => device.channels[name])) return null;

  // channelMeta is passed through unchanged from baseEntity, not computed
  // here -- this is plumbing, not a decode-logic change. Without it, a real
  // climate VirtualEntity would never carry the type/states metadata
  // dispatcher.ts's encodeChannelValue needs, and fix-round 2 would only work
  // against hand-built test fixtures, never a real detected device.
  const { source, channelMeta, lastChanged, friendly } = baseEntity(device, entityId, values);
  const attributes: Record<string, unknown> = { ...friendly };
  const baselineKeys = Object.keys(attributes).length;
  const writable: Record<string, boolean> = {};

  // Single vs. dual setpoint (review round 1, ruling 14). A plain SET always
  // wins as the one target, unchanged from before. Otherwise, Home
  // Assistant's own model is that a thermostat with exactly ONE of
  // SET_HEATING/SET_COOLING and no SET is a heat-only or cool-only device
  // with a SINGLE target, not a range missing one side — so that lone
  // channel becomes target_temperature, not target_temp_low/target_temp_high.
  // target_temp_low/target_temp_high are populated ONLY when BOTH
  // SET_HEATING and SET_COOLING exist: that is the only shape the firmware's
  // shared has_target_range flag and the popup's range mode (climate_popup.cpp:
  // has_range = has_target_range && !has_target_temperature) can represent as
  // an actual range. Channel KEYS in `source` are unaffected either way —
  // baseEntity populates them from device.channels directly — so Task 5's
  // dispatcher can still look up 'set'/'set_heating'/'set_cooling' by name.
  const hasPlainSet = device.channels.set !== undefined;
  const hasHeating = device.channels.set_heating !== undefined;
  const hasCooling = device.channels.set_cooling !== undefined;

  if (hasPlainSet) {
    // Never fabricated from ACTUAL: a read-only thermostat (ACTUAL present,
    // SET absent) must not appear to have a settable target.
    const targetTemperature = readNumber(device, 'set', values);
    if (targetTemperature !== undefined) attributes.target_temperature = targetTemperature;
    setWritable(writable, 'setpoint', device.channels.set);
  } else if (hasHeating && hasCooling) {
    const targetLow = readNumber(device, 'set_heating', values);
    if (targetLow !== undefined) attributes.target_temp_low = targetLow;
    setWritable(writable, 'target_temp_low', device.channels.set_heating);

    const targetHigh = readNumber(device, 'set_cooling', values);
    if (targetHigh !== undefined) attributes.target_temp_high = targetHigh;
    setWritable(writable, 'target_temp_high', device.channels.set_cooling);
  } else if (hasHeating || hasCooling) {
    const loneChannel = hasHeating ? 'set_heating' : 'set_cooling';
    const targetTemperature = readNumber(device, loneChannel, values);
    if (targetTemperature !== undefined) attributes.target_temperature = targetTemperature;
    setWritable(writable, 'setpoint', device.channels[loneChannel]);
  }

  // ACTUAL and HUMIDITY are read-only telemetry in both thermostat and
  // airCondition patterns (write:false) — there is no writable channel to
  // back a target_humidity, so only the current reading is ever populated.
  //
  // With no separate temperature object, type-detector binds ACTUAL to a
  // read-only or write-silent setpoint's OWN object: ACTUAL's pattern
  // (write:false, role /temperature(\..*)?$/) matches it too (Task 5c finding
  // (e)). That object is the target, not a reading, so it is never published
  // as the current temperature.
  const actual = device.channels.actual;
  const actualIsSetpoint =
    actual !== undefined && ['set', 'set_heating', 'set_cooling'].some((name) => device.channels[name]?.objectId === actual.objectId);
  const currentTemperature = actualIsSetpoint ? undefined : readNumber(device, 'actual', values);
  if (currentTemperature !== undefined) attributes.current_temperature = currentTemperature;

  const currentHumidity = readNumber(device, 'humidity', values);
  if (currentHumidity !== undefined) attributes.current_humidity = currentHumidity;

  // MODE is the writable target (e.g. heat/cool/off); WORKING_MODE is the
  // read-only running-state readout (e.g. idle/heat/cool) — HA's closest
  // analogue to WORKING_MODE is hvac_action, not hvac_mode.
  const hvacMode = readEnum(device, 'mode', values);
  if (hvacMode !== undefined) attributes.hvac_mode = hvacMode;
  setLabelWritable(writable, 'hvac_mode', device.channels.mode);

  const hvacAction = readEnum(device, 'working_mode', values);
  if (hvacAction !== undefined) attributes.hvac_action = hvacAction;

  // Fan speed: airCondition only. SPEED (named steps) and SPEED_LEVEL (a
  // percentage) are alternates for the same role, same as light.ts treats
  // DIMMER/BRIGHTNESS — prefer the named one, fall back to the percentage.
  //
  // Ruling 25 (fix-round 3): the channel choice must be the SAME for display
  // and for write, decided once by which channel is CONFIGURED, never by
  // which one currently has a usable VALUE. The previous version read
  // `readEnum(speed) ?? String(speedLevel)`: when SPEED was configured but
  // valueless, display silently borrowed SPEED_LEVEL's percentage while
  // setWritable (below) still pointed writes at SPEED (the channel object
  // exists regardless of its value) -- so fan_mode could display "42" and a
  // command would write the number 42 into an enum channel that has no code
  // 42, landing wrong with ok:true. If SPEED is configured, fan_mode comes
  // from SPEED alone, usable value or not; SPEED_LEVEL backs it only when
  // SPEED is not configured at all.
  let fanMode: string | undefined;
  if (device.channels.speed) {
    fanMode = readEnum(device, 'speed', values);
  } else {
    const speedLevel = readNumber(device, 'speed_level', values);
    fanMode = speedLevel !== undefined ? String(speedLevel) : undefined;
  }
  if (fanMode !== undefined) attributes.fan_mode = fanMode;
  const fanChannel = device.channels.speed ?? device.channels.speed_level;
  setLabelWritable(writable, 'fan_mode', fanChannel);

  // The two SWING channels are resolved by role at the detector layer
  // (detector.ts's channelName): 'swing' is the numeric multi-position
  // control, 'swing_toggle' is the boolean on/off toggle. They are read here
  // as two independent attributes, never merged.
  const swingMode = readEnum(device, 'swing', values);
  if (swingMode !== undefined) attributes.swing_mode = swingMode;
  setLabelWritable(writable, 'swing_mode', device.channels.swing);

  const swingHorizontal = readBoolAttr(device, 'swing_toggle', values);
  if (swingHorizontal !== undefined) attributes.swing_horizontal_mode = swingHorizontal;
  // toBoolState never reads a states map, so only a boolean codec is its
  // exact inverse (encodeChannelValue maps exactly on/off to true/false).
  // The bit (via writable) and the on/off list below share this one
  // condition, so they can never disagree (Ruling 36).
  const swingToggle = device.channels.swing_toggle;
  const swingToggleCommandable =
    swingToggle?.write === true && roleCodec('swing_horizontal_mode', swingToggle)?.type === 'boolean';
  if (swingToggle) writable.swing_horizontal_mode = swingToggleCommandable;

  const power = readBoolAttr(device, 'power', values);
  if (power !== undefined) attributes.power = power;
  setWritable(writable, 'power', device.channels.power);

  const boost = readBoolAttr(device, 'boost', values);
  if (boost !== undefined) attributes.boost = boost;
  setWritable(writable, 'boost', device.channels.boost);

  // available: at least one read above added an attribute beyond the
  // friendly_name/icon baseline, i.e. a channel this synth actually reads
  // holds a usable, decodable value -- not merely a configured one (that
  // case is the null-return above). A configured channel shadowed by a
  // preferred alternate is never read, so its value cannot make the entity
  // available on its own: SET_HEATING/SET_COOLING when a plain SET exists,
  // and SPEED_LEVEL when SPEED is configured (Ruling 25).
  const available = Object.keys(attributes).length > baselineKeys;
  const state = hvacMode ?? (available ? STATE_UNKNOWN : STATE_UNAVAILABLE);

  // Task 5b: the firmware draws a mode/fan/swing option list ONLY from these
  // lists. Added only now that `available` is settled: a list is channel
  // metadata, not a reading, and must never make a valueless device look
  // available. Each comes from the one channel its role reads and writes
  // (fanChannel above, Ruling 25), and each is omitted when empty.
  for (const [role, channel, names] of [
    ['hvac_mode', device.channels.mode, HVAC_MODE_NAMES],
    ['fan_mode', fanChannel, FAN_MODE_NAMES],
    ['swing_mode', device.channels.swing, SWING_MODE_NAMES],
  ] as const) {
    const modes = enumModes(role, channel, names);
    if (modes.length) attributes[`${role}s`] = modes;
  }
  if (swingToggleCommandable) attributes.swing_horizontal_modes = ['off', 'on'];

  // Task 8 round 1 (Ruling 49): the panel clamps every setpoint it offers to
  // min_temp..max_temp (7..35 when absent, climate_popup.cpp:225-231), and
  // the dispatcher refuses one outside the setpoint channel's declared range.
  // Publishing that range keeps the two one set -- metadata again, so it
  // waits for `available` like the lists above. A range's two handles share
  // one min/max: the heating minimum and the cooling maximum. A bound the
  // channel does not declare is left to the firmware, never invented.
  const low = hasPlainSet ? device.channels.set : (device.channels.set_heating ?? device.channels.set_cooling);
  const high = hasPlainSet ? device.channels.set : (device.channels.set_cooling ?? device.channels.set_heating);
  if (typeof low?.min === 'number' && Number.isFinite(low.min)) attributes.min_temp = low.min;
  if (typeof high?.max === 'number' && Number.isFinite(high.max)) attributes.max_temp = high.max;

  return { entityId, domain: 'climate', source, state, attributes, available, lastChanged, writable, channelMeta };
}
