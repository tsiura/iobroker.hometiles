import { INSTANCE_ID_RE } from '../config/options';
import { usableNumber } from '../protocol/climate';
import type { SourceValue } from '../registry/types';
import type { Logger } from './mqtt-client';

/** The getHistory options the provider sends, a part of @iobroker/types' GetHistoryOptions (shared.d.ts:321). */
export interface HistoryOptions {
  instance: string;
  start?: number;
  end?: number;
  count: number;
  aggregate: 'none';
  returnNewestEntries: boolean;
  ignoreNull: boolean;
  ack: boolean;
  q: boolean;
}

/**
 * What the provider asks of the adapter: its own history API and two reads.
 * The adapter itself is one. getHistoryAsync goes to the instance named in the
 * options, so one call serves history, sql and influxdb alike (js-controller
 * adapter.js _getHistory).
 */
export interface HistorySource {
  getHistoryAsync(id: string, options: HistoryOptions): Promise<{ result?: unknown }>;
  getForeignObjectAsync(id: string): Promise<unknown>;
  getForeignStateAsync(id: string): Promise<unknown>;
}

/**
 * numeric: a graph's or a meter's readings. Only good numeric rows are kept:
 * a q other than 0 is no reading (Task 17). discrete: a binary, state or
 * editable timeline. Every row is kept, since through the entity's synth bad
 * quality reads as unavailable and null as unknown, as a live state would
 * (Task 18).
 */
export type HistoryKind = 'numeric' | 'discrete';

/** Why a query gave no history. `closed`: the provider was closed, on unload. */
export type HistoryFailure = 'no_instance' | 'not_running' | 'not_logged' | 'timeout' | 'failed' | 'malformed' | 'busy' | 'closed';

export interface HistoryResult {
  /**
   * Oldest first, ts in epoch ms, as the live state arrives. The reading in
   * effect at the window start comes first when one exists. Requests share a
   * result, so never mutate it.
   */
  rows: readonly SourceValue[];
  /** Epoch ms, taken once the history adapter answered: nothing it sent is later, clocks agreeing. */
  now: number;
  /** False when no history could be read: Ruling 126's historyAvailable. `reason` says why. */
  available: boolean;
  reason?: HistoryFailure;
}

/** Per time asked for, in order (readingsBefore). */
export interface Readings {
  /** The newest good numeric reading stamped before the time, or null when none is known. */
  readings: Array<number | null>;
  /** False when a question failed or none could be asked; `reason` says why. */
  available: boolean;
  reason?: HistoryFailure;
}

/** What readBefore's questions brought: each time's reading, null included, and why a time missing from it is. */
type Found = { found: Map<number, number | null>; reason?: HistoryFailure };

/** The most rows one query returns. A busier window keeps its newest (Ruling 123). */
export const MAX_HISTORY_ROWS = 5000;
/** The readings before boundaries the provider keeps (Task 20b); the one read first goes first. */
export const MAX_CACHED_READINGS = 4096;
/** A boundary younger than this may still get a reading before it: the history adapter logs a debounced one late. */
const SETTLE_MS = 60_000;
/** js-controller's getHistory waits for an answer without a timeout, and a stopped instance never sends one. */
export const QUERY_TIMEOUT_MS = 5000;
/**
 * The window and the reading in effect at its start, together (C3). The
 * window keeps QUERY_TIMEOUT_MS; the reading gets what is left, and is not
 * asked for with less than MIN_QUESTION_MS left. A discrete popup shows
 * "History unavailable" after 8 s (mqtt_handlers.cpp:66, :542-551).
 */
export const HISTORY_BUDGET_MS = 7000;
const MIN_QUESTION_MS = 500;
/**
 * A question that timed out keeps its panel slot until its call settles, at
 * most this long after (M-4): js-controller cannot take a sent message back,
 * so the instance may still be working on it.
 */
export const QUERY_HOLD_MS = 30_000;
/** The reading in effect is looked for this far back first (M-8): without a start InfluxDB 2.x reads its whole retention. */
export const PRIOR_LOOKBACK_MS = 7 * 24 * 3_600_000;
/** A panel runs this many queries at once. The rest wait in a queue of PANEL_QUEUE, and beyond that they are refused. */
export const PANEL_QUERIES = 2;
export const PANEL_QUEUE = 32;
const LOG_EVERY_MS = 3_600_000;
/** A row's q that is no number reads as this: 0x01, a general problem (I-1). */
const UNKNOWN_QUALITY = 0x01;

