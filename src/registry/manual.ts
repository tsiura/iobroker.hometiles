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
 *   a button's SET take them (typePatterns.js: both Boolean).
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
  return types.includes(info.type ?? 'mixed') ? info : `${domain} cannot use a state of type ${info.type ?? 'mixed (none declared)'}`;
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
 * of a state id decides, and a later one is reported once.
 */
export function manualDevices(
  entries: readonly ManualEntity[],
  objects: Readonly<Record<string, IoBrokerObject>>,
  ownNamespace: string,
): ManualDevices {
  const devices: DeviceInput[] = [];
  const rejected: ManualDevices['rejected'] = [];
  const seen = new Set<string>();
  for (const { stateId, domain, name } of entries) {
    if (seen.has(stateId)) {
      if (!rejected.some((entry) => entry.stateId === stateId)) {
        rejected.push({ stateId, reason: 'listed more than once; the first entry is used' });
      }
      continue;
    }
    seen.add(stateId);
    const info = servable(stateId, domain, objects, ownNamespace);
    if (typeof info === 'string') {
      rejected.push({ stateId, reason: info });
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
    devices.push(device);
  }
  return { devices, rejected };
}
