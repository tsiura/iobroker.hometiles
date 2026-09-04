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
  const read = readChannel(device, 'actual', values) ?? readChannel(device, 'set', values);

  const attributes: Record<string, unknown> = { ...friendly };
  const deviceClass =
    DEVICE_CLASS_BY_DETECTOR[device.detectorType] ??
    (read?.channel.role ? DEVICE_CLASS_BY_ROLE[read.channel.role] : undefined);
  if (deviceClass) attributes.device_class = deviceClass;
  if (read?.channel.unit) attributes.unit_of_measurement = read.channel.unit;
  if (read?.channel.states) attributes.options = Object.values(read.channel.states);

  if (!read || !isUsable(read.value)) {
    return { entityId, domain: 'sensor', source, state: UNAVAILABLE, attributes, available: false, lastChanged };
  }

  const numeric = read.channel.type === 'number' || typeof read.value.val === 'number';
  const state = numeric ? numberToState(read.value.val) : String(read.value.val);
  if (numeric) attributes.state_class = 'measurement';

  return { entityId, domain: 'sensor', source, state, attributes, available: true, lastChanged };
}
