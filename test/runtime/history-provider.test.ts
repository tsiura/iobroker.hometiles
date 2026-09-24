import type * as utils from '@iobroker/adapter-core';
import { expect } from 'chai';
import sinon from 'sinon';
import {
  HISTORY_BUDGET_MS,
  HistoryProvider,
  MAX_CACHED_READINGS,
  MAX_HISTORY_ROWS,
  PANEL_QUERIES,
  PANEL_QUEUE,
  PRIOR_LOOKBACK_MS,
  QUERY_HOLD_MS,
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
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

/**
 * An adapter whose every answer waits for release(): the first call waiting,
 * or the first for `id`. Each answer is a row at the window start, so no
 * reading before it is asked for.
 */
function gated(): FakeAdapter & { release: (id?: string) => void } {
  const fake = sqlFake([]) as FakeAdapter & { release: (id?: string) => void };
  const waiting: Array<{ id: string; answer: () => void }> = [];
  fake.getHistoryAsync = (id, options) => {
    fake.calls.push({ id, options: { ...options } });
    return new Promise((resolve) => waiting.push({ id, answer: () => resolve({ result: [{ ts: options.start ?? 0, val: 1 }] }) }));
  };
  fake.release = (id) => {
    const at = waiting.findIndex((call) => id === undefined || call.id === id);
    if (at >= 0) waiting.splice(at, 1)[0]!.answer();
  };
  return fake;
}

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

    it('reads `enabled` as truthy, as history, sql and influxdb do (M-3)', async () => {
      // history main.js:73-75, :550; sql :227-229; influxdb :159-161, :968.
      for (const [enabled, logged] of [
        [true, true],
        ['true', true],
        [1, true],
        [{}, true],
        [false, false],
        [0, false],
        ['', false],
        [null, false],
        [undefined, false],
      ] as const) {
        const fake = sqlFake(STORED);
        fake.enabled = enabled;
        const result = await ask(provide(fake));
        expect(result.reason === 'not_logged', String(enabled)).to.equal(!logged);
        expect(fake.calls.length > 0, String(enabled)).to.equal(logged);
      }
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
          // One more than the bound: exactly MAX_HISTORY_ROWS rows is a whole window (M-1).
          count: MAX_HISTORY_ROWS + 1,
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

    it('asks for the reading in effect at the window start as the newest rows of the week up to it (M-8)', async () => {
      const fake = sqlFake(STORED);
      await ask(provide(fake));
      expect(fake.calls).to.have.length(2);
      const prior = fake.calls[1]!.options;
      expect(prior).to.deep.include({ instance: 'sql.0', end: START, aggregate: 'none', returnNewestEntries: true, ignoreNull: false });
      // Without a start InfluxDB 2.x reads its whole retention (main.js:2718-2723, :2776).
      expect(prior.start).to.equal(START - PRIOR_LOOKBACK_MS);
      // One more than the window's rows and then two: the history adapter's
      // day file counts the rows after `end` in that day against it.
      expect(prior.count).to.equal(WINDOW.length + 3);
    });

    it('asks again with no start only when the week before the window holds no reading, however old it is (M-8)', async () => {
      const old: Stored = { ts: START - 30 * DAY, val: 17, ack: true, q: 0 };
      for (const [name, make] of flavours) {
        const fake = make([old, ...WINDOW]);
        const result = await ask(provide(fake));
        expect(result.rows[0], name).to.include({ ts: old.ts, val: 17 });
        expect(
          fake.calls.map(({ options }) => [options.start, options.end, options.count]),
          name,
        ).to.deep.equal([
          [START, undefined, MAX_HISTORY_ROWS + 1],
          [START - PRIOR_LOOKBACK_MS, START, WINDOW.length + 3],
          [undefined, START, WINDOW.length + 3],
        ]);
      }
    });

    for (const [name, make] of flavours) {
      it(`${name}: returns every row of the window after the reading in effect at its start, oldest first, in ms`, async () => {
        const fake = make(STORED);
        const result = await ask(provide(fake));
        expect(result.available).to.equal(true);
        expect(stamps(result)).to.deep.equal(STORED.map((row) => row.ts));
        expect(values(result)).to.deep.equal(STORED.map((row) => row.val));
        // Both questions ask for this state, never another (M-6 a).
        expect(fake.calls.map((call) => call.id)).to.deep.equal([ID, ID]);
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

    it('reads exactly MAX_HISTORY_ROWS rows as a whole window, with the reading in effect before it (M-1)', async () => {
      const log = logger();
      const fake = sqlFake([{ ts: START - MINUTE, val: 7, ack: true, q: 0 }, ...series(START + MINUTE, 10_000, MAX_HISTORY_ROWS)]);
      const result = await ask(provide(fake, log));
      expect(result.rows).to.have.length(MAX_HISTORY_ROWS + 1);
      expect(result.rows[0]).to.include({ ts: START - MINUTE, val: 7 });
      expect(fake.calls).to.have.length(2);
      expect(log.lines).to.deep.equal([]);
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
      // A q that is no number is bad quality, 0x01 (I-1): kept for a timeline, as unavailable.
      expect(result.rows).to.deep.equal([
        { ts: START, val: 4, ack: false, q: 0 },
        { ts: START + 1, val: 3, ack: false, q: 0x01 },
      ]);
    });

    it("reads InfluxDB 2.x's tag strings, q '0' and ack 'true', as good quality and true (I-1)", async () => {
      // With "Use tags to store metadata" influxdb stores q and ack as tags
      // (DatabaseInfluxDB2x.js:158-165), which come back as strings (main.js:2903-2908).
      for (const kind of ['numeric', 'discrete'] as const) {
        const fake = influxFake([]);
        fake.replyNext(async () => ({
          result: [
            { ts: START + 5 * MINUTE, val: 21.5, ack: 'true', q: '0' },
            { ts: START + 65 * MINUTE, val: 22, ack: 'true', q: '0' },
          ],
        }));
        fake.replyNext(async () => ({ result: [{ ts: START - 5 * MINUTE, val: 20, ack: 'true', q: '0' }] }));
        const result = await ask(provide(fake), kind);
        expect(result, kind).to.deep.equal({
          rows: [
            { ts: START - 5 * MINUTE, val: 20, ack: true, q: 0 },
            { ts: START + 5 * MINUTE, val: 21.5, ack: true, q: 0 },
            { ts: START + 65 * MINUTE, val: 22, ack: true, q: 0 },
          ],
          now: NOW,
          available: true,
        });
      }
    });

    it('reads a q that is a number in a string as that number, and any other as bad quality (I-1)', async () => {
      const rows = [
        { ts: START, val: 1, q: ' 64 ' },
        { ts: START + 1_000, val: 2, q: '0x40' },
        { ts: START + 2_000, val: 3, q: '' },
        { ts: START + 3_000, val: 4, q: true },
        { ts: START + 4_000, val: 5, q: {} },
        { ts: START + 5_000, val: 6, q: null },
        { ts: START + 6_000, val: 7, q: '0' },
      ];
      const read = async (kind: HistoryKind): Promise<HistoryResult> => {
        const fake = sqlFake([]);
        fake.replyNext(async () => ({ result: rows }));
        return ask(provide(fake), kind);
      };
      expect((await read('discrete')).rows.map((row) => row.q)).to.deep.equal([64, 0x40, 0x01, 0x01, 0x01, 0, 0]);
      expect(values(await read('numeric'))).to.deep.equal([6, 7]);
    });

    it('logs one line when every row an answer holds is dropped (I-1)', async () => {
      const log = logger();
      const fake = sqlFake([PRIOR, ...WINDOW.map((row) => ({ ...row, q: 0x42 }))]);
      const provider = provide(fake, log);
      const result = await ask(provider, 'numeric');
      // The reading in effect before the window is good; the window's rows are not.
      expect(values(result)).to.deep.equal([18.5]);
      expect(log.lines).to.have.length(1);
      expect(log.lines[0]).to.include(ID).and.include(`${WINDOW.length} rows`);
      await ask(provider, 'numeric');
      expect(log.lines).to.have.length(1);
      // Some good: no line.
      const quiet = logger();
      await ask(provide(sqlFake(STORED), quiet), 'numeric');
      expect(quiet.lines).to.deep.equal([]);
    });

    it('sends a row sql repeats at its batch boundary once (M-2)', async () => {
      // A row sql is writing is read from its cache and, once committed, again
      // as the first row at or after `end` (main.js:2738-2741, sqlite.js:170-187).
      for (const kind of ['numeric', 'discrete'] as const) {
        const fake = sqlFake([]);
        fake.replyNext(async () => ({
          result: [
            { ts: START, val: 10, q: 0 },
            { ts: START + MINUTE, val: 30, q: 0 },
            { ts: START + MINUTE, val: 30, q: 0 },
          ],
        }));
        expect(values(await ask(provide(fake), kind)), kind).to.deep.equal([10, 30]);
      }
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

    it('reads a shared query from the start of its minute: the changes of a later request with an earlier start (M-6 c)', async () => {
      const changes: Stored[] = [
        { ts: START + 15_000, val: 1, ack: true, q: 0 },
        { ts: START + 20_000, val: 2, ack: true, q: 0 },
      ];
      const provider = provide(sqlFake([PRIOR, ...changes, ...WINDOW]));
      const [late, early] = await Promise.all([ask(provider, 'numeric', START + 30_000), ask(provider, 'numeric', START + 10_000, 'panel-b')]);
      expect(early).to.equal(late);
      expect(values(early)).to.include.members([1, 2]);
    });

    it('joins only a query that runs: a twin still queued behind another panel does not hold this one up (M-5)', async () => {
      const fake = gated();
      const provider = provide(fake);
      const held = [1, 2].map((n) => ask(provider, 'numeric', START, 'panel-a', `${ID}${n}`));
      const queued = ask(provider, 'numeric', START, 'panel-a');
      let answered = false;
      const other = ask(provider, 'numeric', START + 30_000, 'panel-b').then((result) => {
        answered = true;
        return result;
      });
      await settle();
      // panel-b asked at once, in its own slot.
      expect(fake.calls.map((call) => call.id)).to.deep.equal([`${ID}1`, `${ID}2`, ID]);
      fake.release(ID);
      await settle();
      expect(answered).to.equal(true);
      // panel-a's twin gets its slot later and asks for itself: panel-b's query has ended.
      fake.release(`${ID}1`);
      await settle();
      expect(fake.calls.map((call) => call.id)).to.deep.equal([`${ID}1`, `${ID}2`, ID, ID]);
      fake.release(ID);
      fake.release(`${ID}2`);
      for (const result of [...held, queued, other]) expect((await result).available).to.equal(true);
    });

    it('joins a twin that started while this request waited for its slot (M-5)', async () => {
      const fake = gated();
      const provider = provide(fake);
      const held = [1, 2].map((n) => ask(provider, 'numeric', START, 'panel-a', `${ID}${n}`));
      const queued = ask(provider, 'numeric', START, 'panel-a');
      const other = ask(provider, 'numeric', START, 'panel-b');
      await settle();
      expect(fake.calls.map((call) => call.id)).to.deep.equal([`${ID}1`, `${ID}2`, ID]);
      // panel-a's queued request gets a slot while panel-b's query still runs: it asks nothing.
      fake.release(`${ID}1`);
      await settle();
      expect(fake.calls.map((call) => call.id)).to.deep.equal([`${ID}1`, `${ID}2`, ID]);
      fake.release(ID);
      expect(await queued).to.equal(await other);
      fake.release(`${ID}2`);
      await Promise.all(held);
    });

    it('keeps the slot of a question that timed out until its call settles: the instance gets no more from the panel meanwhile (M-4)', async () => {
      const fake = gated();
      const provider = provide(fake);
      const timedOut = [1, 2].map((n) => ask(provider, 'numeric', START, 'panel-a', `${ID}${n}`));
      const third = ask(provider, 'numeric', START, 'panel-a', `${ID}3`);
      await clock.tickAsync(QUERY_TIMEOUT_MS);
      for (const result of timedOut) expect(await result).to.deep.include({ available: false, reason: 'timeout' });
      await settle();
      expect(fake.calls).to.have.length(2);
      fake.release(`${ID}1`);
      await settle();
      expect(fake.calls.map((call) => call.id)).to.deep.equal([`${ID}1`, `${ID}2`, `${ID}3`]);
      fake.release(`${ID}3`);
      expect((await third).available).to.equal(true);
      fake.release(`${ID}2`);
      await settle();
      // No timer stays behind (M-6 b).
      expect(clock.countTimers()).to.equal(0);
    });

    it(`hands the slot on ${QUERY_HOLD_MS / 1000} s after a timeout when the call never settles (M-4)`, async () => {
      const fake = gated();
      const provider = provide(fake);
      const timedOut = [1, 2].map((n) => ask(provider, 'numeric', START, 'panel-a', `${ID}${n}`));
      const third = ask(provider, 'numeric', START, 'panel-a', `${ID}3`);
      await clock.tickAsync(QUERY_TIMEOUT_MS);
      await Promise.all(timedOut);
      await clock.tickAsync(QUERY_HOLD_MS - 1);
      expect(fake.calls).to.have.length(2);
      await clock.tickAsync(1);
      await settle();
      expect(fake.calls).to.have.length(3);
      fake.release(`${ID}3`);
      expect((await third).available).to.equal(true);
      expect(clock.countTimers()).to.equal(0);
    });

    it('leaves no timer behind once a query is answered (M-6 b)', async () => {
      await ask(provide(sqlFake(STORED)));
      expect(clock.countTimers()).to.equal(0);
      const fake = sqlFake(STORED);
      fake.rejectNext(new Error('database locked'));
      await ask(provide(fake));
      expect(clock.countTimers()).to.equal(0);
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
      // The two that run have asked (each reads its checks first), so no release goes to nothing.
      await settle();
      expect(fake.calls).to.have.length(PANEL_QUERIES);
      for (let n = 0; n < queued.length; n++) {
        fake.release();
        await settle();
      }
      for (const result of queued) expect((await result).available).to.equal(true);
    });
  });

  describe('close(), on adapter unload (I-2)', () => {
    it('settles what runs and what waits as closed, clears every timer, and asks nothing more', async () => {
      // The review's probe P3: a hung instance, three requests on one panel.
      const fake = gated();
      const provider = provide(fake);
      const results = [1, 2, 3].map((n) => ask(provider, 'numeric', START, 'panel-a', `${ID}${n}`));
      await settle();
      expect(fake.calls).to.have.length(2);
      expect(clock.countTimers()).to.equal(2);
      provider.close();
      expect(clock.countTimers()).to.equal(0);
      for (const result of results) expect(await result).to.deep.include({ rows: [], available: false, reason: 'closed' });
      await clock.tickAsync(10 * QUERY_TIMEOUT_MS);
      expect(fake.calls).to.have.length(2);
      // Refused at once: not even the adapter's own reads.
      let reads = 0;
      const state = fake.getForeignStateAsync.bind(fake);
      const object = fake.getForeignObjectAsync.bind(fake);
      fake.getForeignStateAsync = (id) => (reads++, state(id));
      fake.getForeignObjectAsync = (id) => (reads++, object(id));
      expect(await ask(provider)).to.deep.include({ rows: [], available: false, reason: 'closed' });
      expect(await provider.readingsBefore(ID, [START], 'panel-a')).to.deep.equal({ readings: [null], available: false, reason: 'closed' });
      expect(fake.calls).to.have.length(2);
      expect(reads).to.equal(0);
      expect(clock.countTimers()).to.equal(0);
    });

    it('settles a waiting question at once, even behind questions that hang before they ask', async () => {
      const fake = sqlFake(STORED);
      // The objects database stops answering: the two that run never reach a question.
      fake.getForeignObjectAsync = () => new Promise(() => undefined);
      const provider = provide(fake);
      const [, , waiting] = [1, 2, 3].map((n) => ask(provider, 'numeric', START, 'panel-a', `${ID}${n}`));
      await settle();
      provider.close();
      expect(await waiting).to.deep.include({ rows: [], available: false, reason: 'closed' });
      expect(fake.calls).to.deep.equal([]);
    });

    it('asks nothing for a query that was still reading its checks', async () => {
      const fake = sqlFake(STORED);
      const object = fake.getForeignObjectAsync.bind(fake);
      fake.getForeignObjectAsync = (id) => new Promise((resolve) => setTimeout(() => resolve(object(id)), 1_000));
      const provider = provide(fake);
      const pending = ask(provider);
      await settle();
      provider.close();
      await clock.tickAsync(1_000);
      expect(await pending).to.deep.include({ rows: [], available: false, reason: 'closed' });
      expect(fake.calls).to.deep.equal([]);
    });

    it('ends the hold of a question that timed out, and forgets the readings it kept', async () => {
      const fake = sqlFake(STORED);
      const provider = provide(fake);
      const reading = await provider.readingsBefore(ID, [START], 'panel-a');
      expect(reading.readings).to.deep.equal([18.5]);
      fake.hangNext();
      const timedOut = ask(provider, 'discrete');
      await clock.tickAsync(QUERY_TIMEOUT_MS);
      expect(await timedOut).to.deep.include({ reason: 'timeout' });
      // The slot waits for the hung call: one timer, its hold.
      expect(clock.countTimers()).to.equal(1);
      const calls = fake.calls.length;
      provider.close();
      expect(clock.countTimers()).to.equal(0);
      expect(await provider.readingsBefore(ID, [START], 'panel-a')).to.deep.equal({ readings: [null], available: false, reason: 'closed' });
      expect(fake.calls).to.have.length(calls);
    });
  });

  describe('one budget for the window and the reading in effect (C3)', () => {
    it(`gives the question for the reading in effect only what is left of ${HISTORY_BUDGET_MS / 1000} s`, async () => {
      const fake = sqlFake(STORED);
      const log = logger();
      // The window answers after 4 s, the question before it never.
      fake.replyNext(() => new Promise((resolve) => setTimeout(() => resolve({ result: sqlAdapter(STORED, fake.calls[0]!.options) }), 4_000)));
      fake.hangNext();
      const pending = ask(provide(fake, log));
      await clock.tickAsync(HISTORY_BUDGET_MS);
      const result = await pending;
      expect(result).to.deep.include({ now: NOW + HISTORY_BUDGET_MS, available: true });
      expect(stamps(result)).to.deep.equal(WINDOW.map((row) => row.ts));
      expect(log.lines).to.have.length(1);
      expect(log.lines[0]).to.include(`within ${(HISTORY_BUDGET_MS - 4_000) / 1000} s`);
    });

    it('does not ask for the reading in effect when less than half a second is left', async () => {
      const fake = sqlFake(STORED);
      // Its own object read takes 2.2 s, the window 4.5 s more.
      const object = fake.getForeignObjectAsync.bind(fake);
      fake.getForeignObjectAsync = (id) => new Promise((resolve) => setTimeout(() => resolve(object(id)), 2_200));
      fake.replyNext(() => new Promise((resolve) => setTimeout(() => resolve({ result: sqlAdapter(STORED, fake.calls[0]!.options) }), 4_500)));
      const pending = ask(provide(fake));
      await clock.tickAsync(HISTORY_BUDGET_MS);
      const result = await pending;
      expect(result.available).to.equal(true);
      expect(stamps(result)).to.deep.equal(WINDOW.map((row) => row.ts));
      expect(fake.calls).to.have.length(1);
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

    it('asks for a midnight as the newest rows of the week up to the millisecond before it, and for the hours as one window from the first', async () => {
      const fake = sqlFake(COUNTER);
      await before(provide(fake), [MIDNIGHTS[0]!, ...HOURS]);
      const common = { instance: 'sql.0', aggregate: 'none', returnNewestEntries: true, ignoreNull: false, ack: true, q: true };
      const [midnight, window, prior] = fake.calls.map((call) => call.options);
      // iobroker.history's day file of the day before holds no later row to count against `count`.
      expect(midnight).to.deep.include({ ...common, start: MIDNIGHTS[0]! - 1 - PRIOR_LOOKBACK_MS, end: MIDNIGHTS[0]! - 1, count: 3 });
      // The query's own window and the reading before it: its count covers the rows after it in its day file.
      expect(window).to.deep.include({ ...common, start: HOURS[0]! - 1, count: MAX_HISTORY_ROWS + 1 });
      expect(window).to.not.have.property('end');
      const windowRows = COUNTER.filter((row) => row.ts >= HOURS[0]! - 1).length;
      expect(prior).to.deep.include({ ...common, start: HOURS[0]! - 1 - PRIOR_LOOKBACK_MS, end: HOURS[0]! - 1, count: windowRows + 3 });
      expect(fake.calls).to.have.length(3);
      // Every question asks for the meter (M-6 a).
      expect(fake.calls.every((call) => call.id === METER)).to.equal(true);
    });

    it('history: reads the hours from a window, since a day file counts its rows after an hour against `count`', async () => {
      // Written to file up to 04:00, in memory since: an hour's question as a
      // midnight's (newest 3 up to it) would get 01:05 onwards and drop them.
      const fake = historyFake(inMemory(COUNTER, NOW - 2 * HOUR), inFiles(COUNTER, NOW - 2 * HOUR));
      const result = await before(provide(fake), HOURS);
      expect(result.readings).to.deep.equal(HOURS.map((t) => expected(COUNTER, t)));
    });

    it('looks further back, once, behind rows that are none, also when the week before holds no row', async () => {
      // A meter quiet for two weeks: its newest rows before that are three
      // null markers (writeNulls with changesOnly off), its reading a day older.
      const quiet = MIDNIGHTS[0]! - 14 * DAY;
      const rows: Stored[] = [
        { ts: quiet - DAY, val: 7, q: 0 },
        ...series(quiet - 3 * MINUTE, MINUTE, 3, () => null).map((row) => ({ ...row, q: 0x40 })),
      ];
      for (const [name, make] of flavours.filter(([flavour]) => flavour !== 'influxdb')) {
        const fake = make(rows);
        const result = await before(provide(fake), [MIDNIGHTS[0]!]);
        expect(result.readings, name).to.deep.equal([7]);
        expect(
          fake.calls.map(({ options }) => [options.start === undefined, options.count]),
          name,
        ).to.deep.equal([
          [false, 3],
          [true, 3],
          [true, MAX_HISTORY_ROWS],
        ]);
      }
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

    it('logs one line when every row before a midnight is dropped, however far back it looks (I-1)', async () => {
      for (const [name, make] of flavours.slice(0, 2)) {
        const log = logger();
        const bad = COUNTER.filter((row) => row.ts < TODAY).map((row) => ({ ...row, q: 0x42 }));
        const result = await before(provide(make(bad), log), [TODAY]);
        expect(result.readings, name).to.deep.equal([null]);
        expect(log.lines, name).to.have.length(1);
        expect(log.lines[0], name).to.include(METER);
      }
    });

    it('ends its questions at the first after close(), keeping nothing (I-2)', async () => {
      const fake = sqlFake(COUNTER);
      fake.hangNext();
      const provider = provide(fake);
      const pending = before(provider, MIDNIGHTS);
      await settle();
      expect(fake.calls).to.have.length(1);
      provider.close();
      expect(await pending).to.deep.equal({ readings: MIDNIGHTS.map(() => null), available: false, reason: 'closed' });
      expect(fake.calls).to.have.length(1);
      expect(clock.countTimers()).to.equal(0);
    });

    it('asks nothing once the deadline it is given has passed, and keeps nothing (Ruling 133)', async () => {
      const fake = sqlFake(COUNTER);
      const provider = provide(fake);
      expect(await provider.readingsBefore(METER, [TODAY, HOURS[0]!], 'panel-a', NOW - 1)).to.deep.equal({
        readings: [null, null],
        available: false,
        reason: 'timeout',
      });
      // The hours alone: their window is not asked either.
      expect((await provider.readingsBefore(METER, HOURS, 'panel-a', NOW + 100)).reason).to.equal('timeout');
      expect(fake.calls).to.deep.equal([]);
      expect((await before(provider, [TODAY])).readings).to.deep.equal([expected(COUNTER, TODAY)]);
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
        expect(fake.calls.slice(calls).map((call) => call.options.end ?? call.options.start)).to.deep.equal([HOURS[4]! - 1, HOURS[4]! - 1]);
        expect(result.readings).to.deep.equal([TODAY, ...HOURS].map((t) => expected(COUNTER, t)));
      });

      it('keeps the readings of each state apart, and serves a second round of both from the cache (review I2)', async () => {
        const A = COUNTER;
        const B = COUNTER.map((row) => ({ ...row, val: 5000 + (row.val as number) * 2 }));
        const fake = new FakeAdapter('sql.0', (options, id) => sqlAdapter(id === 'a.0.m1' ? A : B, options));
        const provider = provide(fake);
        const times = [MIDNIGHTS[0]!, TODAY, ...HOURS];
        const round = async (): Promise<Readings[]> => [await before(provider, times, 'panel-a', 'a.0.m1'), await before(provider, times, 'panel-a', 'a.0.m2')];
        const first = await round();
        expect(first.map((result) => result.readings)).to.deep.equal([times.map((t) => expected(A, t)), times.map((t) => expected(B, t))]);
        expect(new Set(fake.calls.map((call) => call.id))).to.deep.equal(new Set(['a.0.m1', 'a.0.m2']));
        const calls = fake.calls.length;
        expect(await round()).to.deep.equal(first);
        expect(fake.calls).to.have.length(calls);
      });

      it('asks again for a midnight less than a minute old, however exact a midnight question is (review m2)', async () => {
        clock.setSystemTime(TODAY + 45_000);
        const fake = sqlFake(COUNTER);
        const provider = provide(fake);
        await before(provider, [TODAY]);
        await before(provider, [TODAY]);
        // A reading stamped 23:59:59.9 that the history adapter logs late would otherwise be lost.
        expect(fake.calls.filter((call) => call.options.end === TODAY - 1)).to.have.length(2);
        clock.tick(MINUTE);
        await before(provider, [TODAY]);
        const calls = fake.calls.length;
        await before(provider, [TODAY]);
        expect(fake.calls).to.have.length(calls);
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
        // Two questions a midnight: the week before it holds no reading, so however old (M-8).
        expect(calls).to.equal(2 * days.length);
        // The newest boundary was read first, so it went first.
        await before(provider, days.slice(1));
        expect(fake.calls).to.have.length(calls);
        await before(provider, [days[0]!]);
        expect(fake.calls).to.have.length(calls + 2);
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
