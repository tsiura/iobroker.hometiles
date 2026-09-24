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

/** The most rows one query returns. A busier window keeps its newest (Ruling 123). */
export const MAX_HISTORY_ROWS = 5000;
/** js-controller's getHistory waits for an answer without a timeout, and a stopped instance never sends one. */
export const QUERY_TIMEOUT_MS = 5000;
/** A panel runs this many queries at once. The rest wait in a queue of PANEL_QUEUE, and beyond that they are refused. */
export const PANEL_QUERIES = 2;
export const PANEL_QUEUE = 32;
const LOG_EVERY_MS = 3_600_000;

type Logged = { common?: { custom?: Record<string, { enabled?: unknown } | null> | null } };

const failure = (reason: HistoryFailure): HistoryResult => ({ rows: [], now: Date.now(), available: false, reason });

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
      result = this.slot(panel, () => this.read(id, from, kind)).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, result);
    }
    return result;
  }

  /** Runs `read` in one of the panel's PANEL_QUERIES slots, waiting in its queue for one. */
  private async slot(panel: string, read: () => Promise<HistoryResult>): Promise<HistoryResult> {
    const state = this.panels.get(panel) ?? { running: 0, waiting: [] };
    this.panels.set(panel, state);
    if (state.running < PANEL_QUERIES) state.running += 1;
    // Woken by a query that finished and handed over its slot.
    else if (state.waiting.length < PANEL_QUEUE) await new Promise<void>((resolve) => state.waiting.push(resolve));
    else {
      this.note(`busy ${panel}`, 'warn', `Panel ${panel} asks for more than ${PANEL_QUERIES + PANEL_QUEUE} histories at once; the rest get none`);
      return failure('busy');
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
      const instance = this.instance || (await this.systemDefault());
      if (!instance) {
        this.note('no_instance', 'info', "No history instance is set on the Advanced tab and the system has no default one; panels show no history");
        return failure('no_instance');
      }
      // A stopped instance never answers, and a message js-controller waits
      // on stays pending for up to an hour.
      const alive = (await this.source.getForeignStateAsync(`system.adapter.${instance}.alive`)) as { val?: unknown } | null | undefined;
      if (alive?.val !== true) {
        this.note(`not_running ${instance}`, 'warn', `${instance} is not running; panels show no history until it runs`);
        return failure('not_running');
      }
      // Every history adapter logs a state whose custom settings enable it.
      // Queried anyway, sql logs a warning each time, and the popup would
      // show the live state across the whole window.
      const object = (await this.source.getForeignObjectAsync(id)) as Logged | null | undefined;
      if (object?.common?.custom?.[instance]?.enabled !== true) {
        this.note(`not_logged ${id}`, 'info', `${id} is not logged by ${instance}; panels show no history for it`);
        return failure('not_logged');
      }

      const window = await this.ask(instance, id, { start, count: MAX_HISTORY_ROWS });
      if (typeof window === 'string') return failure(window);
      let rows = usable(window, kind);
      if (window.length >= MAX_HISTORY_ROWS) {
        // The rows between the window start and the oldest one kept are
        // unknown, so no reading is carried over them.
        this.note(
          `truncated ${id}`,
          'info',
          `${id} has more than ${MAX_HISTORY_ROWS} rows in ${instance} since ${new Date(start).toISOString()}; panels show the newest ${MAX_HISTORY_ROWS}`,
        );
      } else if (!rows.some((row) => row.ts <= start)) {
        // The reading in effect at the window start is the newest row up to
        // it, however old. It is asked for on its own, because all three
        // adapters drop the row before `start` that they read for a raw query
        // (@iobroker/aggregate beautify). The history adapter reads a day
        // file newest first with no end check, so the window's own rows of
        // that day count against `count` first. There are at most as many of
        // them as the window returned. The +3 covers the row wanted and two
        // rows written between the two questions.
        const before = await this.ask(instance, id, { end: start, count: window.length + 3 });
        const prior = typeof before === 'string' ? undefined : usable(before, kind).filter((row) => row.ts <= start).at(-1);
        if (prior) rows = [prior, ...rows];
      }
      return { rows, now: Date.now(), available: true };
    } catch (error) {
      this.note(`failed ${id}`, 'warn', `Reading the history of ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      return failure('failed');
    }
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
