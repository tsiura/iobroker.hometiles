/*
 * What a panel reads out of a bridge/apply payload, scanned the way the
 * firmware scans it (HomeTiles v0.6.12, src/network/bridge/ha_bridge_config.cpp)
 * rather than with a JSON parser: the first occurrence of the quoted key, then
 * brackets and quotes from there. A test that JSON.parses the payload cannot
 * see a key shadowed by an earlier value, or an array cut short by a ']'.
 */

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
  const raw = object.slice(q1 + 1, q2);
  let text: string;
  try {
    text = JSON.parse(`"${raw}"`) as string;
  } catch {
    text = raw;
  }
  return text.trim() || undefined;
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
    const value = list.slice(q1 + 1, q2).trim();
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
