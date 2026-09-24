import { createHash } from 'node:crypto';
import type { VirtualEntity } from '../registry/types';
import { STATE_UNAVAILABLE, STATE_UNKNOWN } from '../registry/types';
import { unixSeconds } from './apply';
import { usableNumber } from './climate';
import { requireEntityId } from './commands';
import { showable } from './editable';

/**
 * The four shapes that arrive on the single `<base>/history/request` topic
 * (docs/contract-history-energy.md Sec. 2-3). There is no per-kind
 * sub-topic; payload shape is the only dispatch key the firmware itself
 * uses (contract Sec. 1, Sec. 8), so this parser never looks at a topic.
 *
 * - numeric: mqttPublishHistoryRequest, mqtt_handlers.cpp:2381-2447.
 * - state / binary: mqttPublishStateHistoryRequest /
 *   mqttPublishBinaryHistoryRequest, both via the shared
 *   mqttPublishDiscreteHistoryRequest, mqtt_handlers.cpp:2449-2499.
 * - editable: the undocumented fourth producer, editable_request_history,
 *   value_control.cpp:179-189, called from Number/Select/DateTime popups.
 *
 * `maxTransitions` is the most segments and Activity entries a reply carries
 * (Ruling 122), already capped at 96.
 */
export type HistoryRequest =
  | { kind: 'numeric'; entityId: string; hours: number; periodMinutes: number }
  | { kind: 'state'; entityId: string; hours: 24 | 168; maxTransitions: number }
  | { kind: 'binary'; entityId: string; hours: 24 | 168; maxTransitions: number }
  | { kind: 'editable'; entityId: string; hours: 24 | 168; maxTransitions: number; requestId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The popup's two ranges (sensor_popup.cpp:249-257), all a discrete or editable popup asks for. */
const popupHours = (value: unknown): 24 | 168 | null => (value === 24 || value === 168 ? value : null);

/** kBinaryMaxSegments and kBinaryMaxActivityEntries (sensor_popup.cpp:59, :61). */
const MAX_TRANSITIONS = 96;

/**
 * max_transitions: the popup asks for its 96 (sensor_popup.cpp:2549-2553,
 * value_control.cpp:186) and the publisher clamps to 2..96
 * (mqtt_handlers.cpp:2457-2459). More is capped at 96; none, or null, is the
 * 48 both the publisher and the Bridge default to (mqtt_handlers.cpp:2457,
 * state_history.py:70-75); anything else is malformed.
 */
function maxTransitions(value: unknown): number | null {
  if (value === undefined || value === null) return 48;
  return typeof value === 'number' && Number.isInteger(value) && value >= 2 ? Math.min(value, MAX_TRANSITIONS) : null;
}

/** The longest request_id answered; the Bridge cuts at 48 (__init__.py:1637). */
const MAX_REQUEST_ID_BYTES = 64;

/**
 * Parses one `history/request` payload into a typed request, or `null` if
 * it does not cleanly match exactly one of the four shapes above. Never
 * throws: this runs inside an MQTT message handler, and a malformed,
 * truncated, non-JSON, or wrong-typed payload must not take the handler
 * down with it.
 *
 * Dispatch is entirely on the payload's `kind` field, which is the
 * contract's actual distinguishing field (Sec. 8):
 * `mqttPublishHistoryRequest` (numeric) never writes a `kind` key at all
 * (verified directly against mqtt_handlers.cpp:2411-2419 -- the payload is
 * hand-built by string concatenation with no such key), so "kind absent" IS
 * the numeric shape, not a leftover default. `kind:"binary"` / `"state"`
 * select the two discrete shapes (mqtt_handlers.cpp:2476-2486); `kind:
 * "editable"` selects the editable shape (value_control.cpp:179-189). Any
 * other `kind` value fits none of the four and is rejected -- this also
 * means a payload cannot be ambiguous between shapes: exactly one of
 * {absent, "binary", "state", "editable"} ever matches.
 *
 * `entity_id` and every range field (`hours`, `period_minutes`) are carried
 * through with their original type and value, never rounded or
 * re-derived: a future responder must echo them back verbatim for the
 * firmware to accept the response (contract Sec. 4.1, Sec. 5). For the
 * discrete and editable shapes, `hours` must be exactly 24 or 168 -- the
 * firmware only ever *sends* one of those two (it snaps a discrete request
 * before publishing, mqtt_handlers.cpp:2456; an editable popup asks with its
 * range's, sensor_popup.cpp:2536-2540), and this parser deliberately does
 * not replicate that snap: an incoming value outside {24, 168} is rejected,
 * not silently coerced to 24. An editable popup drops a reply for any other
 * range anyway (sensor_popup.cpp:2255), and its graph's period follows from
 * those two alone.
 */
export function parseHistoryRequest(payload: string): HistoryRequest | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!isRecord(parsed)) return null;

    const entityId = requireEntityId(parsed);
    const kind = parsed.kind;

    if (kind === undefined) {
      const hours = finiteNumber(parsed.hours);
      const periodMinutes = finiteNumber(parsed.period_minutes);
      if (hours === null || periodMinutes === null) return null;
      return { kind: 'numeric', entityId, hours, periodMinutes };
    }

    if (kind === 'binary' || kind === 'state' || kind === 'editable') {
      const hours = popupHours(parsed.hours);
      const limit = maxTransitions(parsed.max_transitions);
      if (hours === null || limit === null) return null;
      if (kind !== 'editable') return { kind, entityId, hours, maxTransitions: limit };
      // Every reply echoes it. The panel's has 26 characters
      // (value_control.cpp:36-42); a far longer one would make a reply the
      // panel cuts at 32767 bytes and cannot parse (review M2b).
      const requestId = parsed.request_id;
      if (typeof requestId !== 'string' || requestId.length === 0 || Buffer.byteLength(requestId) > MAX_REQUEST_ID_BYTES) return null;
      return { kind, entityId, hours, maxTransitions: limit, requestId };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * The most values one numeric response carries: the firmware's largest
 * request, kHistoryPoints24h (sensor_popup.cpp:52) -- the popup's 24-hour
 * range and every tile graph ask for 24 h in 5-minute periods
 * (sensor_popup.cpp:2557, tile_renderer.cpp:4673) -- and the hard cap of its
 * editable path (sensor_popup.cpp:2288, :2342). 288 values of any width stay
 * far inside the 32767 bytes the firmware copies out of a history message
 * (mqtt_handlers.cpp:1496, :1836); a longer message is cut there and no
 * longer parses.
 */
const MAX_NUMERIC_HISTORY_VALUES = 288;

type HistorySample = { ts: number; val: unknown };

/**
 * Builds the `history/response` payload for a numeric graph request, or
 * returns null for a malformed range, which gets no response at all. `now`
 * and every `ts` are epoch milliseconds, as ioBroker history stamps rows.
 *
 * No timestamps go on the wire: the array index is the time. Both firmware
 * readers size the chart to the array (sensor_popup.cpp:2349, :2417;
 * tile_renderer.cpp:4627), and the popup labels the axis from the panel's own
 * clock, now - hours .. now (sensor_popup.cpp:616-643, :645-670). So there are
 * always hours * 60 / period_minutes buckets (the firmware's own formula for
 * `points`, mqtt_handlers.cpp:2393), oldest first, the last one ending at
 * `now`; a shorter array would be stretched over the whole axis.
 *
 * A reading is a numeric sample: a non-numeric, blank or non-finite `val` is
 * none, never 0. A sample at exactly `now` is in the last bucket; a later one
 * is not history. A bucket with readings holds their mean (the request asks
 * for `"stat":"mean"`, mqtt_handlers.cpp:2419). An empty bucket carries the
 * reading in effect -- the latest reading before it, one from before the
 * window included -- because both firmware readers would fill a `null` by
 * copying the previous element (sensor_popup.cpp:2351-2380,
 * tile_renderer.cpp:4573-4594), and that is a bucket's MEAN: after one
 * 2000 W minute logged on change, it would paint 1000 W over the idle hours
 * that follow. So a value is `null` only while no reading exists yet, a
 * leading gap the firmware back-fills from the first value.
 *
 * `entity_id`, `hours` and `period_minutes` are echoed verbatim -- the popup
 * drops a response whose hours or period differ from its range
 * (sensor_popup.cpp:2324-2329) -- and nothing else is emitted: `stat` and
 * `points` are never read back. A malformed range -- zero, negative or
 * non-finite hours or period_minutes, or more than 288 buckets -- is refused:
 * the firmware never sends one, and the tile graph applies any response for
 * its entity without checking the range (tile_renderer.cpp:4498-4514), so even
 * an empty answer would wipe it. A valid range with no readings still gets an
 * answer, every value null, so a stale graph clears.
 */
export function buildNumericHistoryResponse(
  req: Extract<HistoryRequest, { kind: 'numeric' }>,
  samples: readonly HistorySample[],
  now: number,
): string | null {
  const { entityId, hours, periodMinutes } = req;
  // Checked before dividing: -24 hours over -5 minutes is +288 buckets.
  const count = periodMinutes > 0 ? Math.floor((hours * 60) / periodMinutes) : 0;
  if (!(count >= 1 && count <= MAX_NUMERIC_HISTORY_VALUES)) return null;
  const values = bucketValues(samples, now, periodMinutes * 60_000, count);
  return JSON.stringify({ entity_id: entityId, hours, period_minutes: periodMinutes, values });
}

type Bucket = { sum: number; n: number; lastTs: number; last: number | null };

function bucketValues(
  samples: readonly HistorySample[],
  now: number,
  periodMs: number,
  count: number,
): Array<number | null> {
  const start = now - count * periodMs;
  const newBucket = (): Bucket => ({ sum: 0, n: 0, lastTs: -Infinity, last: null });
  const before = newBucket(); // readings before the window: only the latest is used
  const buckets = Array.from({ length: count }, newBucket);
  for (const { ts, val } of samples) {
    const value = usableNumber(val);
    if (value === undefined || !Number.isFinite(ts) || ts > now) continue;
    const bucket = ts < start ? before : buckets[Math.min(Math.floor((ts - start) / periodMs), count - 1)];
    if (!bucket) continue;
    bucket.sum += value;
    bucket.n += 1;
    if (ts >= bucket.lastTs) {
      bucket.lastTs = ts;
      bucket.last = value;
    }
  }
  let inEffect = before.last;
  return buckets.map((bucket) => {
    if (bucket.n === 0) return inEffect;
    inEffect = bucket.last;
    return bucket.sum / bucket.n;
  });
}

/** A history row as the entity's own state text -- what its synth makes of the row -- stamped in epoch ms. */
export type StateSample = { ts: number; state: string };

/** The entity as it is published now; lastChanged is epoch ms, 0 when never observed. */
export type CurrentState = Pick<VirtualEntity, 'state' | 'available' | 'lastChanged'>;

type Segment = { start: number; end: number; state: string };

/** kBinaryMaxTimelineBins (sensor_popup.cpp:60): the bar's resolution. */
const TIMELINE_POINTS = 768;

/** A history message is copied into LARGE_BUF and cut at 32767 bytes (mqtt_handlers.cpp:1496, :1836); cut, it no longer parses. */
const MAX_RESPONSE_BYTES = 32767;

/** Arduino's String::trim: isspace, ASCII blanks only. */
const ASCII_BLANKS = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g;

/** bounded_utf8_prefix_length (sensor_popup.cpp:894-915): whole characters within `max` UTF-8 bytes. */
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

/**
 * normalize_state_live_value (sensor_popup.cpp:917-926): trimmed and cut to
 * 255 bytes. A lone surrogate becomes U+FFFD first, as it reaches the panel
 * over MQTT.
 */
const liveText = (text: string): string => utf8Prefix(Buffer.from(text).toString().replace(ASCII_BLANKS, ''), 255);

/**
 * normalize_state_history_value (sensor_popup.cpp:928-953), byte for byte: the
 * panel's own name for a state in its bar, palette and Activity. Over 32
 * bytes, a text keeps 23 and gains "~" and 8 hex of the SHA-256 of the
 * trimmed, 255-byte text. Sending that name bounds every label at 32 bytes,
 * and it is the name the panel gives the same state arriving live, so the
 * two are never different states.
 */
function stateLabel(text: string): string {
  const live = liveText(text);
  if (!live || /^unknown$/i.test(live)) return STATE_UNKNOWN;
  if (/^unavailable$/i.test(live)) return STATE_UNAVAILABLE;
  if (Buffer.byteLength(live) <= 32) return live;
  return `${utf8Prefix(live, 23)}~${createHash('sha256').update(live).digest('hex').slice(0, 8)}`;
}

/** binary_state_code (sensor_popup.cpp:854-865): on, off or unavailable, anything else unknown. */
function binaryLabel(text: string): string {
  const state = text.replace(ASCII_BLANKS, '').toLowerCase();
  return state === 'on' || state === 'off' || state === STATE_UNAVAILABLE ? state : STATE_UNKNOWN;
}

/**
 * The rows in time order, by their millisecond stamps. The live state counts
 * as the Bridge counts it (binary_history.py:125-146): with rows, as one more
 * at its last change, so a history adapter that lags behind still ends on it;
 * with none, not at all -- the caller lets it stand for the whole window
 * rather than make up a change from its last_changed.
 */
function historyRows(samples: readonly StateSample[], current: CurrentState, endS: number): StateSample[] {
  const rows = samples
    .map((sample, order) => ({ ...sample, order }))
    .filter(({ ts }) => Number.isFinite(ts) && unixSeconds(ts) < endS);
  if (rows.length && current.lastChanged > 0 && unixSeconds(current.lastChanged) < endS) {
    rows.push({ ts: current.lastChanged, state: current.state, order: samples.length });
  }
  return rows.sort((a, b) => a.ts - b.ts || a.order - b.order);
}

/**
 * The window's opening state and every change within it, oldest first, in
 * whole epoch seconds: extract_epoch reads an integer and drops a fraction as
 * 0 (sensor_popup.cpp:836-851). Of several rows in one second the last
 * stands, as the Bridge collapses them (binary_history.py:341-350); a
 * repeated state is no change.
 */
function transitions(rows: StateSample[], fallback: string, startS: number, label: (text: string) => string) {
  const seconds: Array<[number, string]> = [];
  for (const { ts, state } of rows) {
    const second = unixSeconds(ts);
    const last = seconds.at(-1);
    if (last?.[0] === second) last[1] = label(state);
    else seconds.push([second, label(state)]);
  }
  let initial = fallback;
  const changes: Array<[number, string]> = [];
  for (const [second, state] of seconds) {
    if (second <= startS) initial = state;
    else if (state !== (changes.at(-1)?.[1] ?? initial)) changes.push([second, state]);
  }
  return { initial, changes };
}

/**
 * An editable Number's graph (Ruling 127): Task 17's buckets -- `count` of
 * `periodMs`, the last ending at `now` -- each holding the reading in effect
 * at its end, the latest row at or before it, as the Bridge samples the value
 * in effect (editable_helpers.py:178-187). So no bucket shows a value the
 * number never held, and the live row, one row among the others, never
 * weighs twice. A row that is no number (unavailable, unknown) is a gap until
 * the next number, as is the time before the first row: an editable graph
 * draws a gap as a gap (sensor_popup.cpp:2369).
 */
function valuesInEffect(rows: readonly StateSample[], now: number, periodMs: number, count: number): Array<number | null> {
  const start = now - count * periodMs;
  let next = 0;
  let inEffect: number | null = null;
  return Array.from({ length: count }, (_, bucket) => {
    const end = start + (bucket + 1) * periodMs;
    for (; next < rows.length && rows[next]!.ts <= end; next++) inEffect = usableNumber(rows[next]!.state) ?? null;
    return inEffect;
  });
}

/**
 * The bar in TIMELINE_POINTS bins over the window, each the code of the
 * segment that wins it, by the Bridge's bin arithmetic
 * (binary_history.py:305-330). The segments cover the window end to end, so
 * every bin gets one.
 */
function timelineCodes(
  segments: Segment[],
  startS: number,
  endS: number,
  code: (state: string) => number,
  wins: (next: number, held: number) => boolean,
): number[] {
  const span = endS - startS;
  const codes: number[] = [];
  for (const { start, end, state } of segments) {
    const next = code(state);
    const last = Math.floor(((end - startS) * TIMELINE_POINTS - 1) / span);
    for (let bin = Math.floor(((start - startS) * TIMELINE_POINTS) / span); bin <= last; bin++) {
      const held = codes[bin];
      if (held === undefined || wins(next, held)) codes[bin] = next;
    }
  }
  return codes;
}

/** Off 0, on 1, unknown 2, unavailable 3 (binary_state_code, sensor_popup.cpp:854-865). */
const BINARY_CODES: Readonly<Record<string, number>> = { off: 0, on: 1, unknown: 2, unavailable: 3 };
/** By code: on over unavailable over unknown over off -- binary_state_priority (sensor_popup.cpp:876-883). */
const BINARY_PRIORITY = [1, 4, 2, 3];

/**
 * "2bit-hex": four codes a byte, the first in the high bits
 * (decode_binary_timeline, sensor_popup.cpp:1783-1798). A short "on" wins
 * its bin, so a motion within one still shows.
 */
function binaryTimeline(segments: Segment[], startS: number, endS: number): Record<string, unknown> {
  const codes = timelineCodes(
    segments,
    startS,
    endS,
    (state) => BINARY_CODES[state] ?? 2,
    (next, held) => BINARY_PRIORITY[next]! > BINARY_PRIORITY[held]!,
  );
  let data = '';
  for (let i = 0; i < codes.length; i += 4) {
    data += ((codes[i]! << 6) | (codes[i + 1]! << 4) | (codes[i + 2]! << 2) | codes[i + 3]!).toString(16).padStart(2, '0');
  }
  return { timeline_points: TIMELINE_POINTS, timeline_encoding: '2bit-hex', timeline_data: data };
}

/**
 * "palette4-hex": one hex digit a bin, an index into a palette of at most 16
 * (decode_state_timeline, sensor_popup.cpp:1803-1836; kStateHistoryMaxPaletteEntries,
 * :62). unknown and unavailable first, then the newest states, as the Bridge
 * orders them (state_history.py:437-458); a state without a slot is unknown,
 * code 0, and palette_complete says so (:2126-2131). A bin is the state it
 * ends in, as the panel fills one on a live change (:1389-1416).
 */
function stateTimeline(segments: Segment[], startS: number, endS: number): Record<string, unknown> {
  const reserved = [STATE_UNKNOWN, STATE_UNAVAILABLE];
  const slots = 16 - reserved.length;
  const newest = [...new Set(segments.map(({ state }) => state).reverse())].filter((state) => !reserved.includes(state));
  const palette = [...reserved, ...newest.slice(0, slots)];
  const codes = timelineCodes(segments, startS, endS, (state) => Math.max(0, palette.indexOf(state)), () => true);
  return {
    timeline_points: TIMELINE_POINTS,
    timeline_encoding: 'palette4-hex',
    timeline_data: codes.map((code) => code.toString(16)).join(''),
    palette,
    palette_complete: newest.length <= slots,
  };
}

/**
 * The `history/response` payload for a binary, state or editable popup
 * (docs/contract-history-energy.md Sec. 4.2-4.4), or null for a request the
 * parser refuses, which gets no response (Ruling 70). `now`, every sample's
 * `ts` and `current.lastChanged` are epoch ms; the wire carries whole epoch
 * seconds. `samples` are the entity's history rows as its synth reads each,
 * one from before the window included: the latest of those opens it.
 *
 * - kind, entity_id and hours lead, then request_id: the dispatcher reads the
 *   FIRST "kind", "entity_id" and "hours" anywhere in the text
 *   (mqtt_handlers.cpp:1839-1853), and a reply that does not clear the
 *   pending request is overwritten 8 s later by the panel's own "history
 *   unavailable" (:541-553). hours is echoed (sensor_popup.cpp:1843-1844,
 *   :2094-2095, :2255), request_id too (:2253).
 * - The bar: a 768-bin timeline over the whole window. The popup draws it in
 *   preference to the segments (:1110-1157) and moves it on a live change
 *   (:1389-1418); segments alone would leave all but the newest 96 of a busy
 *   window blank.
 * - segments and activity: the newest min(max_transitions, 96), oldest
 *   first. The popup keeps the first 96 valid segments in wire order and
 *   walks Activity from the end (:1894-1937, :2163-2204); more would keep the
 *   oldest segments.
 * - binary: current, available and last_changed (:1846-1871); a
 *   last_changed of 0 is left out, since null would clear it. state: current
 *   (:2111-2119). An editable popup reads neither.
 * - editable (Ruling 121): the popup runs the state history whatever the
 *   kind (:2282-2291), and a state goes by the name /control gives it
 *   (`showable`), which its live Activity uses (:3099). A number adds its
 *   graph, the reading in effect at each bucket end (Ruling 127), over the
 *   range's period (:2287-2289) under kind "number" -- "state" returns before
 *   the graph (:2309-2310) -- and, like the Bridge, no bar or palette, which
 *   its popup hides (:2071; editable_helpers.py:188-190). A select or
 *   date/time goes as "state", which keeps it off the tile graphs
 *   (mqtt_handlers.cpp:1870-1871).
 *
 * `historyAvailable` false (Ruling 126: the provider read no history) makes
 * the popup say "History unavailable" at once: history_available false and an
 * error, which forces it whatever the flag says (:1873-1874 and :1967-1976,
 * :2121-2122 and :2237-2246, :2283 and :2301), under the same head. An
 * editable popup has no timeout of its own (value_control.cpp:179-189), so it
 * always gets this reply. It carries no values, which the tile graphs would
 * take (tile_renderer.cpp:4498-4526). A reply over 32767 bytes -- only texts
 * full of control characters get there -- would be cut and dropped, leaving
 * the popup on "Loading"; it gets the same reply.
 */
export function buildDiscreteHistoryResponse(
  req: Extract<HistoryRequest, { kind: 'binary' | 'state' | 'editable' }>,
  samples: readonly StateSample[],
  now: number,
  current: CurrentState,
  historyAvailable: boolean,
): string | null {
  const { entityId, hours, maxTransitions: limit } = req;
  if ((hours !== 24 && hours !== 168) || !Number.isInteger(limit) || limit < 2 || limit > MAX_TRANSITIONS) return null;
  const binary = req.kind === 'binary';
  const number = req.kind === 'editable' && entityId.startsWith('number.');
  const head = {
    kind: binary ? 'binary' : number ? 'number' : 'state',
    entity_id: entityId,
    hours,
    ...(req.kind === 'editable' ? { request_id: req.requestId } : {}),
  };
  const unavailable = (error: string): string => JSON.stringify({ ...head, history_available: false, error });
  if (!historyAvailable) return unavailable('history_unavailable');

  const endS = unixSeconds(now);
  const startS = endS - hours * 3600;
  const label = binary ? binaryLabel : req.kind === 'editable' ? (text: string) => stateLabel(showable(text)) : stateLabel;
  const rows = historyRows(samples, current, endS);
  const { initial, changes } = transitions(rows, rows.length ? STATE_UNKNOWN : label(current.state), startS, label);
  const window = { range_start: startS, range_end: endS, history_available: true };
  const activity = changes.slice(-limit).map(([timestamp, state]) => ({ timestamp, state }));
  let body: Record<string, unknown>;
  if (number) {
    const periodMinutes = hours === 24 ? 5 : 60;
    const values = valuesInEffect(rows, now, periodMinutes * 60_000, (hours * 60) / periodMinutes);
    body = { ...head, period_minutes: periodMinutes, ...window, values, activity };
  } else {
    const edges = [startS, ...changes.map(([second]) => second), endS];
    const segments = [initial, ...changes.map(([, state]) => state)].map((state, i) => ({ start: edges[i]!, end: edges[i + 1]!, state }));
    const live =
      req.kind === 'binary'
        ? {
            current: liveText(current.state),
            available: current.available,
            ...(current.lastChanged > 0 ? { last_changed: unixSeconds(current.lastChanged) } : {}),
          }
        : req.kind === 'state'
          ? { current: liveText(current.state) }
          : {};
    const timeline = binary ? binaryTimeline(segments, startS, endS) : stateTimeline(segments, startS, endS);
    body = { ...head, ...window, ...live, ...timeline, segments: segments.slice(-limit), activity };
  }
  const text = JSON.stringify(body);
  return Buffer.byteLength(text) <= MAX_RESPONSE_BYTES ? text : unavailable('response_too_large');
}
