import * as utils from '@iobroker/adapter-core';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AES_PREFIX,
  declaresEncryptedPassword,
  outdatedAdmins,
  PICKER_VERSION,
  storedInPlainText,
  storedPassword,
  validateOptions,
  type AdapterOptions,
  type DeviceOverride,
} from './config/options';
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
  sensorTopic,
  stateTopic,
} from './protocol/topics';
import { discoverDevices, type Discovery, type RootAnchors } from './registry/detector';
import { idsToStore, parseStringMap, resolveEntityIds } from './registry/entity-id';
import { EntityRegistry } from './registry/entity-registry';
import { listed, manualDevices } from './registry/manual';
import { applyClimateModes, applyOverrides, detectedRows, mergeDetected, unbuiltForces, unbuiltPicks } from './registry/overrides';
import { lacks, synthesise } from './registry/synth/index';
import type { DeviceInput, SourceValue, VirtualEntity } from './registry/types';
import { Dispatcher } from './runtime/dispatcher';
import { energyMeters, EnergySource, unloggedWarning, type EnergyNames, type TotalNames } from './runtime/energy-source';
import { HistoryProvider } from './runtime/history-provider';
import { HomeTilesMqttClient, probeBroker, type Logger } from './runtime/mqtt-client';
import { PanelManager } from './runtime/panel-manager';
import { PanelObjects } from './runtime/panel-objects';
import type { PanelSession } from './runtime/panel-session';
import { credentialsFromOptions, pushCredentials, type PairingResult } from './runtime/pairing';
import { mergeSceneAliases } from './runtime/scene-aliases';
import { connectSources, SOURCE_CALL_MS, UNANSWERED, within } from './runtime/sources';

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
/** What the Connection tab's Test broker sends as typed (Ruling 140): the fields a broker connection is made of. */
const BROKER_FIELDS = ['brokerHost', 'brokerPort', 'brokerTls', 'brokerUser', 'brokerPassword', 'clientId'] as const;
/** How long Test broker waits at most (Ruling 143): past mqtt.js's own 10 s connect timeout, for what that never ends. */
const TEST_BROKER_DEADLINE_MS = 12_000;
/** Ruling 144, once per start that finds a broker password nothing may use. */
const PASSWORD_UNREADABLE =
  'The broker password could not be decrypted, so the adapter connects to no broker and pairs no panel. ' +
  'Passwords are stored encrypted since 0.2.0: enter it again on the Connection tab and save';
/** Final review I-5, once per start whose instance does not list the broker password in encryptedNative. */
const UNDECLARED =
  'The installation is incomplete: this instance does not declare the broker password as encrypted, so it is left ' +
  'stored as it is. Run "iobroker upload hometiles", then restart the adapter';
/** Ruling 149, once per start that finds a password to migrate beside an admin older than 6.2.3. */
const OUTDATED_ADMIN = (admins: readonly string[]): string =>
  `An ioBroker admin older than 6.2.3 is installed (${admins.join(', ')}). It stores passwords in a form the adapter cannot ` +
  'tell from the plain text of 0.1, so the broker password is left as stored and not migrated. Update admin to 6.2.3 or ' +
  'newer; if the broker refuses the password meanwhile, enter it again on the Connection tab and save';

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

/** A payload as the admin's preview shows it (Task 23): a JSON object as one, anything else as the text it is. */
function readable(payload: string): unknown {
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed !== null && typeof parsed === 'object' ? parsed : payload;
  } catch {
    return payload;
  }
}

