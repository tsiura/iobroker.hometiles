import { createHash } from 'node:crypto';
import type { Domain, VirtualEntity } from '../registry/types';
import type { EnergyCatalogEntry } from './energy';

export interface ApplyInput {
  entities: VirtualEntity[];
  sceneMap: Record<string, string>;
  /** The energy meters' catalog (Task 20b), in the order a rebuild resolved them. */
  energy?: readonly EnergyCatalogEntry[];
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

/**
 * The largest bridge/icons payload a panel applies, in UTF-8 bytes (Ruling
 * 114): processMqttMessage copies it into its own 32768-byte buffer, NUL
 * included, and cuts anything longer without a log (mqtt_handlers.cpp:1496,
 * :1779-1785); the cut map then fails to parse, and applyIconUpdate applies
 * none of it (ha_bridge_config.cpp:736-737).
 */
export const MAX_ICONS_BYTES = 32767;

/**
 * Ruling 111: a panel keeps the values of at most this many numbers,
 * selects and datetimes together, refusing any further one without a log
 * (ha_bridge_config.cpp:1781-1786), and its tiles draw from those values
 * alone (value_control.cpp:136-150).
 */
export const MAX_EDITABLES = 128;
const EDITABLE: readonly Domain[] = ['number', 'select', 'datetime'];

function text(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];
  return typeof value === 'string' && value.length ? value : undefined;
}

/**
 * Ruling 112: free text the panel's hand-rolled parsers can take.
 * sensor_meta and binary_sensor_meta end at the first ']'
 * (ha_bridge_config.cpp:1198, :1246), a sensor_meta entry at the first '}'
 * (:1205), and extractStringField a value at the first '"', escaped or not
 * (:1073-1077). Every name, unit and value lands in a blob of "id=text"
 * lines, so a line break in one adds an entry of its own (:1627-1660).
 * Brackets and braces become parentheses, a quote an apostrophe, a control
 * character a space. Never applied to an entity id or a scene alias: those
 * must match the state topics, the commands and the panel's scene slots.
 */
const PANEL_SAFE: Readonly<Record<string, string>> = { '[': '(', ']': ')', '{': '(', '}': ')', '"': "'" };

/**
 * Every key the panel looks for in an apply (applyJson and parseIconMetaSections,
 * ha_bridge_config.cpp:567-661, :1382-1394), and every field its hand-rolled
 * parsers read by name (extractStringField, :1066-1081). A text equal to one
 * is that key, quoted as it goes out: found before its section, the panel
 * reads the section from there, one it is never sent (cameras) as well, and
 * an object reads a field from the wrong place. A trailing space keeps the
 * text apart; the panel trims it where it reads the text (:1079, :1627-1660)
 * (Task 20b).
 */
const PANEL_KEYS: ReadonlySet<string> = new Set([
  'sensors',
  'configured_sensors',
  'numbers',
  'selects',
  'datetimes',
  'binary_sensors',
  'energy',
  'weathers',
  'lights',
  'switches',
  'media_players',
  'climates',
  'covers',
  'cameras',
  'scene_map',
  'sensor_meta',
  'binary_sensor_meta',
  'editable_meta',
  'weather_meta',
  'light_meta',
  'switch_meta',
  'scene_meta',
  'media_player_meta',
  'climate_meta',
  'cover_meta',
  'camera_meta',
  'entity_id',
  'name',
  'unit',
  'value',
  'state_kind',
  'icon',
  'id',
  'category',
]);

