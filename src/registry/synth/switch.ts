import type { DeviceInput, VirtualEntity } from '../types';
import { baseEntity, isUsable, readChannel, toBoolState, UNAVAILABLE, type Values } from './common';

export function synthSwitch(device: DeviceInput, entityId: string, values: Values): VirtualEntity {
  const { source, lastChanged, friendly } = baseEntity(device, entityId, values);
  const actual = readChannel(device, 'actual', values);
  const set = readChannel(device, 'set', values);
  // ACTUAL is real feedback and wins over the last command written to SET.
  const read = actual && isUsable(actual.value) ? actual : set;

  const attributes: Record<string, unknown> = { ...friendly };
  // Without an ACTUAL channel the only evidence is SET. An unacknowledged SET
  // means the device never confirmed, which is exactly what assumed_state says.
  attributes.assumed_state = !actual && !(set?.value?.ack ?? false);

  if (!read || !isUsable(read.value)) {
    return { entityId, domain: 'switch', source, state: UNAVAILABLE, attributes, available: false, lastChanged };
  }

  return {
    entityId,
    domain: 'switch',
    source,
    state: toBoolState(read.value.val),
    attributes,
    available: true,
    lastChanged,
  };
}
