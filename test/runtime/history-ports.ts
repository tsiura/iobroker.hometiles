/*
 * The three history adapters' getHistory as ports, and an adapter that
 * answers through them (Task 19): shared by the provider's tests and the
 * energy source's (Task 20b).
 */
import type {} from '@iobroker/adapter-core';
import type { HistorySource } from '../../src/runtime/history-provider';
import type { Logger } from '../../src/runtime/mqtt-client';

// ---- Ports of the three history adapters' getHistory, aggregate "none" only ----
//
// Read from the published packages (npm pack): iobroker.history 5.0.1,
// iobroker.sql 4.1.5, iobroker.influxdb 5.0.3 and the @iobroker/aggregate 1.0.1
// they share; js-controller-adapter 7.2.3 and 8.0.0-alpha for the message.

/** A row as a history adapter stores it. */
export type Stored = { ts: number; val: unknown; ack?: boolean; q?: number };
export type Options = ioBroker.GetHistoryOptions;

const byTs = (a: Stored, b: Stored): number => a.ts - b.ts;
const newestFirst = (a: Stored, b: Stored): number => b.ts - a.ts;

/** Only raw reads are ported: any other aggregate fails loudly, as a wrong query should. */
function rawOnly(adapter: string, options: Options): void {
  if (options.aggregate !== 'none') throw new Error(`the ${adapter} port reads raw rows only, not ${String(options.aggregate)}`);
}

/**
 * What js-controller does before it sends the message (adapter.js _getHistory,
 * 7.2.3 :6023-6025 and 8.0.0-alpha :6146-6148): an end of now + 5000 s, and
 * a week's start when neither count nor start is given.
 */
function asked(options: Options): Options & { end: number } {
  const o = { ...options };
  o.end ||= Date.now() + 5e6;
  if (!o.count && !o.start) o.start ||= Date.now() - 6048e5;
  return o as Options & { end: number };
}

/**
 * beautify for aggregate none (@iobroker/aggregate aggregate.js:1183-1344):
 * nulls per ignoreNull (:1207-1220), rows before start and after end dropped
 * (:1224-1234), no border values (:1241), the newest `count` kept (:1340-1344).
 */
function beautifyNone(rows: Stored[], start: number | undefined, end: number, count: number, ignoreNull: boolean | 0): Stored[] {
  let out = rows;
  if (ignoreNull === true) out = out.filter((row) => row.val !== null);
  else if (ignoreNull === 0) out = out.map((row) => (row.val === null ? { ...row, val: 0 } : row));
  if (start) out = out.filter((row) => row.ts >= start);
  const after = out.findIndex((row) => row.ts > end);
  if (after >= 0) out = out.slice(0, after);
  return out.length > count ? out.slice(out.length - count) : out;
}