type Logged = { common?: { custom?: Record<string, { enabled?: unknown } | null> | null } };
/** A question's hold on its panel slot: the calls it left pending when it timed out (M-4). */
type Lease = { pending: Array<Promise<unknown>> };
/** A panel's slots: those taken, and the questions waiting, each woken holding one (true) or by close() (false). */
type Panel = { running: number; waiting: Array<(granted: boolean) => void> };

const failure = (reason: HistoryFailure): HistoryResult => ({ rows: [], now: Date.now(), available: false, reason });

/**
 * Whether `instance` logs the state `object`: its custom settings for it are
 * enabled, as truthy as history, sql and influxdb read `enabled` (history
 * main.js:73-75; sql :227-229; influxdb :159-161).
 */
export function isLogged(object: unknown, instance: string): boolean {
  return Boolean((object as Logged | null | undefined)?.common?.custom?.[instance]?.enabled);
}

/**
 * The first moment of a local day, where iobroker.history's day files begin
 * (getHistory.js ts2day): its file of the day before holds no later row.
 */
const isMidnight = (time: number): boolean => new Date(time - 1).getDate() !== new Date(time).getDate();

/** The newest reading among good numeric rows, oldest first, stamped before `time`. */
function readingBefore(rows: readonly SourceValue[], time: number): number | null {
  const row = rows.filter((candidate) => candidate.ts < time).at(-1);
  return row ? usableNumber(row.val)! : null;
}

/**
 * A row's q as a number (I-1): absent or null is good; a number in a string is
 * that number, as InfluxDB 2.x sends q stored as a tag (DatabaseInfluxDB2x.js
 * :158-165); anything else is bad quality.
 */
function quality(q: unknown): number {
  if (q === undefined || q === null) return 0;
  const value = typeof q === 'string' && q.trim() !== '' ? Number(q) : q;
  return typeof value === 'number' && Number.isFinite(value) ? value : UNKNOWN_QUALITY;
}

/**
 * The rows a history adapter sent, oldest first, each shaped as a live state:
 * a row that is no object or has no time is dropped, and so is one that
 * repeats the row before it, which sql sends at the boundary of a batch it is
 * writing (M-2). ack is true, or "true" as an InfluxDB 2.x tag.
 */
function usable(sent: unknown[], kind: HistoryKind): SourceValue[] {
  const rows: SourceValue[] = [];
  for (const entry of sent) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { ts, val, ack, q } = entry as Record<string, unknown>;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
    const bad = quality(q);
    if (kind === 'numeric' && (bad !== 0 || usableNumber(val) === undefined)) continue;
    rows.push({ ts, val, ack: ack === true || ack === 'true', q: bad });
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows.filter((row, i) => {
    const before = rows[i - 1];
    return !before || before.ts !== row.ts || before.val !== row.val || before.q !== row.q;
  });
}

/** The newest of the rows sent that suits `kind` and is stamped at or before `end`. */
const suited = (sent: unknown[], kind: HistoryKind, end: number): SourceValue | undefined =>
  usable(sent, kind)
    .filter((row) => row.ts <= end)
    .at(-1);

/**
 * Reads a state's history from the configured history, sql or influxdb
 * instance, as raw rows (Ruling 123). The builders average numeric buckets
 * themselves and carry the reading in effect into empty ones (Ruling 75), and
 * a timeline needs every change. An average would lose the last raw reading,
 * and each adapter stamps its aggregates differently.
 */
export class HistoryProvider {
  /** Queries that run, shared by identical requests: panels ask again as a popup opens. */
  private readonly inFlight = new Map<string, Promise<HistoryResult>>();
  private readonly panels = new Map<string, Panel>();
  /** When each log line last went out: panels ask every minute. */
  private readonly logged = new Map<string, number>();
  /** `${id} ${time}` -> the reading before that past boundary, or null for none: it never changes (Task 20b). */
  private readonly before = new Map<string, number | null>();
  /** Every timer that runs, with what ends its wait early: close() clears them all (I-2). */
  private readonly timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  private closed = false;

