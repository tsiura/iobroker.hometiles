/*
 * What a panel reads out of a bridge/apply payload, scanned the way the
 * firmware scans it (HomeTiles v0.6.12, src/network/bridge/ha_bridge_config.cpp)
 * rather than with a JSON parser: the first occurrence of the quoted key, then
 * brackets and quotes from there. A test that JSON.parses the payload cannot
 * see a key shadowed by an earlier value, or a section cut short by a ']'.
 * Each function names the firmware code it ports; the ports keep that code's
 * flaws, since those are what the payload has to survive.
 */

/** Arduino's String::trim, isspace: ASCII whitespace only. */
const asciiTrim = (text: string): string => text.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, '');

const ESCAPED: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** decodeJsonEscapes (:1001-1064): a lone trailing backslash stays, an unknown escape yields its character. */
function decodeEscapes(value: string): string {
  let out = '';
  const hex = (at: number): boolean => /^[0-9a-fA-F]{4}$/.test(value.slice(at, at + 4));
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c !== '\\' || i + 1 >= value.length) {
      out += c;
      continue;
    }
    const esc = value[i + 1]!;
    if (esc === 'u' && i + 5 < value.length && hex(i + 2)) {
      const code = parseInt(value.slice(i + 2, i + 6), 16);
      i += 5;
      if (code >= 0xd800 && code <= 0xdbff && i + 6 < value.length && value[i + 1] === '\\' && value[i + 2] === 'u' && hex(i + 3)) {
        const low = parseInt(value.slice(i + 3, i + 7), 16);
        if (low >= 0xdc00 && low <= 0xdfff) {
          out += String.fromCodePoint(0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00));
          i += 6;
          continue;
        }
      }
      out += String.fromCharCode(code);
      continue;
    }
    out += ESCAPED[esc] ?? esc;
    i += 1;
  }
  return out;
}

