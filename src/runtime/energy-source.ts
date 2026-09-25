import type { EnergyMeterRow } from '../config/options';
import { usableNumber } from '../protocol/climate';
import {
  applyEnergySign,
  bridgeRound,
  buildEnergyResponse,
  MAX_ENERGY_BYTES,
  parseEnergyRequest,
  type EnergyCatalogEntry,
  type EnergyCategory,
  type EnergyEntry,
  type EnergyPeriod,
} from '../protocol/energy';
import { energyResponseTopic } from '../protocol/topics';
import { lastSegment, objectMeta, type IoBrokerObject, type ObjectMeta } from '../registry/detector';
import { ENERGY_KEY, resolveEnergyIds } from '../registry/entity-id';
import { listed } from '../registry/manual';
import { HISTORY_BUDGET_MS, isLogged, PANEL_QUERIES, type HistoryProvider } from './history-provider';
import type { Logger } from './mqtt-client';

/**
 * Energy meters (Task 20b, Ruling 124): the Home Assistant Bridge reads HA's
 * energy dashboard and recorder statistics (__init__.py:2505-2971); ioBroker
 * has neither, so the user declares cumulative meters on the Energy tab and
 * each bucket's consumption is the counter's increase, read from the history
 * instance at the bucket's boundaries.
 */

/** A meter as the panels know it: an Energy tab row, its id resolved and its name and unit read. */
export interface EnergyMeter {
  /** `energy.<slug>`, stored under `energy:<state id>` (resolveEnergyIds): what an energy tile binds to. */
  id: string;
  stateId: string;
  category: EnergyCategory;
  sign: 1 | -1;
  name: string;
  unit?: string;
  price?: number;
}

/** Each category's total, named in the system's language: the Bridge's are German only (__init__.py:2828-2836). */
export type TotalNames = Readonly<Record<EnergyCategory, string>>;

/** The names of the totals an answer adds, in the system's language (Rulings 124, 132). */
export interface EnergyNames {
  totals: TotalNames;
  /** consumption_total, the Bridge's "Gesamtverbrauch" (__init__.py:2906). */
  consumption: string;
  /** consumption_untracked, its "Nicht erfasster Verbrauch" (__init__.py:2939). */
  untracked: string;
}

/** A meter's buckets: each counter increase, null where no reading is known, and their sum. */
export interface Consumption {
  values: Array<number | null>;
  total: number | null;
}

/** The value types a counter can be written in: a number, or its text (usableNumber, as history's rows). */
const COUNTER_TYPES: ReadonlySet<string> = new Set(['number', 'string', 'mixed']);

/** The state's metadata when it can be a meter, else why not (as registry/manual.ts servable). */
function counter(stateId: string, objects: Readonly<Record<string, IoBrokerObject>>, ownNamespace: string): ObjectMeta | string {
  const obj = Object.hasOwn(objects, stateId) ? objects[stateId] : undefined;
  if (!obj) return 'no such object';
  if (obj.type !== 'state') return `not a state object (type ${obj.type})`;
  if (stateId.startsWith(`${ownNamespace}.`)) return "the adapter's own state";
  const info = objectMeta(stateId, obj);
  if (info.type !== undefined && !COUNTER_TYPES.has(info.type)) return `a meter is a number, not a ${info.type}`;
  return info;
}

/**
 * The categories the house's consumption is made of (consumptionEntries, the
 * Bridge's __init__.py:2882-2944): while one of their meters is unknown, so
 * are its totals.
 */
export const ELECTRIC_CATEGORIES: readonly EnergyCategory[] = ['solar', 'grid', 'battery'];

/**
 * The Energy tab's rows as meters, at each rebuild. A row whose state is
 * missing, no state, the adapter's own, or holds no number is left out with
 * its reason. A meter's id is kept under `energy:<state id>` like a manual
 * entity's under `manual:` (`ids` goes into the stored map); its name is the
 * row's, else the object's as detection reads it; its unit the object's.
 * `unlogged`: meters `instance` does not log, whose tiles would show nothing;
 * `unloggedElectric`: those of them the house's consumption waits for too.
 */
