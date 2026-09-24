/**
 * The energy request and response of HomeTiles v0.6.12
 * (docs/contract-history-energy.md §6.1-6.3), shaped as the Home Assistant
 * Bridge answers (__init__.py _async_handle_energy_request, :2505-2971).
 * Not the `energy` catalog of bridge/apply (§6.4): apply.ts builds that.
 */

export type EnergyPeriod = 'day' | 'week' | 'month';

/** The categories the panel draws an icon for (energy_data.cpp:161-171, ha_bridge_config.cpp:1083-1099). */
export const ENERGY_CATEGORIES = ['grid', 'solar', 'battery', 'gas', 'water', 'device', 'device_water'] as const;
export type EnergyCategory = (typeof ENERGY_CATEGORIES)[number];

/** ENERGY_VALUES_MAX (energy_data.h:7): the panel reads no further value of an entry (energy_data.cpp:260). */
export const MAX_ENERGY_VALUES = 32;

/**
 * The largest energy/response a panel parses, in UTF-8 bytes: it copies the
 * payload into its 32768-byte LARGE_BUF, NUL included, cutting anything longer
 * (mqtt_handlers.cpp:1496, :1876-1883), and a cut payload is no JSON, so the
 * whole answer is dropped (energy_data.cpp:203-207).
 */
export const MAX_ENERGY_BYTES = 32767;

/**
 * One entry, as the Bridge builds it (__init__.py:2785-2880). The panel signs
 * `values` and `total` itself, flipping only a positive one for sign -1
 * (apply_energy_sign, energy_data.cpp:156-159): a meter's values go out as
 * measured and its total signed, as the Bridge's do, and neither is flipped
 * twice. A total left undefined is unknown and not sent: null and absent both
 * show 0.000 (energy_data.cpp:249-250), and JSON has no NaN for "--".
 */
export interface EnergyEntry {
  id: string;
  category: string;
  sign: 1 | -1;
  values: Array<number | null>;
  total?: number;
  name?: string;
  unit?: string;
  is_cost?: true;
  is_total?: true;
}

/**
 * The period of a panel's {"period":"day"|"week"|"month"}; any other period is
 * day, as on the panel (mqtt_handlers.cpp:2531-2535) and in the Bridge, which
 * trims and lowercases it (__init__.py:2514-2516). Null when the payload is no
 * JSON object: nothing is answered (the Bridge would answer day).
 */
export function parseEnergyRequest(payload: string): { period: EnergyPeriod } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const asked = (parsed as { period?: unknown }).period;
  const period = typeof asked === 'string' ? asked.trim().toLowerCase() : '';
  return { period: period === 'week' || period === 'month' ? period : 'day' };
}

/**
 * Python's round(value, digits), which the Bridge rounds with: the nearest,
 * an exact tie to the even neighbour (round(0.125, 2) is 0.12; toFixed says
 * 0.13). A tie is exact only when value * 2^(digits+1) is an odd integer.
 */
export function bridgeRound(value: number, digits: number): number {
  const twice = value * 2 ** (digits + 1);
  if (Number.isInteger(twice) && twice % 2 !== 0) {
    const tie = (twice * 5 ** digits) / 2;
    const down = Math.floor(tie);
    return (down % 2 === 0 ? down : Math.ceil(tie)) / 10 ** digits;
  }
  return Number(value.toFixed(digits));
}

/** The Bridge's _apply_stat_sign (__init__.py:2703-2706), the panel's apply_energy_sign: only a positive value turns negative. */
export function applyEnergySign(value: number, sign: number): number {
  return sign < 0 && value > 0 ? -value : value;
}

export interface EnergyResponse {
  payload: string;
  /** Entries sent without their values to fit MAX_ENERGY_BYTES, the last ones first. */
  valuesDropped: number;
  /** Entries left out at the end, once no values were left to drop. */
  entriesDropped: number;
}

/** An entry as it goes out: at most MAX_ENERGY_VALUES values, nothing that is not finite. */
function wire(entry: EnergyEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry, values: entry.values.slice(0, MAX_ENERGY_VALUES).map((v) => (v !== null && Number.isFinite(v) ? v : null)) };
  if (entry.total === undefined || !Number.isFinite(entry.total)) delete out.total;
  return out;
}

/**
 * energy/response. The period goes first: the panel picks the answer's queue
 * by the first "period" anywhere in the text (response_period,
 * energy_data.cpp:65-80), and an entry's text could spell one. `start` is the
 * period's first moment in local ISO 8601; the popup counts the week's days
 * from its date (energy_popup.cpp:224-255). The Bridge's `stat_period` is left
 * out: the panel never reads it.
 *
 * Over MAX_ENERGY_BYTES, the last entries lose their values first, which only
 * the popup's chart needs; if the totals alone are still too many, the last
 * entries go. Never more bytes than a panel parses.
 */
export function buildEnergyResponse(period: EnergyPeriod, start: string, entries: readonly EnergyEntry[]): EnergyResponse {
  const head = `{"period":${JSON.stringify(period)},"start":${JSON.stringify(start)},"entries":[`;
  const tail = ']}';
  const parts = entries.map((entry) => JSON.stringify(wire(entry)));
  const sizes = parts.map((part) => Buffer.byteLength(part, 'utf8'));
  let bytes = Buffer.byteLength(head + tail, 'utf8') + sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, parts.length - 1);
  let valuesDropped = 0;
  for (let i = parts.length - 1; i >= 0 && bytes > MAX_ENERGY_BYTES; i--) {
    const bare = wire(entries[i]!);
    delete bare.values;
    parts[i] = JSON.stringify(bare);
    const size = Buffer.byteLength(parts[i]!, 'utf8');
    bytes += size - sizes[i]!;
    sizes[i] = size;
    valuesDropped++;
  }
  let entriesDropped = 0;
  while (parts.length > 0 && bytes > MAX_ENERGY_BYTES) {
    bytes -= sizes.pop()! + (parts.length > 1 ? 1 : 0);
    parts.pop();
    entriesDropped++;
  }
  return { payload: head + parts.join(',') + tail, valuesDropped, entriesDropped };
}