  constructor(
    private readonly source: HistorySource,
    private readonly log: Logger,
    /** options.historyInstance: '' is the system's default. */
    private readonly instance: string,
  ) {}

  /**
   * The history of state `id` from `start` (epoch ms) to now. It never throws:
   * a failure is an empty, unavailable result with its reason. Requests for the
   * same state, kind and minute share one query while it runs, so `rows` may
   * begin up to a minute before `start`. The builders read those rows as before
   * their window.
   */
  query(id: string, { start, kind, panel }: { start: number; kind: HistoryKind; panel: string }): Promise<HistoryResult> {
    if (this.closed) return Promise.resolve(failure('closed'));
    const from = Math.floor(start / 60_000) * 60_000;
    const key = `${kind} ${from} ${id}`;
    // Only a query that runs is joined: one still waiting in another panel's
    // queue would hold this panel behind that backlog (M-5). A twin that
    // started while this request waited is joined once it has a slot.
    const running = this.inFlight.get(key);
    if (running) return running;
    return this.slot(
      panel,
      (lease) => {
        const twin = this.inFlight.get(key);
        if (twin) return twin;
        const result = this.read(lease, id, from, kind).finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, result);
        return result;
      },
      failure,
    );
  }

  /**
   * The reading in effect just before each of `times`, epoch ms, none of
   * them ahead of now: the newest good numeric row stamped before it, however
   * old, or null when there is none or it cannot be known. For the
   * boundaries of energy buckets (Task 20b): one a minute old never changes,
   * so each is read once and kept. It never throws. The questions take one of
   * the panel's slots, as a query does.
   *
   * A local midnight -- each day's start, the period's -- is read as the
   * newest rows up to the millisecond before it: iobroker.history's day file
   * of the day before holds no later row to count against `count` (Task 19
   * report, row 6), and neither sql nor influxdb has one. Any other time, an
   * hour of today, has such rows in its own day file; those are read from
   * one window from the earliest, as query() reads one. A window keeps its
   * newest MAX_HISTORY_ROWS rows, and an hour before them reads null.
   *
   * `deadline`, epoch ms: no question runs past it, and none is asked with
   * less than half a second left (for the energy answer's budget, Ruling 133).
   */
  async readingsBefore(id: string, times: readonly number[], panel: string, deadline = Infinity): Promise<Readings> {
    const closed = (): Readings => ({ readings: times.map(() => null), available: false, reason: 'closed' });
    if (this.closed) return closed();
    const key = (time: number): string => `${id} ${time}`;
    const missing = times.filter((time) => !this.before.has(key(time)));
    const read: Found =
      missing.length > 0
        ? await this.slot(panel, (lease) => this.readBefore(lease, id, missing, deadline), (reason) => ({ found: new Map(), reason }))
        : { found: new Map() };
    if (this.closed) return closed();
    const readings = times.map((time) => (read.found.has(time) ? read.found.get(time)! : (this.before.get(key(time)) ?? null)));
    const settled = Date.now() - SETTLE_MS;
    for (const [time, reading] of read.found) {
      if (time > settled) continue;
      // ponytail: first in, first out; a boundary read long ago is the one least likely asked again.
      if (this.before.size >= MAX_CACHED_READINGS) this.before.delete(this.before.keys().next().value!);
      this.before.set(key(time), reading);
    }
    return read.reason ? { readings, available: false, reason: read.reason } : { readings, available: true };
  }

  /**
   * Stops the provider, called first on adapter unload (I-2): the adapter runs
   * in compact mode, so the process may go on. What runs and what waits
   * settles as `closed`, every timer is cleared, nothing is kept, and no call
   * is made after it. A message js-controller already sent cannot be taken
   * back; its callback goes with the instance.
   */
  close(): void {
    this.closed = true;
    for (const [timer, stop] of this.timers) {
      clearTimeout(timer);
      stop();
    }
    this.timers.clear();
    for (const state of this.panels.values()) for (const wake of state.waiting.splice(0)) wake(false);
    this.panels.clear();
    this.inFlight.clear();
    this.before.clear();
    this.logged.clear();
  }

  /** readingsBefore's questions: each reading known, null included, and why any other is not. */
  private async readBefore(lease: Lease, id: string, times: readonly number[], deadline: number): Promise<Found> {
    const found = new Map<number, number | null>();
    try {
      const checked = await this.logging(id);
      if ('reason' in checked) return { found, reason: checked.reason };
      const { instance } = checked;
      for (const time of times.filter(isMidnight)) {
        const prior = await this.prior(lease, instance, id, time - 1, 3, 'numeric', deadline);
        // A question that failed would fail again, each up to QUERY_TIMEOUT_MS:
        // what is left waits for the next request.
        if (typeof prior === 'string') return { found, reason: prior };
        found.set(time, prior ? usableNumber(prior.val)! : null);
      }
      const hours = times.filter((time) => !isMidnight(time));
      if (hours.length === 0) return { found };
      const window = await this.window(lease, instance, id, Math.min(...hours) - 1, 'numeric', Date.now() + HISTORY_BUDGET_MS, deadline);
      if (typeof window === 'string') return { found, reason: window };
      let reason: HistoryFailure | undefined;
      for (const time of hours) {
        const reading = readingBefore(window.rows, time);
        // Unknown only while the question before the window failed.
        if (reading !== null || !window.priorFailed) found.set(time, reading);
        else reason = 'failed';
      }
      return { found, reason };
    } catch (error) {
      this.note(`failed ${id}`, 'warn', `Reading the history of ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      return { found, reason: 'failed' };
    }
  }

  /**
   * Runs `run` in one of the panel's PANEL_QUERIES slots, waiting in its queue
   * for one: `busy` when the queue is full, `closed` when close() came first.
   */
  private async slot<T>(panel: string, run: (lease: Lease) => Promise<T>, refuse: (reason: 'busy' | 'closed') => T): Promise<T> {
    const state = this.panels.get(panel) ?? { running: 0, waiting: [] };
    this.panels.set(panel, state);
    if (state.running < PANEL_QUERIES) state.running += 1;
    else if (state.waiting.length < PANEL_QUEUE) {
      // Woken holding the slot of a question that ended, or by close() holding none.
      if (!(await new Promise<boolean>((resolve) => state.waiting.push(resolve)))) return refuse('closed');
    } else {
      this.note(`busy ${panel}`, 'warn', `Panel ${panel} asks for more than ${PANEL_QUERIES + PANEL_QUEUE} histories at once; the rest get none`);
      return refuse('busy');
    }
    const lease: Lease = { pending: [] };
    try {
      return await run(lease);
    } finally {
      void this.release(panel, state, lease);
    }
  }

  /**
   * Hands the slot to the next waiting question once the calls a timed-out
   * question left pending have settled (M-4): until then the instance gets
   * nothing more from this panel, for at most QUERY_HOLD_MS.
   */
  private async release(panel: string, state: Panel, lease: Lease): Promise<void> {
    if (lease.pending.length > 0) await this.within(Promise.allSettled(lease.pending), QUERY_HOLD_MS);
    const next = state.waiting.shift();
    if (next) next(true);
    else if (--state.running === 0 && this.panels.get(panel) === state) this.panels.delete(panel);
  }

  private async read(lease: Lease, id: string, start: number, kind: HistoryKind): Promise<HistoryResult> {
    const deadline = Date.now() + HISTORY_BUDGET_MS;
    try {
      const checked = await this.logging(id);
      if ('reason' in checked) return failure(checked.reason);
      const found = await this.window(lease, checked.instance, id, start, kind, deadline);
      if (typeof found === 'string') return failure(found);
      return { rows: found.rows, now: Date.now(), available: true };
    } catch (error) {
      this.note(`failed ${id}`, 'warn', `Reading the history of ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      return failure('failed');
    }
  }

  /** The instance to ask about `id`, or why none may be asked. Each check is one cheap read. */
  private async logging(id: string): Promise<{ instance: string } | { reason: HistoryFailure }> {
    const instance = await this.instanceName();
    if (!instance) {
      this.note('no_instance', 'info', "No history instance is set on the Advanced tab and the system has no default one; panels show no history");
      return { reason: 'no_instance' };
    }
    // A stopped instance never answers, and a message js-controller waits
    // on stays pending for up to an hour.
    const alive = (await this.source.getForeignStateAsync(`system.adapter.${instance}.alive`)) as { val?: unknown } | null | undefined;
    if (alive?.val !== true) {
      this.note(`not_running ${instance}`, 'warn', `${instance} is not running; panels show no history until it runs`);
      return { reason: 'not_running' };
    }
    // Every history adapter logs a state whose custom settings enable it.
    // Queried anyway, sql logs a warning each time, and the popup would
    // show the live state across the whole window.
    if (!isLogged(await this.source.getForeignObjectAsync(id), instance)) {
      this.note(`not_logged ${id}`, 'info', `${id} is not logged by ${instance}; panels show no history for it`);
      return { reason: 'not_logged' };
    }
    return { instance };
  }

  /**
   * The rows from `start` to now, the reading in effect at `start` first when
   * one exists; that one is asked for with what is left before `budget` (C3).
   * No question runs past `limit`, a caller's own deadline. `priorFailed`:
   * the question for it failed or was not asked, so what lies before the
   * window is unknown.
   */
  private async window(
    lease: Lease,
    instance: string,
    id: string,
    start: number,
    kind: HistoryKind,
    budget: number,
    limit = Infinity,
  ): Promise<{ rows: SourceValue[]; priorFailed: boolean } | HistoryFailure> {
    // One row over the bound: exactly MAX_HISTORY_ROWS is a whole window (M-1).
    const sent = await this.question(lease, instance, id, { start, count: MAX_HISTORY_ROWS + 1 }, limit);
    if (typeof sent === 'string') return sent;
    const truncated = sent.length > MAX_HISTORY_ROWS;
    // All three adapters send their rows oldest first (history main.js:1245,
    // :1269; sql :2723, :2776; influxdb :2560, :2915): the newest are last.
    const rows = usable(truncated ? sent.slice(-MAX_HISTORY_ROWS) : sent, kind);
    if (sent.length > 0 && rows.length === 0) this.unusable(instance, id, sent.length, kind);
    if (truncated) {
      // The rows between the window start and the oldest one kept are
      // unknown, so no reading is carried over them.
      this.note(
        `truncated ${id}`,
        'info',
        `${id} has more than ${MAX_HISTORY_ROWS} rows in ${instance} since ${new Date(start).toISOString()}; panels show the newest ${MAX_HISTORY_ROWS}`,
      );
      return { rows, priorFailed: false };
    }
    if (rows.some((row) => row.ts <= start)) return { rows, priorFailed: false };
    // The reading in effect at the window start is the newest row up to it,
    // however old. It is asked for on its own, because all three adapters
    // drop the row before `start` that they read for a raw query
    // (@iobroker/aggregate beautify). The history adapter reads a day file
    // newest first with no end check, so the window's own rows of that day
    // count against `count` first. There are at most as many of them as the
    // window returned. The +3 covers the row wanted and two rows written
    // between the two questions.
    const prior = await this.prior(lease, instance, id, start, sent.length + 3, kind, Math.min(budget, limit));
    if (typeof prior === 'string') return { rows, priorFailed: true };
    return { rows: prior ? [prior, ...rows] : rows, priorFailed: false };
  }

  /**
   * The newest row at or before `end` that suits `kind`, however old. First
   * from the newest `count` rows of the week up to `end` (M-8: without a start
   * InfluxDB 2.x reads its whole retention, main.js:2718-2723, :2776). Only
   * when those hold none is it asked for with no start: as far back as the
   * bound when rows came that do not suit, of bad quality or no number
   * (Task 20b), else the newest `count` however old. An empty answer then is
   * final: the rows a day file spills past `end` are dropped before it is
   * sent. Both questions share what is left before `deadline` (C3); with less
   * than MIN_QUESTION_MS left none is asked, as if it had timed out.
   */
  private async prior(
    lease: Lease,
    instance: string,
    id: string,
    end: number,
    count: number,
    kind: HistoryKind,
    deadline = Infinity,
  ): Promise<SourceValue | undefined | HistoryFailure> {
    const near = await this.question(lease, instance, id, { start: end - PRIOR_LOOKBACK_MS, end, count }, deadline);
    if (typeof near === 'string') return near;
    const found = suited(near, kind, end);
    if (found) return found;
    const far = await this.question(lease, instance, id, { end, count: near.length > 0 ? MAX_HISTORY_ROWS : count }, deadline);
    if (typeof far === 'string') return far;
    if (far.length > 0 && usable(far, kind).length === 0) this.unusable(instance, id, far.length, kind);
    return suited(far, kind, end);
  }

  /** ask() with what is left before `deadline`, at most QUERY_TIMEOUT_MS; `timeout` at once with less than MIN_QUESTION_MS. */
  private question(lease: Lease, instance: string, id: string, range: { start?: number; end?: number; count: number }, deadline: number): Promise<unknown[] | HistoryFailure> {
    const left = Math.min(QUERY_TIMEOUT_MS, deadline - Date.now());
    return left < MIN_QUESTION_MS ? Promise.resolve('timeout') : this.ask(lease, instance, id, range, left);
  }

  /**
   * One raw getHistory call, bounded in time: the rows as sent, or why there
   * are none. `returnNewestEntries` keeps the newest `count` rows. Without it
   * each adapter keeps the oldest. A call that times out stays in the lease
   * (M-4).
   */
  private async ask(
    lease: Lease,
    instance: string,
    id: string,
    range: { start?: number; end?: number; count: number },
    timeout: number,
  ): Promise<unknown[] | HistoryFailure> {
    if (this.closed) return 'closed';
    const options: HistoryOptions = {
      instance,
      ...range,
      aggregate: 'none',
      returnNewestEntries: true,
      ignoreNull: false,
      ack: true,
      q: true,
    };
    try {
      const call = this.source.getHistoryAsync(id, options);
      const answer = await this.within(call, timeout);
      if (answer === 'closed') return 'closed';
      if (answer === 'timeout') {
        lease.pending.push(call);
        this.note(`timeout ${instance}`, 'warn', `${instance} did not answer for ${id} within ${timeout / 1000} s`);
        return 'timeout';
      }
      // js-controller resolves with no result when the message could not be sent.
      if (!Array.isArray(answer?.result)) {
        this.note(`malformed ${id}`, 'warn', `${instance} answered for ${id} with no list of rows`);
        return 'malformed';
      }
      return answer.result;
    } catch (error) {
      this.note(`failed ${id}`, 'warn', `${instance} could not read the history of ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return 'failed';
    }
  }

  /** `promise`, or `timeout` after `ms`, or `closed` when close() comes first; the timer never stays behind. */
  private within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout' | 'closed'> {
    let stop!: (why: 'timeout' | 'closed') => void;
    const expiry = new Promise<'timeout' | 'closed'>((resolve) => (stop = resolve));
    const timer = setTimeout(() => stop('timeout'), ms);
    this.timers.set(timer, () => stop('closed'));
    return Promise.race([promise, expiry]).finally(() => {
      clearTimeout(timer);
      this.timers.delete(timer);
    });
  }

  /** One line when an answer's every row was dropped: history that would otherwise read as none, silently (I-1). */
  private unusable(instance: string, id: string, sent: number, kind: HistoryKind): void {
    const why = kind === 'numeric' ? 'a bad quality, no number or no time' : 'no time';
    this.note(`unusable ${id}`, 'warn', `${instance} sent ${sent} rows for ${id}, and each has ${why}: panels show none of them`);
  }

  /** The instance history is read from: the configured one, else the system's default, else '' (none). */
  async instanceName(): Promise<string> {
    return this.instance || (await this.systemDefault());
  }

  /** system.config's default history instance, or ''. No guess: js-controller's own fallback picks a storage adapter or history.0. */
  private async systemDefault(): Promise<string> {
    const config = (await this.source.getForeignObjectAsync('system.config')) as { common?: { defaultHistory?: unknown } } | null | undefined;
    const value = config?.common?.defaultHistory;
    return typeof value === 'string' && INSTANCE_ID_RE.test(value) ? value : '';
  }

  /** One English line per key and hour. */
  private note(key: string, level: 'info' | 'warn', text: string): void {
    const now = Date.now();
    if (now - (this.logged.get(key) ?? -Infinity) < LOG_EVERY_MS) return;
    // ponytail: cleared when full; keys are instances, panels and logged states, so 1000 is rarely reached.
    if (this.logged.size >= 1000) this.logged.clear();
    this.logged.set(key, now);
    this.log[level](`[History] ${text}`);
  }
}
