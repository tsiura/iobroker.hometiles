import type { IoBrokerObject } from '../registry/detector';
import { listed } from '../registry/manual';
import type { SourceValue } from '../registry/types';
import type { Logger } from './mqtt-client';

/**
 * How long the adapter waits for js-controller to answer one subscribe,
 * unsubscribe or read at start (Ruling 150). Each is a database round trip of
 * milliseconds, well under a second on a Raspberry Pi busy starting every
 * adapter at boot: 5 s leaves that margin several times over. Too short would
 * cost only a value, the state showing unavailable until it next changes;
 * each call left unanswered delays the start by this much, as the calls go
 * one at a time (connectSources).
 */
export const SOURCE_CALL_MS = 5_000;

/** What within() resolves to when the deadline passes first. */
export const UNANSWERED = Symbol('unanswered');

/**
 * The call's answer, or UNANSWERED once `ms` pass without one: js-controller
 * 5.0.19 to 7.2.3 never answers a subscribe to an alias it cannot resolve
 * (adapter.js _subscribeForeignStates), and 5.x's promisify drops a rejection
 * inside the call. A refusal in time still rejects. A late answer or refusal
 * goes nowhere, and the timer goes as soon as either comes first.
 */
export async function within<T>(call: Promise<T>, ms: number): Promise<T | typeof UNANSWERED> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<typeof UNANSWERED>((resolve) => {
    timer = setTimeout(() => resolve(UNANSWERED), ms);
  });
  try {
    return await Promise.race([call, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Why an alias's target cannot be read, or undefined: none, as js-controller
 * reads it (adapter.js _addAliasSubscribe: common.alias.id, or its `read` of
 * a {read, write} pair, which validateId refuses empty, not a string, or
 * ending in "."), or no state among the objects discovery read. An object
 * outside them, or no alias state, is left to js-controller.
 */
export function aliasProblem(objectId: string, objects: Readonly<Record<string, IoBrokerObject>>): string | undefined {
  const object = objects[objectId];
  if (!objectId.startsWith('alias.') || object?.type !== 'state') return undefined;
  const target = (object.common as { alias?: { id?: unknown } } | undefined)?.alias?.id;
  if (!target) return 'no target';
  const read = typeof target === 'object' ? (target as { read?: unknown }).read : target;
  if (!read) return 'no read target';
  if (typeof read !== 'string' || read.endsWith('.')) return `target ${JSON.stringify(read)} is invalid`;
  if (objects[read]?.type !== 'state') return `target ${read} is missing or not a state`;
  return undefined;
}

/** The js-controller calls a rebuild makes for the states its entities read. */
export interface SourceAccess {
  subscribe(objectId: string): Promise<unknown>;
  unsubscribe(objectId: string): Promise<unknown>;
  read(objectId: string): Promise<ioBroker.State | null | undefined>;
}

/**
 * A rebuild's subscriptions and first reads: the states it stopped reading
 * let go, the new ones subscribed, then each one's value read, so a panel
 * that connects later finds retained state rather than an empty dashboard.
 * One bad object must not hold back every other (Ruling 60(2)), nor stop the
 * start (Ruling 150): an alias whose target cannot be read is neither
 * subscribed nor read, and a call js-controller leaves unanswered is given up
 * after SOURCE_CALL_MS; a state not subscribed in time is not read, and a
 * value read too late is dropped, as a change the subscription brought
 * meanwhile is newer. Each is named in one warning per rebuild. A source
 * whose value cannot be read stays unavailable until it changes. Left
 * without a value, each is asked for again should this attempt fail later
 * (RebuildResult.subscribe). The calls go one at a time: js-controller counts
 * subscriptions to some adapters' states with a read-modify-write
 * (_subscribeForeignStates, autoSubscribe) that calls at once would undercount.
 */
export async function connectSources(
  changes: { subscribe: readonly string[]; unsubscribe: readonly string[] },
  objects: Readonly<Record<string, IoBrokerObject>>,
  access: SourceAccess,
  apply: (objectId: string, value: SourceValue | null) => void,
  log: Pick<Logger, 'warn'>,
): Promise<void> {
  const unanswered: string[] = [];
  const answer = async <T>(what: string, call: Promise<T>): Promise<T | typeof UNANSWERED> => {
    const result = await within(call, SOURCE_CALL_MS);
    if (result === UNANSWERED) unanswered.push(what);
    return result;
  };
  const broken: string[] = [];
  const subscribe = changes.subscribe.filter((objectId) => {
    const problem = aliasProblem(objectId, objects);
    if (problem) broken.push(`${objectId} (${problem})`);
    return !problem;
  });
  if (broken.length > 0) {
    log.warn(
      `[Registry] Aliases left out, their target cannot be read: ${listed(broken)}. ` +
        'Their devices show unavailable until the alias is repaired and the adapter restarted',
    );
  }

  for (const objectId of changes.unsubscribe) await answer(`unsubscribing ${objectId}`, access.unsubscribe(objectId));
  const subscribed: string[] = [];
  for (const objectId of subscribe) {
    if ((await answer(`subscribing ${objectId}`, access.subscribe(objectId))) !== UNANSWERED) subscribed.push(objectId);
  }
  const unread: string[] = [];
  for (const objectId of subscribed) {
    let state: Awaited<ReturnType<SourceAccess['read']>> | typeof UNANSWERED;
    try {
      state = await answer(`reading ${objectId}`, access.read(objectId));
    } catch (error) {
      unread.push(`${objectId} (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (state === UNANSWERED) continue;
    apply(objectId, state ? { val: state.val, ack: state.ack, q: state.q ?? 0, ts: state.ts } : null);
  }
  if (unread.length > 0) {
    log.warn(`[Registry] Could not read the value of ${unread.join(', ')}; unavailable until it changes`);
  }
  if (unanswered.length > 0) {
    log.warn(
      `[Registry] js-controller gave no answer within ${SOURCE_CALL_MS / 1000} s to ${listed(unanswered)}. ` +
        'Carried on without them: their devices may show unavailable until the adapter restarts',
    );
  }
}
