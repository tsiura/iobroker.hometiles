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

/** Why a query gave no history. */
export type HistoryFailure = 'no_instance' | 'not_running' | 'not_logged' | 'timeout' | 'failed' | 'malformed' | 'busy';

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
/** A panel runs this many queries at once. The rest wait in a queue of PANEL_QUEUE, and beyond that they are refused. */
export const PANEL_QUERIES = 2;
export const PANEL_QUEUE = 32;
const LOG_EVERY_MS = 3_600_000;

type Logged = { common?: { custom?: Record<string, { enabled?: unknown } | null> | null } };

const failure = (reason: HistoryFailure): HistoryResult => ({ rows: [], now: Date.now(), available: false, reason });

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
 * The rows a history adapter sent, oldest first, each shaped as a live state.
 * A row that is no object, or whose ts or q is not a number, is dropped. q
 * absent or null is good quality, as for a live state.
 */
function usable(sent: unknown[], kind: HistoryKind): SourceValue[] {
  const rows: SourceValue[] = [];
  for (const entry of sent) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { ts, val, ack, q } = entry as Record<string, unknown>;
    const quality = q ?? 0;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || typeof quality !== 'number') continue;
    if (kind === 'numeric' && (quality !== 0 || usableNumber(val) === undefined)) continue;
    rows.push({ ts, val, ack: ack === true, q: quality });
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

/**
 * Reads a state's history from the configured history, sql or influxdb
 * instance, as raw rows (Ruling 123). The builders average numeric buckets
 * themselves and carry the reading in effect into empty ones (Ruling 75), and
 * a timeline needs every change. An average would lose the last raw reading,
 * and each adapter stamps its aggregates differently.
 */
