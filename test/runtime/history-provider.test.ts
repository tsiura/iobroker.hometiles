import type * as utils from '@iobroker/adapter-core';
import { expect } from 'chai';
import sinon from 'sinon';
import {
  HistoryProvider,
  MAX_HISTORY_ROWS,
  PANEL_QUERIES,
  PANEL_QUEUE,
  QUERY_TIMEOUT_MS,
  type HistoryKind,
  type HistoryResult,
  type HistorySource,
} from '../../src/runtime/history-provider';
import type { Logger } from '../../src/runtime/mqtt-client';

// ---- Ports of the three history adapters' getHistory, aggregate "none" only ----
//
// Read from the published packages (npm pack): iobroker.history 5.0.1,
// iobroker.sql 4.1.5, iobroker.influxdb 5.0.3 and the @iobroker/aggregate 1.0.1
// they share; js-controller-adapter 7.2.3 and 8.0.0-alpha for the message.

/** A row as a history adapter stores it. */
type Stored = { ts: number; val: unknown; ack?: boolean; q?: number };
type Options = ioBroker.GetHistoryOptions;

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
function day(ts: number): number {
  const date = new Date(ts);
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

/**
 * iobroker.history handleGetHistory, aggregate none (main.js:1097-1308). `cache`
 * is the in-memory list of rows not yet written, the newest; `files` the rows
 * in its day files.
 */
function historyAdapter(cache: Stored[], files: Stored[], options: Options): Stored[] {
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
function sqlAdapter(stored: Stored[], options: Options): Stored[] {
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
function influxAdapter(stored: Stored[], options: Options): Stored[] {
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
class FakeAdapter implements HistorySource {
  readonly calls: Array<{ id: string; options: Options }> = [];
  alive = true;
  logged = true;
  defaultHistory: unknown = '';
  private readonly scripted: Array<() => Promise<{ result?: unknown }>> = [];

  constructor(
    readonly instance: string,
    private readonly read: (options: Options) => Stored[],
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
      return Promise.resolve({ result: this.read(options) });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async getForeignObjectAsync(id: string): Promise<unknown> {
    if (id === 'system.config') return { common: { defaultHistory: this.defaultHistory } };
    return { type: 'state', common: { custom: this.logged ? { [this.instance]: { enabled: true } } : {} } };
  }

  async getForeignStateAsync(id: string): Promise<unknown> {
    return id === `system.adapter.${this.instance}.alive` ? { val: this.alive } : null;
  }
}

const historyFake = (cache: Stored[], files: Stored[]): FakeAdapter =>
  new FakeAdapter('history.0', (options) => historyAdapter(cache, files, options));
const sqlFake = (rows: Stored[]): FakeAdapter => new FakeAdapter('sql.0', (options) => sqlAdapter(rows, options));
const influxFake = (rows: Stored[]): FakeAdapter => new FakeAdapter('influxdb.0', (options) => influxAdapter(rows, options));

function logger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const add = (level: string) => (message: string) => void lines.push(`${level}: ${message}`);
  return { lines, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Local 06:00, so the window start's day file also holds the hours before it. */
const START = new Date(2026, 8, 23, 6, 0, 0).getTime();
const NOW = START + DAY;
const ID = 'hm-rpc.0.OEQ0123456.1.TEMPERATURE';

/** `count` rows `step` ms apart from `first`, each value from its index. */
function series(first: number, step: number, count: number, val: (i: number) => unknown = (i) => 20 + i / 10): Stored[] {
  return Array.from({ length: count }, (_, i) => ({ ts: first + i * step, val: val(i), ack: true, q: 0 }));
}

/** A reading three days old, then one every 30 minutes through the window. */
const PRIOR: Stored = { ts: START - 3 * DAY, val: 18.5, ack: true, q: 0 };
const WINDOW = series(START + 15 * MINUTE, 30 * MINUTE, 48);
const STORED = [PRIOR, ...WINDOW];

/** The history adapter keeps its newest rows in memory until it writes them. */
const inMemory = (rows: Stored[], since: number): Stored[] => rows.filter((row) => row.ts >= since);
const inFiles = (rows: Stored[], since: number): Stored[] => rows.filter((row) => row.ts < since);

const flavours: Array<[string, (rows: Stored[]) => FakeAdapter]> = [
  ['history', (rows) => historyFake(inMemory(rows, NOW - 2 * HOUR), inFiles(rows, NOW - 2 * HOUR))],
  ['sql', sqlFake],
  ['influxdb', influxFake],
];

const provide = (fake: FakeAdapter, log: Logger = logger(), instance = fake.instance): HistoryProvider =>
  new HistoryProvider(fake, log, instance);

const ask = (provider: HistoryProvider, kind: HistoryKind = 'numeric', start = START, panel = 'panel-a', id = ID): Promise<HistoryResult> =>
  provider.query(id, { start, kind, panel });

const values = (result: HistoryResult): unknown[] => result.rows.map((row) => row.val);
const stamps = (result: HistoryResult): number[] => result.rows.map((row) => row.ts);

/** Lets every pending promise callback run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('runtime/history-provider', () => {
  let clock: sinon.SinonFakeTimers;
  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => clock.restore());

  describe('the instance it reads', () => {
    it('queries the configured instance', async () => {
      const fake = sqlFake(STORED);
      await ask(provide(fake, logger(), 'sql.0'));
      expect(fake.lastCall.options.instance).to.equal('sql.0');
    });

    it("falls back to the system's default history instance when none is configured", async () => {
      const fake = sqlFake(STORED);
      fake.defaultHistory = 'sql.0';
      const result = await ask(provide(fake, logger(), ''));
      // The window, then the reading in effect before it.
      expect(fake.calls.map((call) => call.options.instance)).to.deep.equal(['sql.0', 'sql.0']);
      expect(result.available).to.equal(true);
    });

    it('asks nothing, never guessing history.0, when neither is set', async () => {
      for (const defaultHistory of ['', undefined, null, 5, 'history', 'history.0; x']) {
        const fake = historyFake([], STORED);
        fake.defaultHistory = defaultHistory;
        const log = logger();
        const result = await ask(provide(fake, log, ''));
        expect(result, String(defaultHistory)).to.deep.equal({ rows: [], now: NOW, available: false, reason: 'no_instance' });
        expect(fake.calls, String(defaultHistory)).to.deep.equal([]);
        expect(log.lines, String(defaultHistory)).to.have.length(1);
      }
    });

    it('asks nothing of an instance that is not running, which would never answer', async () => {
      const fake = sqlFake(STORED);
      fake.alive = false;
      const pending = ask(provide(fake));
      await clock.tickAsync(QUERY_TIMEOUT_MS);
      expect(await pending).to.deep.include({ rows: [], available: false, reason: 'not_running' });
      expect(fake.calls).to.deep.equal([]);
    });

    it('asks nothing for a state the instance does not log', async () => {
      const fake = sqlFake(STORED);
      fake.logged = false;
      expect(await ask(provide(fake))).to.deep.equal({ rows: [], now: NOW, available: false, reason: 'not_logged' });
      expect(fake.calls).to.deep.equal([]);
    });
  });

  describe('the query (Ruling 123)', () => {
    it('reads raw rows, never an average, for every kind: the newest up to the bound, with quality and ack', async () => {
      for (const kind of ['numeric', 'discrete'] as const) {
        const fake = sqlFake(STORED);
        await ask(provide(fake), kind);
        const [main] = fake.calls;
        expect(main!.options, kind).to.deep.include({
          instance: 'sql.0',
          start: START,
          count: MAX_HISTORY_ROWS,
          aggregate: 'none',
          returnNewestEntries: true,
          ignoreNull: false,
          ack: true,
          q: true,
        });
        // No end: the adapter reads up to when it answers, and `now` is taken after that.
        expect(main!.options, kind).to.not.have.property('end');
      }
    });

    it('asks for the reading in effect at the window start as the newest rows up to it, however old', async () => {
      const fake = sqlFake(STORED);
      await ask(provide(fake));
      expect(fake.calls).to.have.length(2);
      const prior = fake.calls[1]!.options;
      expect(prior).to.deep.include({ instance: 'sql.0', end: START, aggregate: 'none', returnNewestEntries: true, ignoreNull: false });
      expect(prior).to.not.have.property('start');
      // One more than the window's rows and then two: the history adapter's
      // day file counts the rows after `end` in that day against it.
      expect(prior.count).to.equal(WINDOW.length + 3);
    });

    for (const [name, make] of flavours) {
      it(`${name}: returns every row of the window after the reading in effect at its start, oldest first, in ms`, async () => {
        const result = await ask(provide(make(STORED)));
        expect(result.available).to.equal(true);
        expect(stamps(result)).to.deep.equal(STORED.map((row) => row.ts));
        expect(values(result)).to.deep.equal(STORED.map((row) => row.val));
      });

      it(`${name}: returns the reading in effect alone when nothing changed in the window`, async () => {
        const result = await ask(provide(make([PRIOR])));
        expect(result.rows).to.have.length(1);
        expect(result.rows[0]).to.include({ ts: PRIOR.ts, val: 18.5 });
      });

      it(`${name}: keeps the NEWEST rows when the bound is hit, and nothing from before them`, async () => {
        // Over two days: the history adapter reads each day file newest first,
        // so only a second day tells the newest rows from the oldest.
        const busy = [PRIOR, ...series(START + MINUTE, 16_000, MAX_HISTORY_ROWS + 100)];
        expect(day(busy.at(-1)!.ts)).to.not.equal(day(START));
        const fake = make(busy);
        const result = await ask(provide(fake));
        expect(result.rows).to.have.length(MAX_HISTORY_ROWS);
        expect(stamps(result)).to.deep.equal(busy.slice(-MAX_HISTORY_ROWS).map((row) => row.ts));
        // The rows before the newest are unknown: no reading is carried over them.
        expect(fake.calls).to.have.length(1);
      });
    }

    it('history: finds the reading in effect behind a day file full of later rows', async () => {
      // Local 05:59, then 400 changes the same day: the adapter reads each day
      // file newest first and counts those 400 before it reaches 05:59.
      const prior: Stored = { ts: START - MINUTE, val: 7, ack: true, q: 0 };
      const earlier = series(START - 5 * HOUR, HOUR, 5, () => 3);
      const sameDay = series(START + MINUTE, 2 * MINUTE, 400);
      const nextDay = series(START + 18 * HOUR, 10 * MINUTE, 30);
      const rows = [...earlier, prior, ...sameDay, ...nextDay];
      const result = await ask(provide(historyFake(nextDay.slice(-5), rows.slice(0, -5))));
      expect(result.rows[0]).to.include({ ts: prior.ts, val: 7 });
      expect(result.rows).to.have.length(1 + sameDay.length + nextDay.length);
    });

    it('history: finds the reading in effect when the whole window is in the day file it starts in', async () => {
      // Written to file and quiet since: all 100 rows of the window come
      // before 05:59 in that file, newest first.
      const prior: Stored = { ts: START - MINUTE, val: 7, ack: true, q: 0 };
      const window = series(START + MINUTE, 2 * MINUTE, 100);
      const result = await ask(provide(historyFake([], [prior, ...window])));
      expect(values(result)).to.deep.equal([7, ...window.map((row) => row.val)]);
    });

    it('influxdb: reads a row at exactly the window start as the reading in effect, without asking again', async () => {
      const fake = influxFake([PRIOR, { ts: START, val: 19, ack: true, q: 0 }, ...WINDOW]);
      const result = await ask(provide(fake));
      expect(result.rows[0]).to.include({ ts: START, val: 19 });
      expect(fake.calls).to.have.length(1);
    });

    it('takes `now` after the adapter answered', async () => {
      const fake = sqlFake(STORED);
      fake.replyNext(async () => {
        clock.tick(7_000);
        return { result: sqlAdapter(STORED, { ...fake.lastCall.options }) };
      });
      const result = await ask(provide(fake));
      expect(result.now).to.equal(NOW + 7_000);
    });

    it('logs one line per entity and hour when the bound is hit', async () => {
      const log = logger();
      const provider = provide(sqlFake(series(START + MINUTE, 10_000, MAX_HISTORY_ROWS + 1)), log);
      await ask(provider);
      await ask(provider);
      expect(log.lines).to.have.length(1);
      expect(log.lines[0]).to.include(ID).and.include(String(MAX_HISTORY_ROWS));
      clock.tick(HOUR);
      await ask(provider);
      expect(log.lines).to.have.length(2);
    });
  });

  describe('quality (Task 17 and Task 18 carries)', () => {
    // The history adapter writes a null with q 0x40 when it stops and starts
    // (writeNulls, main.js:288-300, :398-425); a device can report bad quality.
    const MARKED: Stored[] = [
      PRIOR,
      { ts: START - HOUR, val: null, ack: true, q: 0x40 },
      { ts: START + HOUR, val: 21, ack: true, q: 0 },
      { ts: START + 2 * HOUR, val: null, ack: true, q: 0x40 },
      { ts: START + 3 * HOUR, val: 22, ack: false, q: 0x42 },
      { ts: START + 4 * HOUR, val: 'n/a', ack: true, q: 0 },
      { ts: START + 5 * HOUR, val: 23, ack: true, q: 0 },
    ];

    for (const [name, make] of flavours.slice(0, 2)) {
      it(`${name}: numeric keeps only good numeric readings, the reading in effect a good one`, async () => {
        const result = await ask(provide(make(MARKED)), 'numeric');
        expect(values(result)).to.deep.equal([18.5, 21, 23]);
      });

      it(`${name}: discrete keeps every row, bad quality and null included, with its quality`, async () => {
        const result = await ask(provide(make(MARKED)), 'discrete');
        expect(result.rows.map((row) => [row.val, row.q])).to.deep.equal([
          [null, 0x40],
          [21, 0],
          [null, 0x40],
          [22, 0x42],
          ['n/a', 0],
          [23, 0],
        ]);
        expect(result.rows[3]!.ack).to.equal(false);
      });
    }

    it('drops malformed rows and keeps the rest', async () => {
      const fake = sqlFake([]);
      fake.replyNext(async () => ({
        result: [null, 5, 'row', { ts: 'x', val: 1 }, { ts: Number.NaN, val: 1 }, { val: 2 }, { ts: START + 1, val: 3, q: 'bad' }, { ts: START, val: 4 }],
      }));
      const result = await ask(provide(fake), 'discrete');
      expect(result.available).to.equal(true);
      expect(result.rows).to.deep.equal([{ ts: START, val: 4, ack: false, q: 0 }]);
    });
  });

  describe('never throwing into the MQTT handler', () => {
    it('does not throw when the history adapter fails', async () => {
      const fake = sqlFake(STORED);
      fake.rejectNext(new Error('not running'));
      const log = logger();
      expect(await ask(provide(fake, log))).to.deep.equal({ rows: [], now: NOW, available: false, reason: 'failed' });
      expect(log.lines.join()).to.include('not running');
    });

    it('gives up on an adapter that does not answer', async () => {
      const fake = sqlFake(STORED);
      fake.hangNext();
      const pending = ask(provide(fake));
      await clock.tickAsync(QUERY_TIMEOUT_MS);
      expect(await pending).to.deep.equal({ rows: [], now: NOW + QUERY_TIMEOUT_MS, available: false, reason: 'timeout' });
    });

    it('reads an answer without a list of rows as no history', async () => {
      // js-controller resolves with no result when the message could not be
      // sent (adapter.js 7.2.3 :4793-4795 with :6041-6042).
      for (const reply of [{}, { result: 'rows' }, { result: { 0: {} } }]) {
        const fake = sqlFake(STORED);
        fake.replyNext(async () => reply);
        expect(await ask(provide(fake)), JSON.stringify(reply)).to.deep.equal({ rows: [], now: NOW, available: false, reason: 'malformed' });
      }
    });

    it('keeps the window when only the question for the reading in effect fails', async () => {
      const fake = sqlFake(STORED);
      fake.replyNext(async () => ({ result: sqlAdapter(STORED, { ...fake.lastCall.options }) }));
      fake.rejectNext(new Error('connection lost'));
      const result = await ask(provide(fake));
      expect(result.available).to.equal(true);
      expect(stamps(result)).to.deep.equal(WINDOW.map((row) => row.ts));
    });

    it('does not throw when the adapter cannot read its own objects', async () => {
      const fake = sqlFake(STORED);
      fake.getForeignObjectAsync = () => Promise.reject(new Error('objects database closed'));
      expect(await ask(provide(fake))).to.deep.include({ rows: [], available: false, reason: 'failed' });
    });

    it('takes the adapter itself as its source (a compile-time check)', () => {
      const fits = (adapter: utils.AdapterInstance): HistorySource => adapter;
      expect(fits).to.be.a('function');
    });
  });

  describe('load (per panel, and shared)', () => {
    /** An adapter whose every answer waits for release(); each answer is a row at the window start. */
    function gated(): FakeAdapter & { release: () => void } {
      const fake = sqlFake([]) as FakeAdapter & { release: () => void };
      const waiting: Array<() => void> = [];
      fake.getHistoryAsync = (id, options) => {
        fake.calls.push({ id, options: { ...options } });
        return new Promise((resolve) => waiting.push(() => resolve({ result: [{ ts: options.start ?? 0, val: 1 }] })));
      };
      fake.release = () => waiting.shift()?.();
      return fake;
    }

    it('shares one query among identical requests in flight, within the same minute', async () => {
      const fake = sqlFake(STORED);
      const provider = provide(fake);
      const [a, b] = await Promise.all([ask(provider), ask(provider, 'numeric', START + 30_000, 'panel-b')]);
      expect(fake.calls).to.have.length(2); // the window and the reading before it, once
      expect(b).to.equal(a);
      await ask(provider, 'discrete');
      expect(fake.calls).to.have.length(4);
      await ask(provider);
      expect(fake.calls).to.have.length(6);
    });

    it(`runs at most ${PANEL_QUERIES} queries per panel at once and queues the rest; other panels are not held up`, async () => {
      const fake = gated();
      const provider = provide(fake);
      const results = [1, 2, 3].map((n) => ask(provider, 'numeric', START, 'panel-a', `${ID}${n}`));
      const other = ask(provider, 'numeric', START, 'panel-b', `${ID}4`);
      await settle();
      expect(fake.calls.map((call) => call.id)).to.deep.equal([`${ID}1`, `${ID}2`, `${ID}4`]);
      fake.release();
      await settle();
      expect(fake.calls.map((call) => call.id)).to.deep.equal([`${ID}1`, `${ID}2`, `${ID}4`, `${ID}3`]);
      fake.release();
      fake.release();
      fake.release();
      for (const result of [...results, other]) expect((await result).available).to.equal(true);
    });

    it('answers a panel that asks for more than it may queue as busy', async () => {
      const fake = gated();
      const log = logger();
      const provider = provide(fake, log);
      const queued = Array.from({ length: PANEL_QUERIES + PANEL_QUEUE }, (_, n) => ask(provider, 'numeric', START, 'panel-a', `${ID}${n}`));
      const refused = await ask(provider, 'numeric', START, 'panel-a', `${ID}x`);
      expect(refused).to.deep.equal({ rows: [], now: NOW, available: false, reason: 'busy' });
      expect(log.lines).to.have.length(1);
      for (let n = 0; n < queued.length; n++) {
        fake.release();
        await settle();
      }
      for (const result of queued) expect((await result).available).to.equal(true);
    });
  });
});
