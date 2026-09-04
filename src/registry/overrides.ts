import type { DeviceOverride } from '../config/options';
import type { DeviceInput, Domain } from './types';
import { DOMAINS } from './types';

function isDomain(value: string | undefined): value is Domain {
  return !!value && (DOMAINS as readonly string[]).includes(value);
}

/**
 * Overrides are keyed by ioBroker object id, never by position, so reordering
 * or filtering the admin table can never reassign an override to another device.
 */
export function applyOverrides(devices: DeviceInput[], overrides: DeviceOverride[]): DeviceInput[] {
  const byObjectId = new Map(overrides.map((override) => [override.objectId, override]));
  const result: DeviceInput[] = [];

  for (const device of devices) {
    const override = byObjectId.get(device.objectId);
    if (override && override.include === false) continue;
    if (!override) {
      result.push(device);
      continue;
    }

    const name = (override.name ?? '').trim();
    result.push({
      ...device,
      name: name || device.name,
      domain: isDomain(override.forcedDomain) ? override.forcedDomain : device.domain,
    });
  }

  return result;
}
