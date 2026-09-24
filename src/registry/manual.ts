import type { ManualEntity } from '../config/options';
import { channelInput, lastSegment, objectMeta, type IoBrokerObject, type ObjectMeta } from './detector';
import type { DeviceInput, Domain } from './types';

/**
 * The domains one state can serve, each with the state types its synth can
 * use (Task 13b). A state without a type holds any value, as a mixed one does.
 *
 * - sensor (synthSensor): a number, or any value's text. A boolean is a
 *   binary_sensor's.
 * - binary_sensor (toBoolState): a boolean, a number (0 is off), an on/off text.
 * - switch, scene: the dispatcher writes true and false raw, as a socket's and
 *   a button's SET take them (typePatterns.js: both Boolean), so neither
 *   takes a state whose write is false: every press would act on nothing.
 * - number (synthNumber): a number.
 * - select (selectOptions): a number's or a text's states map.
 * - datetime: a date or time text; an epoch-ms number is synthDatetime's to
 *   read (Ruling 84), so it is let through rather than decided here.
 *
 * light, cover, climate, media_player and weather need a device's several
 * states: detection and overrides serve them.
 */
const USABLE_TYPES = new Map<string, readonly string[]>([
  ['sensor', ['number', 'string', 'mixed']],
  ['binary_sensor', ['boolean', 'number', 'string', 'mixed']],
  ['switch', ['boolean']],
  ['scene', ['boolean']],
  ['number', ['number']],
  ['select', ['number', 'string']],
  ['datetime', ['string', 'number']],
]);

/** The domains a manual entity can take: the admin table offers exactly these. */
export const MANUAL_DOMAINS: readonly string[] = [...USABLE_TYPES.keys()];

export interface ManualDevices {
  devices: DeviceInput[];
  /** At most one per state id: main.ts logs each once per rebuild. */
  rejected: Array<{ stateId: string; reason: string }>;
}

/** The state's metadata when it alone can serve the domain, else why not. */
function servable(
  stateId: string,
  domain: string,
  objects: Readonly<Record<string, IoBrokerObject>>,
  ownNamespace: string,
): ObjectMeta | string {
  const types = USABLE_TYPES.get(domain);
  if (!types) return `"${domain}" is not a domain one state can serve (${[...USABLE_TYPES.keys()].join(', ')})`;
  const obj = Object.hasOwn(objects, stateId) ? objects[stateId] : undefined;
  if (!obj) return 'no such object';
  if (obj.type !== 'state') return `not a state object (type ${obj.type})`;
  // The adapter's own panel states never reach the registry (main.ts
  // onStateChange), and its objects are no devices: discovery leaves the
  // namespace out too.
  if (stateId.startsWith(`${ownNamespace}.`)) return "the adapter's own state";
  const info = objectMeta(stateId, obj);
  if (!types.includes(info.type ?? 'mixed')) return `${domain} cannot use a state of type ${info.type ?? 'mixed (none declared)'}`;
  // Only an explicit false (Ruling 38): no write flag at all stays writable.
  if (info.write === false && domain === 'switch') return 'switch cannot use a read-only state (write false); declare it as binary_sensor';
  if (info.write === false && domain === 'scene') return 'scene cannot use a read-only state (write false)';
  return info;
}

/**
 * The devices the user declared by state id (Task 13b), built as detection
 * builds one: the object's metadata through objectMeta and channelInput, one
 * channel under the name the domain's synth reads. A sensor's reading is
 * `actual` whatever its write flag, since it writes nothing; every other
 * domain writes `set` (the dispatcher, valueChannel) and reads a state that
 * refuses writes as `actual`. The name is the entry's, else the object's as
 * detection reads it.
 *
 * The key is `manual:<state id>`, not the state id: discoverDevices keys a
 * root's further controls by their own state, and a manual entity on that
 * state must keep an id of its own (and its own persisted one) beside the
 * detected entity's. Entries are rejected, never thrown on: the first entry
 * of a state id decides, and a later one is reported once. A datetime keeps
 * its declared kind (Ruling 92); no other domain has one.
 */
export function manualDevices(
  entries: readonly ManualEntity[],
  objects: Readonly<Record<string, IoBrokerObject>>,
  ownNamespace: string,
): ManualDevices {
  const devices: DeviceInput[] = [];
  const rejected: ManualDevices['rejected'] = [];
  const seen = new Set<string>();
  // Each state reported once, by one Set lookup: scanning the reports for
  // every duplicate took half a second at 40,000 entries (m6).
  const reported = new Set<string>();
  const reject = (stateId: string, reason: string): void => {
    if (reported.has(stateId)) return;
    reported.add(stateId);
    rejected.push({ stateId, reason });
  };
  for (const { stateId, domain, name, kind } of entries) {
    if (seen.has(stateId)) {
      reject(stateId, 'listed more than once; the first entry is used');
      continue;
    }
    seen.add(stateId);
    const info = servable(stateId, domain, objects, ownNamespace);
    if (typeof info === 'string') {
      reject(stateId, info);
      continue;
    }
    const channel = channelInput(stateId, info);
    const reads = domain === 'sensor' || domain === 'binary_sensor' || channel.write === false ? 'actual' : 'set';
    const device: DeviceInput = {
      objectId: `manual:${stateId}`,
      name: name?.trim() || info.name.trim() || lastSegment(stateId),
      detectorType: 'manual',
      domain: domain as Domain,
      channels: { [reads]: channel },
    };
    if (info.icon) device.icon = info.icon;
    if (domain === 'datetime' && kind) device.kind = kind;
    devices.push(device);
  }
  return { devices, rejected };
}

/** How many entries one log line names (m6). */
const LISTED = 20;

/** Log items as one bounded line: the first 20, then how many more (m6). */
export function listed(items: readonly string[]): string {
  const more = items.length - LISTED;
  return items.slice(0, LISTED).join(', ') + (more > 0 ? `, and ${more} more` : '');
}
