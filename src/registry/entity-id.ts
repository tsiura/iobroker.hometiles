import type { DeviceInput, Domain } from './types';

export function slugify(input: string): string {
  const folded = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  const slug = folded.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || 'unnamed';
}

/** Uses the last dot-separated segment of an object id, so hue.0.Kueche -> kueche. */
function sourceSlug(source: string): string {
  const tail = source.split('.').pop() ?? source;
  return slugify(tail);
}

/**
 * The longest entity id a panel command may carry (protocol/commands.ts
 * requireEntityId). Home Assistant's are far shorter; the cap exists because
 * every field crossing that boundary is untrusted, so none may be unbounded.
 */
export const MAX_ENTITY_ID_LENGTH = 255;

/** The longest suffix uniqueId appends, `_9999`. */
const SUFFIX_ROOM = '_9999'.length;

/**
 * A new id, cut to leave room for any suffix, so that `<domain>.<slug>_<n>`
 * stays one a command can address: a 300-character name made a 307-character
 * id that refused every command (Task 13b round 1, m4). The cut never leaves
 * a trailing separator. Only new ids pass here: a persisted one is kept as it
 * is (resolveEntityIds' first pass).
 */
function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const root = base.slice(0, MAX_ENTITY_ID_LENGTH - SUFFIX_ROOM).replace(/_+$/, '');
  if (!taken.has(root)) return root;
  for (let suffix = 2; suffix < 10000; suffix++) {
    const candidate = `${root}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`cannot allocate an entity id for ${root}`);
}

/** Derives an id from an OBJECT ID, whose last dot-separated segment is the name. */
export function buildEntityId(domain: Domain, source: string, taken: ReadonlySet<string>): string {
  return uniqueId(`${domain}.${sourceSlug(source)}`, taken);
}

/**
 * A persisted id map as main.ts stores it: a JSON object whose values are all
 * strings. Anything else a hand edit can leave -- JSON null, an array, a
 * number, a string, a non-string value, no JSON at all -- is undefined,
 * never a value that throws later inside discovery (Ruling 51).
 */
export function parseStringMap(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  return Object.values(parsed).every((value) => typeof value === 'string') ? (parsed as Record<string, string>) : undefined;
}

/**
 * Entity ids are keyed by ioBroker object id and persisted. A rename of the
 * underlying object must never orphan tiles already placed on a panel, so a
 * known object id keeps the id it was first given -- while it stays in that
 * id's domain. The firmware routes a command by the id's domain prefix, so a
 * device re-detected as a light at switch.x could never receive set_light;
 * it gets a new id instead.
 */
export function resolveEntityIds(
  devices: DeviceInput[],
  persisted: Readonly<Record<string, string>>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  const taken = new Set<string>();

  // Reserve every persisted id first, including ones whose device is currently
  // absent, so a returning device cannot find its id taken by a newcomer.
  for (const entityId of Object.values(persisted)) taken.add(entityId);

  // A persisted id goes to one device only: two keys holding one id, as a
  // hand-edited store can, would fold two entities into one (Task 13b).
  const given = new Set<string>();
  for (const device of devices) {
    const existing = persisted[device.objectId];
    if (!existing?.startsWith(`${device.domain}.`) || given.has(existing)) continue;
    given.add(existing);
    resolved[device.objectId] = existing;
  }

  for (const device of devices) {
    if (resolved[device.objectId]) continue;
    // A display name is slugified WHOLE. Routing it through sourceSlug would
    // split on the last dot and turn "Sensor v1.2" into the id "sensor.2".
    // Only an object id has a meaningful dot-separated tail.
    const name = device.name.trim();
    const entityId = name
      ? uniqueId(`${device.domain}.${slugify(name)}`, taken)
      : buildEntityId(device.domain, device.objectId, taken);
    taken.add(entityId);
    resolved[device.objectId] = entityId;
  }

  return resolved;
}

/** The key an energy meter's id is stored under, `energy:<state id>` (Task 20b): no device's key starts so. */
export const ENERGY_KEY = 'energy:';
/**
 * An energy meter's cost entry is `<id>_cost` (__init__.py:2814), and the
 * panel draws any id ending so with the currency icon, before it looks at
 * the category (energyIconForCategory, ha_bridge_config.cpp:1092).
 */
const COST = '_cost';
/** What a meter id whose name ends in "cost" gets instead (review m3). */
const METER = '_meter';

/**
 * A meter id the panel can take: a lowercase slug the catalog's hand parser
 * reads whole (ha_bridge_config.cpp:1115-1116, a ']' ends the section), no
 * `_cost` at its end, and room for its cost id within MAX_ENTITY_ID_LENGTH.
 * A stored one is hand-editable (review m4).
 */
const usableEnergyId = (id: string): boolean =>
  /^energy\.[a-z0-9_]+$/.test(id) && !id.endsWith(COST) && id.length + COST.length <= MAX_ENTITY_ID_LENGTH;

/**
 * Energy meter ids, stored like a manual entity's (Task 20b): `energy.` and
 * the name's slug, kept once given; a stored id wins before any new one is
 * made. No registry id is ever one -- none of their domains is energy -- so a
 * meter never shares an id, a name or a state topic with an entity. No meter
 * id ends in `_cost`, and every cost id does: none is another's.
 */
export function resolveEnergyIds(
  meters: ReadonlyArray<{ stateId: string; name: string }>,
  persisted: Readonly<Record<string, string>>,
): Record<string, string> {
  const ids: Record<string, string> = {};
  const taken = new Set<string>();
  for (const { stateId } of meters) {
    const key = ENERGY_KEY + stateId;
    const stored = Object.hasOwn(persisted, key) ? persisted[key] : undefined;
    if (stored === undefined || !usableEnergyId(stored) || taken.has(stored)) continue;
    ids[key] = stored;
    taken.add(stored);
  }
  for (const { stateId, name } of meters) {
    const key = ENERGY_KEY + stateId;
    if (ids[key]) continue;
    let root = `energy.${slugify(name)}`.slice(0, MAX_ENTITY_ID_LENGTH - SUFFIX_ROOM - COST.length - METER.length).replace(/_+$/, '');
    if (root.endsWith(COST)) root += METER;
    let id = root;
    for (let suffix = 2; taken.has(id); suffix++) id = `${root}_${suffix}`;
    ids[key] = id;
    taken.add(id);
  }
  return ids;
}

/**
 * The ids to store after a rebuild: each one the registry resolved, and the
 * stored id of every detected device it was not handed -- one not picked, or
 * un-picked (Task 21b). Stored, the id stays reserved (resolveEntityIds), so
 * picking the device again gives it back, whatever took its name meanwhile.
 * A device detected no more loses its id, as it did before the picker.
 */
export function idsToStore(
  persisted: Readonly<Record<string, string>>,
  detected: readonly DeviceInput[],
  resolved: Readonly<Record<string, string>>,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const { objectId } of detected) {
    const entityId = Object.hasOwn(persisted, objectId) ? persisted[objectId] : undefined;
    if (entityId !== undefined) kept[objectId] = entityId;
  }
  return { ...kept, ...resolved };
}
