import type { DeviceInput, VirtualEntity } from '../types';
import { synthBinarySensor } from './binary_sensor';
import { synthClimate } from './climate';
import type { Values } from './common';
import { synthCover } from './cover';
import { synthDatetime, synthNumber, synthSelect } from './editable';
import { synthLight } from './light';
import { synthMediaPlayer } from './media_player';
import { synthScene } from './scene';
import { synthSensor } from './sensor';
import { synthSwitch } from './switch';
import { synthWeather } from './weather';

export type { Values } from './common';

/**
 * VirtualEntity | null: climate is the first domain whose synth can find
 * nothing usable behind a device (type-detector 6.0.1 requires a setpoint,
 * but a later ^6 minor or a domain override need not; see synthClimate).
 * Returning null here means no hollow
 * entity is ever registered, rather than one that reports "unavailable"
 * forever.
 */
export function synthesise(device: DeviceInput, entityId: string, values: Values): VirtualEntity | null {
  switch (device.domain) {
    case 'sensor':
      return synthSensor(device, entityId, values);
    case 'binary_sensor':
      return synthBinarySensor(device, entityId, values);
    case 'switch':
      return synthSwitch(device, entityId, values);
    case 'light':
      return synthLight(device, entityId, values);
    case 'scene':
      return synthScene(device, entityId, values);
    case 'climate':
      return synthClimate(device, entityId, values);
    case 'cover':
      return synthCover(device, entityId, values);
    case 'media_player':
      return synthMediaPlayer(device, entityId, values);
    case 'weather':
      return synthWeather(device, entityId, values);
    case 'number':
      return synthNumber(device, entityId, values);
    case 'select':
      return synthSelect(device, entityId, values);
    case 'datetime':
      return synthDatetime(device, entityId, values);
  }
}
