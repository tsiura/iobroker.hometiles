import type { Announcement, LocalIoChannel } from '../protocol/announce';
import { buildApplyPayload, buildIconsPayload, configSignature, MAX_APPLY_BYTES, MAX_ICONS_BYTES } from '../protocol/apply';
import { CommandError, parseCommand, parseValueCommand, requireEntityId, type ServiceCall } from '../protocol/commands';
import { buildValueAck, CONTROL_SESSION, MAX_CONTROL_BYTES, type ValueStatus } from '../protocol/editable';
import type { EnergyCatalogEntry } from '../protocol/energy';
import { buildDiscreteHistoryResponse, buildNumericHistoryResponse, parseHistoryRequest } from '../protocol/history';
import { buildStateClear, buildStatePublish } from '../protocol/state-payload';
import {
  applyTopic,
  bridgeRequestTopic,
  commandTopic,
  energyRequestTopic,
  historyRequestTopic,
  historyResponseTopic,
  iconsTopic,
  ioStateTopic,
  PANEL_SETTING_LEAVES,
  stateTopic,
  weatherRequestTopic,
} from '../protocol/topics';
import { valueChannel } from '../registry/synth/editable';
import type { Domain, SourceValue, VirtualEntity } from '../registry/types';
import type { Dispatcher } from './dispatcher';
import type { EnergySource } from './energy-source';
import { HISTORY_BUDGET_MS, type HistoryFailure, type HistoryProvider } from './history-provider';
import { isPlausibleHost } from './pairing';
import type { Logger, PublishRequest } from './mqtt-client';

/** What a panel's history and energy requests are answered from (Task 22); main.ts wires the adapter's own. */
export interface PanelRequests {
  /** The history provider (Task 19). */
  history: Pick<HistoryProvider, 'query'>;
  /**
   * The state the entity's own synth gives one history row of its state
   * `objectId`, as it reads a live one (Task 18): bad quality is unavailable,
   * a null what the domain makes of one. Undefined for an entity the
   * registry no longer holds.
   */
  stateOf(entityId: string, objectId: string, row: SourceValue): string | undefined;
  /** The energy source (Task 20b): the answer's topic and payload, or null for none, as while unarmed. */
  energy: Pick<EnergySource, 'answer'>;
}

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
 * A value command's deadline, epoch seconds, must lie ahead of now by more
 * than 0 and at most this much (__init__.py:1562-1566). The panel sends its
 * own now + 10, in whole seconds (value_control.cpp:295, :309), so its clock
 * may run at most about 5 s ahead of this host's, or up to about 10 s behind,
 * less the time in transit (review m3): a panel or host whose clock is off by
 * more gets "expired" for every command.
 */
const MAX_DEADLINE_AHEAD_S = 15;
/** What the panel adds to its clock for a deadline (value_control.cpp:309). */
const PANEL_DEADLINE_S = 10;
/** The window as a clock offset, the panel's less this host's: accepted while -10 s < offset <= 5 s. */
const AHEAD_LIMIT_S = MAX_DEADLINE_AHEAD_S - PANEL_DEADLINE_S;
const BEHIND_LIMIT_S = PANEL_DEADLINE_S;
/**
 * An offset this far beyond either edge is named in a warning (Rulings 102,
 * 105): 7 s ahead, or 12 s behind. Transit, and the panel's whole seconds,
 * only ever make its clock look further behind; the margin keeps a single
 * borderline expiry quiet.
 */
const CLOCK_WARN_MARGIN_S = 2;
/** No clock is this far off: such a deadline is no Unix time in seconds (review T12). */
const MAX_CLOCK_OFFSET_S = 1e9;
/** The clock warning, at most once in this long per panel. */
const CLOCK_WARN_INTERVAL_MS = 3_600_000;
/** Command ids held against a replay, at most (__init__.py:1567-1570). */
const MAX_HELD_COMMAND_IDS = 128;
const EDITABLE_DOMAINS: ReadonlySet<string> = new Set(['number', 'select', 'datetime']);
/** A failed value command is logged at most once in this long per panel, with how many failed meanwhile: each is answered. */
const FAILURE_LOG_INTERVAL_MS = 60_000;
/** What the dispatcher refuses a value with that is itself an answer; any other refusal means it cannot be written. */
const VALUE_REFUSALS: ReadonlySet<string> = new Set(['changed', 'unavailable', 'invalid_value', 'invalid_step', 'invalid_option']);
/** Text from the wire for a log line: JSON-escaped, so no line break gets through, and cut short (review m6). */
const quoted = (text: string): string => JSON.stringify(text).slice(0, 100);
/** A line about a panel's requests, at most once in this long for what it names: panels ask again every minute. */
const REQUEST_LOG_INTERVAL_MS = 3_600_000;
/** The states a sensor's and a binary sensor's synth read their reading from, the first configured one (synth/sensor.ts, synth/binary_sensor.ts). */
const READINGS: Partial<Record<Domain, readonly string[]>> = {
  sensor: ['actual', 'pressure', 'set'],
  binary_sensor: ['actual', 'level', 'set'],
};

