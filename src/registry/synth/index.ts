import type { DeviceInput, VirtualEntity } from '../types';
import { synthBinarySensor } from './binary_sensor';
import type { Values } from './common';
import { synthLight } from './light';
import { synthScene } from './scene';
import { synthSensor } from './sensor';
import { synthSwitch } from './switch';

export type { Values } from './common';

export function synthesise(device: DeviceInput, entityId: string, values: Values): VirtualEntity {
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
  }
}
