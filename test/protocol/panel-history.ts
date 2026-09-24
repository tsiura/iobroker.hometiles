/*
 * What a panel keeps of a history/response payload (HomeTiles v0.6.12,
 * src/ui/popups/sensor/sensor_popup.cpp and src/network/mqtt/mqtt_handlers.cpp),
 * ported loop for loop where order, caps or a first-match scan decide what
 * survives. A test that only JSON.parses the payload cannot see that the popup
 * keeps the FIRST 96 valid segments in wire order, the LAST 96 activity
 * entries, or that the dispatcher reads `kind` from the first "kind" anywhere
 * in the text. Each function names the firmware code it ports.
 */
import { createHash } from 'node:crypto';

/** Arduino's String::trim, isspace: ASCII whitespace only. */
const asciiTrim = (text: string): string => text.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, '');

type Doc = Record<string, unknown>;
const isDoc = (value: unknown): value is Doc => typeof value === 'object' && value !== null && !Array.isArray(value);
const uint16 = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff;
/** `doc["history_available"] | true` behind `doc.containsKey("error") ? false :` (:1873-1874, :2121-2122, :2283). */
const historyAvailable = (doc: Doc): boolean =>
  'error' in doc ? false : typeof doc.history_available === 'boolean' ? doc.history_available : true;

/** extract_epoch (:836-852): a positive JSON integer, or a string's leading digits; a fraction, a negative, null: 0. */
export function extractEpoch(value: unknown): number {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : 0;
  if (typeof value === 'string') {
    const digits = /^\s*\+?(\d+)/.exec(value);
    return digits ? Number(digits[1]) : 0;
  }
  return 0;
}

/** binary_state_code then binary_state_identifier (:854-865, :885-892), of `item["state"] | "unknown"`. */
function binaryState(value: unknown): string {
  const state = asciiTrim(typeof value === 'string' ? value : 'unknown').toLowerCase();
  return state === 'on' || state === 'off' || state === 'unavailable' ? state : 'unknown';
}

/** bounded_utf8_prefix_length (:894-915): whole characters within `max` UTF-8 bytes. */
function utf8Prefix(text: string, max: number): string {
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    bytes += Buffer.byteLength(ch);
    if (bytes > max) break;
    out += ch;
  }
  return out;
}

/** normalize_state_live_value (:917-926): trimmed, cut to 255 bytes. */
export const liveValue = (value: string): string => utf8Prefix(asciiTrim(value), 255);

/** normalize_state_history_value (:928-953): what a state text is called in the popup's timeline and Activity. */
export function historyLabel(value: string): string {
  const text = liveValue(value);
  if (!text || /^unknown$/i.test(text)) return 'unknown';
  if (/^unavailable$/i.test(text)) return 'unavailable';
  if (Buffer.byteLength(text) <= 32) return text;
  return `${utf8Prefix(text, 23)}~${createHash('sha256').update(text).digest('hex').slice(0, 8)}`;
}

const nibble = (ch: string | undefined): number => (ch !== undefined && /^[0-9a-fA-F]$/.test(ch) ? parseInt(ch, 16) : -1);

/** decode_binary_timeline (:1767-1801): four 2-bit codes a byte, high bits first; any flaw rejects it whole. */
export function decodeBinaryTimeline(points: unknown, encoding: unknown, data: unknown): number[] {
  if (!uint16(points) || typeof encoding !== 'string' || typeof data !== 'string') return [];
  if (!points || points > 768 || encoding !== '2bit-hex') return [];
  const bytes = Math.ceil(points / 4);
  if (Buffer.byteLength(data) !== bytes * 2) return [];
  const out: number[] = [];
  for (let i = 0; i < bytes; i++) {
    const high = nibble(data[i * 2]);
    const low = nibble(data[i * 2 + 1]);
    if (high < 0 || low < 0) return [];
    const packed = (high << 4) | low;
    for (let shift = 6; shift >= 0 && out.length < points; shift -= 2) out.push((packed >> shift) & 3);
  }
  return out;
}

/** decode_state_timeline (:1803-1836): one hex digit a point, each an index into a palette of 1 to 16. */
export function decodeStateTimeline(points: unknown, encoding: unknown, data: unknown, palette: string[]): number[] {
  if (!uint16(points) || typeof encoding !== 'string' || typeof data !== 'string') return [];
  if (!palette.length || palette.length > 16 || !points || points > 768 || encoding !== 'palette4-hex') return [];
  if (Buffer.byteLength(data) !== Math.floor((points + 1) / 2) * 2) return [];
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    const code = nibble(data[i]);
    if (code < 0 || code >= palette.length) return [];
    out.push(code);
  }
  return out;
}