export class HistoryProvider {
  /** Queries in flight, shared by identical requests: panels ask again as a popup opens. */
  private readonly inFlight = new Map<string, Promise<HistoryResult>>();
  private readonly panels = new Map<string, { running: number; waiting: Array<() => void> }>();
  /** When each log line last went out: panels ask every minute. */
  private readonly logged = new Map<string, number>();
  /** `${id} ${time}` -> the reading before that past boundary, or null for none: it never changes (Task 20b). */
  private readonly before = new Map<string, number | null>();

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
    const from = Math.floor(start / 60_000) * 60_000;
    const key = `${kind} ${from} ${id}`;
    let result = this.inFlight.get(key);
    if (!result) {
      result = this.slot(panel, () => this.read(id, from, kind), failure('busy')).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, result);
    }
    return result;
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
   */
  async readingsBefore(id: string, times: readonly number[], panel: string): Promise<Readings> {
    const key = (time: number): string => `${id} ${time}`;
    const missing = times.filter((time) => !this.before.has(key(time)));
    const read: Found =
      missing.length > 0 ? await this.slot(panel, () => this.readBefore(id, missing), { found: new Map(), reason: 'busy' }) : { found: new Map() };
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

  /** readingsBefore's questions: each reading known, null included, and why any other is not. */
  private async readBefore(id: string, times: readonly number[]): Promise<Found> {
    const found = new Map<number, number | null>();
    try {
      const checked = await this.logging(id);
      if ('reason' in checked) return { found, reason: checked.reason };
      const { instance } = checked;
      for (const time of times.filter(isMidnight)) {
        const prior = await this.prior(instance, id, time - 1, 3, 'numeric');
        // A question that failed would fail again, each up to QUERY_TIMEOUT_MS:
        // what is left waits for the next request.
        if (typeof prior === 'string') return { found, reason: prior };
        found.set(time, prior ? usableNumber(prior.val)! : null);
      }
      const hours = times.filter((time) => !isMidnight(time));
      if (hours.length === 0) return { found };
      const window = await this.window(instance, id, Math.min(...hours) - 1, 'numeric');
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

  /** Runs `read` in one of the panel's PANEL_QUERIES slots, waiting in its queue for one; `busy` when the queue is full. */
  private async slot<T>(panel: string, read: () => Promise<T>, busy: T): Promise<T> {
    const state = this.panels.get(panel) ?? { running: 0, waiting: [] };
    this.panels.set(panel, state);
    if (state.running < PANEL_QUERIES) state.running += 1;
    // Woken by a query that finished and handed over its slot.
    else if (state.waiting.length < PANEL_QUEUE) await new Promise<void>((resolve) => state.waiting.push(resolve));
    else {
      this.note(`busy ${panel}`, 'warn', `Panel ${panel} asks for more than ${PANEL_QUERIES + PANEL_QUEUE} histories at once; the rest get none`);
      return busy;
    }
    try {
      return await read();
    } finally {
      const next = state.waiting.shift();
      if (next) next();
      else if (--state.running === 0) this.panels.delete(panel);
    }
  }

  private async read(id: string, start: number, kind: HistoryKind): Promise<HistoryResult> {
    try {
      const checked = await this.logging(id);
      if ('reason' in checked) return failure(checked.reason);
      const found = await this.window(checked.instance, id, start, kind);
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
    const object = (await this.source.getForeignObjectAsync(id)) as Logged | null | undefined;
    if (object?.common?.custom?.[instance]?.enabled !== true) {
      this.note(`not_logged ${id}`, 'info', `${id} is not logged by ${instance}; panels show no history for it`);
      return { reason: 'not_logged' };
    }
    return { instance };
  }

  /**
   * The rows from `start` to now, the reading in effect at `start` first when
   * one exists. `priorFailed`: the question for that reading failed, so what
   * lies before the window is unknown.
   */
  private async window(
    instance: string,
    id: string,
    start: number,
    kind: HistoryKind,
  ): Promise<{ rows: SourceValue[]; priorFailed: boolean } | HistoryFailure> {
    const window = await this.ask(instance, id, { start, count: MAX_HISTORY_ROWS });
    if (typeof window === 'string') return window;
    const rows = usable(window, kind);
    if (window.length >= MAX_HISTORY_ROWS) {
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
    const prior = await this.prior(instance, id, start, window.length + 3, kind);
    if (typeof prior === 'string') return { rows, priorFailed: true };
    return { rows: prior ? [prior, ...rows] : rows, priorFailed: false };
  }

  /**
   * The newest row at or before `end` that suits `kind`, however old, from
   * the newest `count` rows up to `end`. When rows come back and none suits
   * -- each of bad quality, or no number -- it looks back once more, as far
   * as the bound allows (Task 20b). An empty answer is final: the rows a day
   * file spills past `end` are dropped before it is sent.
   */
  private async prior(instance: string, id: string, end: number, count: number, kind: HistoryKind): Promise<SourceValue | undefined | HistoryFailure> {
    const rows = await this.ask(instance, id, { end, count });
    if (typeof rows === 'string') return rows;
    const found = usable(rows, kind).filter((row) => row.ts <= end).at(-1);
    if (found || rows.length === 0 || count >= MAX_HISTORY_ROWS) return found;
    return this.prior(instance, id, end, MAX_HISTORY_ROWS, kind);
  }

  /**
   * One raw getHistory call, bounded in time: the rows as sent, or why there
   * are none. `returnNewestEntries` keeps the newest `count` rows. Without it
   * each adapter keeps the oldest.
   */
  private async ask(instance: string, id: string, range: { start: number; count: number } | { end: number; count: number }): Promise<unknown[] | HistoryFailure> {
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), QUERY_TIMEOUT_MS);
    });
    try {
      const options: HistoryOptions = {
        instance,
        ...range,
        aggregate: 'none',
        returnNewestEntries: true,
        ignoreNull: false,
        ack: true,
        q: true,
      };
      const answer = await Promise.race([this.source.getHistoryAsync(id, options), expiry]);
      if (answer === 'timeout') {
        this.note(`timeout ${instance}`, 'warn', `${instance} did not answer for ${id} within ${QUERY_TIMEOUT_MS / 1000} s`);
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
    } finally {
      clearTimeout(timer);
    }
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
