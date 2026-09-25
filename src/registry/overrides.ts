import type { ClimateModeRow, DeviceOverride } from '../config/options';
import { lastSegment, type IoBrokerObject } from './detector';
import { lacks, type Lack } from './synth/index';
import type { ChannelInput, DeviceInput, Domain } from './types';
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

/**
 * The picked devices whose forced type makes no entity (Ruling 139): each
 * with that type and what the device lacks for it, by the synths' own test
 * (lacks). They stay no entity, as Task 13 pinned; main.ts names them. A
 * type the detector found is no force.
 */
export function unbuiltForces(
  detected: readonly DeviceInput[],
  picked: readonly DeviceInput[],
): Array<{ objectId: string; domain: Domain; lack: Lack }> {
  const found = new Map(detected.map((device) => [device.objectId, device.domain]));
  return picked.flatMap((device) => {
    const lack = device.domain === found.get(device.objectId) ? undefined : lacks(device);
    return lack ? [{ objectId: device.objectId, domain: device.domain, lack }] : [];
  });
}

/** A Climate modes row left out, and why, in English (Ruling 141). */
export interface RejectedClimateMode {
  row: ClimateModeRow;
  reason: string;
}

/**
 * The key of the one state of a mode state that a device mode names: its
 * value, or its label in any case, as encodeChannelValue reads labels. With no
 * states map, the raw value itself, as readEnum looks it up (String(raw)).
 */
function modeKey(mode: ChannelInput, deviceMode: string): string | undefined {
  const wanted = deviceMode.trim();
  if (!wanted) return undefined;
  const entries = Object.entries(mode.states ?? {});
  if (entries.length === 0) {
    if (mode.type !== 'number') return wanted;
    const numeric = Number(wanted);
    return Number.isFinite(numeric) ? String(numeric) : undefined;
  }
  const label = wanted.toLowerCase();
  const keys = entries.filter(([key, own]) => key === wanted || own.trim().toLowerCase() === label).map(([key]) => key);
  return new Set(keys).size === 1 ? keys[0] : undefined;
}

/**
 * The Climate modes table (Ruling 141). Each row names a state of a picked
 * climate device's mode state, and the firmware hvac name the panel shows
 * for it. That state is relabelled with the name in the device's own states
 * map, which readEnum decodes, enumModes lists and encodeChannelValue
 * reverses: the one codec shows the device's MANU as heat, lists heat, and
 * writes MANU's own raw value for the panel's heat. A label no row maps keeps
 * what it had, a firmware name or not.
 *
 * A row is left out, with its reason, when its device is no picked climate
 * device, has no mode state, or holds no one state its device mode names;
 * when two rows map one state; and when its panel mode would stand for more
 * than one state -- two rows' or a state already labelled so -- since the
 * codec could then write neither. Leaving a row out gives its state its own
 * label back, which can clash in turn, so the check runs until none does.
 */
export function applyClimateModes(
  devices: readonly DeviceInput[],
  rows: readonly ClimateModeRow[],
): { devices: DeviceInput[]; rejected: RejectedClimateMode[] } {
  const rejected: Array<RejectedClimateMode & { index: number }> = [];
  const climate = new Map(devices.filter((device) => device.domain === 'climate').map((device) => [device.objectId, device]));
  // Per device, each row it keeps and the state key the row names.
  const mapped = new Map<string, Array<{ row: ClimateModeRow; index: number; key: string }>>();
  rows.forEach((row, index) => {
    const mode = climate.get(row.device)?.channels.mode;
    const key = mode && modeKey(mode, row.deviceMode);
    if (key !== undefined) mapped.set(row.device, [...(mapped.get(row.device) ?? []), { row, index, key }]);
    else {
      const reason = !climate.has(row.device)
        ? 'no climate device of this id is picked on the Devices tab'
        : !mode
          ? 'the device has no mode state'
          : `not exactly one value or label of ${mode.objectId}`;
      rejected.push({ row, index, reason });
    }
  });

  const relabelled = new Map<string, Record<string, string>>();
  for (const [objectId, entries] of mapped) {
    const own = climate.get(objectId)!.channels.mode!.states ?? {};
    let kept = entries.filter((entry) => {
      if (entries.filter((other) => other.key === entry.key).length === 1) return true;
      rejected.push({ ...entry, reason: 'this device mode is mapped more than once' });
      return false;
    });
    for (;;) {
      const states = { ...own, ...Object.fromEntries(kept.map(({ key, row }) => [key, row.panelMode])) };
      const clashing = kept.filter(({ key, row }) =>
        Object.entries(states).some(([other, label]) => other !== key && label.trim().toLowerCase() === row.panelMode),
      );
      if (clashing.length === 0) {
        if (kept.length > 0) relabelled.set(objectId, states);
        break;
      }
      for (const entry of clashing) rejected.push({ ...entry, reason: `${entry.row.panelMode} would stand for more than one device mode` });
      kept = kept.filter((entry) => !clashing.includes(entry));
    }
  }

  return {
    devices: devices.map((device) => {
      const states = relabelled.get(device.objectId);
      return states ? { ...device, channels: { ...device.channels, mode: { ...device.channels.mode!, states } } } : device;
    }),
    rejected: rejected.sort((a, b) => a.index - b.index).map(({ row, reason }) => ({ row, reason })),
  };
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
 *   would show another row's choice (Ruling 119). A blank row, or one it
 *   cannot read -- its object id no text, or no object at all (N4) -- names no
 *   device: it stays as it is, and selects nothing (validateOptions leaves
 *   it out).
 * - A row of a detected device keeps the user's include, name and forced
 *   domain and takes what detection found, every row of a duplicated id alike
 *   (applyOverrides reads the last).
 * - Its tick is the user's only if this picker wrote the row, in a form this
 *   picker armed (`armed`, the form's native.pickerArmed at PICKER_VERSION):
 *   every other row shows unticked (Rulings 118, 120). A saved Refresh of
 *   44d1111 or 4cbb6d3 left rows of the same shape, with ticks the user
 *   never set in this picker.
 * - A row whose device is detected no more stays, its detected name marked
 *   `mark` once (Ruling 117), after the mark of any language in `marks` is
 *   taken off (Ruling 119, M4): main.ts passes the system's language's text,
 *   and every language's.
 * - New devices follow, unticked, ordered by object id in code units, the
 *   same under every locale.
 */
export function mergeDetected<Row>(
  rows: readonly (DeviceOverride | Row)[],
  detected: readonly Detected[],
  { armed = false, mark = '(not detected)', marks = [mark] }: { armed?: boolean; mark?: string; marks?: readonly string[] } = {},
): (DeviceOverride | Row)[] {
  const found = new Map(detected.map((row) => [row.objectId, row]));
  const merged = rows.map((row) => {
    if (!readable(row) || !row.objectId.trim()) return row;
    const own = armed && byPicker(row) ? row : { ...row, include: false };
    const hit = found.get(row.objectId);
    return hit ? { ...own, ...hit } : { ...own, detectedName: marked(row.detectedName ?? '', mark, marks) };
  });
  const listed = new Set(rows.filter(readable).map((row) => row.objectId));
  const byObjectId = (a: Detected, b: Detected): number => (a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0);
  const added = detected.filter((row) => !listed.has(row.objectId)).sort(byObjectId);
  return [...merged, ...added.map((row) => ({ include: false, name: '', forcedDomain: '', ...row }))];
}

/** A form row the merge can read: an object naming its object id as text. */
function readable(row: unknown): row is DeviceOverride {
  return typeof row === 'object' && row !== null && typeof (row as { objectId?: unknown }).objectId === 'string';
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
