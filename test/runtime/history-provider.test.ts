import type * as utils from '@iobroker/adapter-core';
import { expect } from 'chai';
import sinon from 'sinon';
import {
  HistoryProvider,
  MAX_CACHED_READINGS,
  MAX_HISTORY_ROWS,
  PANEL_QUERIES,
  PANEL_QUEUE,
  QUERY_TIMEOUT_MS,
  type HistoryKind,
  type HistoryResult,
  type HistorySource,
  type Readings,
} from '../../src/runtime/history-provider';
import type { Logger } from '../../src/runtime/mqtt-client';
import { day, FakeAdapter, historyFake, influxFake, logger, sqlAdapter, sqlFake, type Stored } from './history-ports';

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

  describe('readings before bucket boundaries (Task 20b)', () => {
    const METER = 'shelly.0.shellyem3.Total';
    /** Local midnight of NOW's day; NOW is 06:00. */
    const TODAY = new Date(2026, 8, 24).getTime();
    /** The week's local midnights: 6 days ago to today. */
    const MIDNIGHTS = Array.from({ length: 7 }, (_, i) => new Date(2026, 8, 18 + i).getTime());
    /** 01:00 to 05:00: every hour of the day so far but the current one. */
    const HOURS = [1, 2, 3, 4, 5].map((h) => TODAY + h * HOUR);
    /** A kWh counter read every 10 minutes, from 5 past a midnight eight days ago to 05:55 today: 144 rows a day. */
    const COUNTER = series(new Date(2026, 8, 16).getTime() + 5 * MINUTE, 10 * MINUTE, 8 * 144 + 36, (i) => 1000 + i / 10);
    /** The newest good numeric reading stamped before `t`. */
    const expected = (rows: Stored[], t: number): number | null => {
      const row = rows.filter((r) => r.ts < t && (r.q ?? 0) === 0 && typeof r.val === 'number').at(-1);
      return row ? (row.val as number) : null;
    };
    const before = (provider: HistoryProvider, times: number[], panel = 'panel-a', id = METER): Promise<Readings> =>
      provider.readingsBefore(id, times, panel);

    for (const [name, make] of flavours) {
      it(`${name}: reads the newest good reading before each midnight and each hour, however many rows follow it`, async () => {
        const times = [...MIDNIGHTS, ...HOURS];
        const result = await before(provide(make(COUNTER)), times);
        expect(result.available).to.equal(true);
        expect(result.readings).to.deep.equal(times.map((t) => expected(COUNTER, t)));
        expect(result.readings.every((reading) => reading !== null)).to.equal(true);
      });

      it(`${name}: reads a row stamped on a boundary as the next bucket's, and passes over bad quality`, async () => {
        const rows: Stored[] = [
          { ts: TODAY - HOUR, val: 10, q: 0 },
          { ts: TODAY - MINUTE, val: null, q: 0x40 },
          { ts: TODAY, val: 11, q: 0 },
          { ts: TODAY + HOUR - 1, val: 12, q: 0 },
          { ts: TODAY + HOUR, val: 13, q: 0 },
          { ts: TODAY + 90 * MINUTE, val: 'n/a', q: 0 },
          { ts: TODAY + 100 * MINUTE, val: 14, q: 0x42 },
        ];
        const result = await before(provide(make(rows)), [TODAY, TODAY + HOUR, TODAY + 2 * HOUR]);
        expect(result.readings).to.deep.equal([10, 12, 13]);
      });

      it(`${name}: reads null before the first reading, which stays null`, async () => {
        const late = COUNTER.filter((row) => row.ts > MIDNIGHTS[3]! + 2 * HOUR);
        const fake = make(late);
        const provider = provide(fake);
        const result = await before(provider, [...MIDNIGHTS, HOURS[0]!]);
        expect(result.readings).to.deep.equal([null, null, null, null, ...MIDNIGHTS.slice(4).map((t) => expected(late, t)), expected(late, HOURS[0]!)]);
        const calls = fake.calls.length;
        await before(provider, MIDNIGHTS);
        expect(fake.calls).to.have.length(calls);
      });
    }

    it('asks for a midnight as the newest rows up to the millisecond before it, however old, and for the hours as one window from the first', async () => {
      const fake = sqlFake(COUNTER);
      await before(provide(fake), [MIDNIGHTS[0]!, ...HOURS]);
      const common = { instance: 'sql.0', aggregate: 'none', returnNewestEntries: true, ignoreNull: false, ack: true, q: true };
      const [midnight, window, prior] = fake.calls.map((call) => call.options);
      // iobroker.history's day file of the day before holds no later row to count against `count`.
      expect(midnight).to.deep.include({ ...common, end: MIDNIGHTS[0]! - 1, count: 3 });
      expect(midnight).to.not.have.property('start');
      // The query's own window and the reading before it: its count covers the rows after it in its day file.
      expect(window).to.deep.include({ ...common, start: HOURS[0]! - 1, count: MAX_HISTORY_ROWS });
      expect(window).to.not.have.property('end');
      const windowRows = COUNTER.filter((row) => row.ts >= HOURS[0]! - 1).length;
      expect(prior).to.deep.include({ ...common, end: HOURS[0]! - 1, count: windowRows + 3 });
      expect(fake.calls).to.have.length(3);
    });

    it('history: reads the hours from a window, since a day file counts its rows after an hour against `count`', async () => {
      // Written to file up to 04:00, in memory since: an hour's question as a
      // midnight's (newest 3 up to it) would get 01:05 onwards and drop them.
      const fake = historyFake(inMemory(COUNTER, NOW - 2 * HOUR), inFiles(COUNTER, NOW - 2 * HOUR));
      const result = await before(provide(fake), HOURS);
      expect(result.readings).to.deep.equal(HOURS.map((t) => expected(COUNTER, t)));
    });

    it('looks further back, once, for a reading behind rows that are none', async () => {
      // Three bad rows right before the midnight, the reading two days older.
      const rows: Stored[] = [
        { ts: MIDNIGHTS[0]! - 2 * DAY, val: 7, q: 0 },
        ...series(MIDNIGHTS[0]! - 3 * MINUTE, MINUTE, 3, () => null).map((row) => ({ ...row, q: 0x42 })),
        ...COUNTER.filter((row) => row.ts >= MIDNIGHTS[0]!),
      ];
      for (const [name, make] of flavours.filter(([flavour]) => flavour !== 'influxdb')) {
        const fake = make(rows);
        const result = await before(provide(fake), [MIDNIGHTS[0]!]);
        expect(result.readings, name).to.deep.equal([7]);
        expect(fake.calls.map((call) => call.options.count), name).to.deep.equal([3, MAX_HISTORY_ROWS]);
      }
    });

    describe('the cache: a boundary a minute old never changes', () => {
      it('asks nothing again for the boundaries it read', async () => {
        const fake = sqlFake(COUNTER);
        const provider = provide(fake);
        const first = await before(provider, [TODAY, ...HOURS]);
        const calls = fake.calls.length;
        const again = await before(provider, [TODAY, ...HOURS]);
        expect(fake.calls).to.have.length(calls);
        expect(again).to.deep.equal(first);
      });

      it('asks only for a boundary it has not read, the next hour, with a window from it', async () => {
        const fake = sqlFake(COUNTER);
        const provider = provide(fake);
        await before(provider, [TODAY, ...HOURS.slice(0, 4)]);
        const calls = fake.calls.length;
        const result = await before(provider, [TODAY, ...HOURS]);
        // The window from 04:59:59.999, and the reading before it.
        expect(fake.calls.slice(calls).map((call) => call.options.start ?? call.options.end)).to.deep.equal([HOURS[4]! - 1, HOURS[4]! - 1]);
        expect(result.readings).to.deep.equal([TODAY, ...HOURS].map((t) => expected(COUNTER, t)));
      });

      it('asks again for a boundary less than a minute old: the history adapter may log a reading before it late', async () => {
        const fake = sqlFake(COUNTER);
        const provider = provide(fake);
        const fresh = NOW - 30_000;
        await before(provider, [fresh]);
        await before(provider, [fresh]);
        expect(fake.calls.filter((call) => call.options.start === fresh - 1)).to.have.length(2);
        clock.tick(MINUTE);
        await before(provider, [fresh]);
        const calls = fake.calls.length;
        await before(provider, [fresh]);
        expect(fake.calls).to.have.length(calls);
      });

      it('keeps nothing it could not read: an instance that is not logging, or a failed question', async () => {
        const fake = sqlFake(COUNTER);
        fake.unlogged.add(METER);
        const provider = provide(fake);
        expect(await before(provider, [TODAY, HOURS[0]!])).to.deep.equal({ readings: [null, null], available: false, reason: 'not_logged' });
        fake.unlogged.delete(METER);
        fake.rejectNext(new Error('database locked'));
        const asked = fake.calls.length;
        const failed = await before(provider, [TODAY, HOURS[0]!]);
        // A question that failed would fail again: nothing more is asked this time, and nothing kept.
        expect(failed).to.deep.equal({ readings: [null, null], available: false, reason: 'failed' });
        expect(fake.calls).to.have.length(asked + 1);
        const calls = fake.calls.length;
        expect((await before(provider, [TODAY, HOURS[0]!])).readings).to.deep.equal([expected(COUNTER, TODAY), expected(COUNTER, HOURS[0]!)]);
        // The midnight, the window from the hour and the reading before it; kept from now on.
        expect(fake.calls.slice(calls).map((call) => call.options.end ?? call.options.start)).to.deep.equal([TODAY - 1, HOURS[0]! - 1, HOURS[0]! - 1]);
        const kept = fake.calls.length;
        await before(provider, [TODAY, HOURS[0]!]);
        expect(fake.calls).to.have.length(kept);
      });

      it('keeps no hour whose reading the question before the window failed to bring', async () => {
        const fake = sqlFake(COUNTER);
        const provider = provide(fake);
        fake.replyNext(async () => ({ result: sqlAdapter(COUNTER, { ...fake.lastCall.options }) }));
        fake.rejectNext(new Error('timeout'));
        const first = await before(provider, HOURS);
        expect(first.readings).to.deep.equal([null, ...HOURS.slice(1).map((t) => expected(COUNTER, t))]);
        const second = await before(provider, HOURS);
        expect(second.readings).to.deep.equal(HOURS.map((t) => expected(COUNTER, t)));
      });

      it('keeps an hour before the newest MAX_HISTORY_ROWS rows as null: the window only grows', async () => {
        // A reading every second from 00:30: the window from 01:00 holds 6200 rows.
        const busy = series(TODAY + 30 * MINUTE, 1_000, MAX_HISTORY_ROWS + 3000, (i) => 5000 + i);
        const fake = sqlFake(busy);
        const provider = provide(fake);
        const oldest = busy.at(-MAX_HISTORY_ROWS)!.ts;
        expect(oldest).to.be.greaterThan(HOURS[0]!).and.lessThan(HOURS[1]!);
        const result = await before(provider, HOURS);
        expect(result.readings).to.deep.equal(HOURS.map((t) => (t - 1 >= oldest ? expected(busy, t) : null)));
        expect(result.readings[0]).to.equal(null);
        expect(result.readings.slice(1).every((reading) => reading !== null)).to.equal(true);
        const calls = fake.calls.length;
        await before(provider, HOURS);
        expect(fake.calls).to.have.length(calls);
      });

      it(`holds at most ${MAX_CACHED_READINGS} readings, the oldest read going first`, async () => {
        const fake = sqlFake([{ ts: 0, val: 1, q: 0 }]);
        const provider = provide(fake);
        const days = Array.from({ length: MAX_CACHED_READINGS + 1 }, (_, i) => new Date(2026, 8, 24 - i).getTime());
        await before(provider, days);
        const calls = fake.calls.length;
        expect(calls).to.equal(days.length);
        // The newest boundary was read first, so it went first.
        await before(provider, days.slice(1));
        expect(fake.calls).to.have.length(calls);
        await before(provider, [days[0]!]);
        expect(fake.calls).to.have.length(calls + 1);
      });
    });

    it("waits for one of the panel's query slots", async () => {
      const fake = sqlFake(COUNTER);
      const provider = provide(fake);
      const asked: string[] = [];
      const waiting: Array<() => void> = [];
      const answer = fake.getHistoryAsync.bind(fake);
      fake.getHistoryAsync = (id, options) => {
        asked.push(id);
        return new Promise((resolve) => waiting.push(() => resolve(answer(id, options))));
      };
      const held = [ask(provider, 'numeric', START, 'panel-a', `${ID}1`), ask(provider, 'numeric', START, 'panel-a', `${ID}2`)];
      const readings = before(provider, [TODAY]);
      await settle();
      expect(asked).to.deep.equal([`${ID}1`, `${ID}2`]);
      for (let i = 0; i < 20 && waiting.length > 0; i++) {
        waiting.shift()!();
        await settle();
      }
      await Promise.all(held);
      expect(asked.filter((id) => id === METER)).to.have.length(1);
      expect((await readings).readings).to.deep.equal([expected(COUNTER, TODAY)]);
    });
  });
});
