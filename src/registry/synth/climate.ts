import type { ChannelInput, DeviceInput, VirtualEntity } from '../types';
import { STATE_UNAVAILABLE, STATE_UNKNOWN } from '../types';
import { baseEntity, isUsable, readChannel, toBoolState, type Values } from './common';

/**
 * Channel roles this synthesiser understands, by their internal (lowercased)
 * name in DeviceInput.channels — see detector.ts's channelName. thermostat
 * has NO required channel at all (docs/contract-iobroker-types.md) and
 * airCondition requires only MODE, so a detected climate device may have none
 * of these configured. If none are present, synthClimate returns null rather
 * than emitting an entity with nothing behind it.
 */
const TRACKED_CHANNELS = [
  'set',
  'set_heating',
  'set_cooling',
  'actual',
  'humidity',
  'mode',
  'working_mode',
  'speed',
  'speed_level',
  'swing',
  'swing_toggle',
  'power',
  'boost',
] as const;

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
  // hollow tile is ever registered for it.
  if (!TRACKED_CHANNELS.some((name) => device.channels[name])) return null;

  const { source, lastChanged, friendly } = baseEntity(device, entityId, values);
  const attributes: Record<string, unknown> = { ...friendly };
  const baselineKeys = Object.keys(attributes).length;
  const writable: Record<string, boolean> = {};

  // Single setpoint. Never fabricated from ACTUAL: a read-only thermostat
  // (ACTUAL present, SET absent) must not appear to have a settable target.
  const targetTemperature = readNumber(device, 'set', values);
  if (targetTemperature !== undefined) attributes.target_temperature = targetTemperature;
  setWritable(writable, 'setpoint', device.channels.set);

  // Dual setpoint. SET_HEATING/SET_COOLING are separate from SET: a
  // dual-setpoint thermostat may expose only these two and no SET at all.
  const targetLow = readNumber(device, 'set_heating', values);
  if (targetLow !== undefined) attributes.target_temp_low = targetLow;
  setWritable(writable, 'target_temp_low', device.channels.set_heating);

  const targetHigh = readNumber(device, 'set_cooling', values);
  if (targetHigh !== undefined) attributes.target_temp_high = targetHigh;
  setWritable(writable, 'target_temp_high', device.channels.set_cooling);

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

  return { entityId, domain: 'climate', source, state, attributes, available, lastChanged, writable };
}