export function energyMeters(
  rows: readonly EnergyMeterRow[],
  objects: Readonly<Record<string, IoBrokerObject>>,
  persisted: Readonly<Record<string, string>>,
  ownNamespace: string,
  instance: string,
): {
  meters: EnergyMeter[];
  ids: Record<string, string>;
  rejected: Array<{ stateId: string; reason: string }>;
  unlogged: string[];
  unloggedElectric: string[];
} {
  const rejected: Array<{ stateId: string; reason: string }> = [];
  const kept: Array<{ row: EnergyMeterRow; name: string; unit?: string }> = [];
  for (const row of rows) {
    const info = counter(row.stateId, objects, ownNamespace);
    if (typeof info === 'string') rejected.push({ stateId: row.stateId, reason: info });
    else kept.push({ row, name: row.name ?? (info.name.trim() || lastSegment(row.stateId)), unit: info.unit?.trim() || undefined });
  }
  const ids = resolveEnergyIds(
    kept.map(({ row, name }) => ({ stateId: row.stateId, name })),
    persisted,
  );
  const meters = kept.map(({ row, name, unit }): EnergyMeter => {
    const meter: EnergyMeter = { id: ids[ENERGY_KEY + row.stateId]!, stateId: row.stateId, category: row.category, sign: row.sign, name };
    if (unit) meter.unit = unit;
    if (row.price !== undefined) meter.price = row.price;
    return meter;
  });
  const unlogged = instance ? meters.filter((m) => !isLogged(objects[m.stateId], instance)) : [];
  return {
    meters,
    ids,
    rejected,
    unlogged: unlogged.map((m) => m.stateId),
    unloggedElectric: unlogged.filter((m) => ELECTRIC_CATEGORIES.includes(m.category)).map((m) => m.stateId),
  };
}

/**
 * The warning naming the meters the history instance does not log: their
 * tiles show no consumption, nor, while an electric one is among them, do
 * the house's totals, which are known only where every electric meter is
 * (energy round 2, C2).
 */
export function unloggedWarning(instance: string, unlogged: readonly string[], unloggedElectric: readonly string[]): string {
  const house = unloggedElectric.length
    ? `The house's total and untracked consumption stay blank as well while any grid, solar or battery meter is unknown: ${listed(unloggedElectric)}. `
    : '';
  return `Not logged by ${instance}, so their energy tiles show no consumption: ${listed(unlogged)}. ${house}Enable ${instance} in the settings of each of these states`;
}

const HOUR = 3_600_000;

/**
 * A period's first moment and its buckets' start times, in the host's local
 * time, as the Bridge's (__init__.py:2657-2668): day, every real hour from
 * local midnight, so 23 on the spring day and 25 on the autumn one; week,
 * the local midnights from six days ago; month, those from the 1st. The last
 * bucket runs from the last boundary to `now`. At most 31 buckets.
 */
export function energyPeriod(period: EnergyPeriod, now: number): { start: number; boundaries: number[] } {
  const today = new Date(now);
  const [year, month, day] = [today.getFullYear(), today.getMonth(), today.getDate()];
  if (period === 'day') {
    const start = new Date(year, month, day).getTime();
    return { start, boundaries: Array.from({ length: Math.floor((now - start) / HOUR) + 1 }, (_, h) => start + h * HOUR) };
  }
  const first = period === 'week' ? day - 6 : 1;
  const boundaries = Array.from({ length: day - first + 1 }, (_, i) => new Date(year, month, first + i).getTime());
  return { start: boundaries[0]!, boundaries };
}

