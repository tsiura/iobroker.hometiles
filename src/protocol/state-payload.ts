import type { Domain, VirtualEntity } from '../registry/types';
import { entityStateTopic } from './topics';

export interface StatePublish {
  topic: string;
  payload: string;
  retain: true;
}

type PayloadShape = 'bare' | 'json' | 'none';

/**
 * The wire format is domain-dependent, and getting it wrong is visible on a
 * wall panel as literal JSON text. This is an exhaustive switch with no
 * `default` on purpose: adding a domain to the `Domain` union without deciding
 * its payload shape must fail to COMPILE, not silently fall into the JSON
 * branch. Do not rewrite it as a set membership test with a fallthrough.
 *
 * - bare: sync_external_temp_entity publishes a bare dtostrf result or the
 *   literal "unavailable", and tiles_update_sensor_by_entity consumes the raw
 *   payload for TILE_SENSOR, TILE_SWITCH and TILE_BINARY_SENSOR.
 * - json: sync_local_device_entities publishes {"state":"on","brightness_pct":N}.
 * - none: a scene has no state; the panel only ever fires it.
 *
 * climate, cover, media_player, weather, number, select and datetime all
 * publish JSON: docs/contract-climate-cover.md, docs/contract-media-weather.md
 * and docs/contract-editable.md (the `/control` payload).
 */
function payloadShape(domain: Domain): PayloadShape {
  switch (domain) {
    case 'sensor':
    case 'binary_sensor':
    case 'switch':
      return 'bare';
    case 'light':
    case 'climate':
    case 'cover':
    case 'media_player':
    case 'weather':
    case 'number':
    case 'select':
    case 'datetime':
      return 'json';
    case 'scene':
      return 'none';
  }
}

export function buildStatePublish(haPrefix: string, entity: VirtualEntity): StatePublish | null {
  const shape = payloadShape(entity.domain);
  if (shape === 'none') return null;

  const topic = entityStateTopic(haPrefix, entity.entityId);

  if (shape === 'bare') {
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