const panelText = (value: string): string => {
  const safe = value.replace(/[[\]{}"\u0000-\u001f\u007f]/g, (c) => PANEL_SAFE[c] ?? ' ');
  return PANEL_KEYS.has(safe) ? `${safe} ` : safe;
};

/** The name the panel shows: the friendly name, else the entity id. */
const displayName = (entity: VirtualEntity): string => panelText(text(entity.attributes, 'friendly_name') ?? entity.entityId);

/**
 * Ruling 110: the icon, only when it is an MDI name -- "mdi:" and letters,
 * digits and hyphens, as all 7447 names the panel knows are
 * (mdi_icons.cpp). Anything else the panel keeps as it is and draws as a
 * "?" glyph in place of the tile's own icon (mdi_icons.cpp:7549), and on a
 * cover in place of its open/closed icon too (cover/renderer.cpp:304-311).
 * In any case: the panel lowercases (mdi_icons.cpp:7508-7521).
 */
const MDI_ICON = /^mdi:[a-z0-9-]+$/i;
function mdiIcon(entity: VirtualEntity): string | undefined {
  const icon = text(entity.attributes, 'icon');
  return icon !== undefined && MDI_ICON.test(icon) ? icon : undefined;
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
      // What parseSensorMetaSection reads and nothing else
      // (ha_bridge_config.cpp:1209-1236): value is the initial value it
      // shows; state and number are never read (Ruling 109).
      const meta: Record<string, unknown> = {
        entity_id: entity.entityId,
        name: displayName(entity),
        unit: panelText(text(entity.attributes, 'unit_of_measurement') ?? ''),
        value: panelText(entity.state),
        // Firmware accepts only "number" or "state" here: parseSensorMetaSection
        // in ha_bridge_config.cpp stores the key only for those two values, and
        // sensor/renderer.cpp branches on them to pick graph vs history mode.
        // Any other value, including the intuitive "text", is silently dropped
        // and the panel falls back to a unit-based heuristic that guesses wrong
        // for a textual sensor that happens to carry a unit.
        state_kind: numeric ? 'number' : 'state',
      };
      const icon = mdiIcon(entity);
      if (icon) meta.icon = icon;
      return meta;
    });
}

function binarySensorMeta(entities: VirtualEntity[]): Record<string, unknown>[] {
  return entities
    .filter((entity) => entity.domain === 'binary_sensor')
    .map((entity) => {
      // What parseBinarySensorMetaSection reads and nothing else
      // (ha_bridge_config.cpp:1259-1313): on, off, unknown and unavailable are
      // compared with state there, never read as keys (Ruling 109).
      const meta: Record<string, unknown> = {
        entity_id: entity.entityId,
        name: displayName(entity),
        device_class: text(entity.attributes, 'device_class') ?? '',
        state: entity.state,
        available: entity.available,
      };
      // lastChanged 0 means the source has never produced a value. Publishing
      // unixSeconds(0) would tell the panel this entity last changed in 1970,
      // and fabricating Date.now() would make a dead entity look fresh on every
      // push. Omitting the key lets the firmware's scanner simply not find it.
      if (entity.lastChanged > 0) meta.last_changed = unixSeconds(entity.lastChanged);
      const icon = mdiIcon(entity);
      if (icon) meta.icon = icon;
      return meta;
    });
}

/**
 * light_meta, switch_meta and scene_meta: read for icons alone
 * (ha_bridge_config.cpp:1388-1390; they are no name sections, :657-661), so
 * an entity without an icon has nothing to say there (Ruling 109).
 */
function iconMeta(entities: VirtualEntity[], domain: Domain): Record<string, unknown>[] {
  return entities.flatMap((entity) => {
    const icon = entity.domain === domain ? mdiIcon(entity) : undefined;
    return icon ? [{ entity_id: entity.entityId, icon }] : [];
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
      const meta: Record<string, unknown> = { entity_id: entity.entityId, name: displayName(entity) };
      const icon = mdiIcon(entity);
      if (icon) meta.icon = icon;
      return meta;
    });
}

/**
 * A catalog entry as parseEnergySection reads it (ha_bridge_config.cpp:1108-1184):
 * the first '{' to the first '}' of the section, each field the first quoted
 * token after its name. Free text made safe (Ruling 112), never the id: a tile
 * binds to it (energy_data.cpp:186). No unit, no key.
 */
function energyEntry({ id, name, unit, category }: EnergyCatalogEntry): Record<string, string> {
  return unit ? { id, name: panelText(name), unit: panelText(unit), category } : { id, name: panelText(name), category };
}