/**
 * The state an entity's history is read from: the one its synth reads (Task
 * 18 hand-off), for an editable its value channel, SET over ACTUAL
 * (valueChannel). None for a domain whose history no panel asks for.
 */
function historyState(entity: VirtualEntity): string | undefined {
  const name = EDITABLE_DOMAINS.has(entity.domain)
    ? valueChannel(entity.source)
    : READINGS[entity.domain]?.find((channel) => entity.source[channel] !== undefined);
  return name === undefined ? undefined : entity.source[name];
}

/**
 * A read that found the entity has no history to show, not one that failed
 * for now: a graph is then given the live value, as the Bridge answers an
 * entity without recorded history (__init__.py:2388-2392, :2439-2440).
 */
const NO_HISTORY: ReadonlySet<HistoryFailure | undefined> = new Set<HistoryFailure>(['no_instance', 'not_running', 'not_logged']);
/** An apply payload's three largest sections with their sizes, for a log line: "sensor_meta 20113 bytes, ...". */
function largestSections(payload: string): string {
  return Object.entries(JSON.parse(payload) as Record<string, unknown>)
    .map(([key, value]): [string, number] => [key, Buffer.byteLength(JSON.stringify(value), 'utf8')])
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([key, size]) => `${key} ${size} bytes`)
    .join(', ');
}
/** A clock offset in words, for a log line: "about 8 s ahead of this host's". */
function apart(offset: number): string {
  const seconds = Math.round(Math.abs(offset));
  return seconds === 0 ? "in step with this host's" : `about ${seconds} s ${offset > 0 ? 'ahead of' : 'behind'} this host's`;
}

export class PanelSession {
  private lastSignature: string | null = null;
  /** The last configuration refused as too large, so each is named in one error only (Ruling 108). */
  private refusedSignature: string | null = null;
  private lastIconsPayload: string | null = null;
  /** The configuration whose icon map was last refused as too large, so each is named in one error only (Ruling 114). */
  private refusedIconsFor: string | null = null;
  /** The configuration whose icon map last went out without its "" entries, so each is named in one warning only (Task 23). */
  private degradedIconsFor: string | null = null;
  private started = false;
  /**
   * The entities pushed to this panel, as last pushed: what its requests are
   * answered for and with -- weather (Task 12), history (Task 22) -- and the
   * only editables whose value command it takes (__init__.py:1557); the
   * /control published after an answer is this one.
   */
  private readonly pushed = new Map<string, VirtualEntity>();
  /** entity id -> when its weather request was last answered */
  private readonly weatherAnswered = new Map<string, number>();
  /**
   * Editable values last sent without their option list, too large for the
   * panel with it (Ruling 98): one warning per episode, which ends with a
   * payload that fits or the entity's removal.
   */
  private readonly oversized = new Set<string>();
  /** When each line about the panel's requests last went out, by what it names (note). */
  private readonly noted = new Map<string, number>();
  /** Value command id -> its deadline, epoch seconds: a replay while it runs is dropped (Ruling 99). */
  private readonly commandIds = new Map<string, number>();
  private failureLoggedAt = -Infinity;
  private failuresUnlogged = 0;
  private clockWarnedAt = -Infinity;

  online = false;
  ip: string | null = null;

