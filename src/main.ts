import * as utils from '@iobroker/adapter-core';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PICKER_VERSION, validateOptions, type AdapterOptions, type DeviceOverride } from './config/options';
import { AnnounceError } from './protocol/announce';
import { listsAnyEntity, MAX_EDITABLES, splitEditables } from './protocol/apply';
import { ENTITY_ID_RE } from './protocol/commands';
import { ENERGY_CATEGORIES } from './protocol/energy';
import { buildStatePublish } from './protocol/state-payload';
import {
  ANNOUNCE_TOPIC_PATTERN,
  deviceIdFromAnnounceTopic,
  ioStateTopic,
  PANEL_SETTING_LEAVES,
  stateTopic,
} from './protocol/topics';
import { discoverDevices, type Discovery, type RootAnchors } from './registry/detector';
import { idsToStore, parseStringMap } from './registry/entity-id';
import { EntityRegistry } from './registry/entity-registry';
import { listed, manualDevices } from './registry/manual';
import { applyOverrides, detectedRows, mergeDetected } from './registry/overrides';
import { synthesise } from './registry/synth/index';
import type { DeviceInput, SourceValue, VirtualEntity } from './registry/types';
import { Dispatcher } from './runtime/dispatcher';
import { energyMeters, EnergySource, type TotalNames } from './runtime/energy-source';
import { HistoryProvider } from './runtime/history-provider';
import { HomeTilesMqttClient, type Logger } from './runtime/mqtt-client';
import { PanelManager } from './runtime/panel-manager';
import { PanelObjects } from './runtime/panel-objects';
import type { PanelSession } from './runtime/panel-session';
import { credentialsFromOptions, pushCredentials } from './runtime/pairing';
import { mergeSceneAliases } from './runtime/scene-aliases';

const ENTITY_ID_STATE = 'info.entityIds';
const ROOT_ANCHOR_STATE = 'info.rootAnchors';
/** The entities the panels were given, kept across the restart a saved selection causes (Task 21b). */
const PUBLISHED_STATE = 'info.publishedIds';
/** Rulings 116 and 118, once per rebuild that holds everything back until the Devices tab has been used. */
const NOT_ARMED = 'No devices selected yet — open the Devices tab and click Refresh detected devices, then pick devices and save';
/** Task 21b rule 5 and Ruling 116, once per rebuild that holds the apply back because nothing is picked. */
const NOTHING_SELECTED = 'No devices selected yet — pick devices in the adapter settings (Devices tab)';
/** Ruling 116, once per rebuild that holds the apply back although something is picked. */
const NOTHING_LISTED =
  'Nothing picked shows in a panel list: a scene needs none, and no entity could be made of the rest. ' +
  'Panels keep their last configuration until something is picked that does';
/** A failed discovery is retried after 5 s, 10 s, 20 s ... and at most every 5 minutes. */
const DISCOVERY_RETRY_FIRST_MS = 5_000;
const DISCOVERY_RETRY_MAX_MS = 300_000;

const I18N_DIR = path.join(__dirname, '..', 'admin', 'i18n');

