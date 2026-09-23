import type { Domain, VirtualEntity } from '../registry/types';
import { buildClimatePayload } from './climate';
import { buildCoverPayload } from './cover';
import { buildControlPayload, CONTROL_SESSION } from './editable';
import { buildMediaPayload } from './media';
import { entityStateTopic } from './topics';
import { buildWeatherPayload } from './weather';

export interface StatePublish {
  topic: string;
  payload: string;
  retain: true;
}

type PayloadShape = 'bare' | 'json' | 'control' | 'none';

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
 * - control: an editable value (number, select, datetime) is read from the
 *   `control` leaf only, in the /control schema (docs/contract-editable.md
 *   §3, src/protocol/editable.ts), never through the generic JSON loop on
 *   `state` (Task 13, Ruling 97).
 * - none: a scene has no state; the panel only ever fires it.
 *
 * climate, cover, media_player and weather publish JSON:
 * docs/contract-climate-cover.md and docs/contract-media-weather.md.
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
      return 'json';
    case 'number':
    case 'select':
    case 'datetime':
      return 'control';
    case 'scene':
      return 'none';
  }
}

/** Whether a domain's value travels in the /control schema, on the `control` leaf. */
export function publishesControl(domain: Domain): boolean {
  return payloadShape(domain) === 'control';
}

/**
 * Weather's leaf is the literal word `weather` (mqtt_handlers.cpp:1415), an
 * editable value's `control` (:1330, :1373), every other domain's `state`.
 * By the id's domain prefix, which is always the entity's domain
 * (entity-id.ts), so a clear, which has only the id, hits the topic the
 * publish used.
 */
function stateLeaf(entityId: string): 'state' | 'weather' | 'control' {
  if (entityId.startsWith('weather.')) return 'weather';
  return publishesControl(entityId.slice(0, entityId.indexOf('.')) as Domain) ? 'control' : 'state';
}

export function buildStatePublish(haPrefix: string, entity: VirtualEntity): StatePublish | null {
  const shape = payloadShape(entity.domain);
  if (shape === 'none') return null;

  const topic = entityStateTopic(haPrefix, entity.entityId, stateLeaf(entity.entityId));

  // Null when the panel would drop it for its size: nothing is published,
  // and the panel keeps its last value (Ruling 96).
  if (shape === 'control') {
    const payload = buildControlPayload(entity, CONTROL_SESSION);
    return payload === null ? null : { topic, payload, retain: true };
  }

  if (shape === 'bare') {
    return { topic, payload: entity.state, retain: true };
  }

  // Climate publishes a different shape than every other JSON domain here:
  // the firmware caches it by full overwrite (never merge), so the payload
  // must always carry the complete attribute set, and its hand-rolled string
  // parser makes a bare `null` dangerous. See src/protocol/climate.ts and
  // docs/contract-climate-cover.md for the full rules; do not fold this back
  // into the generic loop below.
  if (entity.domain === 'climate') {
    return { topic, payload: buildClimatePayload(entity), retain: true };
  }

  // Cover publishes a different shape than the generic JSON loop below for
  // the same reason as climate: an explicit supported_features must be
  // computed from `writable` and sent on every publish (task 7; see
  // src/protocol/cover.ts and docs/contract-climate-cover.md), never left to
  // the generic attribute loop, which would forward whatever happens to be
  // in `attributes` and never add supported_features at all.
  if (entity.domain === 'cover') {
    return { topic, payload: buildCoverPayload(entity), retain: true };
  }

  // Media: an allow-list of the keys the panel's media parser reads, and an
  // explicit "no cover" -- the generic loop below would leave the artwork
  // keys out, which keeps the last track's cover up (src/protocol/media.ts).
  if (entity.domain === 'media_player') {
    return { topic, payload: buildMediaPayload(entity), retain: true };
  }

  // Weather: an allow-list too. The generic loop would send the provider's
  // own text, icon URL and raw dates, none of which the panel can place
  // (src/protocol/weather.ts).
  if (entity.domain === 'weather') {
    return { topic, payload: buildWeatherPayload(entity), retain: true };
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
  return { topic: entityStateTopic(haPrefix, entityId, stateLeaf(entityId)), payload: '', retain: true };
}