/** A time in local ISO 8601 with its offset, as Python's isoformat: the popup reads the date (energy_popup.cpp:224-249). */
export function localIso(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(Math.abs(value)).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${offset < 0 ? '-' : '+'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

/** A counter's increase: a decrease is a reset and counts 0; noise below 1e-9 is 0, as the Bridge's (__init__.py:2729-2730). */
const increase = (from: number, to: number): number => (to - from > 1e-9 ? to - from : 0);

/**
 * Each bucket's consumption: the counter's increase from the reading before
 * its start to the reading before the next bucket's, the last to the live
 * reading. After a reset the next bucket counts from the new reading. A
 * bucket with no reading on either side is null. The total spans those gaps
 * (review I1): the increase between each two readings known, as HA's
 * statistics telescope across a missing hour. An hour a window could not
 * reach costs its bars, not the day's total.
 */
export function consumption(readings: ReadonlyArray<number | null>, live: number | null): Consumption {
  const values = readings.map((from, i) => {
    const to = i + 1 < readings.length ? readings[i + 1]! : live;
    return from === null || to === null ? null : increase(from, to);
  });
  const known = [...readings, live].filter((reading): reading is number => reading !== null);
  return { values, total: known.length > 1 ? known.slice(1).reduce((total, to, i) => total + increase(known[i]!, to), 0) : null };
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const known = (values: ReadonlyArray<number | null>): number[] => values.filter((value): value is number => value !== null);

/** Each slot's sum of the members' values, each signed, rounded; null where no member has one (__init__.py:2848-2860, :2888-2899). */
function signedSlots(members: readonly EnergyEntry[], digits: number): Array<number | null> {
  const length = Math.max(...members.map((member) => member.values.length));
  return Array.from({ length }, (_, i) => {
    const slot = members.flatMap((member) => {
      const value = member.values[i];
      return value === null || value === undefined ? [] : [applyEnergySign(value, member.sign)];
    });
    return slot.length > 0 ? bridgeRound(sum(slot), digits) : null;
  });
}

/** The sum of the members' signed totals, rounded, a total not known skipped; none while no member has one (review trap 6). */
function knownTotal(members: readonly EnergyEntry[], digits: number): number | undefined {
  const totals = known(members.map((member) => member.total ?? null));
  return totals.length > 0 ? bridgeRound(sum(totals), digits) : undefined;
}

/**
 * The entries of an answer, shaped as the Bridge's (__init__.py:2770-2944):
 * per meter its own, and a cost entry when it has a price; then each
 * category of two or more a total, one of energy and one of cost; and the
 * house's consumption (consumptionEntries), which goes first. Values and
 * totals are rounded as the Bridge rounds them: a meter's values to 3
 * decimals and its total from their unrounded sum, spanning any gap
 * (consumption); costs priced from the rounded values, to 4 decimals, their
 * total to 2, the gap at the same price; a category's slots to 3
 * (or 4) and its total, the sum of its members', to 3 (or 2). A meter's
 * values go out as measured and its total signed, so the panel, which turns
 * a positive value negative for sign -1, signs each once (applyEnergySign);
 * a total is signed already and goes out with sign 1. Without `series`, each
 * entry has no values: the catalog.
 */
export function energyEntries(
  meters: readonly EnergyMeter[],
  currency: string,
  names: EnergyNames,
  series?: ReadonlyMap<string, Consumption>,
): EnergyEntry[] {
  const entries: EnergyEntry[] = [];
  for (const meter of meters) {
    const used = series?.get(meter.id);
    const values = (used?.values ?? []).map((value) => (value === null ? null : bridgeRound(value, 3)));
    const own: EnergyEntry = { id: meter.id, category: meter.category, sign: meter.sign, values, name: meter.name };
    if (used && used.total !== null) own.total = bridgeRound(applyEnergySign(used.total, meter.sign), 3);
    if (meter.unit) own.unit = meter.unit;
    entries.push(own);
    if (meter.price === undefined) continue;
    const costs = values.map((value) => (value === null ? null : Math.abs(value) * meter.price!));
    const cost: EnergyEntry = {
      id: `${meter.id}_cost`,
      category: meter.category,
      sign: meter.sign,
      values: costs.map((value) => (value === null ? null : bridgeRound(value, 4))),
      unit: currency,
      is_cost: true,
      name: `${meter.name} (${currency})`,
    };
    // The rounded values priced, as the Bridge's (:2749-2765); the increase
    // the total spans across a gap in them (review I1) at the same price.
    if (used && used.total !== null) {
      const gap = used.total - sum(known(used.values));
      cost.total = bridgeRound(applyEnergySign(sum(known(costs)) + gap * meter.price, meter.sign), 2);
    }
    entries.push(cost);
  }
  for (const isCost of [false, true]) {
    const groups = new Map<string, EnergyEntry[]>();
    for (const entry of entries) {
      if (entry.is_total || !!entry.is_cost !== isCost) continue;
      groups.set(entry.category, [...(groups.get(entry.category) ?? []), entry]);
    }
    for (const [category, members] of groups) {
      if (members.length < 2) continue;
      const label = names.totals[category as EnergyCategory];
      const values = signedSlots(members, isCost ? 4 : 3);
      const total: EnergyEntry = { id: `${category}_total${isCost ? '_cost' : ''}`, category, sign: 1, name: isCost ? `${label} (${currency})` : label, values, is_total: true };
      const sumTotal = knownTotal(members, isCost ? 2 : 3);
      if (sumTotal !== undefined) total.total = sumTotal;
      if (isCost) {
        total.unit = currency;
        total.is_cost = true;
      } else if (members[0]!.unit) total.unit = members[0]!.unit;
      entries.push(total);
    }
  }
  return [...consumptionEntries(entries, names), ...entries];
}

/**
 * The Bridge's "Gesamtverbrauch" and "Nicht erfasster Verbrauch"
 * (__init__.py:2882-2944), under its ids -- a panel moved from Home Assistant
 * keeps its tiles -- and translated names (Ruling 132). consumption_total,
 * once a grid, solar or battery meter is set: each slot their values, each
 * signed, to 3 decimals; its total their signed totals. consumption_untracked,
 * once a device meter is set too: each slot of the consumption less the device
 * meters' values as measured, its total less their signed totals, as the
 * Bridge subtracts them (:2918, :2928; its dev_max is unused, the slots are the
 * consumption's). A slot or total is known only where every grid, solar and
 * battery meter has one (review N2): with the solar meter unknown, import less
 * export would read as the house's, even below 0. A device not known counts 0,
 * as in the Bridge. The unit is the first meter's where the Bridge writes kWh
 * (review trap 7).
 * They go first in an answer: its size guard strips the last entries first,
 * and the house's consumption is the tile most likely bound (review trap 8).
 */
function consumptionEntries(entries: readonly EnergyEntry[], names: EnergyNames): EnergyEntry[] {
  const own = (categories: readonly string[]): EnergyEntry[] =>
    entries.filter((entry) => !entry.is_total && !entry.is_cost && categories.includes(entry.category));
  const electric = own(ELECTRIC_CATEGORIES);
  if (electric.length === 0) return [];
  const unit = electric[0]!.unit;
  const complete = (i: number): boolean => electric.every((entry) => (entry.values[i] ?? null) !== null);
  const values = signedSlots(electric, 3).map((value, i) => (complete(i) ? value : null));
  const house: EnergyEntry = { id: 'consumption_total', category: 'consumption', sign: 1, name: names.consumption, values, is_total: true };
  const houseTotal = knownTotal(electric, 3);
  if (houseTotal !== undefined && electric.every((entry) => entry.total !== undefined)) house.total = houseTotal;
  if (unit) house.unit = unit;
  const devices = own(['device']);
  if (devices.length === 0) return [house];
  const untracked: EnergyEntry = {
    id: 'consumption_untracked',
    category: 'consumption',
    sign: 1,
    name: names.untracked,
    values: house.values.map((value, i) => (value === null ? null : bridgeRound(value - sum(known(devices.map((device) => device.values[i] ?? null))), 3))),
    is_total: true,
  };
  if (house.total !== undefined) untracked.total = bridgeRound(house.total - sum(known(devices.map((device) => device.total ?? null))), 3);
  if (unit) untracked.unit = unit;
  return [house, untracked];
}

/**
 * bridge/apply's `energy` catalog (contract §6.4): every id an answer
 * carries -- meters, cost entries, category totals and the house's
 * consumption, as the Bridge's catalog lists them (__init__.py:3981-4234) --
 * with its name, unit and category. It is where a tile finds its title
 * (energy/renderer.cpp:110-113) and its icon (ha_bridge_config.cpp:1083-1099,
 * :1165-1167); an answer's names are never shown.
 */
export function energyCatalog(meters: readonly EnergyMeter[], currency: string, names: EnergyNames): EnergyCatalogEntry[] {
  return energyEntries(meters, currency, names).map(({ id, name, unit, category }) => (unit ? { id, name: name!, unit, category } : { id, name: name!, category }));
}

/** What a rebuild tells the energy source. */
export interface EnergyConfig {
  /** Rulings 116 and 118: until the Devices tab has been used, no panel is answered. */
  armed: boolean;
  meters: readonly EnergyMeter[];
  currency: string;
  names: EnergyNames;
}

const LOG_EVERY_MS = 3_600_000;

/**
 * Answers the panels' energy requests (Task 20b) from the meters the last
 * rebuild configured, their readings before each bucket boundary from the
 * history provider, which keeps those of past boundaries, and each meter's
 * live reading for the running bucket.
 */
export class EnergySource {
  private config: EnergyConfig | undefined;
  /** When each log line last went out: the panel asks for the day every minute. */
  private readonly logged = new Map<string, number>();
  /** Meters named since the last rebuild for missing an answer's budget (Ruling 133). */
  private readonly named = new Set<string>();

  constructor(
    private readonly history: Pick<HistoryProvider, 'readingsBefore'>,
    private readonly states: { getForeignStateAsync(id: string): Promise<unknown> },
    private readonly log: Logger,
  ) {}

  configure(config: EnergyConfig): void {
    this.config = config;
    this.named.clear();
  }

  /**
   * Whether panels are given meters: once armed (Ruling 118), while one is
   * set. They alone make an apply worth sending (Ruling 131).
   */
  content(): boolean {
    return !!this.config?.armed && this.config.meters.length > 0;
  }

  /** The catalog of bridge/apply: the meters' while content(), else none. */
  catalog(): EnergyCatalogEntry[] {
    return this.content() ? energyCatalog(this.config!.meters, this.config!.currency, this.config!.names) : [];
  }

  /**
   * The one call Task 22 makes for a panel's energy/request: the topic and
   * payload of the answer, published not retained, or null for no answer --
   * while not armed or configured (Rulings 116, 118), for a payload that is no
   * request, and while no meter is set, as the Bridge (__init__.py:2644-2646).
   * It never throws. One budget of HISTORY_BUDGET_MS bounds the answer, the
   * wait for the panel's history slots included, so it goes out before the
   * panel asks again (energy_data.cpp:45-47). The meters are read
   * PANEL_QUERIES at a time, as many as the panel has slots, so its queue
   * stays free for its popups (Ruling 133, review trap 9). A meter not read
   * in time is answered with the readings kept, null for the rest, and named
   * once per rebuild.
   */
  async answer(deviceId: string, payload: string): Promise<{ topic: string; payload: string } | null> {
    const config = this.config;
    if (!config?.armed) return null;
    const request = parseEnergyRequest(payload);
    if (!request) return null;
    if (config.meters.length === 0) {
      this.note('none', 'info', `Panel ${deviceId} asks for energy data, but no energy meter is set on the Energy tab of the adapter settings`);
      return null;
    }
    try {
      const deadline = Date.now() + HISTORY_BUDGET_MS;
      const { start, boundaries } = energyPeriod(request.period, Date.now());
      const series = new Map<string, Consumption>();
      const late = new Set<string>();
      const next = config.meters.values();
      const reader = async (): Promise<void> => {
        for (const meter of next) {
          const { readings, reason } = await this.history.readingsBefore(meter.stateId, boundaries, deviceId, deadline);
          if (reason === 'timeout') late.add(meter.stateId);
          series.set(meter.id, consumption(readings, await this.live(meter.stateId)));
        }
      };
      await Promise.all(Array.from({ length: PANEL_QUERIES }, reader));
      const unnamed = config.meters.map((meter) => meter.stateId).filter((stateId) => late.has(stateId) && !this.named.has(stateId));
      if (unnamed.length > 0) {
        for (const stateId of unnamed) this.named.add(stateId);
        this.log.warn(
          `[Energy] The history instance did not answer in time for ${listed(unnamed)}: panel ${deviceId}'s ${request.period} ` +
            `answer went out within ${HISTORY_BUDGET_MS / 1000} s without some of their readings, which later answers read`,
        );
      }
      const built = buildEnergyResponse(request.period, localIso(start), energyEntries(config.meters, config.currency, config.names, series));
      if (built.valuesDropped > 0 || built.entriesDropped > 0) {
        this.note(
          `size ${request.period}`,
          'warn',
          `The ${request.period} answer is over the ${MAX_ENERGY_BYTES} bytes a panel parses: sent without the values of ` +
            `${built.valuesDropped} entries and without the last ${built.entriesDropped}. Set fewer energy meters on the Energy tab`,
        );
      }
      return { topic: energyResponseTopic(deviceId), payload: built.payload };
    } catch (error) {
      this.note('failed', 'warn', `Answering the energy request of panel ${deviceId} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** The meter's reading now: its live value when it is good, else none. */
  private async live(stateId: string): Promise<number | null> {
    try {
      const state = (await this.states.getForeignStateAsync(stateId)) as { val?: unknown; q?: unknown } | null | undefined;
      if (!state || (state.q ?? 0) !== 0) return null;
      return usableNumber(state.val) ?? null;
    } catch {
      return null;
    }
  }

  /** One English line per key and hour. */
  private note(key: string, level: 'info' | 'warn', text: string): void {
    const now = Date.now();
    if (now - (this.logged.get(key) ?? -Infinity) < LOG_EVERY_MS) return;
    this.logged.set(key, now);
    this.log[level](`[Energy] ${text}`);
  }
}