/** One text of one admin translation file, or undefined. Only a language code names a file, never a path. */
function i18nText(language: string, key: string): string | undefined {
  if (!/^[a-z]{2}(-[a-z]{2,4})?$/i.test(language)) return undefined;
  try {
    const text: unknown = JSON.parse(readFileSync(path.join(I18N_DIR, `${language}.json`), 'utf8'))[key];
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A text from the admin's own translations (admin/i18n), in `language`, else
 * in English: what the adapter writes into the admin form is translated like
 * the form's labels (Ruling 117). The key itself when neither file has it.
 */
function adminText(key: string, language: string): string {
  return i18nText(language, key) ?? i18nText('en', key) ?? key;
}

/** The text in every language admin/i18n has: a mark written in one is taken off in all (Ruling 119, M4). */
function adminTexts(key: string): string[] {
  let files: string[] = [];
  try {
    files = readdirSync(I18N_DIR).filter((file) => file.endsWith('.json'));
  } catch {
    // No translations installed: no mark to take off.
  }
  return files.flatMap((file) => i18nText(file.slice(0, -'.json'.length), key) ?? []);
}

class HomeTiles extends utils.Adapter {
  private options!: AdapterOptions;
  private mqtt!: HomeTilesMqttClient;
  private registry!: EntityRegistry;
  private panels!: PanelManager;
  private panelObjects!: PanelObjects;
  private dispatcher!: Dispatcher;
  /** Panel history and energy read through it (Task 19): Task 22 answers history requests with it too. */
  private history!: HistoryProvider;
  /**
   * The energy meters (Task 20b): their catalog goes into every apply, and
   * Task 22 answers a panel's energy/request with energy.answer(deviceId, payload).
   */
  private energy!: EnergySource;
  private persistedIds: Record<string, string> = {};
  private rootAnchors: RootAnchors = {};
  /** What the registry is handed: the picked devices, then the manual entities (Task 21b). */
  private devices: DeviceInput[] = [];
  /** Every detected device, picked or not: previewEntity shows one before it is picked. */
  private detected: DeviceInput[] = [];
  /** Object id -> entity id of each entity the panels were given at the last rebuild, in this run or the last. */
  private published: Record<string, string> = {};
  /** Entity ids an earlier rebuild published and the registry holds no more; a new panel is told (Task 21b). */
  private unpublished: string[] = [];
  /** Until a discovery has succeeded in this run, panels get no configuration (Ruling 56). */
  private discovered = false;
  /** Set first on unload: from then on nothing is published (Ruling 62 B). */
  private unloading = false;
  private discoveryRetry: ioBroker.Timeout | undefined;

  constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: 'hometiles' });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('message', this.onMessage.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  private get log4(): Logger {
    return {
      info: (message) => this.log.info(message),
      warn: (message) => this.log.warn(message),
      error: (message) => this.log.error(message),
      debug: (message) => this.log.debug(message),
    };
  }

  private async onReady(): Promise<void> {
    const { options, errors, warnings } = validateOptions(this.config as unknown as Partial<AdapterOptions>);
    for (const error of errors) this.log.error(`[Config] ${error}`);
    for (const warning of warnings) this.log.warn(`[Config] ${warning}`);
    this.options = options;

    await this.setState('info.connection', false, true);
    this.persistedIds = await this.loadJsonMap(ENTITY_ID_STATE);
    this.rootAnchors = await this.loadJsonMap(ROOT_ANCHOR_STATE);
    // A hand-edited id that is no entity id would make its clear throw (Ruling 51).
    this.published = Object.fromEntries(
      Object.entries(await this.loadJsonMap(PUBLISHED_STATE)).filter(([, entityId]) => ENTITY_ID_RE.test(entityId)),
    );

    this.mqtt = new HomeTilesMqttClient(options, this.log4);
    this.history = new HistoryProvider(this, this.log4, options.historyInstance);
    this.energy = new EnergySource(this.history, this, this.log4);
    this.registry = new EntityRegistry(
      {
        onEntityChanged: (entity) => this.publishEntity(entity),
        onMembershipChanged: () => this.pushConfigToAllPanels(),
      },
      options.coalesceMs,
    );
    this.dispatcher = new Dispatcher(
      {
        byId: (entityId) => this.registry.byId(entityId),
        bySceneAlias: (alias) => this.registry.bySceneAlias(alias),
      },
      async (objectId, value) => {
        await this.setForeignStateAsync(objectId, value as ioBroker.StateValue, false);
      },
      this.log4,
    );
    this.panelObjects = new PanelObjects(
      {
        setObject: async (id, obj) => {
          await this.setObjectNotExistsAsync(id, obj as ioBroker.SettableObject);
        },
        deleteObject: async (id, recursive) => {
          await this.delObjectAsync(id, { recursive });
        },
        setState: async (id, value, ack) => {
          await this.setState(id, value as ioBroker.StateValue, ack);
        },
      },
      this.log4,
    );
    this.panels = new PanelManager({
      transport: {
        // Every panel publish passes here; none once the adapter stops.
        publish: (request) => {
          if (!this.unloading) this.mqtt.publish(request);
        },
        subscribe: (topic) => this.mqtt.subscribe(topic),
        unsubscribe: (topic) => this.mqtt.unsubscribe(topic),
      },
      dispatcher: this.dispatcher,
      log: this.log4,
      entities: () => this.panelEntities(),
      unpublished: () => this.unpublished,
      energy: () => this.energy.catalog(),
      onSessionsChanged: async () => {
        await this.syncPanelObjects();
      },
      onPanelRemoved: (deviceId) => this.panelObjects.remove(deviceId),
    });

    this.mqtt.onConnectionChange((connected) => {
      void this.setState('info.connection', connected, true);
      if (connected) void this.mqtt.subscribe(ANNOUNCE_TOPIC_PATTERN);
    });
    this.mqtt.onMessage((topic, payload, retain) => void this.onMqttMessage(topic, payload, retain));

    await this.discover();
    await this.subscribeStatesAsync('panels.*');

    // A broker that is down must not stop the adapter: the client reconnects.
    await this.mqtt.connect();
    this.log.info(
      this.discovered ? `[HomeTiles] Ready. ${this.tally}` : '[HomeTiles] Ready. Devices are published once a discovery succeeds',
    );
  }

  /** What detection found, what the user picked (Task 21b), and what the panels get. */
  private get tally(): string {
    return (
      `${this.detected.length} devices detected, ${this.devices.length} picked (manual entities included), ` +
      `${this.publishedCount} entities published`
    );
  }

  /** The entities the panels are given: none while the apply is held back (Ruling 116, Ruling 119 M7). */
  private get publishedCount(): number {
    const entities = this.registry.all();
    return listsAnyEntity(entities) ? entities.length : 0;
  }

  /**
   * What waits for the Devices tab beyond detection, so an upgraded
   * installation says why nothing shows (Ruling 118). Unarmed, every row is
   * an earlier version's, a 44d1111 or 4cbb6d3 Refresh's too (Ruling 120).
   */
  private waiting(manual: number): string {
    const earlier = this.options.deviceOverrides.filter((row) => row.objectId.trim()).length;
    const meters = this.options.energyMeters.length;
    const held = [
      manual ? `${manual} manual entities` : '',
      earlier ? `${earlier} device rows of an earlier version` : '',
      meters ? `${meters} energy meters` : '',
    ].filter(Boolean);
    return held.length ? `. Held back until then: ${held.join(', ')}` : '';
  }

  /**
   * One malformed object anywhere in the installation must not keep the
   * adapter from serving panels: v0.1 crash-looped right here, rejecting
   * onReady before MQTT ever connected (Ruling 51). A problem confined to one
   * object leaves out only that object, with a warning naming it
   * (Ruling 60(2)). What still fails here is systemic -- objects or states
   * that cannot be read or subscribed at all -- and it must not publish an
   * empty world either (Ruling 56): it is logged and retried with a bounded
   * backoff, and until a discovery succeeds no panel gets a configuration,
   * so each keeps its last one. The first success then proceeds as a normal
   * start would.
   */
  private async discover(attempt = 0): Promise<void> {
    try {
      await this.rebuildRegistry();
    } catch (error) {
      const delay = Math.min(DISCOVERY_RETRY_FIRST_MS * 2 ** attempt, DISCOVERY_RETRY_MAX_MS);
      this.log.error(
        `[Registry] Discovering devices failed: ${error instanceof Error ? error.message : String(error)}. ` +
          `Panels keep their last configuration; retrying in ${delay / 1000} s`,
      );
      this.log.debug(`[Registry] ${error instanceof Error ? error.stack : String(error)}`);
      this.discoveryRetry = this.setTimeout(() => void this.discover(attempt + 1), delay);
      return;
    }
    this.discovered = true;
    if (attempt > 0) {
      this.log.info(`[Registry] Discovery succeeded: ${this.tally}`);
    }
    // Panels that announced meanwhile got nothing; they get everything now.
    for (const session of this.panels.sessions()) this.pushEverything(session);
  }

  /**
   * The entities panels may be given: none until a discovery has succeeded
   * (Ruling 56), nor once the adapter stops, when the registry is emptied
   * (Ruling 62 B), nor while none of them lands in a list (Ruling 116):
   * nothing picked yet, or everything un-picked. An apply with every list
   * empty would make each panel drop its layout and save that. Null holds
   * back every push -- apply, icons, states and clears -- so each panel
   * keeps its last configuration, and the broker its retained one.
   */
  private panelEntities(): VirtualEntity[] | null {
    const entities = this.discovered && !this.unloading ? this.registry.all() : [];
    return listsAnyEntity(entities) ? entities : null;
  }

  private pushEverything(session: PanelSession): void {
    const entities = this.panelEntities();
    session.pushConfig(entities, true);
    for (const entity of entities ?? []) session.pushEntityState(entity);
    // A panel that announced while discovery kept failing is told here.
    if (entities) for (const entityId of this.unpublished) session.clearEntityState(entityId);
  }

  private async onUnload(callback: () => void): Promise<void> {
    try {
      // First: in compact mode the process lives on, and so would queued
      // history questions and their timers (Task 19 review I-2).
      this.history?.close();
      this.clearTimeout(this.discoveryRetry);
      // The newest values go out while every entity is still there. Then,
      // before anything is torn down, publishing stops: the registry is
      // emptied next, and a panel asking for its configuration meanwhile was
      // sent an empty one -- the firmware prunes every tile and saves that
      // (Ruling 62 B). Both are synchronous, so nothing runs in between.
      this.registry?.flush();
      this.unloading = true;
      this.registry?.dispose();
      await this.panels?.stopAll();
      await this.mqtt?.disconnect();
      await this.setState('info.connection', false, true);
    } catch (error) {
      this.log.warn(`[HomeTiles] Unload: ${(error as Error).message}`);
    } finally {
      callback();
    }
  }

  // ---- MQTT ----

  private async onMqttMessage(topic: string, payload: string, retain: boolean): Promise<void> {
    const announceDeviceId = deviceIdFromAnnounceTopic(topic);
    if (announceDeviceId) {
      try {
        await this.panels.handleAnnouncement(announceDeviceId, payload);
      } catch (error) {
        const code = error instanceof AnnounceError ? error.code : (error as Error).message;
        this.log.warn(`[Panel ${announceDeviceId}] Announcement failed: ${code}`);
      }
      return;
    }

    // The manager owns command routing; main only mirrors the panel's own
    // retained echoes into the object tree afterwards.
    await this.panels.handleMessage(topic, payload, retain);
    for (const session of this.panels.sessions()) {
      await this.mirrorPanelStat(session, topic, payload);
    }
  }

  /** Mirrors the panel's own retained echoes into the adapter object tree. */
  private async mirrorPanelStat(session: PanelSession, topic: string, payload: string): Promise<void> {
    const root = `panels.${session.deviceId}`;

    if (topic === stateTopic(session.baseTopic, 'connected')) {
      await this.setState(`${root}.info.connected`, session.online, true);
      return;
    }
    if (topic === stateTopic(session.baseTopic, 'ip')) {
      await this.setState(`${root}.info.ip`, session.ip, true);
      return;
    }
    for (const leaf of PANEL_SETTING_LEAVES) {
      if (topic === stateTopic(session.baseTopic, leaf)) {
        await this.panelObjects.applyPanelStat(session, leaf, payload);
        return;
      }
    }
    for (const channel of session.localIo) {
      if (topic === ioStateTopic(session.baseTopic, channel.id)) {
        await this.panelObjects.applyIoStat(session, channel.id, payload);
        return;
      }
    }
  }

  // ---- ioBroker state changes ----

  private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
    if (!state) {
      this.registry.applyStateChange(id, null);
      return;
    }

    if (id.startsWith(`${this.namespace}.panels.`)) {
      if (state.ack) return;
      await this.handlePanelWrite(id, state);
      return;
    }

    this.registry.applyStateChange(id, { val: state.val, ack: state.ack, q: state.q ?? 0, ts: state.ts });
  }

  private async handlePanelWrite(id: string, state: ioBroker.State): Promise<void> {
    const rest = id.slice(`${this.namespace}.panels.`.length);
    const separator = rest.indexOf('.');
    if (separator < 0) return;
    const deviceId = rest.slice(0, separator);
    const path = rest.slice(separator + 1);

    const session = this.panels.get(deviceId);
    if (!session) return;

    if (path === 'control.refresh') {
      this.pushEverything(session);
      await this.setState(id, false, true);
      return;
    }

    if (path === 'control.pair') {
      const host = session.ip;
      if (!host) {
        this.log.warn(`[Panel ${deviceId}] Pairing skipped: the panel has not reported an IP address`);
      } else {
        await pushCredentials(host, credentialsFromOptions(this.options), this.log4);
      }
      await this.setState(id, false, true);
      return;
    }

    this.panelObjects.handleControlWrite(session, path, state.val);
  }

  // ---- Registry ----

  private async rebuildRegistry(): Promise<void> {
    const { devices: detected, anchors, ignored, badRoles, objects } = await this.detectDevices();
    if (ignored.length > 0) {
      this.log.warn(
        `[Registry] Function enums left out, their members are not a list: ${ignored.join(', ')}. ` +
          'Devices typed only through them are published by their own roles until they are repaired',
      );
    }
    if (badRoles.length > 0) {
      this.log.warn(
        `[Registry] Objects left out, their role is not text: ${badRoles.join(', ')}. ` +
          'They are detected again once repaired',
      );
    }
    const manual = manualDevices(this.options.manualEntities, objects, this.namespace);
    if (manual.rejected.length > 0) {
      const rejected = manual.rejected.map(({ stateId, reason }) => `${stateId} (${reason})`);
      this.log.warn(`[Registry] Manual entities left out: ${listed(rejected)}`);
    }
    // Opt-in (Task 21b): a detected device reaches the registry only once the
    // user picks it. A manual entity is the user's pick already, and overrides
    // are for detected devices (Task 13b); after them, it never takes an id
    // one of them would be given. Until the Devices tab has been used, though,
    // nothing is: an earlier version's rows and hand-added manual entities
    // would give each panel a list of only those (Ruling 118).
    const armed = this.options.pickerArmed;
    this.detected = detected;
    this.devices = armed ? [...applyOverrides(detected, this.options.deviceOverrides), ...manual.devices] : [];
    this.rootAnchors = anchors;
    await this.saveJsonMap(ROOT_ANCHOR_STATE, 'Root anchors: the state each root id stays with', anchors);
    // Before the registry, whose membership change pushes the apply with their catalog.
    const energyIds = await this.configureEnergy(objects, armed);

    const result = this.registry.rebuild(this.devices, this.persistedIds);
    // Ruling 116: while no entity lands in a list, the panels are given
    // nothing (panelEntities), and the log says why instead.
    const holding = !listsAnyEntity(this.registry.all());
    if (!armed) this.log.info(`[Registry] ${NOT_ARMED}${this.waiting(manual.devices.length)}`);
    else if (holding) this.log.info(`[Registry] ${this.devices.length === 0 ? NOTHING_SELECTED : NOTHING_LISTED}`);
    if (result.skipped.length > 0) {
      const skipped = result.skipped.map(({ objectId, reason }) => `${objectId} (${reason})`);
      this.log.warn(`[Registry] Devices left out, no entity could be made of them: ${skipped.join(', ')}`);
    }
    // A detected device not picked keeps its stored id, so picking it again
    // gives the id back (Task 21b rule 6); so does a manual entity held back
    // until the Devices tab is used, renamed meanwhile or not (Ruling 120, N1).
    // Energy meters keep theirs under energy:<state id>, like manual entities, as long as they are set (Task 20b).
    this.persistedIds = { ...idsToStore(this.persistedIds, [...detected, ...manual.devices], result.entityIds), ...energyIds };
    await this.saveJsonMap(ENTITY_ID_STATE, 'Persisted entity ids', this.persistedIds);

    for (const objectId of result.unsubscribe) await this.unsubscribeForeignStatesAsync(objectId);
    for (const objectId of result.subscribe) await this.subscribeForeignStatesAsync(objectId);

    // Seed the registry with the values the sources already hold, so a panel
    // that connects later finds retained state rather than an empty dashboard.
    // A source whose value cannot be read -- js-controller refuses an alias
    // whose target id is malformed (adapter.js _getForeignState) -- stays
    // unavailable until it changes: one bad object must not hold back every
    // other (Ruling 60(2)). Left unread, it is asked for again should this
    // attempt fail later (RebuildResult.subscribe).
    const unread: string[] = [];
    for (const objectId of result.subscribe) {
      let state: ioBroker.State | null | undefined;
      try {
        state = await this.getForeignStateAsync(objectId);
      } catch (error) {
        unread.push(`${objectId} (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      this.registry.applyStateChange(
        objectId,
        state ? { val: state.val, ack: state.ack, q: state.q ?? 0, ts: state.ts } : null,
      );
    }
    if (unread.length > 0) {
      this.log.warn(`[Registry] Could not read the value of ${unread.join(', ')}; unavailable until it changes`);
    }
    this.registry.flush();

    // A manual number, select or datetime the panel cannot edit, and what its
    // object lacks: the tile alone would never say (Task 13b round 1, m2). A
    // datetime's case depends on its value, so this follows the seeding.
    const readOnly = manual.devices.flatMap((device) => {
      const why = this.registry.byId(result.entityIds[device.objectId] ?? '')?.readOnly;
      const [state] = Object.values(device.channels);
      return why === undefined || !state ? [] : [`${state.objectId} (${why})`];
    });
    if (readOnly.length > 0) this.log.warn(`[Registry] Manual entities shown read-only: ${listed(readOnly)}`);

    // Ruling 111: what no panel is given, once per rebuild rather than per panel.
    const { left } = splitEditables(this.registry.all());
    if (left.length > 0) {
      this.log.warn(
        `[Registry] ${left.length} numbers, selects and datetimes left off the panels: a panel keeps at most ` +
          `${MAX_EDITABLES}, taken by entity id (${listed(left.map((entity) => entity.entityId))}). ` +
          'Pick fewer on the Devices tab of the adapter settings to choose which',
      );
    }

    // What the panels were given before and are not now. Saving a selection
    // restarts the adapter, so the registry starts empty and its own removed
    // list never names an entity the user un-picked: the record of the last
    // rebuild, which outlives the restart, does (Task 21b rule 6). While the
    // apply is held back the panels are given nothing new and keep showing
    // what the record names: it stays, and nothing is cleared until an apply
    // goes out (Ruling 116).
    if (!holding) {
      const now = new Set(this.registry.all().map((entity) => entity.entityId));
      const gone = Object.values(this.published).filter((entityId) => !now.has(entityId));
      this.published = Object.fromEntries(Object.entries(result.entityIds).filter(([, entityId]) => now.has(entityId)));
      this.unpublished = [...new Set([...this.unpublished, ...gone])].filter((entityId) => !now.has(entityId));
      // Only a panel that was given a configuration is told an entity left it
      // (Ruling 56); one that announces later is told by its first push.
      if (this.discovered) {
        for (const entityId of gone) {
          for (const session of this.panels.sessions()) session.clearEntityState(entityId);
        }
      }
    }
    await this.saveJsonMap(PUBLISHED_STATE, 'Entity ids the panels were given', this.published);

    await this.setState('info.entities', this.publishedCount, true);
  }

  /**
   * The Energy tab's meters (Task 20b): what the energy source answers panels
   * with and lists in every apply, only while armed (Ruling 118), with each
   * category's total named in the system's language. One warning per rebuild
   * names the meters left out, and one those the history instance does not
   * log, whose tiles would show nothing. The meters' ids, to store.
   */
  private async configureEnergy(objects: Record<string, ioBroker.Object>, armed: boolean): Promise<Record<string, string>> {
    const rows = this.options.energyMeters;
    const instance = rows.length > 0 ? await this.history.instanceName().catch(() => '') : '';
    const { meters, ids, rejected, unlogged } = energyMeters(rows, objects, this.persistedIds, this.namespace, instance);
    if (rejected.length > 0) {
      this.log.warn(`[Energy] Meters left out: ${listed(rejected.map(({ stateId, reason }) => `${stateId} (${reason})`))}`);
    }
    if (meters.length > 0 && !instance) {
      this.log.warn('[Energy] No history instance is set on the Advanced tab and the system has no default one: energy tiles show no consumption');
    } else if (unlogged.length > 0) {
      this.log.warn(
        `[Energy] Not logged by ${instance}, so their energy tiles show no consumption: ${listed(unlogged)}. ` +
          `Enable ${instance} in the settings of each of these states`,
      );
    }
    const language = (await this.getForeignObjectAsync('system.config'))?.common?.language ?? 'en';
    const totals = Object.fromEntries(ENERGY_CATEGORIES.map((category) => [category, adminText(`energy_total_${category}`, language)])) as TotalNames;
    this.energy.configure({ armed, meters, currency: this.options.currency, totals });
    return ids;
  }

  /** The discovery, and the objects it read: the manual entities' states are among them. */
  private async detectDevices(): Promise<Discovery & { objects: Record<string, ioBroker.Object> }> {
    const objects = {
      ...(await this.objectsOfType('state')),
      ...(await this.objectsOfType('channel')),
      ...(await this.objectsOfType('device')),
      // The detector reads function enums from the same map (a lamp in "Licht").
      ...(await this.objectsOfType('enum', 'enum.functions.')),
    };
    return { ...discoverDevices(objects, this.namespace, this.rootAnchors), objects };
  }

  /**
   * Every object of one type, read through the object view. Not through
   * getForeignObjects: that also resolves each object's enums, which
   * discovery never uses and which throws on one hand-corrupted enum
   * (js-controller adapter.js _getForeignObjects), failing every discovery
   * (Ruling 58 D).
   */
  private async objectsOfType(
    type: 'state' | 'channel' | 'device' | 'enum',
    prefix?: string,
  ): Promise<Record<string, ioBroker.Object>> {
    const range = prefix ? { startkey: prefix, endkey: `${prefix}\u9999` } : {};
    const { rows } = await this.getObjectViewAsync('system', type, range);
    const objects: Record<string, ioBroker.Object> = {};
    for (const row of rows) if (row.value) objects[row.id] = row.value;
    return objects;
  }

  private publishEntity(entity: VirtualEntity): void {
    if (!this.discovered) return;
    for (const session of this.panels.sessions()) session.pushEntityState(entity);
  }

  private pushConfigToAllPanels(): void {
    for (const session of this.panels.sessions()) session.pushConfig(this.panelEntities());
  }

  private async syncPanelObjects(): Promise<void> {
    const sessions = this.panels.sessions();
    for (const session of sessions) {
      await this.panelObjects.sync(session);
    }
    // setSceneAliases REPLACES the registry's map, so it must be called once
    // with every panel's aliases merged in, not once per panel in the loop
    // above — the latter left only the last panel's aliases reachable.
    this.registry.setSceneAliases(mergeSceneAliases(sessions, this.log4));
    await this.setState('info.panels', sessions.length, true);
  }

  /**
   * A stored map is validated before use: it is a hand-editable state
   * (Ruling 51). A rejected value goes into the log, the only copy left once
   * the next save overwrites it (Ruling 58 C).
   */
  private async loadJsonMap(id: string): Promise<Record<string, string>> {
    const state = await this.getStateAsync(id);
    if (state?.val === null || state?.val === undefined) return {};
    const map = parseStringMap(state.val);
    if (!map) {
      const held = typeof state.val === 'string' ? state.val : JSON.stringify(state.val);
      this.log.warn(`[Registry] Stored ${id} is not a JSON object of strings, starting from scratch. It held: ${held}`);
    }
    return map ?? {};
  }

  private async saveJsonMap(id: string, name: string, map: Record<string, string>): Promise<void> {
    await this.setObjectNotExistsAsync(id, {
      type: 'state',
      common: { name, type: 'string', role: 'json', read: true, write: false, def: '{}' },
      native: {},
    } as ioBroker.SettableObject);
    await this.setState(id, JSON.stringify(map), true);
  }

  // ---- Admin messages ----

  /**
   * A failing admin request is answered with its error: thrown, it was an
   * unhandled rejection, and that stops the adapter (Ruling 58 E).
   */
  private async onMessage(message: ioBroker.Message): Promise<void> {
    const reply = (payload: unknown): void => {
      if (message.callback) this.sendTo(message.from, message.command, payload, message.callback);
    };
    try {
      await this.answer(message, reply);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log.error(`[Admin] ${message.command} failed: ${reason}`);
      reply({ error: reason });
    }
  }

  private async answer(message: ioBroker.Message, reply: (payload: unknown) => void): Promise<void> {
    switch (message.command) {
      case 'listDetected': {
        const { devices: detected } = await this.detectDevices();
        reply(
          detected.map((device) => ({
            objectId: device.objectId,
            name: device.name,
            detectorType: device.detectorType,
            domain: device.domain,
            entityId: this.persistedIds[device.objectId] ?? '',
            channels: Object.keys(device.channels).join(', '),
          })),
        );
        return;
      }

      case 'refreshDetected': {
        // The picker (Task 21b). The form's rows arrive with the request
        // (jsonData), unsaved choices included, and so does its marker: only
        // a form this picker armed holds ticks the user set here (Ruling 120).
        // The stored ones stand in should admin send none.
        const request = (message.message ?? {}) as { rows?: unknown; pickerArmed?: unknown };
        const sent = Array.isArray(request.rows);
        const armed = sent
          ? validateOptions({ pickerArmed: request.pickerArmed } as Partial<AdapterOptions>).options.pickerArmed
          : this.options.pickerArmed;
        // One by one, so a row validateOptions leaves out stays where it
        // stands, as it is: none may shift under the admin's cells (N4).
        const rows: unknown[] = sent
          ? (request.rows as unknown[]).map((row) => validateOptions({ deviceOverrides: [row] as DeviceOverride[] }).options.deviceOverrides[0] ?? row)
          : this.options.deviceOverrides;
        const { devices: detected, objects } = await this.detectDevices();
        const rooms = await this.objectsOfType('enum', 'enum.rooms.');
        const language = (await this.getForeignObjectAsync('system.config'))?.common?.language ?? 'en';
        const found = detectedRows(detected, { ...objects, ...rooms }, language);
        const deviceOverrides = mergeDetected(rows, found, { armed, mark: adminText('not_detected', language), marks: adminTexts('not_detected') });
        // admin writes each key of `native` into the form (useNative;
        // json-config ConfigSendto.js:253-257, ConfigGeneric.onChange), saves
        // every form key that has no field (JsonConfig.onSave, :489-497), and
        // shows the `result` text filled with `args`. pickerArmed is such a
        // key: saved with the picker's rows, it arms publishing (Ruling 118).
        return reply({
          native: { deviceOverrides, pickerArmed: PICKER_VERSION },
          result: 'refreshed',
          // The merge keeps every row and appends each new device.
          args: [String(found.length), String(deviceOverrides.length - rows.length)],
        });
      }

      case 'previewEntity': {
        const objectId = String((message.message as { objectId?: string })?.objectId ?? '');
        // A detected device can be previewed before it is picked.
        const device = [...this.devices, ...this.detected].find((candidate) => candidate.objectId === objectId);
        if (!device) return reply({ error: 'device_not_detected' });

        const entityId = this.persistedIds[objectId] ?? `${device.domain}.preview`;
        const values: Record<string, SourceValue | null> = {};
        for (const channel of Object.values(device.channels)) {
          const state = await this.getForeignStateAsync(channel.objectId);
          values[channel.objectId] = state
            ? { val: state.val, ack: state.ack, q: state.q ?? 0, ts: state.ts }
            : null;
        }
        const entity = synthesise(device, entityId, values);
        if (!entity) return reply({ error: 'no_usable_channel' });
        const publish = buildStatePublish(this.options.haPrefix, entity);
        return reply({ entity, publish: publish ?? { note: 'this domain publishes no state' } });
      }

      case 'testBroker': {
        const probe = new HomeTilesMqttClient(this.options, this.log4);
        await probe.connect();
        const connected = probe.connected;
        await probe.disconnect();
        return reply({ connected });
      }

      case 'pairPanel': {
        const host = String((message.message as { host?: string })?.host ?? '');
        const result = await pushCredentials(host, credentialsFromOptions(this.options), this.log4);
        return reply(result);
      }

      default:
        return reply({ error: `unknown_command_${message.command}` });
    }
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new HomeTiles(options);
} else {
  ((): HomeTiles => new HomeTiles())();
}
