import { createHash } from 'node:crypto';
import type { Domain, VirtualEntity } from '../registry/types';

export interface ApplyInput {
  entities: VirtualEntity[];
  sceneMap: Record<string, string>;
}

function text(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];
  return typeof value === 'string' && value.length ? value : undefined;
}

function idsFor(entities: VirtualEntity[], domain: Domain): string[] {
  return entities.filter((entity) => entity.domain === domain).map((entity) => entity.entityId);
}

/** The firmware stores last_changed as unix seconds. */
function unixSeconds(msValue: number): number {
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

  const payload = {
    sensors: idsFor(entities, 'sensor'),
    binary_sensors: idsFor(entities, 'binary_sensor'),
    lights: idsFor(entities, 'light'),
    switches: idsFor(entities, 'switch'),
    // Domains outside v0.1. Emitted empty so the firmware's scan finds a
    // well-formed section instead of falling back to a stale stored value.
    media_players: [] as string[],
    climates: [] as string[],
    covers: [] as string[],
    cameras: [] as string[],
    weathers: [] as string[],
    // Unlike the other unimplemented domains above, the firmware keeps STALE
    // energy configuration when this key is absent (ha_bridge_config.cpp
    // scans for "energy" specifically), so a panel migrated from Home
    // Assistant would otherwise keep old energy sources forever.
    energy: [] as string[],
    scene_map: sceneMap,
    sensor_meta: sensorMeta(entities),
    binary_sensor_meta: binarySensorMeta(entities),
    light_meta: simpleMeta(entities, 'light'),
    switch_meta: simpleMeta(entities, 'switch'),
    scene_meta: simpleMeta(entities, 'scene'),
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
