import type { DeviceOverride } from '../config/options';
import { lastSegment, type IoBrokerObject } from './detector';
import type { DeviceInput, Domain } from './types';
import { DOMAINS } from './types';

function isDomain(value: string | undefined): value is Domain {
  return !!value && (DOMAINS as readonly string[]).includes(value);
}

/**
 * The detected devices the user picked (Task 21b): only a device whose row
 * says include: true reaches the panels. No row, or any other include, keeps
 * it off them -- a large installation does not fit in one bridge/apply
 * (Task 21), so nothing is published unless picked. A picked device takes
 * its row's name and forced domain.
 *
 * Rows are keyed by ioBroker object id, never by position, so reordering or
 * filtering the admin table can never move a choice to another device.
 */
export function applyOverrides(devices: DeviceInput[], overrides: DeviceOverride[]): DeviceInput[] {
  const byObjectId = new Map(overrides.map((override) => [override.objectId, override]));
  const result: DeviceInput[] = [];

  for (const device of devices) {
    const override = byObjectId.get(device.objectId);
    if (override?.include !== true) continue;

    const name = (override.name ?? '').trim();
    result.push({
      ...device,
      name: name || device.name,
      domain: isDomain(override.forcedDomain) ? override.forcedDomain : device.domain,
    });
  }

  return result;
}

/** What detection found of one device: the picker shows it read-only beside the user's choices. */
export type Detected = Required<Pick<DeviceOverride, 'objectId' | 'detectedName' | 'detectedDomain' | 'room'>>;

/** An enum's name in `language`, else in English, else its id's last segment. */
function enumName(id: string, name: unknown, language: string): string {
  if (typeof name === 'string' && name.trim()) return name.trim();
  const names = (name && typeof name === 'object' ? name : {}) as Record<string, unknown>;
  for (const text of [names[language], names.en]) if (typeof text === 'string' && text.trim()) return text.trim();
  return lastSegment(id);
}

/**
 * One picker row per detected device: its name and domain as detection has
 * them, and the rooms, then the functions, whose members hold the device or
 * one of its states -- the object itself or anything above it. An enum whose
 * members are no list is passed over, as discovery passes over one.
 */
export function detectedRows(
  devices: readonly DeviceInput[],
  objects: Readonly<Record<string, IoBrokerObject>>,
  language: string,
): Detected[] {
  const rooms = (id: string): number => (id.startsWith('enum.rooms.') ? 0 : 1);
  const enumIds = Object.keys(objects)
    .filter((id) => objects[id]?.type === 'enum' && (id.startsWith('enum.rooms.') || id.startsWith('enum.functions.')))
    .sort((a, b) => rooms(a) - rooms(b) || (a < b ? -1 : a > b ? 1 : 0));
  // Member id -> the enums listing it.
  const listedIn = new Map<string, string[]>();
  for (const id of enumIds) {
    const members = (objects[id]?.common as { members?: unknown } | undefined)?.members;
    if (!Array.isArray(members)) continue;
    for (const member of members) if (typeof member === 'string') listedIn.set(member, [...(listedIn.get(member) ?? []), id]);
  }

  return devices.map((device) => {
    const holding = new Set<string>();
    for (const start of [device.objectId, ...Object.values(device.channels).map((channel) => channel.objectId)]) {
      for (let id = start; id; id = id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : '') {
        for (const enumId of listedIn.get(id) ?? []) holding.add(enumId);
      }
    }
    const names = enumIds
      .filter((id) => holding.has(id))
      .map((id) => enumName(id, (objects[id]?.common as { name?: unknown } | undefined)?.name, language));
    return { objectId: device.objectId, detectedName: device.name, detectedDomain: device.domain, room: [...new Set(names)].join(', ') };
  });
}

/**
 * The picker's rows after a refresh (Task 21b): every detected device, a new
 * one unticked; a row the user has keeps its include, name and forced domain,
 * with what detection found brought up to date; a row whose device is
 * detected no more stays as it was. Ordered by object id in code units, the
 * same under every locale, so a refresh orders the rows alike whatever order
 * they came in. A row naming no object selects nothing and is dropped; of two
 * rows for one device the last is kept, the one applyOverrides reads.
 */
export function mergeDetected(rows: readonly DeviceOverride[], detected: readonly Detected[]): DeviceOverride[] {
  const byObjectId = new Map<string, DeviceOverride>();
  for (const row of rows) if (row.objectId.trim()) byObjectId.set(row.objectId, row);
  for (const found of detected) {
    byObjectId.set(found.objectId, { ...(byObjectId.get(found.objectId) ?? { include: false, name: '', forcedDomain: '' }), ...found });
  }
  return [...byObjectId.values()].sort((a, b) => (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0));
}
