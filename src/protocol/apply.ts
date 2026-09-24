import { createHash } from 'node:crypto';
import type { Domain, VirtualEntity } from '../registry/types';

export interface ApplyInput {
  entities: VirtualEntity[];
  sceneMap: Record<string, string>;
}

/**
 * The largest bridge/apply payload a panel applies whole, in UTF-8 bytes
 * (Ruling 108). processMqttMessage copies it into a 32768-byte buffer, its
 * NUL included, and cuts anything longer -- then applies the cut text all
 * the same (mqtt_handlers.cpp:1497, :1729-1742): every section past the cut
 * is lost, and a cut inside sensor_meta loses every sensor's name and unit
 * (ha_bridge_config.cpp:1189-1201). This binds before the MQTT packet does:
 * whatever buffer size the panel runs with (16, 24 or 32 KiB,
 * network_manager.cpp:34-41), reception grows it for any PUBLISH of up to
 * 65535 bytes (mqtt_packet_safety.h:13, PubSubClient.cpp:397-413), and the
 * topic and framing add fewer than 70 bytes.
 */
export const MAX_APPLY_BYTES = 32767;

function text(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];
  return typeof value === 'string' && value.length ? value : undefined;
}

function idsFor(entities: VirtualEntity[], domain: Domain): string[] {
  return entities.filter((entity) => entity.domain === domain).map((entity) => entity.entityId);
}

/** The firmware stores last_changed as unix seconds. */
export function unixSeconds(msValue: number): number {
  return Math.floor(msValue / 1000);
}

function sensorMeta(entities: VirtualEntity[]): Record<string, unknown>[] {
  return entities
    .filter((entity) => entity.domain === 'sensor')
    .map((entity) => {
      // Derived from the declared type (synthSensor sets state_class exactly
      // when the channel is numeric), never from entity.state itself: this
      // section is only re-pushed when registry MEMBERSHIP changes, not on
      // every state change (see EntityRegistry.onMembershipChanged), so a
      // sensor that is "unavailable" at adapter startup would otherwise be
      // published as state_kind "state" and stay a categorical timeline on
      // the panel forever, even once it starts reporting real numbers. This
      // also stops a numeric-looking transient string like "0x10" from being
      // read as a number by coercion.
      const numeric = entity.attributes.state_class === 'measurement';
      const meta: Record<string, unknown> = {
        entity_id: entity.entityId,
        name: text(entity.attributes, 'friendly_name') ?? entity.entityId,
        unit: text(entity.attributes, 'unit_of_measurement') ?? '',
        state: entity.state,
        value: entity.state,
        // Firmware accepts only "number" or "state" here: parseSensorMetaSection
        // in ha_bridge_config.cpp stores the key only for those two values, and
        // sensor/renderer.cpp branches on them to pick graph vs history mode.
        // Any other value, including the intuitive "text", is silently dropped
        // and the panel falls back to a unit-based heuristic that guesses wrong
        // for a textual sensor that happens to carry a unit.
        state_kind: numeric ? 'number' : 'state',
        number: numeric,
      };
      const icon = text(entity.attributes, 'icon');
      if (icon) meta.icon = icon;
      return meta;
    });
}

function binarySensorMeta(entities: VirtualEntity[]): Record<string, unknown>[] {
  return entities
    .filter((entity) => entity.domain === 'binary_sensor')
    .map((entity) => {
      const meta: Record<string, unknown> = {
        entity_id: entity.entityId,
        name: text(entity.attributes, 'friendly_name') ?? entity.entityId,
        device_class: text(entity.attributes, 'device_class') ?? '',
        state: entity.state,
        on: 'on',
        off: 'off',
        unknown: 'unknown',
        unavailable: 'unavailable',
        available: entity.available,
      };
      // lastChanged 0 means the source has never produced a value. Publishing
      // unixSeconds(0) would tell the panel this entity last changed in 1970,
      // and fabricating Date.now() would make a dead entity look fresh on every
      // push. Omitting the key lets the firmware's scanner simply not find it.
      if (entity.lastChanged > 0) meta.last_changed = unixSeconds(entity.lastChanged);
      const icon = text(entity.attributes, 'icon');
      if (icon) meta.icon = icon;
      return meta;
    });
}

