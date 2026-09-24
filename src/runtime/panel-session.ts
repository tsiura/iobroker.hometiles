import type { Announcement, LocalIoChannel } from '../protocol/announce';
import { buildApplyPayload, buildIconsPayload, configSignature } from '../protocol/apply';
import { CommandError, parseCommand, parseValueCommand, requireEntityId, type ServiceCall } from '../protocol/commands';
import { buildValueAck, CONTROL_SESSION, MAX_CONTROL_BYTES, type ValueStatus } from '../protocol/editable';
import { buildStateClear, buildStatePublish } from '../protocol/state-payload';
import {
  applyTopic,
  bridgeRequestTopic,
  commandTopic,
  iconsTopic,
  ioStateTopic,
  PANEL_SETTING_LEAVES,
  stateTopic,
  weatherRequestTopic,
} from '../protocol/topics';
import type { VirtualEntity } from '../registry/types';
import type { Dispatcher } from './dispatcher';
import { isPlausibleHost } from './pairing';
import type { Logger, PublishRequest } from './mqtt-client';

export interface PanelTransport {
  publish(request: PublishRequest): void;
  subscribe(topic: string): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
}

/**
 * Command leaves this adapter implements. Everything else is deliberately not
 * subscribed. Each is the firmware's own topic leaf (mqtt_topics.cpp:9-14):
 * media_player's is "media", and number, select and datetime share "value"
 * (value_control.cpp:311).
 */
const COMMAND_LEAVES = ['light', 'switch', 'scene', 'climate', 'cover', 'media', 'value'] as const;
type CommandLeaf = (typeof COMMAND_LEAVES)[number];

/** A weather request repeated within this long of its answer is not answered again. */
const WEATHER_REQUEST_REPEAT_MS = 1000;

/**
 * A value command's deadline, epoch seconds, must lie ahead by at most this
 * much (__init__.py:1562-1566); the panel sends now + 10 (value_control.cpp:
 * 309). A panel whose clock is off by more gets "expired" for every command.
 */
const MAX_DEADLINE_AHEAD_S = 15;
/** Command ids held against a replay, at most (__init__.py:1567-1570). */
const MAX_HELD_COMMAND_IDS = 128;
const EDITABLE_DOMAINS: ReadonlySet<string> = new Set(['number', 'select', 'datetime']);
/** A failed value command is logged at most once in this long per panel, with how many failed meanwhile: each is answered. */
const FAILURE_LOG_INTERVAL_MS = 60_000;
/** What the dispatcher refuses a value with that is itself an answer; any other refusal means it cannot be written. */
const VALUE_REFUSALS: ReadonlySet<string> = new Set(['changed', 'unavailable', 'invalid_value', 'invalid_step', 'invalid_option']);

export class PanelSession {
  private lastSignature: string | null = null;
  private lastIconsPayload: string | null = null;
  private started = false;
  /** The weather entities pushed to this panel, as last pushed: what its weather request is answered with. */
  private readonly weathers = new Map<string, VirtualEntity>();
  /** entity id -> when its weather request was last answered */
  private readonly weatherAnswered = new Map<string, number>();
  /**
   * Editable values last sent without their option list, too large for the
   * panel with it (Ruling 98): one warning per episode, which ends with a
   * payload that fits or the entity's removal.
   */
  private readonly oversized = new Set<string>();
  /**
   * The numbers, selects and datetimes pushed to this panel, as last pushed:
   * a value command for any other entity is dropped (__init__.py:1557), and
   * the /control published after an answer is this one.
   */
  private readonly editables = new Map<string, VirtualEntity>();
  /** Value command id -> its deadline, epoch seconds: a replay while it runs is dropped (Ruling 99). */
  private readonly commandIds = new Map<string, number>();
  private failureLoggedAt = -Infinity;
  private failuresUnlogged = 0;

  online = false;
  ip: string | null = null;

