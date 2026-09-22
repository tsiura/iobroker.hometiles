import type { ChannelInput, DeviceInput, VirtualEntity } from '../types';
import { STATE_UNAVAILABLE, STATE_UNKNOWN } from '../types';
import { baseEntity, isUsable, readChannel, toBoolState, type Values } from './common';

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
 * thermostat has NO required channel at all (docs/contract-iobroker-types.md)
 * and airCondition requires only MODE, so a detected device may have none of
 * these configured either; returning null here rather than an entity with
 * nothing behind it is the same defence as before, just drawn at the
 * boundary the firmware actually enforces.
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

export function synthClimate(device: DeviceInput, entityId: string, values: Values): VirtualEntity | null {
  // The trap: thermostat has no required channel and airCondition requires
  // only MODE, so a detected device may have nothing among the roles below.
  // Returning null here — rather than an "unavailable" entity — means no
  // hollow tile is ever registered for it. Narrowed to VALIDITY_CHANNELS
  // (review round 1, M6): a device exposing only SPEED/SPEED_LEVEL/SWING/
  // SWING_TOGGLE/POWER/BOOST would previously have synthesised anyway, then
  // published a payload the firmware always rejects as invalid.
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
  const currentTemperature = readNumber(device, 'actual', values);
  if (currentTemperature !== undefined) attributes.current_temperature = currentTemperature;

  const currentHumidity = readNumber(device, 'humidity', values);
  if (currentHumidity !== undefined) attributes.current_humidity = currentHumidity;

  // MODE is the writable target (e.g. heat/cool/off); WORKING_MODE is the
  // read-only running-state readout (e.g. idle/heat/cool) — HA's closest
  // analogue to WORKING_MODE is hvac_action, not hvac_mode.
  const hvacMode = readEnum(device, 'mode', values);
  if (hvacMode !== undefined) attributes.hvac_mode = hvacMode;
  setWritable(writable, 'hvac_mode', device.channels.mode);

  const hvacAction = readEnum(device, 'working_mode', values);
  if (hvacAction !== undefined) attributes.hvac_action = hvacAction;

  // Fan speed: airCondition only. SPEED (named steps) and SPEED_LEVEL (a
  // percentage) are alternates for the same role, same as light.ts treats
  // DIMMER/BRIGHTNESS — prefer the named one, fall back to the percentage.
  const speedLevel = readNumber(device, 'speed_level', values);
  const fanMode = readEnum(device, 'speed', values) ?? (speedLevel !== undefined ? String(speedLevel) : undefined);
  if (fanMode !== undefined) attributes.fan_mode = fanMode;
  setWritable(writable, 'fan_mode', device.channels.speed ?? device.channels.speed_level);

  // The two SWING channels are resolved by role at the detector layer
  // (detector.ts's channelName): 'swing' is the numeric multi-position
  // control, 'swing_toggle' is the boolean on/off toggle. They are read here
  // as two independent attributes, never merged.
  const swingMode = readEnum(device, 'swing', values);
  if (swingMode !== undefined) attributes.swing_mode = swingMode;
  setWritable(writable, 'swing_mode', device.channels.swing);

  const swingHorizontal = readBoolAttr(device, 'swing_toggle', values);
  if (swingHorizontal !== undefined) attributes.swing_horizontal_mode = swingHorizontal;
  setWritable(writable, 'swing_horizontal_mode', device.channels.swing_toggle);

  const power = readBoolAttr(device, 'power', values);
  if (power !== undefined) attributes.power = power;
  setWritable(writable, 'power', device.channels.power);

  const boost = readBoolAttr(device, 'boost', values);
  if (boost !== undefined) attributes.boost = boost;
  setWritable(writable, 'boost', device.channels.boost);

  // available reflects whether any configured channel currently holds a
  // usable value, not just whether one is structurally configured (that
  // distinction is already handled by the null-return above): every usable
  // read above added a key beyond the friendly_name/icon baseline.
  const available = Object.keys(attributes).length > baselineKeys;
  const state = hvacMode ?? (available ? STATE_UNKNOWN : STATE_UNAVAILABLE);

  return { entityId, domain: 'climate', source, state, attributes, available, lastChanged, writable, channelMeta };
}
