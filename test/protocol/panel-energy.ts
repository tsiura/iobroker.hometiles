/*
 * What a panel keeps of an energy/response payload (HomeTiles v0.6.12,
 * src/types/energy/energy_data.cpp and src/network/mqtt/mqtt_handlers.cpp),
 * ported where a substring scan, a cap or a sign rule decides what the panel
 * shows. A test that only JSON.parses the payload cannot see that the period
 * is routed by the first "period" anywhere in the text, that a total is
 * signed once more on arrival, or that a payload over 32767 bytes is cut and
 * then fails to parse. Each function names the firmware code it ports.
 */

/** LARGE_BUF - 1 (mqtt_handlers.cpp:1496, :1879-1882): the bytes of an energy response the panel copies. */
const COPIED = 32767;
/** ENERGY_VALUES_MAX (energy_data.h:7). */
const VALUES_MAX = 32;

/** normalize_period (:49-54): week and month exactly, anything else day. */
const normalize = (period: unknown): string => (period === 'week' || period === 'month' ? period : 'day');

/**
 * response_period (:65-80): the queue a response waits in, found by the first
 * "period" in the whole text, the next ':' after it, then the next quoted token.
 */
export function responsePeriod(payload: string): string {
  const key = payload.indexOf('"period"');
  if (key < 0) return 'day';
  const colon = payload.indexOf(':', key + 8);
  if (colon < 0) return 'day';
  const begin = payload.indexOf('"', colon + 1);
  if (begin < 0) return 'day';
  const end = payload.indexOf('"', begin + 1);
  if (end < 0) return 'day';
  const value = payload.slice(begin + 1, end);
  return value === 'week' || value === 'month' ? value : 'day';
}

/** apply_energy_sign (:156-159): only a positive value is turned negative, and only for sign -1. */
export const panelSign = (value: number, sign: number): number => (sign < 0 && value > 0 ? -value : value);

/** format_energy_total (:151-154): what an energy tile shows, 2 decimals for a cost entry, else 3. */
export const panelTotalText = (total: number, isCost: boolean): string => (Number.isFinite(total) ? total.toFixed(isCost ? 2 : 3) : '--');

/** One EnergyEntryData (energy_data.h:9-25) as parse_energy_response leaves it. */
export interface PanelEnergyEntry {
  id: string;
  period: string;
  start: string;
  category: string;
  name: string;
  unit: string;
  isCost: boolean;
  isTotal: boolean;
  hasCost: boolean;
  sign: number;
  total: number;
  cost: number;
  /** A value the panel marks invalid (value_valid false) is null here. */
  values: Array<number | null>;
}

/**
 * The panel's handling of one energy/response (mqtt_handlers.cpp:1876-1885,
 * then queue_energy_response and parse_energy_response, energy_data.cpp:201-297):
 * cut at 32767 bytes, routed to a period's queue, parsed; null when the panel
 * drops it. Every entry with an id is kept; the name and unit fall back to the
 * apply's maps, given here as `names` and `units` (findSensorName, findSensorUnit).
 */
export function panelEnergy(
  payload: string,
  names: ReadonlyMap<string, string> = new Map(),
  units: ReadonlyMap<string, string> = new Map(),
): { queue: string; period: string; entries: PanelEnergyEntry[] } | null {
  const cut = Buffer.from(payload, 'utf8').subarray(0, COPIED).toString('utf8');
  const queue = responsePeriod(cut);
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(cut) as Record<string, unknown>;
  } catch {
    return null; // "[Energy] Response JSON invalid" (:204-206)
  }
  const period = normalize(doc.period ?? 'day');
  const start = typeof doc.start === 'string' ? doc.start : '';
  if (!Array.isArray(doc.entries)) return null; // "[Energy] Response without entries" (:212-216)
  const entries: PanelEnergyEntry[] = [];
  for (const item of doc.entries as unknown[]) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id : '';
    if (!id) continue; // :222-223
    const text = (value: unknown): string => (typeof value === 'string' ? value : '');
    const rawSign = typeof obj.sign === 'number' ? Math.trunc(obj.sign) : 1; // obj["sign"] | 1
    const sign = rawSign < 0 ? -1 : 1; // :234-235
    const entry: PanelEnergyEntry = {
      id,
      period,
      start,
      category: text(obj.category),
      name: text(obj.name) || (names.get(id) ?? ''),
      unit: text(obj.unit) || (units.get(id) ?? ''),
      isCost: obj.is_cost === true,
      isTotal: obj.is_total === true,
      hasCost: false,
      sign,
      // null and absent alike are 0 (:249-250): JSON has no NaN, so no total shows "--".
      total: typeof obj.total === 'number' ? panelSign(obj.total, sign) : 0,
      cost: 0,
      values: [],
    };
    if (obj.cost !== undefined && obj.cost !== null) {
      entry.cost = typeof obj.cost === 'number' ? obj.cost : 0;
      entry.hasCost = true; // present, even 0 (:251-255)
    }
    if (Array.isArray(obj.values)) {
      for (const value of obj.values as unknown[]) {
        if (entry.values.length >= VALUES_MAX) break; // :260
        entry.values.push(typeof value === 'number' ? panelSign(value, sign) : null); // :262-269
      }
    }
    entries.push(entry);
  }
  return { queue, period, entries };
}
