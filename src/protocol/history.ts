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
