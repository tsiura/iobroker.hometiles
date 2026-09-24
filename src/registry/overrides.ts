import type { DeviceOverride } from '../config/options';
import { lastSegment, type IoBrokerObject } from './detector';
import type { DeviceInput, Domain } from './types';
import { DOMAINS } from './types';

function isDomain(value: string | undefined): value is Domain {
  return !!value && (DOMAINS as readonly string[]).includes(value);
}

/**
 * Whether the picker wrote this row: Refresh fills in what detection found,
 * the detected domain among it. An earlier version's row lacks it -- its
 * checkbox was ticked by default and meant "not excluded" -- and so does a
 * row the table's "+" added (Ruling 118).
 */
export function byPicker(row: DeviceOverride): boolean {
  return typeof row.detectedDomain === 'string' && row.detectedDomain !== '';
}

/**
 * The detected devices the user picked (Task 21b): only a device whose row
 * the picker wrote and the user ticked (include: true) reaches the panels.
 * No row, any other include, or a row of an earlier version keeps it off
 * them -- a large installation does not fit in one bridge/apply (Task 21),
 * so nothing is published unless picked. A picked device takes its row's
 * name and forced domain.
 *
 * Rows are keyed by ioBroker object id, never by position, so reordering or
 * filtering the admin table can never move a choice to another device.
 */
export function applyOverrides(devices: DeviceInput[], overrides: DeviceOverride[]): DeviceInput[] {
  const byObjectId = new Map(overrides.map((override) => [override.objectId, override]));
  const result: DeviceInput[] = [];

  for (const device of devices) {
    const override = byObjectId.get(device.objectId);
    if (override?.include !== true || !byPicker(override)) continue;

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
 * The picker's rows after a refresh (Task 21b), for the form to show and save:
 *
 * - Every row of the form stays where it stands, a blank or duplicated one
 *   too. The admin's table keys each row's cells by index, and a select keeps
 *   the value it mounted with (json-config ConfigTable.js:309,
 *   ConfigSelect.js:161-165): a row moved or dropped from under its cells
 *   would show another row's choice (Ruling 119). A blank row names no
 *   device, stays as it is and selects nothing.
 * - A row of a detected device keeps the user's include, name and forced
 *   domain and takes what detection found, every row of a duplicated id alike
 *   (applyOverrides reads the last).
 * - A row the picker never wrote shows unticked (Ruling 118).
 * - A row whose device is detected no more stays, its detected name marked
 *   `mark` once (Ruling 117), after the mark of any language in `marks` is
 *   taken off (Ruling 119, M4): main.ts passes the system's language's text,
 *   and every language's.
 * - New devices follow, unticked, ordered by object id in code units, the
 *   same under every locale.
 */
export function mergeDetected(
  rows: readonly DeviceOverride[],
  detected: readonly Detected[],
  mark = '(not detected)',
  marks: readonly string[] = [mark],
): DeviceOverride[] {
  const found = new Map(detected.map((row) => [row.objectId, row]));
  const merged = rows.map((row) => {
    if (!row.objectId.trim()) return row;
    const own = byPicker(row) ? row : { ...row, include: false };
    const hit = found.get(row.objectId);
    return hit ? { ...own, ...hit } : { ...own, detectedName: marked(row.detectedName ?? '', mark, marks) };
  });
  const listed = new Set(rows.map((row) => row.objectId));
  const byObjectId = (a: Detected, b: Detected): number => (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0);
  const added = detected.filter((row) => !listed.has(row.objectId)).sort(byObjectId);
  return [...merged, ...added.map((row) => ({ include: false, name: '', forcedDomain: '', ...row }))];
}

/** A missing device's detected name, marked once: every mark it carries, in any language, taken off first. */
function marked(name: string, mark: string, marks: readonly string[]): string {
  let bare = name;
  for (let again = true; again; ) {
    again = false;
    for (const each of [mark, ...marks]) {
      if (!each || !bare.endsWith(each)) continue;
      bare = bare.slice(0, -each.length).trimEnd();
      again = true;
    }
  }
  return bare ? `${bare} ${mark}` : mark;
}
