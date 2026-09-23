import type { DeviceInput, VirtualEntity } from '../types';
import { STATE_UNKNOWN } from '../types';
import { baseEntity, type Values } from './common';

/**
 * A scene has no meaningful state: Home Assistant reports the last activation
 * timestamp and HomeTiles only ever fires it. It stays available so the tile
 * remains pressable, and no state is ever published for it.
 */
export function synthScene(device: DeviceInput, entityId: string, values: Values): VirtualEntity {
  // channelMeta carries each channel's write flag: the dispatcher refuses a
  // read-only one (Ruling 38).
  const { source, channelMeta, lastChanged, friendly } = baseEntity(device, entityId, values);
  return {
    entityId,
    domain: 'scene',
    source,
    state: STATE_UNKNOWN,
    attributes: { ...friendly },
    available: true,
    lastChanged,
    channelMeta,
  };
}