export interface PanelHistory {
  available: boolean;
  /** The first 96 valid segments in wire order, then sorted by start (:1894-1916, :2163-2184). */
  segments: Array<{ start: number; end: number; state: string }>;
  /** Walked from the array's END, up to 96 valid entries: stored newest first (:1918-1937, :2186-2204). */
  activity: Array<{ timestamp: number; state: string }>;
  /** The decoded timeline: the bar is drawn from these whenever there are any (:1110-1157). */
  bins: number[];
  palette: string[];
  /** The popup's value label, only where the payload sets it. */
  current?: string;
}

function segmentsOf(doc: Doc, available: boolean, label: (state: unknown) => string): PanelHistory['segments'] {
  const out: PanelHistory['segments'] = [];
  if (!available || !Array.isArray(doc.segments)) return out;
  for (const item of doc.segments) {
    if (out.length >= 96) break;
    const fields = isDoc(item) ? item : {};
    const start = extractEpoch(fields.start);
    const end = extractEpoch(fields.end);
    const state = label(fields.state);
    if (!start || !end || end <= start) continue;
    out.push({ start, end, state });
  }
  return out.sort((a, b) => a.start - b.start);
}

function activityOf(doc: Doc, available: boolean, label: (state: unknown) => string): PanelHistory['activity'] {
  const out: PanelHistory['activity'] = [];
  if (!available || !Array.isArray(doc.activity)) return out;
  for (let index = doc.activity.length - 1; index >= 0 && out.length < 96; index--) {
    const item: unknown = doc.activity[index];
    const fields = isDoc(item) ? item : {};
    const timestamp = extractEpoch(fields.timestamp);
    if (!timestamp) continue;
    out.push({ timestamp, state: label(fields.state) });
  }
  return out;
}

/** The hours gate, `doc["hours"] | range_cfg.hours` (:1843-1844, :2094-2095). */
const rangeMatches = (doc: Doc, hours: number): boolean => (uint16(doc.hours) ? doc.hours : hours) === hours;

/** apply_binary_history_payload (:1838-1937) in a binary popup showing `hours`; null where it returns early. */
export function panelBinary(payload: string, hours: 24 | 168): PanelHistory | null {
  const doc = JSON.parse(payload) as Doc;
  if (!rangeMatches(doc, hours)) return null;
  const available = historyAvailable(doc);
  const current = 'current' in doc ? (doc.current === null ? '' : typeof doc.current === 'string' ? doc.current : undefined) : undefined;
  return {
    available,
    segments: segmentsOf(doc, available, binaryState),
    activity: activityOf(doc, available, binaryState),
    bins: available ? decodeBinaryTimeline(doc.timeline_points, doc.timeline_encoding, doc.timeline_data) : [],
    palette: [],
    ...(current === undefined ? {} : { current }),
  };
}

const stateLabel = (state: unknown): string => historyLabel(typeof state === 'string' ? state : 'unknown');

/** apply_state_history_payload (:2089-2204); an editable popup reads no `current` (:2111). */
export function panelState(payload: string, hours: 24 | 168, editable = false): PanelHistory | null {
  const doc = JSON.parse(payload) as Doc;
  if (!rangeMatches(doc, hours)) return null;
  const available = historyAvailable(doc);
  const palette: string[] = [];
  if (available && Array.isArray(doc.palette) && doc.palette.length <= 16) {
    for (const item of doc.palette) {
      if (typeof item !== 'string') {
        palette.length = 0;
        break;
      }
      palette.push(historyLabel(item));
    }
  }
  // String(current_variant.as<const char*>()): a non-string is no text at all.
  const current = !editable && 'current' in doc ? liveValue(typeof doc.current === 'string' ? doc.current : '') : undefined;
  return {
    available,
    segments: segmentsOf(doc, available, stateLabel),
    activity: activityOf(doc, available, stateLabel),
    bins: available ? decodeStateTimeline(doc.timeline_points, doc.timeline_encoding, doc.timeline_data, palette) : [],
    palette,
    ...(current === undefined ? {} : { current }),
  };
}

/** An editable popup waiting for a reply: editable_kind, and the id and range it asked with (sensor_popup.cpp:2536-2541). */
export interface EditablePopup {
  entityId: string;
  kind: 'number' | 'select' | 'date' | 'time' | 'datetime';
  requestId: string;
  hours: 24 | 168;
}