  constructor(
    private announcement: Announcement,
    private readonly transport: PanelTransport,
    private readonly dispatcher: Dispatcher,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  get deviceId(): string {
    return this.announcement.deviceId;
  }

  get baseTopic(): string {
    return this.announcement.baseTopic;
  }

  get haPrefix(): string {
    return this.announcement.haPrefix;
  }

  get localIo(): LocalIoChannel[] {
    return this.announcement.localIo;
  }

  get sceneMap(): Record<string, string> {
    return this.announcement.sceneMap;
  }

  get deviceName(): string {
    return this.announcement.deviceName;
  }

  get model(): string {
    return this.announcement.model;
  }

  publishRaw(topic: string, payload: string): void {
    this.transport.publish({ topic, payload, retain: false });
  }

  commandTopics(): string[] {
    const topics = COMMAND_LEAVES.map((leaf) => commandTopic(this.baseTopic, leaf));
    topics.push(stateTopic(this.baseTopic, 'connected'));
    topics.push(stateTopic(this.baseTopic, 'ip'));
    topics.push(bridgeRequestTopic(this.deviceId));
    topics.push(weatherRequestTopic(this.deviceId));
    for (const leaf of PANEL_SETTING_LEAVES) topics.push(stateTopic(this.baseTopic, leaf));
    for (const channel of this.announcement.localIo) topics.push(ioStateTopic(this.baseTopic, channel.id));
    return topics;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const topic of this.commandTopics()) {
      await this.transport.subscribe(topic);
    }
    this.log.info(`[Panel ${this.deviceId}] Session started on base topic ${this.baseTopic}`);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const topic of this.commandTopics()) {
      await this.transport.unsubscribe(topic);
    }
  }

  /**
   * A base topic change means the panel now listens somewhere else, so the old
   * subscriptions have to go before the new ones are taken.
   */
  async updateAnnouncement(next: Announcement): Promise<void> {
    const rewired = next.baseTopic !== this.baseTopic || next.haPrefix !== this.haPrefix;
    if (!rewired) {
      this.announcement = next;
      return;
    }
    await this.stop();
    this.announcement = next;
    this.lastSignature = null;
    this.lastIconsPayload = null;
    await this.start();
  }

  /**
   * `null`: the entity list is not known yet, because no discovery has
   * succeeded in this run, so nothing is published. A retained apply with
   * every list empty would make the firmware prune the panel's tile bindings
   * and save that to flash; the panel keeps its last configuration instead
   * (Ruling 56).
   */
  pushConfig(entities: VirtualEntity[] | null, force = false): boolean {
    if (!entities) return false;
    const payload = buildApplyPayload({ entities, sceneMap: this.sceneMap });
    const signature = configSignature(payload);
    if (!force && signature === this.lastSignature) return false;

    this.lastSignature = signature;
    this.transport.publish({ topic: applyTopic(this.deviceId), payload, retain: true });

    const icons = buildIconsPayload(entities);
    if (icons !== this.lastIconsPayload) {
      this.lastIconsPayload = icons;
      this.transport.publish({ topic: iconsTopic(this.deviceId), payload: icons, retain: true });
    }

    this.log.info(`[Panel ${this.deviceId}] Configuration pushed, ${entities.length} entities`);
    return true;
  }

  pushEntityState(entity: VirtualEntity): void {
    const publish = buildStatePublish(this.haPrefix, entity);
    if (!publish) return;
    const { degraded, ...request } = publish;
    if (!degraded) {
      this.oversized.delete(entity.entityId);
    } else if (!this.oversized.has(entity.entityId)) {
      this.oversized.add(entity.entityId);
      this.log.warn(
        `[Panel ${this.deviceId}] ${entity.entityId} sent without its option list, so read-only: with it, its control ` +
          `payload is over the panel's ${MAX_CONTROL_BYTES}-byte limit`,
      );
    }
    if (entity.domain === 'weather') this.weathers.set(entity.entityId, entity);
    if (EDITABLE_DOMAINS.has(entity.domain)) this.editables.set(entity.entityId, entity);
    this.transport.publish(request);
  }

  clearEntityState(entityId: string): void {
    this.weathers.delete(entityId);
    this.editables.delete(entityId);
    this.oversized.delete(entityId);
    this.transport.publish(buildStateClear(this.haPrefix, entityId));
  }

  publishPanelCommand(leaf: string, payload: string): void {
    this.transport.publish({ topic: commandTopic(this.baseTopic, leaf), payload, retain: false });
  }

  /**
   * Returns true when this session owns the topic. The manager uses that to
   * stop after the first match: command topics are keyed by BASE TOPIC, not
   * device id, so two panels sharing a base topic would otherwise both execute
   * the same press — one physical tap becoming two writes, and a toggle
   * netting to no visible change at all. `retain`: the broker replayed the
   * message on a new subscription (MQTT 3.1.1 §3.3.1.3).
   */
  async handleMessage(topic: string, payload: string, retain = false): Promise<boolean> {
    if (topic === bridgeRequestTopic(this.deviceId)) {
      // Signature reset makes the next pushConfig unconditional.
      this.lastSignature = null;
      this.lastIconsPayload = null;
      if (!this.onRefreshRequested) {
        // The session does not own the entity list — the manager does. Caching
        // the last pushed list here to republish it would risk replaying STALE
        // config on the one path where freshness matters most. So an unwired
        // handler is a wiring bug, and it must be loud, not a silent no-op.
        this.log.warn(`[Panel ${this.deviceId}] Refresh requested but no handler is wired`);
        return true;
      }
      this.onRefreshRequested(payload.trim() === 'force');
      return true;
    }

    if (topic === weatherRequestTopic(this.deviceId)) {
      this.answerWeatherRequest(payload);
      return true;
    }

    if (topic === stateTopic(this.baseTopic, 'connected')) {
      const text = payload.trim().toLowerCase();
      this.online = text === 'online' || text === 'true' || text === '1' || text === 'on';
      return true;
    }

    if (topic === stateTopic(this.baseTopic, 'ip')) {
      const reported = payload.trim();
      // stat/ip feeds the pairing flow, which POSTs broker credentials to it.
      // fetch would read panel.lan@attacker.example as attacker.example, so an
      // implausible reported value could redirect credentials. This value arrives
      // over MQTT — it is not a trusted string.
      if (reported && !isPlausibleHost(reported)) {
        this.log.warn(`[Panel ${this.deviceId}] implausible reported IP, keeping previous value`);
        return true;
      }
      this.ip = reported || null;
      return true;
    }

    const leaf = COMMAND_LEAVES.find((candidate) => topic === commandTopic(this.baseTopic, candidate));
    if (!leaf) return false;

    if (leaf === 'value') await this.executeValueCommand(payload, retain);
    else await this.executeCommand(leaf, payload);
    return true;
  }

  /** Set by the manager so a forced refresh can reach the entity registry. */
  onRefreshRequested?: (forced: boolean) => void;

  /**
   * The weather popup's cold-cache nudge, {"entity_id":"weather.x"}
   * (mqtt_handlers.cpp:2515-2529). It has no response topic: the answer is the
   * entity's retained weather state, published again on its weather leaf
   * (docs/contract-media-weather.md). Unreadable JSON, an id that is no
   * weather entity of this panel, and a repeat within a second of the last
   * answer are ignored.
   */
  private answerWeatherRequest(payload: string): void {
    let entityId: string;
    try {
      entityId = requireEntityId(JSON.parse(payload) as Record<string, unknown>);
    } catch {
      return;
    }
    const entity = this.weathers.get(entityId);
    if (!entity) {
      this.log.debug(`[Panel ${this.deviceId}] Weather request for ${entityId} ignored: no weather entity of this panel`);
      return;
    }
    const now = this.now();
    if (now - (this.weatherAnswered.get(entityId) ?? -Infinity) < WEATHER_REQUEST_REPEAT_MS) return;
    this.weatherAnswered.set(entityId, now);
    this.pushEntityState(entity);
  }

  /**
   * A number, select or datetime command, taken as the Bridge takes one
   * (Ruling 99, __init__.py:1549-1590). Dropped without an answer: a retained
   * one, which every new subscription would run again; one that is no
   * command (parseValueCommand); one for an entity not pushed to this panel;
   * an id seen while its deadline runs, or any while 128 are held. "expired"
   * for a deadline not within 15 s ahead, in epoch seconds, or another
   * session; then the dispatcher (valueWrite). Every answer goes out on
   * stat/value, and the entity's /control after it. Refusals are logged at
   * debug only: the answer carries them.
   */
  private async executeValueCommand(payload: string, retain: boolean): Promise<void> {
    if (retain) return;
    let call: Extract<ServiceCall, { kind: 'set_value' }>;
    try {
      call = parseValueCommand(payload);
    } catch (error) {
      const code = error instanceof CommandError ? error.code : (error as Error).message;
      this.log.debug(`[Panel ${this.deviceId}] Value command dropped: ${code}`);
      return;
    }
    if (!this.editables.has(call.entityId)) {
      this.log.debug(`[Panel ${this.deviceId}] Value command dropped: ${call.entityId} is no editable value of this panel`);
      return;
    }
    const now = this.now() / 1000;
    const { deadline } = call;
    let status: ValueStatus;
    if (typeof deadline !== 'number' || !(deadline - now > 0 && deadline - now <= MAX_DEADLINE_AHEAD_S) || call.session !== CONTROL_SESSION) {
      status = 'expired';
    } else {
      for (const [id, expiry] of this.commandIds) if (expiry <= now) this.commandIds.delete(id);
      if (this.commandIds.has(call.id) || this.commandIds.size >= MAX_HELD_COMMAND_IDS) {
        this.log.debug(`[Panel ${this.deviceId}] Value command ${call.id} dropped: seen, or ${MAX_HELD_COMMAND_IDS} held`);
        return;
      }
      this.commandIds.set(call.id, deadline);
      status = await this.dispatchValue(call);
    }
    if (status !== 'ok') this.log.debug(`[Panel ${this.deviceId}] Value command for ${call.entityId} refused: ${status}`);
    this.transport.publish(buildValueAck(this.baseTopic, call.entityId, call.id, status));
    // As the Bridge does after every answer (__init__.py:1586): the panel re-reads it.
    const entity = this.editables.get(call.entityId);
    if (entity) this.pushEntityState(entity);
  }

  /** The dispatcher's outcome as an answer: a failed write, or anything thrown, is "failed" (__init__.py:1581-1583). */
  private async dispatchValue(call: Extract<ServiceCall, { kind: 'set_value' }>): Promise<ValueStatus> {
    let cause: string;
    try {
      const result = await this.dispatcher.dispatch(call);
      if (result.ok) return 'ok';
      if (result.reason !== 'write_failed') return VALUE_REFUSALS.has(result.reason) ? (result.reason as ValueStatus) : 'unavailable';
      cause = result.cause ?? 'the write failed';
    } catch (error) {
      cause = (error as Error).message;
    }
    this.logFailure(call.entityId, cause);
    return 'failed';
  }

  /** One English line per failure, at most once a minute, then with how many failed meanwhile. */
  private logFailure(entityId: string, cause: string): void {
    const now = this.now();
    if (now - this.failureLoggedAt < FAILURE_LOG_INTERVAL_MS) {
      this.failuresUnlogged++;
      return;
    }
    const more = this.failuresUnlogged > 0 ? ` (and ${this.failuresUnlogged} more since the last such line)` : '';
    this.failureLoggedAt = now;
    this.failuresUnlogged = 0;
    this.log.error(`[Panel ${this.deviceId}] Value command for ${entityId} failed: ${cause}${more}`);
  }

  private async executeCommand(leaf: Exclude<CommandLeaf, 'value'>, payload: string): Promise<void> {
    try {
      const call = parseCommand(leaf, payload);
      const result = await this.dispatcher.dispatch(call);
      if (!result.ok) {
        this.log.warn(`[Panel ${this.deviceId}] Command on ${leaf} rejected: ${result.reason}`);
      }
    } catch (error) {
      const code = error instanceof CommandError ? error.code : (error as Error).message;
      this.log.warn(`[Panel ${this.deviceId}] Invalid command on ${leaf}: ${code}`);
    }
  }
}
