import type { Domain, VirtualEntity } from '../registry/types';
import { entityStateTopic } from './topics';

export interface StatePublish {
  topic: string;
  payload: string;
  retain: true;
}

/**
 * Domains the firmware consumes as a bare string. See sync_external_temp_entity
 * and the TILE_SENSOR / TILE_SWITCH branches of tiles_update_sensor_by_entity.
 * Everything else that has state is published as a JSON object, matching
 * sync_local_device_entities, which publishes {"state":"on","brightness_pct":N}.
 */
const BARE_STRING_DOMAINS: ReadonlySet<Domain> = new Set<Domain>(['sensor', 'binary_sensor', 'switch']);

/** A scene has no state to publish; the panel only ever fires it. */
const STATELESS_DOMAINS: ReadonlySet<Domain> = new Set<Domain>(['scene']);

export function buildStatePublish(haPrefix: string, entity: VirtualEntity): StatePublish | null {
  if (STATELESS_DOMAINS.has(entity.domain)) return null;

  const topic = entityStateTopic(haPrefix, entity.entityId);

  if (BARE_STRING_DOMAINS.has(entity.domain)) {
    return { topic, payload: entity.state, retain: true };
  }

  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entity.attributes)) {
    if (value === undefined) continue;
    body[key] = value;
  }
  // The entity's own state is authoritative and overwrites any attribute that
  // happens to share the name.
  body.state = entity.state;

  return { topic, payload: JSON.stringify(body), retain: true };
}

/** An empty retained payload removes the retained value from the broker. */
export function buildStateClear(haPrefix: string, entityId: string): StatePublish {
  return { topic: entityStateTopic(haPrefix, entityId), payload: '', retain: true };
}