/** ts2day (iobroker.history getHistory.js:122-136): the local day a row's file is named after. */
export function day(ts: number): number {
  const date = new Date(ts);
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/**
 * iobroker.history handleGetHistory, aggregate none (main.js:1097-1308). `cache`
 * is the in-memory list of rows not yet written, the newest; `files` the rows
 * in its day files.
 */
export function historyAdapter(cache: Stored[], files: Stored[], options: Options): Stored[] {
  rawOnly('history', options);
  const o = asked(options);
  const count = o.count || o.limit || 2000; // :1110, :1116-1119, :1139-1146
  const start = o.start;
  const newest = !!o.returnNewestEntries || (!start && !!count); // :1122, :1181-1183
  const ignoreNull = o.ignoreNull === true || o.ignoreNull === 0 ? o.ignoreNull : false; // :1214-1229
  // applyOptions (:1074-1096): ack and q only when asked for, ack as a boolean (:932-934, :1013-1015).
  const shaped = (rows: Stored[]): Stored[] =>
    rows.map(({ ts, val, ack, q }) => ({ ts, val, ...(o.ack ? { ack: !!ack } : {}), ...(o.q && q !== undefined ? { q } : {}) }));
  // getOneCachedData (:915-968): newest first, with one row before start and one after end.
  const cached: Stored[] = [];
  let after: Stored | undefined;
  for (let i = cache.length - 1; i >= 0; i--) {
    const row = cache[i]!;
    if (start && row.ts < start) {
      cached.unshift(row);
      break;
    }
    if (row.ts > o.end) {
      after = row;
      continue;
    }
    if (after) cached.unshift(after);
    after = undefined;
    cached.unshift(row);
    if (newest && cached.length >= count) break;
  }
  // The cache alone fills the request: sent as it is, no beautify (:983, :1244-1256).
  if (newest && cached.length >= count) return shaped(cached).sort(byTs).slice(-count);
  // getFileData (:1050-1073) and getOneFileData (:985-1049): each day file read
  // newest first, with no end check, until count; the days newest first when newest.
  const fileCount = newest ? count - cached.length : count; // :1258-1261
  const days = [...new Set(files.map((row) => day(row.ts)))]
    .filter((d) => d >= (start ? day(start) : 0) && d <= day(o.end))
    .sort((a, b) => (newest ? b - a : a - b));
  const read: Stored[] = [];
  for (const d of days) {
    let last = false;
    for (const row of files.filter((r) => day(r.ts) === d).sort(newestFirst)) {
      read.push(row);
      if (read.length >= fileCount) break;
      if (last) break;
      if (start && row.ts < start) last = true;
    }
    if (read.length >= fileCount) break;
  }
  let rows = [...shaped(cached), ...shaped(read)].sort(byTs);
  if (rows.length > count && !newest) {
    // The OLDEST count rows from start on (:1271-1291).
    const cut = start ? Math.max(0, rows.findIndex((row) => row.ts >= start)) : 0;
    rows = rows.slice(cut, cut + count);
  }
  return beautifyNone(rows, start, o.end, count, ignoreNull); // :1295
}

/**
 * iobroker.sql getHistorySql, aggregate none (main.js:2549-2787), its database
 * read as SQLite words it (lib/sqlite.js:136-205; mysql.js and postgresql.js
 * alike). Rows it has not yet written are not ported.
 */
export function sqlAdapter(stored: Stored[], options: Options): Stored[] {
  rawOnly('sql', options);
  const o = asked(options);
  const count = o.count || o.limit || 2000; // :2573, :2576, :2600-2607
  const start = o.start;
  const newest = !!o.returnNewestEntries || (!start && !!count); // :2582, :2628-2630
  const ignoreNull = o.ignoreNull === true ? true : o.ignoreNull === 0 ? 0 : false; // :2557-2566
  let rows = stored.filter((row) => row.ts < o.end && (!start || row.ts >= start)); // sqlite.js:145-149
  if (start) {
    // With a start: the last row before it and the first at or after end (sqlite.js:150-188).
    const before = stored.filter((row) => row.ts < start).at(-1);
    const next = stored.find((row) => row.ts >= o.end);
    rows = [...(before ? [before] : []), ...rows, ...(next ? [next] : [])];
  }
  // ORDER BY ts DESC when newest, LIMIT count + 2 (sqlite.js:192-202).
  rows = rows.sort(newest ? newestFirst : byTs).slice(0, count + 2).sort(byTs); // main.js:2776
  if (rows.length > count && !newest) {
    // The OLDEST count rows from start on (main.js:2756-2775).
    const cut = start ? Math.max(0, rows.findIndex((row) => row.ts >= start)) : 0;
    rows = rows.slice(cut, cut + count);
  }
  // sendResponse (aggregate.js:1383-1385) without a start: the newest count.
  if (!start && rows.length > count) rows = rows.slice(rows.length - count);
  // Columns ack and q only when asked for (sqlite.js:137); ack as a boolean (main.js:2474-2476).
  const shaped = rows.map(({ ts, val, ack, q }) => ({ ts, val, ...(o.ack ? { ack: !!ack } : {}), ...(o.q ? { q } : {}) }));
  return beautifyNone(shaped, start || shaped[0]?.ts, o.end, count, ignoreNull); // aggregate.js:1388, :1407-1410
}

/** iobroker.influxdb getHistoryV1, aggregate none (main.js:2258-2581). */
export function influxAdapter(stored: Stored[], options: Options): Stored[] {
  rawOnly('influxdb', options);
  const o = asked(options);
  const count = o.count || o.limit || 2000; // :2272-2277, :2298-2305
  const start = o.start;
  const newest = !!o.returnNewestEntries || (!start && !!count); // :2281, :2327-2329
  // SELECT * ... time > start AND time < end ORDER BY time DESC|ASC LIMIT count (:2442-2468).
  const main = stored
    .filter((row) => (!start || row.ts > start) && row.ts < o.end)
    .sort(newest ? newestFirst : byTs)
    .slice(0, count);
  // The border rows, `value` only: the last at or before start, the first at or after end (:2470-2478).
  const border: Stored[] = [];
  const before = start ? stored.filter((row) => row.ts <= start).at(-1) : undefined;
  if (before) border.push({ ts: before.ts, val: before.val });
  const next = stored.find((row) => row.ts >= o.end);
  if (next) border.push({ ts: next.ts, val: next.val });
  let rows = [...main.map((row) => ({ ...row })), ...border].sort(byTs); // :2496-2560
  if (!start && rows.length > count) rows = rows.slice(rows.length - count); // aggregate.js:1383-1385
  return beautifyNone(rows, start || rows[0]?.ts, o.end, count, true); // ignoreNull is forced true (:2279)
}

/**
 * An adapter as the provider sees it. getHistory runs one of the ports; like
 * js-controller, it sends the message whether or not the instance runs, and a
 * stopped instance never answers.
 */
export class FakeAdapter implements HistorySource {
  readonly calls: Array<{ id: string; options: Options }> = [];
  alive = true;
  logged = true;
  /** States this instance does not log, when `logged` is true. */
  readonly unlogged = new Set<string>();
  /** Live states by id, as getForeignStateAsync reads them. */
  readonly states: Record<string, unknown> = {};
  defaultHistory: unknown = '';
  private readonly scripted: Array<() => Promise<{ result?: unknown }>> = [];

  constructor(
    readonly instance: string,
    private readonly read: (options: Options, id: string) => Stored[],
  ) {}

  get lastCall(): { id: string; options: Options } {
    return this.calls.at(-1)!;
  }

  rejectNext(error: Error): void {
    this.scripted.push(() => Promise.reject(error));
  }

  replyNext(reply: () => Promise<{ result?: unknown }>): void {
    this.scripted.push(reply);
  }

  hangNext(): void {
    this.scripted.push(() => new Promise(() => undefined));
  }

  getHistoryAsync(id: string, options: Options): Promise<{ result?: unknown }> {
    this.calls.push({ id, options: { ...options } });
    const scripted = this.scripted.shift();
    if (scripted) return scripted();
    if (!this.alive) return new Promise(() => undefined);
    try {
      return Promise.resolve({ result: this.read(options, id) });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getForeignObjectAsync(id: string): Promise<unknown> {
    if (id === 'system.config') return { common: { defaultHistory: this.defaultHistory } };
    const logged = this.logged && !this.unlogged.has(id);
    return { type: 'state', common: { custom: logged ? { [this.instance]: { enabled: true } } : {} } };
  }

  async getForeignStateAsync(id: string): Promise<unknown> {
    return id === `system.adapter.${this.instance}.alive` ? { val: this.alive } : (this.states[id] ?? null);
  }
}

export const historyFake = (cache: Stored[], files: Stored[]): FakeAdapter =>
  new FakeAdapter('history.0', (options) => historyAdapter(cache, files, options));
export const sqlFake = (rows: Stored[]): FakeAdapter => new FakeAdapter('sql.0', (options) => sqlAdapter(rows, options));
export const influxFake = (rows: Stored[]): FakeAdapter => new FakeAdapter('influxdb.0', (options) => influxAdapter(rows, options));

export function logger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const add = (level: string) => (message: string) => void lines.push(`${level}: ${message}`);
  return { lines, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}
