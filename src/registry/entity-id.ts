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
 * Entity ids are keyed by ioBroker object id and persisted. A rename of the
 * underlying object must never orphan tiles already placed on a panel, so a
 * known object id always keeps the id it was first given.
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
    if (existing) resolved[device.objectId] = existing;
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