/** findMatchingJsonArrayEnd / findMatchingJsonObjectEnd (:486-541): string-aware bracket matching. */
function matchingEnd(text: string, start: number, open: string, close: string): number {
  if (start < 0 || text[start] !== open) return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

/** extractStringField (:1066-1081): no escape awareness, the first quoted token after the key's colon. */
function field(object: string, key: string): string | undefined {
  const at = object.indexOf(`"${key}"`);
  const colon = at < 0 ? -1 : object.indexOf(':', at);
  const q1 = colon < 0 ? -1 : object.indexOf('"', colon);
  const q2 = q1 < 0 ? -1 : object.indexOf('"', q1 + 1);
  if (q2 < 0) return undefined;
  return asciiTrim(decodeEscapes(object.slice(q1 + 1, q2))) || undefined;
}

/**
 * applyJson's list lookup and parseArraySection (:426-450, :567-636): the first
 * '[' after the key, the first ']' after that, every quoted token between.
 * undefined when the key is absent.
 */
export function panelList(payload: string, key: string): string[] | undefined {
  const at = payload.indexOf(`"${key}"`);
  if (at < 0) return undefined;
  const body = payload.slice(at);
  const start = body.indexOf('[');
  const end = start < 0 ? -1 : body.indexOf(']', start);
  if (start < 0 || end < start) return [];
  const list = body.slice(start + 1, end);
  const values: string[] = [];
  for (let pos = 0; pos < list.length; ) {
    const q1 = list.indexOf('"', pos);
    const q2 = q1 < 0 ? -1 : list.indexOf('"', q1 + 1);
    if (q2 < 0) break;
    const value = asciiTrim(list.slice(q1 + 1, q2));
    if (value) values.push(value);
    pos = q2 + 1;
  }
  return values;
}

/** The objects of one *_meta section, as parseEntityNameSection and parseEntityIconSection walk them (:1323-1380). */
function metaObjects(payload: string, key: string): string[] {
  const at = payload.indexOf(`"${key}"`);
  if (at < 0) return [];
  const start = payload.indexOf('[', at);
  const end = matchingEnd(payload, start, '[', ']');
  if (start < 0 || end < start) return [];
  const segment = payload.slice(start + 1, end);
  const objects: string[] = [];
  for (let from = segment.indexOf('{'); from >= 0; ) {
    const to = matchingEnd(segment, from, '{', '}');
    if (to < 0) break;
    objects.push(segment.slice(from, to + 1));
    from = segment.indexOf('{', to + 1);
  }
  return objects;
}

function metaMap(payload: string, key: string, value: 'name' | 'icon'): Record<string, string> {
  const map: Record<string, string> = {};
  for (const object of metaObjects(payload, key)) {
    const entityId = field(object, 'entity_id');
    const text = field(object, value);
    if (entityId && text) map[entityId] = text;
  }
  return map;
}

/** parseEntityNameSection (:1323-1346): entity id to display name, from one *_meta section. */
export const panelNames = (payload: string, key: string): Record<string, string> => metaMap(payload, key, 'name');

/** parseEntityIconSection (:1348-1380): entity id to icon, from one *_meta section. */
export const panelIcons = (payload: string, key: string): Record<string, string> => metaMap(payload, key, 'icon');

/** rebuildIndexFromBlob (:1627-1660): "key=value" lines, split at the first '=', and the FIRST line of a key wins. */
function indexBlob(blob: string): Map<string, string> {
  const index = new Map<string, string>();
  for (const line of blob.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = asciiTrim(line.slice(0, eq));
    if (key && !index.has(key)) index.set(key, asciiTrim(line.slice(eq + 1)));
  }
  return index;
}

const append = (blob: string, key: string, value: string): string => `${blob}${blob ? '\n' : ''}${key}=${value}`;

/** upsertKeyValueMap (:1439-1497): replaces the line of that key, compared without case, or adds one. */
function upsert(blob: string, key: string, value: string): string {
  if (!key || !value) return blob;
  let out = '';
  let found = false;
  for (const line of blob ? blob.split('\n') : []) {
    const eq = line.indexOf('=');
    if (eq > 0 && asciiTrim(line.slice(0, eq)).toLowerCase() === key.toLowerCase()) {
      out = append(out, key, value);
      found = true;
    } else if (line) {
      out = `${out}${out ? '\n' : ''}${line}`;
    }
  }
  return found ? out : append(out, key, value);
}

function sensorMetaBlobs(payload: string): { names: string; units: string; values: string; kinds: string } {
  const blobs = { names: '', units: '', values: '', kinds: '' };
  const at = payload.indexOf('"sensor_meta"');
  const start = at < 0 ? -1 : payload.indexOf('[', at);
  const end = start < 0 ? -1 : payload.indexOf(']', start);
  if (start < 0 || end < start) return blobs;
  const segment = payload.slice(start + 1, end);
  for (let from = segment.indexOf('{'); from >= 0; ) {
    const to = segment.indexOf('}', from);
    if (to < 0) break;
    const object = segment.slice(from, to + 1);
    const entity = field(object, 'entity_id');
    if (entity) {
      const unit = field(object, 'unit');
      if (unit) blobs.units = append(blobs.units, entity, unit);
      const name = field(object, 'name');
      if (name) blobs.names = append(blobs.names, entity, name);
      const value = field(object, 'value');
      if (value) blobs.values = append(blobs.values, entity, value);
      const kind = field(object, 'state_kind')?.toLowerCase();
      if (kind === 'number' || kind === 'state') blobs.kinds = append(blobs.kinds, entity, kind);
    }
    from = segment.indexOf('{', to + 1);
  }
  return blobs;
}

/**
 * parseSensorMetaSection (:1186-1239): the section ends at the FIRST ']'
 * after its '[', and each entry at the first '}' after its '{', inside a
 * string or not. Each map as its index holds it.
 */
export function panelSensorMeta(payload: string): Record<'names' | 'units' | 'values' | 'kinds', Map<string, string>> {
  const blobs = sensorMetaBlobs(payload);
  return { names: indexBlob(blobs.names), units: indexBlob(blobs.units), values: indexBlob(blobs.values), kinds: indexBlob(blobs.kinds) };
}

/**
 * parseBinarySensorMetaSection (:1241-1321): the section ends at the FIRST
 * ']' after its '['; each string-matched object is then parsed as JSON.
 * Entity id to the state record the panel keeps, and each name upserted
 * into the shared names blob.
 */
function binaryMeta(payload: string, names: string): { states: Map<string, Record<string, unknown>>; names: string } {
  const states = new Map<string, Record<string, unknown>>();
  const at = payload.indexOf('"binary_sensor_meta"');
  const start = at < 0 ? -1 : payload.indexOf('[', at);
  const end = start < 0 ? -1 : payload.indexOf(']', start);
  if (start < 0 || end < start) return { states, names };
  const segment = payload.slice(start + 1, end);
  for (let from = segment.indexOf('{'); from >= 0; ) {
    const to = matchingEnd(segment, from, '{', '}');
    if (to < 0) break;
    let item: Record<string, unknown> | undefined;
    try {
      item = JSON.parse(segment.slice(from, to + 1)) as Record<string, unknown>;
    } catch {
      item = undefined;
    }
    const entity = item?.entity_id;
    if (item && typeof entity === 'string' && entity) {
      if (typeof item.name === 'string' && item.name) names = upsert(names, entity, item.name);
      const state = typeof item.state === 'string' ? asciiTrim(item.state).toLowerCase() : '';
      const record: Record<string, unknown> = { state: ['on', 'off', 'unknown', 'unavailable'].includes(state) ? state : null };
      if (typeof item.available === 'boolean' || item.available === null) record.available = item.available;
      if (typeof item.device_class === 'string') record.device_class = asciiTrim(item.device_class).toLowerCase().slice(0, 23);
      if (typeof item.icon === 'string') record.icon = asciiTrim(item.icon).slice(0, 39);
      if ('last_changed' in item) record.last_changed = item.last_changed;
      states.set(entity, record);
    }
    from = segment.indexOf('{', to + 1);
  }
  return { states, names };
}

/** The binary sensors a panel knows after an apply, with the state record it keeps for each. */
export const panelBinaryMeta = (payload: string): Map<string, Record<string, unknown>> => binaryMeta(payload, '').states;

/**
 * findSensorName after applyJson (:652-661, :1678): sensor_meta's names,
 * then binary_sensor_meta's and the five name sections' upserted into the
 * same blob, then indexed.
 */
export function panelNameIndex(payload: string): Map<string, string> {
  let names = binaryMeta(payload, sensorMetaBlobs(payload).names).names;
  for (const key of ['media_player_meta', 'climate_meta', 'cover_meta', 'camera_meta', 'editable_meta']) {
    for (const object of metaObjects(payload, key)) {
      const entity = field(object, 'entity_id');
      const name = field(object, 'name');
      if (entity && name) names = upsert(names, entity, name);
    }
  }
  return indexBlob(names);
}

const ICON_SECTIONS = [
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
];

/**
 * The icon map after applyJson (:651, :662-665, :1382-1394): rebuilt from
 * every *_meta section's icons -- unless that finds none, when the panel
 * keeps the map it had.
 */
export function panelIconMap(payload: string, previous: ReadonlyMap<string, string>): Map<string, string> {
  let blob = '';
  for (const key of ICON_SECTIONS) {
    for (const object of metaObjects(payload, key)) {
      const entity = field(object, 'entity_id');
      const icon = entity ? field(object, 'icon') : undefined;
      if (entity && icon) blob = append(blob, entity, icon);
    }
  }
  return blob ? indexBlob(blob) : new Map(previous);
}

/**
 * applyIconUpdate (:732-773), the bridge/icons handler: each top-level pair
 * is an entity id and its icon; a value that is no string, or is blank,
 * removes the icon the panel holds. Changes `icons` in place.
 */
export function panelIconUpdate(icons: Map<string, string>, payload: string): boolean {
  let doc: unknown;
  try {
    doc = JSON.parse(payload);
  } catch {
    return false;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  let changed = false;
  for (const [entity, value] of Object.entries(doc as Record<string, unknown>)) {
    if (!entity) continue;
    const next = typeof value === 'string' ? asciiTrim(value) : '';
    const current = icons.get(entity) ?? '';
    if (!next) {
      if (current && icons.delete(entity)) changed = true;
    } else if (current !== next) {
      icons.set(entity, next);
      changed = true;
    }
  }
  return changed;
}
