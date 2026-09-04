import type { DeviceInput, VirtualEntity } from '../types';
import { baseEntity, isUsable, numberToState, readChannel, UNAVAILABLE, type Values } from './common';

/** Detector type to Home Assistant device_class, for the numeric sensors v0.1 covers. */
const DEVICE_CLASS_BY_DETECTOR: Record<string, string> = {
  temperature: 'temperature',
  humidity: 'humidity',
  illuminance: 'illuminance',
  pressure: 'pressure',
};

const DEVICE_CLASS_BY_ROLE: Record<string, string> = {
  'value.temperature': 'temperature',
  'value.humidity': 'humidity',
  'value.brightness': 'illuminance',
  'value.pressure': 'pressure',
  'value.battery': 'battery',
  'value.power': 'power',
  'value.voltage': 'voltage',
  'value.current': 'current',
};

export function synthSensor(device: DeviceInput, entityId: string, values: Values): VirtualEntity {
  const { source, lastChanged, friendly } = baseEntity(device, entityId, values);
  // readChannel returns a non-null wrapper for any CONFIGURED channel even
  // when its value is null, so `readChannel(actual) ?? readChannel(set)`
  // never falls through. Matches switch.ts's pattern: prefer ACTUAL only when
  // it is actually usable, otherwise fall back to SET.
  const actual = readChannel(device, 'actual', values);
  const set = readChannel(device, 'set', values);
  const read = actual && isUsable(actual.value) ? actual : set;

  const attributes: Record<string, unknown> = { ...friendly };
  const deviceClass =
    DEVICE_CLASS_BY_DETECTOR[device.detectorType] ??
    (read?.channel.role ? DEVICE_CLASS_BY_ROLE[read.channel.role] : undefined);
  if (deviceClass) attributes.device_class = deviceClass;
  if (read?.channel.unit) attributes.unit_of_measurement = read.channel.unit;
  if (read?.channel.states) attributes.options = Object.values(read.channel.states);

  // Declared from the channel's own ioBroker type, not from whether a value is
  // currently usable: protocol/apply.ts reads this attribute to decide
  // state_kind, and that section is only re-pushed on registry membership
  // changes, not on every state change. A sensor that is unavailable at
  // adapter startup must still be recognisable as numeric, or it is
  // classified as categorical once and stays that way even after it starts
  // reporting real numbers.
  //
  // Deliberately from `actual ?? set` (channel EXISTENCE), not from `read`
  // (which already picked a channel by value USABILITY): when ACTUAL is
  // configured but not yet usable and there is no SET channel at all, `read`
  // has already fallen through to null, which would silently lose ACTUAL's
  // own declared type right when it is needed most — at startup, before any
  // value has arrived.
  const declaredNumeric = (actual ?? set)?.channel.type === 'number';
  if (declaredNumeric) attributes.state_class = 'measurement';

  if (!read || !isUsable(read.value)) {
    return { entityId, domain: 'sensor', source, state: UNAVAILABLE, attributes, available: false, lastChanged };
  }

  const numeric = declaredNumeric || typeof read.value.val === 'number';
  const state = numeric ? numberToState(read.value.val) : String(read.value.val);
  if (numeric) attributes.state_class = 'measurement';

  return { entityId, domain: 'sensor', source, state, attributes, available: true, lastChanged };
}
