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

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 10000; suffix++) {
    const candidate = `${base}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`cannot allocate an entity id for ${base}`);
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

  for (const device of devices) {
    const existing = persisted[device.objectId];
    if (existing?.startsWith(`${device.domain}.`)) resolved[device.objectId] = existing;
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