function simpleMeta(entities: VirtualEntity[], domain: Domain): Record<string, unknown>[] {
  return entities
    .filter((entity) => entity.domain === domain)
    .map((entity) => {
      const meta: Record<string, unknown> = {
        entity_id: entity.entityId,
        name: text(entity.attributes, 'friendly_name') ?? entity.entityId,
        state: entity.state,
        available: entity.available,
      };
      const icon = text(entity.attributes, 'icon');
      if (icon) meta.icon = icon;
      return meta;
    });
}

/**
 * climate_meta, cover_meta, media_player_meta, weather_meta and
 * editable_meta: the panel reads a name from each but weather_meta
 * (ha_bridge_config.cpp:657-661) and an icon from each (:1386-1393), and
 * nothing else (Ruling 106). State travels on the entity's own topic.
 */
function nameMeta(entities: VirtualEntity[], domains: readonly Domain[]): Record<string, unknown>[] {
  return entities
    .filter((entity) => domains.includes(entity.domain))
    .map((entity) => {
      const meta: Record<string, unknown> = {
        entity_id: entity.entityId,
        name: text(entity.attributes, 'friendly_name') ?? entity.entityId,
      };
      const icon = text(entity.attributes, 'icon');
      if (icon) meta.icon = icon;
      return meta;
    });
}

function byEntityId(a: VirtualEntity, b: VirtualEntity): number {
  return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
}

export function buildApplyPayload(input: ApplyInput): string {
  // Deterministic ordering is what makes the config signature meaningful: a
  // registry that did not change must serialise byte-identically.
  const entities = [...input.entities].sort(byEntityId);

  const sceneMap: Record<string, string> = {};
  for (const alias of Object.keys(input.sceneMap).sort()) {
    const target = input.sceneMap[alias];
    if (target) sceneMap[alias.toLowerCase()] = target;
  }

  // The panel finds each section at the FIRST occurrence of its quoted key
  // (applyJson, ha_bridge_config.cpp:567-636), so every list comes before
  // the first free text -- scene aliases, names, states, icons -- which
  // could otherwise spell a key. Entity ids cannot: each holds a dot.
  // Every list goes out, an empty one too: the panel keeps all but
  // media_players when the key is absent (:581-629), goes on offering their
  // entities, and subscribes to every number, select and datetime listed
  // (mqtt_handlers.cpp:1306-1314). No cameras (Ruling 107): the adapter
  // serves none, and the panel clears its list whether the key is absent or
  // empty (:631-636).
  const payload = {
    sensors: idsFor(entities, 'sensor'),
    binary_sensors: idsFor(entities, 'binary_sensor'),
    lights: idsFor(entities, 'light'),
    switches: idsFor(entities, 'switch'),
    media_players: idsFor(entities, 'media_player'),
    climates: idsFor(entities, 'climate'),
    covers: idsFor(entities, 'cover'),
    weathers: idsFor(entities, 'weather'),
    numbers: idsFor(entities, 'number'),
    selects: idsFor(entities, 'select'),
    datetimes: idsFor(entities, 'datetime'),
    // Not served yet, and sent empty all the same: the firmware keeps a STALE
    // energy configuration while this key is absent (:594-597, :669-675), so
    // a panel migrated from Home Assistant would keep old energy sources
    // forever.
    energy: [] as string[],
    scene_map: sceneMap,
    sensor_meta: sensorMeta(entities),
    binary_sensor_meta: binarySensorMeta(entities),
    light_meta: simpleMeta(entities, 'light'),
    switch_meta: simpleMeta(entities, 'switch'),
    scene_meta: simpleMeta(entities, 'scene'),
    media_player_meta: nameMeta(entities, ['media_player']),
    climate_meta: nameMeta(entities, ['climate']),
    cover_meta: nameMeta(entities, ['cover']),
    weather_meta: nameMeta(entities, ['weather']),
    // One section for all three: there is no number_meta (:661).
    editable_meta: nameMeta(entities, ['number', 'select', 'datetime']),
  };

  return JSON.stringify(payload);
}

export function configSignature(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

export function buildIconsPayload(entities: VirtualEntity[]): string {
  const icons: Record<string, string> = {};
  for (const entity of [...entities].sort(byEntityId)) {
    const icon = text(entity.attributes, 'icon');
    if (icon) icons[entity.entityId] = icon;
  }
  return JSON.stringify({ icons });
}
