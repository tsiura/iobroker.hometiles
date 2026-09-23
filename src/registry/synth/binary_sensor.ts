import type { DeviceInput, VirtualEntity } from '../types';
import { baseEntity, isUsable, readChannel, toBoolState, UNAVAILABLE, type Values } from './common';

const DEVICE_CLASS_BY_DETECTOR: Record<string, string> = {
  window: 'window',
  windowTilt: 'window',
  door: 'door',
  contact: 'opening',
  motion: 'motion',
  fireAlarm: 'smoke',
  floodAlarm: 'moisture',
  coAlarm: 'carbon_monoxide',
  warning: 'problem',
};

export function synthBinarySensor(device: DeviceInput, entityId: string, values: Values): VirtualEntity {
  const { source, lastChanged, friendly } = baseEntity(device, entityId, values);
  // readChannel returns a non-null wrapper for any CONFIGURED channel even
  // when its value is null, so `readChannel(actual) ?? readChannel(set)`
  // never falls through. Matches switch.ts's pattern: prefer ACTUAL only when
  // it is actually usable, otherwise fall back to SET. `level` is the reading
  // of the one mapped binary type whose required state is not ACTUAL
  // (typePatterns.js warning: LEVEL).
  const actual = readChannel(device, 'actual', values) ?? readChannel(device, 'level', values);
  const set = readChannel(device, 'set', values);
  const read = actual && isUsable(actual.value) ? actual : set;

  const attributes: Record<string, unknown> = { ...friendly };
  const deviceClass = DEVICE_CLASS_BY_DETECTOR[device.detectorType];
  if (deviceClass) attributes.device_class = deviceClass;

  if (!read || !isUsable(read.value)) {
    return {
      entityId,
      domain: 'binary_sensor',
      source,
      state: UNAVAILABLE,
      attributes,
      available: false,
      lastChanged,
    };
  }

  return {
    entityId,
    domain: 'binary_sensor',
    source,
    state: toBoolState(read.value.val),
    attributes,
    available: true,
    lastChanged,
  };
}