/**
 * The numbers, selects and datetimes a panel is given -- the first
 * MAX_EDITABLES by entity id, whatever order they come in -- and those left
 * out (Ruling 111).
 */
export function splitEditables(entities: VirtualEntity[]): { kept: VirtualEntity[]; left: VirtualEntity[] } {
  const editables = entities.filter((entity) => EDITABLE.includes(entity.domain)).sort(byEntityId);
  return { kept: editables.slice(0, MAX_EDITABLES), left: editables.slice(MAX_EDITABLES) };
}

function byEntityId(a: VirtualEntity, b: VirtualEntity): number {
  return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
}

/**
 * Whether any entity lands in one of the apply's lists; a scene lands in
 * none (Ruling 116). An apply whose every list is empty makes the panel
 * drop each sensor slot no list names and save that to flash
 * (ha_bridge_config.cpp:685-691, :701-703): it would wipe the panel's layout
 * over the adapter's own empty world, so none is sent.
 */
export function listsAnyEntity(entities: readonly VirtualEntity[]): boolean {
  return entities.some((entity) => entity.domain !== 'scene');
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
  const { kept: editables } = splitEditables(entities);
  const payload = {
    sensors: idsFor(entities, 'sensor'),
    binary_sensors: idsFor(entities, 'binary_sensor'),
    lights: idsFor(entities, 'light'),
    switches: idsFor(entities, 'switch'),
    media_players: idsFor(entities, 'media_player'),
    climates: idsFor(entities, 'climate'),
    covers: idsFor(entities, 'cover'),
    weathers: idsFor(entities, 'weather'),
    numbers: idsFor(editables, 'number'),
    selects: idsFor(editables, 'select'),
    datetimes: idsFor(editables, 'datetime'),
    // The energy meters' catalog (Task 20b), sent empty without meters: the
    // firmware keeps a STALE energy configuration while this key is absent
    // (:594-597, :669-675), so a panel migrated from Home Assistant would
    // keep old energy sources forever. It holds free text, made safe above,
    // and it comes before scene_map, whose aliases are sent as they are: an
    // alias "energy" there would spell this key.
    energy: (input.energy ?? []).map(energyEntry),
    scene_map: sceneMap,
    sensor_meta: sensorMeta(entities),
    binary_sensor_meta: binarySensorMeta(entities),
    light_meta: iconMeta(entities, 'light'),
    switch_meta: iconMeta(entities, 'switch'),
    scene_meta: iconMeta(entities, 'scene'),
    media_player_meta: nameMeta(entities, ['media_player']),
    climate_meta: nameMeta(entities, ['climate']),
    cover_meta: nameMeta(entities, ['cover']),
    weather_meta: nameMeta(entities, ['weather']),
    // One section for all three: there is no number_meta (:661).
    editable_meta: nameMeta(editables, EDITABLE),
  };

  return JSON.stringify(payload);
}

export function configSignature(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * bridge/icons: the flat map of entity id to icon the Bridge sends
 * (__init__.py:3529-3530), each top-level pair one entity to
 * applyIconUpdate (ha_bridge_config.cpp:743-771). Every entity is in it:
 * "" removes an icon the panel still holds (:757-762). That is the one way
 * to clear one, since an apply that carries no icon at all leaves the
 * panel's whole map as it was (:663-665).
 *
 * Over MAX_ICONS_BYTES the "" entries go first (Ruling 114): the MDI icons
 * still arrive, and an entity left out keeps whatever icon the panel holds
 * until it reboots. What is left can still be over the limit -- the icons
 * of the numbers, selects and datetimes past the 128th are in it, and not
 * in the apply -- and the session then publishes none.
 */
export function buildIconsPayload(entities: VirtualEntity[]): string {
  const icons = [...entities].sort(byEntityId).map((entity): [string, string] => [entity.entityId, mdiIcon(entity) ?? '']);
  const whole = JSON.stringify(Object.fromEntries(icons));
  if (Buffer.byteLength(whole, 'utf8') <= MAX_ICONS_BYTES) return whole;
  return JSON.stringify(Object.fromEntries(icons.filter(([, icon]) => icon)));
}