  constructor(
    private announcement: Announcement,
    private readonly transport: PanelTransport,
    private readonly dispatcher: Dispatcher,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
    /** The energy meters' catalog, as the last rebuild resolved them (Task 20b). */
    private readonly energy: () => readonly EnergyCatalogEntry[] = () => [],
    /** What its history and energy requests are answered from (Task 22); none are without. */
    private readonly requests?: PanelRequests,
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
    topics.push(historyRequestTopic(this.deviceId));
    topics.push(energyRequestTopic(this.deviceId));
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
   *
   * Nor is a configuration over MAX_APPLY_BYTES published (Ruling 108): the
   * panel would apply a cut copy of it at every reconnect. The broker keeps
   * the last good retained apply and icons, and the panel its configuration;
   * one error names each configuration that does not fit. An icon map over
   * MAX_ICONS_BYTES, even without its "" entries, is held back the same way
   * (Ruling 114), with the apply still published.
   */
  pushConfig(entities: VirtualEntity[] | null, force = false): boolean {
    if (!entities) return false;
    const payload = buildApplyPayload({ entities, sceneMap: this.sceneMap, energy: this.energy() });
    const signature = configSignature(payload);
    const bytes = Buffer.byteLength(payload, 'utf8');
    if (bytes > MAX_APPLY_BYTES) {
      if (signature !== this.refusedSignature) {
        this.refusedSignature = signature;
        this.log.error(
          `[Panel ${this.deviceId}] Configuration not pushed: it is ${bytes} bytes, over the ${MAX_APPLY_BYTES} bytes a ` +
            `panel takes in one bridge/apply (largest sections: ${largestSections(payload)}). Pick fewer devices on the ` +
            'Devices tab of the adapter settings, or set fewer energy meters on the Energy tab, until it fits; the panel ' +
            'keeps its last configuration meanwhile',
        );
      }
      return false;
    }
    this.refusedSignature = null;
    if (!force && signature === this.lastSignature) return false;

    this.lastSignature = signature;
    this.transport.publish({ topic: applyTopic(this.deviceId), payload, retain: true });

    // Ruling 114: an icon map a panel would cut is not published either;
    // buildIconsPayload has already left out the "" entries to make it fit.
    const { payload: icons, dropped } = buildIconsPayload(entities);
    const iconBytes = Buffer.byteLength(icons, 'utf8');
    if (iconBytes > MAX_ICONS_BYTES) {
      if (signature !== this.refusedIconsFor) {
        this.refusedIconsFor = signature;
        this.log.error(
          `[Panel ${this.deviceId}] Icons not pushed: bridge/icons is ${iconBytes} bytes with its MDI icons alone, over the ` +
            `${MAX_ICONS_BYTES} bytes a panel takes. Pick fewer devices on the Devices tab of the adapter settings ` +
            'until it fits; the panel keeps the icons it has meanwhile',
        );
      }
    } else {
      this.refusedIconsFor = null;
      // Without its "" entries, an icon the panel holds for such an entity is
      // never cleared (Task 21 round 2, C1): said once per configuration, as
      // the refusals are, and again once a whole map has gone out between.
      if (dropped === 0) {
        this.degradedIconsFor = null;
      } else if (signature !== this.degradedIconsFor) {
        this.degradedIconsFor = signature;
        this.log.warn(
          `[Panel ${this.deviceId}] Icons pushed without the entries that clear one: with them, bridge/icons is over the ` +
            `${MAX_ICONS_BYTES} bytes a panel takes. The ${dropped} entities without an MDI icon keep any icon the panel ` +
            'holds for them until it restarts. Pick fewer devices on the Devices tab of the adapter settings to send them again',
        );
      }
      if (icons !== this.lastIconsPayload) {
        this.lastIconsPayload = icons;
        this.transport.publish({ topic: iconsTopic(this.deviceId), payload: icons, retain: true });
      }
    }

    // m3: how close the installation is to the limit, before a push is refused.
    this.log.info(`[Panel ${this.deviceId}] Configuration pushed, ${entities.length} entities, ${bytes} of ${MAX_APPLY_BYTES} bytes`);
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
    this.pushed.set(entity.entityId, entity);
    this.transport.publish(request);
  }

  clearEntityState(entityId: string): void {
    this.pushed.delete(entityId);
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
   * message on a new subscription (MQTT 3.1.1 §3.3.1.3). The panel's own
   * topics are read either way; a command is ignored (Ruling 101).
   */
  async handleMessage(topic: string, payload: string, retain: boolean): Promise<boolean> {
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

    if (topic === historyRequestTopic(this.deviceId) || topic === energyRequestTopic(this.deviceId)) {
      await this.answerRequest(topic, payload, retain);
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

    // Ruling 101: a retained command is replayed at every (re)subscription,
    // so it would run again at every reconnect and restart -- a switch
    // toggling by itself. The panel retains none (retain false at
    // mqtt_handlers.cpp:1976-2377 and value_control.cpp:312). Ignored on
    // every leaf, where the Bridge ignores only value, switch and scene
    // (__init__.py:1550, :2999, :3082), and before parsing, so a malformed
    // one warns at no reconnect either. Only after the leaf match: the
    // panel's retained presence and IP above, and its announcement in the
    // manager, must still be read (review T1).
    if (retain) {
      this.log.debug(`[Panel ${this.deviceId}] Retained command on ${topic} ignored`);
      return true;
    }
    if (leaf === 'value') await this.executeValueCommand(payload);
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
    const entity = this.pushed.get(entityId);
    if (entity?.domain !== 'weather') {
      this.log.debug(`[Panel ${this.deviceId}] Weather request for ${entityId} ignored: no weather entity of this panel`);
      return;
    }
    const now = this.now();
    if (now - (this.weatherAnswered.get(entityId) ?? -Infinity) < WEATHER_REQUEST_REPEAT_MS) return;
    this.weatherAnswered.set(entityId, now);
    this.pushEntityState(entity);
  }

  /**
   * A history or energy request (Task 22), answered on its response topic,
   * never retained. A retained one is ignored: it would be answered again at
   * every (re)subscription, and the panel retains none (mqtt_handlers.cpp:
   * 2424, :2488, :2555; value_control.cpp:188). Nothing thrown reaches the
   * MQTT handler.
   */
  private async answerRequest(topic: string, payload: string, retain: boolean): Promise<void> {
    if (retain || !this.requests) {
      this.note(`ignored ${topic}`, retain ? 'debug' : 'warn', `Request on ${topic} ignored: ${retain ? 'retained' : 'nothing answers it here, a wiring error'}`);
      return;
    }
    try {
      if (topic === historyRequestTopic(this.deviceId)) {
        await this.answerHistory(this.requests, payload);
        return;
      }
      // Rulings 116, 118: none while unarmed.
      const answer = await this.requests.energy.answer(this.deviceId, payload);
      if (answer) this.publishRaw(answer.topic, answer.payload);
    } catch (error) {
      this.note(`failed ${topic}`, 'warn', `Answering a request on ${topic} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * A history request (Task 16), answered for an entity this panel was given
   * -- none while unarmed (Rulings 116, 118) -- whose history it can ask for:
   * an editable request only for a number, select or datetime, as the
   * Bridge's (__init__.py:1590). The rows of the state its synth reads (Task
   * 19) come by a deadline that leaves the popup's 8 s timer time
   * (mqtt_handlers.cpp:66), the wait for a slot included, and are built by
   * the request's own builder, which a malformed range refuses (Ruling 70):
   *
   * - numeric (Task 17): the good numeric rows. With no history -- no rows,
   *   or none kept for the state -- the live value at now, as the Bridge
   *   answers; a read that failed for now answers nothing, so a tile graph
   *   keeps what it shows, as a Bridge whose recorder raised sends nothing.
   * - binary, state, editable (Task 18): each row as the entity's synth reads
   *   it, the entity as the panel has it once the rows came, and a failed read
   *   as "History unavailable" (Ruling 126).
   */
  private async answerHistory(requests: PanelRequests, payload: string): Promise<void> {
    const request = parseHistoryRequest(payload);
    const given = request ? this.pushed.get(request.entityId) : undefined;
    const stateId = request && given && (request.kind !== 'editable' || EDITABLE_DOMAINS.has(given.domain)) ? historyState(given) : undefined;
    if (!request || !stateId) {
      this.note(
        `ignored ${request?.entityId ?? ''}`,
        'debug',
        request
          ? `History request for ${request.entityId} ignored: no entity of this panel whose history it can ask for`
          : `History request ignored: ${quoted(payload)} is none the panel sends`,
      );
      return;
    }
    const now = this.now();
    const result = await requests.history.query(stateId, {
      start: now - request.hours * 3_600_000,
      kind: request.kind === 'numeric' ? 'numeric' : 'discrete',
      panel: this.deviceId,
      deadline: now + HISTORY_BUDGET_MS,
    });
    // Taken away meanwhile, it is no longer this panel's to ask for.
    const entity = this.pushed.get(request.entityId);
    if (!entity) return;
    let answer: string | null;
    if (request.kind === 'numeric') {
      if (!result.available && !NO_HISTORY.has(result.reason)) return;
      answer = buildNumericHistoryResponse(request, result.rows.length > 0 ? result.rows : [{ ts: result.now, val: entity.state }], result.now);
    } else {
      const samples = result.rows.flatMap((row) => {
        const state = requests.stateOf(entity.entityId, stateId, row);
        return state === undefined ? [] : [{ ts: row.ts, state }];
      });
      answer = buildDiscreteHistoryResponse(request, samples, result.now, entity, result.available);
    }
    if (answer !== null) this.publishRaw(historyResponseTopic(this.deviceId), answer);
  }

  /** One English line per key and hour: panels repeat their requests. */
  private note(key: string, level: 'debug' | 'warn', text: string): void {
    const now = this.now();
    if (now - (this.noted.get(key) ?? -Infinity) < REQUEST_LOG_INTERVAL_MS) return;
    // ponytail: cleared when full; keys are the entities a panel asks about, so 100 is rarely reached.
    if (this.noted.size >= 100) this.noted.clear();
    this.noted.set(key, now);
    this.log[level](`[Panel ${this.deviceId}] ${text}`);
  }

  /**
   * A number, select or datetime command, taken as the Bridge takes one
   * (Ruling 99, __init__.py:1549-1590), a retained one ignored before
   * (handleMessage). Dropped without an answer: one that is no command
   * (parseValueCommand); one for an entity not pushed to this panel; an id
   * seen while its deadline runs, or any while 128 are held. "expired" for
   * a deadline not 0-15 s ahead of now, in epoch seconds (MAX_DEADLINE_AHEAD_S),
   * or another session; then the dispatcher (valueWrite). Every answer goes
   * out on stat/value, and the entity's /control after it. Refusals are
   * logged at debug only: the answer carries them, and an expiry the clock
   * offset its deadline gives. A deadline 2 s or more beyond the window is
   * also named in a warning (warnClock).
   */
  private async executeValueCommand(payload: string): Promise<void> {
    let call: Extract<ServiceCall, { kind: 'set_value' }>;
    try {
      call = parseValueCommand(payload);
    } catch (error) {
      const code = error instanceof CommandError ? error.code : (error as Error).message;
      this.log.debug(`[Panel ${this.deviceId}] Value command dropped: ${code}`);
      return;
    }
    if (!EDITABLE_DOMAINS.has(this.pushed.get(call.entityId)?.domain ?? '')) {
      this.log.debug(`[Panel ${this.deviceId}] Value command dropped: ${quoted(call.entityId)} is no editable value of this panel`);
      return;
    }
    const now = this.now() / 1000;
    const { deadline } = call;
    const timely = typeof deadline === 'number' && deadline - now > 0 && deadline - now <= MAX_DEADLINE_AHEAD_S;
    let status: ValueStatus;
    let why = '';
    if (!timely || call.session !== CONTROL_SESSION) {
      // The panel's clock less this host's, as the deadline gives it (Ruling
      // 105); in the window when only the session is from before a restart.
      const offset = typeof deadline === 'number' && Number.isFinite(deadline) ? deadline - PANEL_DEADLINE_S - now : undefined;
      if (offset !== undefined) this.warnClock(offset);
      why = offset === undefined ? ' (its deadline is no number)' : ` (by its deadline, the panel's clock is ${apart(offset)})`;
      status = 'expired';
    } else {
      for (const [id, expiry] of this.commandIds) if (expiry <= now) this.commandIds.delete(id);
      if (this.commandIds.has(call.id) || this.commandIds.size >= MAX_HELD_COMMAND_IDS) {
        this.log.debug(`[Panel ${this.deviceId}] Value command ${quoted(call.id)} dropped: seen, or ${MAX_HELD_COMMAND_IDS} held`);
        return;
      }
      this.commandIds.set(call.id, deadline);
      status = await this.dispatchValue(call);
    }
    if (status !== 'ok') this.log.debug(`[Panel ${this.deviceId}] Value command for ${call.entityId} refused: ${status}${why}`);
    this.transport.publish(buildValueAck(this.baseTopic, call.entityId, call.id, status));
    // As the Bridge does after every answer (__init__.py:1586): the panel re-reads it.
    const entity = this.pushed.get(call.entityId);
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

  /**
   * Rulings 102 and 105: an offset 2 s or more beyond the window means the
   * panel's clock and this host's disagree, and every command expires. Named
   * at most once an hour per panel, the first time at once, with the offset
   * and its sign, and with the topic: a panel sharing a base topic is
   * answered by another's session (review T11), and either clock can be the
   * wrong one (T9). A deadline that is no Unix time in seconds says nothing
   * of a clock (T12).
   */
  private warnClock(offset: number): void {
    const inside = offset < AHEAD_LIMIT_S + CLOCK_WARN_MARGIN_S && offset > -(BEHIND_LIMIT_S + CLOCK_WARN_MARGIN_S);
    if (inside || Math.abs(offset) >= MAX_CLOCK_OFFSET_S) return;
    const at = this.now();
    if (at - this.clockWarnedAt < CLOCK_WARN_INTERVAL_MS) return;
    this.clockWarnedAt = at;
    this.log.warn(
      `[Panel ${this.deviceId}] Value commands on ${commandTopic(this.baseTopic, 'value')} expire: their deadline puts the ` +
        `sending panel's clock ${apart(offset)}. A command is accepted only while it is at most about ${AHEAD_LIMIT_S} s ahead ` +
        `or ${BEHIND_LIMIT_S} s behind: check the time sync (NTP) of the panel and of this host`,
    );
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
