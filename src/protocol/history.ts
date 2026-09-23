import { usableNumber } from './climate';
import { requireEntityId } from './commands';

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
 */
export type HistoryRequest =
  | { kind: 'numeric'; entityId: string; hours: number; periodMinutes: number }
  | { kind: 'state'; entityId: string; hours: 24 | 168 }
  | { kind: 'binary'; entityId: string; hours: 24 | 168 }
  | { kind: 'editable'; entityId: string; hours: number; requestId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

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
 * discrete shapes, `hours` must be exactly 24 or 168 -- the firmware only
 * ever *sends* one of those two (it snaps any other input before
 * publishing, mqtt_handlers.cpp:2456), and this parser deliberately does
 * not replicate that snap: an incoming value outside {24, 168} is rejected,
 * not silently coerced to 24.
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

    if (kind === 'binary' || kind === 'state') {
      const hours = finiteNumber(parsed.hours);
      if (hours === 24 || hours === 168) {
        return { kind, entityId, hours };
      }
      return null;
    }

    if (kind === 'editable') {
      const hours = finiteNumber(parsed.hours);
      const requestId = parsed.request_id;
      if (hours === null || typeof requestId !== 'string' || requestId.length === 0) return null;
      return { kind: 'editable', entityId, hours, requestId };
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