class HomeTiles extends utils.Adapter {
  private options!: AdapterOptions;
  private mqtt!: HomeTilesMqttClient;
  private registry!: EntityRegistry;
  private panels!: PanelManager;
  private panelObjects!: PanelObjects;
  private dispatcher!: Dispatcher;
  /** Panel history and energy read through it (Task 19): what a panel's history request is answered from (Task 22). */
  private history!: HistoryProvider;
  /** The energy meters (Task 20b): their catalog goes into every apply, and a panel's energy request is answered from them (Task 22). */
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
  /** The stored broker password decrypts to nothing usable: no connection, no pairing (Ruling 144). */
  private passwordUnreadable = false;

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
    // Never a password that could not be decrypted (Ruling 144). One 0.1 stored in plain text is used as
    // stored and stored encrypted, once; storing it restarts the adapter (js-controller), which then finds it
    // encrypted. Neither is ever logged. Beside an admin older than 6.2.3 a value without the AES prefix may
    // be that admin's own encryption, so nothing is migrated (Ruling 149): js-controller's globalDependencies
    // check does not run on a URL install or upgrade.
    const instance = `system.adapter.${this.namespace}`;
    const object = await this.getForeignObjectAsync(instance);
    const stored: unknown = object?.native?.brokerPassword;
    const encrypt = (value: string): string => this.encrypt(value);
    // js-controller decrypts only what the instance lists in encryptedNative (final review I-5): otherwise a
    // value stored encrypted arrives as stored, and the adapter decrypts it itself. Nothing is migrated then.
    const declared = declaresEncryptedPassword(object);
    if (!declared) {
      this.log.error(`[Config] ${UNDECLARED}`);
      if (typeof stored === 'string' && stored.startsWith(AES_PREFIX)) {
        try {
          options.brokerPassword = this.decrypt(stored);
        } catch {
          // Left as stored: storedPassword refuses it, as one js-controller could not decrypt.
        }
      }
    }
    const outdated = storedInPlainText(stored, encrypt) ? outdatedAdmins(await this.objectsOfType('instance', 'system.adapter.admin.')) : [];
    if (outdated.length > 0) this.log.error(`[Config] ${OUTDATED_ADMIN(outdated)}`);
    const password = storedPassword(stored, options.brokerPassword, encrypt, outdated.length === 0 && declared);
    this.passwordUnreadable = !password;
    options.brokerPassword = password?.password ?? '';
    if (!password) this.log.error(`[Config] ${PASSWORD_UNREADABLE}`);
    else if (password.store !== undefined) {
      try {
        await this.extendForeignObjectAsync(instance, { native: { brokerPassword: password.store } });
        this.log.info('[Config] The broker password was stored unencrypted by an earlier version; it is stored encrypted now');
      } catch (error) {
        this.log.warn(`[Config] The broker password, stored unencrypted by an earlier version, could not be stored encrypted: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Stopped meanwhile: unload has run, and anything made from here on would outlive it (with
    // common.compact, the process does too), a client reconnecting for a stopped instance.
    if (this.unloading) return;
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
      requests: {
        history: this.history,
        stateOf: (entityId, objectId, row) => this.registry.stateOf(entityId, objectId, row),
        energy: this.energy,
      },
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
    if (this.unloading) return;
    // Bounded like the sources' calls (Ruling 150): the start goes on without it.
    if ((await within(this.subscribeStatesAsync('panels.*'), SOURCE_CALL_MS)) === UNANSWERED) {
      this.log.warn(
        `[HomeTiles] js-controller gave no answer within ${SOURCE_CALL_MS / 1000} s to subscribing ${this.namespace}.panels.*. ` +
          'Carried on without it: writes to the panels\' states may go unnoticed until the adapter restarts',
      );
    }

    // A broker that is down must not stop the adapter: the client reconnects. With a password that could
    // not be decrypted it connects to none: the broker would only refuse it, every 2 s (Ruling 144).
    if (this.unloading) return;
    if (!this.passwordUnreadable) await this.mqtt.connect();
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
    return this.hasContent(entities) ? entities.length : 0;
  }

  /**
   * Whether an apply is worth a panel's layout (Ruling 116): an entity lands
   * in a list, or an energy meter is set once armed (Ruling 131). Every
   * held-back check asks this one, so the log, info.entities and the clears
   * agree with what goes out (Ruling 119 M7).
   */
  private hasContent(entities: readonly VirtualEntity[]): boolean {
    return listsAnyEntity(entities) || this.energy.content();
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
      // Stopping: what failed is the stop's doing, and a retry would outlive it.
      if (this.unloading) return;
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
   * (Ruling 62 B), nor while none of them lands in a list and no energy
   * meter is set (Rulings 116, 131): nothing picked yet, or everything
   * un-picked. An apply with every list empty would make each panel drop its
   * layout and save that. Null holds back every push -- apply, icons, states
   * and clears -- so each panel keeps its last configuration, and the broker
   * its retained one. Meters alone are an explicit pick: their apply goes
   * out, its entity lists empty.
   */
  private panelEntities(): VirtualEntity[] | null {
    if (!this.discovered || this.unloading) return null;
    const entities = this.registry.all();
    return this.hasContent(entities) ? entities : null;
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
    // Stopping, nothing a panel sends is acted on: the history provider is
    // closed, or was made after unload began (Task 19 re-review observation 3),
    // the registry is emptied, and no answer would go out (Ruling 62 B).
    if (this.unloading) return;
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
    if (topic === sensorTopic(session.baseTopic, 'soc_pct')) {
      await this.panelObjects.applyBattery(session, payload);
      return;
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
        await this.pair(host);
      }
      await this.setState(id, false, true);
      return;
    }

    this.panelObjects.handleControlWrite(session, path, state.val);
  }

  /**
   * Sends a panel the credentials the adapter itself uses, as the Panels tab's button and a panel's
   * control.pair ask for it, and only while the adapter is connected with them: never a password that could
   * not be decrypted (Ruling 144) or one the broker refuses (Ruling 149).
   */
  private async pair(host: string): Promise<PairingResult> {
    if (this.passwordUnreadable) {
      this.log.warn('[Pairing] Nothing sent: the broker password could not be decrypted. Enter it again on the Connection tab and save');
      return { ok: false, reason: 'password_unreadable' };
    }
    if (!this.mqtt?.connected) {
      this.log.warn(`[Pairing] Nothing sent to ${host}: the adapter is not connected to the broker, so its credentials are not known to work`);
      return { ok: false, reason: 'broker_not_connected' };
    }
    return pushCredentials(host, credentialsFromOptions(this.options), this.log4);
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
    const picked = armed ? applyOverrides(detected, this.options.deviceOverrides) : [];
    // A picked thermostat's own modes under the panel's names, as the Climate modes table maps them (Ruling 141).
    const climate = applyClimateModes(picked, armed ? this.options.climateModes : []);
    if (climate.rejected.length > 0) {
      const named = climate.rejected.map(({ row, reason }) => `${row.device}: ${row.deviceMode} as ${row.panelMode} (${reason})`);
      this.log.warn(`[Registry] Climate modes left out: ${listed(named)}`);
    }
    this.devices = armed ? [...climate.devices, ...manual.devices] : [];
    // A forced type the device cannot serve stays no entity, as Task 13 pinned; the log names each such
    // override and what the device lacks, by the synths' own test, as the admin's preview does (Ruling 139).
    const unbuilt = unbuiltForces(detected, picked);
    if (unbuilt.length > 0) {
      const named = unbuilt.map(({ objectId, domain, lack }) => `${domain} on ${objectId} (${adminText(`lack_${lack}`, 'en')})`);
      this.log.warn(`[Registry] Forced types that produced no tile: ${listed(named)}. Choose Auto or another type for them on the Devices tab`);
    }
    // A picked device whose own detected type makes no entity, such as a media player whose play state
    // discovery set aside, is no tile either, and would otherwise be named nowhere (T9).
    const unbuiltPicked = unbuiltPicks(detected, picked);
    if (unbuiltPicked.length > 0) {
      const named = unbuiltPicked.map(({ objectId, domain, lack }) => `${domain} on ${objectId} (${adminText(`lack_${lack}`, 'en')})`);
      this.log.warn(`[Registry] Picked devices that produced no tile: ${listed(named)}`);
    }
    this.rootAnchors = anchors;
    await this.saveJsonMap(ROOT_ANCHOR_STATE, 'Root anchors: the state each root id stays with', anchors);
    // Before the registry, whose membership change pushes the apply with their catalog.
    const energyIds = await this.configureEnergy(objects, armed);

    const result = this.registry.rebuild(this.devices, this.persistedIds);
    // Ruling 116: while no entity lands in a list and no meter is set
    // (Ruling 131), the panels are given nothing (panelEntities), and the log
    // says why instead.
    const holding = !this.hasContent(this.registry.all());
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

    await connectSources(
      result,
      objects,
      {
        subscribe: (objectId) => this.subscribeForeignStatesAsync(objectId),
        unsubscribe: (objectId) => this.unsubscribeForeignStatesAsync(objectId),
        read: (objectId) => this.getForeignStateAsync(objectId),
      },
      (objectId, value) => this.registry.applyStateChange(objectId, value),
      this.log,
    );
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
   * category's total and the house's consumption named in the system's
   * language (Rulings 124, 132). One warning per rebuild
   * names the meters left out, and one those the history instance does not
   * log, whose tiles would show nothing. The meters' ids, to store.
   */
  private async configureEnergy(objects: Record<string, ioBroker.Object>, armed: boolean): Promise<Record<string, string>> {
    const rows = this.options.energyMeters;
    const instance = rows.length > 0 ? await this.history.instanceName().catch(() => '') : '';
    const { meters, ids, rejected, unlogged, unloggedElectric } = energyMeters(rows, objects, this.persistedIds, this.namespace, instance);
    if (rejected.length > 0) {
      this.log.warn(`[Energy] Meters left out: ${listed(rejected.map(({ stateId, reason }) => `${stateId} (${reason})`))}`);
    }
    if (meters.length > 0 && !instance) {
      this.log.warn('[Energy] No history instance is set on the Advanced tab and the system has no default one: energy tiles show no consumption');
    } else if (unlogged.length > 0) {
      const untracked = meters.some((meter) => meter.category === 'device');
      this.log.warn(`[Energy] ${unloggedWarning(instance, unlogged, unloggedElectric, untracked)}`);
    }
    const language = (await this.getForeignObjectAsync('system.config'))?.common?.language ?? 'en';
    const names: EnergyNames = {
      totals: Object.fromEntries(ENERGY_CATEGORIES.map((category) => [category, adminText(`energy_total_${category}`, language)])) as TotalNames,
      consumption: adminText('energy_consumption_total', language),
      untracked: adminText('energy_consumption_untracked', language),
    };
    this.energy.configure({ armed, meters, currency: this.options.currency, names });
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
    type: 'state' | 'channel' | 'device' | 'enum' | 'instance',
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
        // A row of the Detected devices table, as its button sends it
        // (jsonConfig _preview): the device as detected with the row's type
        // and name, among the form's other rows and its Climate modes, unsaved
        // ones included -- what the panels get once the form is saved with the
        // row ticked. A script may send the object id alone: the saved rows
        // and modes stand in for the form's.
        const request = (message.message ?? {}) as { objectId?: unknown; forcedDomain?: unknown; name?: unknown; rows?: unknown; climateModes?: unknown };
        const text = (value: unknown): string => (typeof value === 'string' ? value : '');
        const objectId = text(request.objectId);
        const detected = this.detected.find((candidate) => candidate.objectId === objectId);
        if (!detected) return reply({ error: 'device_not_detected' });
        // As a start takes them (validateOptions).
        const form = validateOptions({
          deviceOverrides: Array.isArray(request.rows) ? request.rows : this.options.deviceOverrides,
          climateModes: Array.isArray(request.climateModes) ? request.climateModes : this.options.climateModes,
        } as Partial<AdapterOptions>).options;
        const row = { objectId, include: true, detectedDomain: detected.domain, forcedDomain: text(request.forcedDomain), name: text(request.name) };
        // Every device the save picks, in detection order, as the rebuild picks them; this row last, so that
        // it is the one its device takes (applyOverrides keys rows by object id).
        const picked = applyClimateModes(applyOverrides(this.detected, [...form.deviceOverrides, row]), form.climateModes).devices;
        const device = picked.find((candidate) => candidate.objectId === objectId)!;
        const language = (await this.getForeignObjectAsync('system.config'))?.common?.language ?? 'en';
        // What the device lacks for the type chosen, by the synths' own test: the rebuild's warning names the same (Ruling 139).
        const lack = lacks(device);
        if (lack) return reply({ error: 'no_usable_channel', args: [adminText(`lack_${lack}`, language)] });

        // The id the rebuild gives it, resolved over every device the save picks, as the registry resolves them:
        // of two new ones of one name the earlier takes the plain slug (review m1). The manual entities come after
        // them and take no id of theirs (resolveEntityIds reserves every stored id first).
        const entityId = resolveEntityIds(picked, this.persistedIds)[objectId]!;
        const values: Record<string, SourceValue | null> = {};
        for (const channel of Object.values(device.channels)) {
          // A value js-controller will not read -- an alias whose target id is malformed -- is none, as the
          // rebuild's seed takes it: the entity shows unavailable, never an error (review m1 b).
          const state = await this.getForeignStateAsync(channel.objectId).catch(() => null);
          values[channel.objectId] = state
            ? { val: state.val, ack: state.ack, q: state.q ?? 0, ts: state.ts }
            : null;
        }
        // None where lacks names nothing: the synths return null by that same test (Ruling 139).
        const entity = synthesise(device, entityId, values);
        if (!entity) return reply({ error: 'no_usable_channel', args: [''] });
        const built = buildStatePublish(this.options.haPrefix, entity);
        // What goes on the wire, never the internal degraded flag (Task 14 re-review N1): a note says what it means.
        const publish = built && { topic: built.topic, payload: built.payload, retain: built.retain };
        const note = !built ? adminText('preview_no_state', language) : built.degraded ? adminText('preview_degraded', language) : undefined;
        const shown = {
          entity_id: entity.entityId,
          ...(publish ? { topic: publish.topic, retain: publish.retain, payload: readable(publish.payload) } : {}),
          ...(note ? { note } : {}),
        };
        // json-config's sendTo opens a copyDialog: its title, translated, over its text in an editor
        // (ConfigSendto.renderCopyDialog, json-config 8.1.10 on); anything else it answers with "Ok" alone.
        return reply({
          entity,
          publish,
          ...(note ? { note } : {}),
          copyDialog: { title: 'column_preview', type: 'json', text: JSON.stringify(shown, null, 2) },
        });
      }

      case 'testBroker': {
        // The Connection tab as typed, unsaved fields included (jsonConfig _testBroker, Ruling 140); a
        // field a script leaves out is the saved one. Validated as a start validates them: of these
        // fields, validateOptions refuses only a port.
        const typed = typeof message.message === 'object' && message.message !== null ? (message.message as Record<string, unknown>) : {};
        const raw = Object.fromEntries(BROKER_FIELDS.map((key) => [key, key in typed ? typed[key] : this.options[key]]));
        const { options, errors } = validateOptions(raw as Partial<AdapterOptions>);
        if (errors.length > 0) return reply({ connected: false, error: 'invalid_port' });
        const broker = `${options.brokerHost}:${options.brokerPort}`;
        // What goes wrong is this test's answer, not the adapter's trouble: to the reply, and to debug.
        const quiet: Logger = {
          info: (text) => this.log.debug(text),
          warn: (text) => this.log.debug(text),
          error: (text) => this.log.debug(text),
          debug: (text) => this.log.debug(text),
        };
        const { connected, error, timedOut } = await probeBroker(options, quiet, TEST_BROKER_DEADLINE_MS);
        // Never a password: the broker, and what it or the network said.
        this.log.info(`[Admin] Broker test of ${broker}: ${connected ? 'connected' : `no connection, ${error ?? 'no answer'}`}`);
        // Each answer as admin shows it (json-config ConfigSendto): a result text, the native branch
        // taken so that no raw code follows it, or an error text; never "Ok" alone.
        if (connected) return reply({ connected, result: 'connected', args: [broker], native: {} });
        // mqtt.js gives up after the connect timeout, 10 s (mqtt-client.ts), with this error; the deadline ends what
        // it retries for ever without one, a broker that hangs up on each connection (Ruling 143).
        if (timedOut || error === 'connack timeout') return reply({ connected, error: 'timeout', args: [broker] });
        return reply({ connected, error: 'failed', args: [broker, error ?? ''] });
      }

      case 'pairPanel': {
        // The Panels tab's address field (jsonConfig _pairHost, Ruling 140); the credentials the
        // Connection tab saved, which the adapter itself uses.
        const request = typeof message.message === 'object' && message.message !== null ? (message.message as { host?: unknown }) : {};
        const host = typeof request.host === 'string' ? request.host.trim() : '';
        const result = await this.pair(host);
        // As admin shows it: a result text, or the failure's own text with the address and any HTTP status.
        return reply(
          result.ok
            ? { ...result, result: 'paired', args: [host], native: {} }
            : { ...result, error: result.reason, args: [host, String(result.status ?? '')] },
        );
      }

      case 'climateDevices': {
        // The Climate modes table's device column (jsonConfig climateModes, Ruling 141), a selectSendTo: its
        // options as [{label, value}] (json-config ConfigSelectSendTo). Every thermostat detected or picked as
        // one, under the name it is picked with.
        const picked = new Map(this.devices.map((device) => [device.objectId, device]));
        const thermostats = this.detected.map((device) => picked.get(device.objectId) ?? device).filter((device) => device.domain === 'climate');
        return reply(thermostats.map((device) => ({ label: `${device.name} (${device.objectId})`, value: device.objectId })));
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
