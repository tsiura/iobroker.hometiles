import type { DeviceInput, VirtualEntity } from '../types';
import { synthBinarySensor } from './binary_sensor';
import { hasClimateChannel, synthClimate } from './climate';
import type { Values } from './common';
import { synthCover } from './cover';
import { synthDatetime, synthNumber, synthSelect, valueChannel } from './editable';
import { synthLight } from './light';
import { playerState, synthMediaPlayer } from './media_player';
import { synthScene } from './scene';
import { synthSensor } from './sensor';
import { synthSwitch } from './switch';
import { synthWeather, weatherReadings } from './weather';

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

/** What a device can lack for a type (Ruling 139), each named in admin/i18n as lack_<code>. */
export const LACKS = ['climate_channels', 'player_state', 'weather_reading', 'value_channel'] as const;
export type Lack = (typeof LACKS)[number];

/**
 * What `device` lacks to be made an entity of its domain, or undefined: the
 * very test each synth returns null by, so synthesise makes none exactly
 * when this names a lack (Ruling 139). Only a forced type can meet one:
 * each detector type brings what its domain needs.
 */
export function lacks(device: DeviceInput): Lack | undefined {
  switch (device.domain) {
    case 'sensor':
    case 'binary_sensor':
    case 'switch':
    case 'light':
    case 'scene':
    case 'cover':
      return undefined;
    case 'climate':
      return hasClimateChannel(device) ? undefined : 'climate_channels';
    case 'media_player':
      return playerState(device) ? undefined : 'player_state';
    case 'weather':
      return weatherReadings(device) ? undefined : 'weather_reading';
    case 'number':
    case 'select':
    case 'datetime':
      return valueChannel(device.channels) ? undefined : 'value_channel';
  }
}