/**
 * apply_history_payload for an editable popup (:2263-2302, then :2303-2342 for
 * a number). Null where the reply is dropped whole. `values` is what the graph
 * plots (a gap null), `[]` a cleared chart, absent when the graph is untouched.
 */
export function panelEditable(payload: string, popup: EditablePopup): { history: PanelHistory; values?: Array<number | null> } | null {
  const doc = JSON.parse(payload) as Doc;
  const entity = typeof doc.entity_id === 'string' ? doc.entity_id : '';
  if (entity.toLowerCase() !== popup.entityId.toLowerCase()) return null;
  const available = historyAvailable(doc);
  const period = popup.hours === 24 ? 5 : 60;
  const values = doc.values;
  if (
    popup.kind === 'number' &&
    available &&
    (!Array.isArray(values) || values.length > 288 || (uint16(doc.period_minutes) ? doc.period_minutes : period) !== period)
  ) {
    return null;
  }
  // accept_editable_history_range (:2252-2261): request_id, then `doc["hours"] | 0`.
  if (!popup.requestId || popup.requestId !== (typeof doc.request_id === 'string' ? doc.request_id : '')) return null;
  if ((Number.isInteger(doc.hours) ? doc.hours : 0) !== popup.hours) return null;
  const history = panelState(payload, popup.hours, true);
  if (!history) return null;
  if (popup.kind !== 'number') return { history };
  if (!available) return { history, values: [] };
  // The kind switch comes first (:2303-2313): "binary" or "state" returns before the graph.
  if (doc.kind === 'binary' || doc.kind === 'state') return { history };
  if ((uint16(doc.hours) ? doc.hours : popup.hours) !== popup.hours) return { history };
  if ((uint16(doc.period_minutes) ? doc.period_minutes : period) !== period) return { history };
  if (!Array.isArray(values) || values.length > 288) return { history };
  // extract_numeric, and an editable graph's 1e8 bound (:2350-2358); no gap fill for an editable (:2369).
  return {
    history,
    values: values.map((v: unknown) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e8 ? v : null)),
  };
}

/** extract_json_string_field (mqtt_handlers.cpp:326-350): after the first quoted key ANYWHERE, the next quoted text. */
export function scanString(json: string, key: string): string {
  const pattern = `"${key}"`;
  const found = json.indexOf(pattern);
  if (found < 0) return '';
  const colon = json.indexOf(':', found + pattern.length);
  if (colon < 0) return '';
  const q1 = json.indexOf('"', colon + 1);
  if (q1 < 0) return '';
  const q2 = json.indexOf('"', q1 + 1);
  if (q2 < 0 || q2 <= q1 + 1) return '';
  return asciiTrim(json.slice(q1 + 1, q2));
}

/** extract_json_uint16_field (mqtt_handlers.cpp:352-375): digits right after the first key's colon, or 0. */
export function scanUint16(json: string, key: string): number {
  const pattern = `"${key}"`;
  const found = json.indexOf(pattern);
  if (found < 0) return 0;
  const colon = json.indexOf(':', found + pattern.length);
  if (colon < 0) return 0;
  const digits = /^[ \t\r\n]*(\d+)/.exec(json.slice(colon + 1));
  if (!digits) return 0;
  const value = Number(digits[1]);
  return value > 0xffff ? 0 : value;
}

/**
 * The history/response dispatch (mqtt_handlers.cpp:1832-1874): whether the
 * reply clears the one pending binary/state request -- entity and kind must
 * match, and hours too unless it is absent or 0
 * (clear_pending_discrete_history_request, :391-407, the hours check :402-405)
 * -- and whether it also goes to the tile graphs (non-discrete
 * only). A pending request left uncleared is answered 8 s later by the
 * panel itself with history_available:false (:541-553), over the real reply.
 */
export function dispatch(
  payload: string,
  pending: { entityId: string; kind: 'binary' | 'state'; hours: 24 | 168 },
): { clearsPending: boolean; toTileGraph: boolean } {
  const json = payload.slice(0, 32767);
  const entity = scanString(json, 'entity_id');
  const kind = scanString(json, 'kind').toLowerCase();
  const discrete = kind === 'binary' || kind === 'state';
  const hours = scanUint16(json, 'hours');
  const clearsPending =
    discrete &&
    entity.length > 0 &&
    entity.toLowerCase() === pending.entityId.toLowerCase() &&
    kind === pending.kind &&
    (hours === 0 || hours === pending.hours);
  return { clearsPending, toTileGraph: !discrete };
}
