import * as utils from '@iobroker/adapter-core';
import { validateOptions, type AdapterOptions, type DeviceOverride } from './config/options';
import { AnnounceError } from './protocol/announce';
import { buildStatePublish } from './protocol/state-payload';
import {
  ANNOUNCE_TOPIC_PATTERN,
  deviceIdFromAnnounceTopic,
  ioStateTopic,
  PANEL_SETTING_LEAVES,
  stateTopic,
} from './protocol/topics';
import { discoverDevices, type Discovery, type RootAnchors } from './registry/detector';
import { parseStringMap } from './registry/entity-id';
import { EntityRegistry } from './registry/entity-registry';
import { applyOverrides } from './registry/overrides';
import { synthesise } from './registry/synth/index';
import type { DeviceInput, SourceValue, VirtualEntity } from './registry/types';
import { Dispatcher } from './runtime/dispatcher';
import { HomeTilesMqttClient, type Logger } from './runtime/mqtt-client';
import { PanelManager } from './runtime/panel-manager';
import { PanelObjects } from './runtime/panel-objects';
import type { PanelSession } from './runtime/panel-session';
import { credentialsFromOptions, pushCredentials } from './runtime/pairing';
import { mergeSceneAliases } from './runtime/scene-aliases';

const ENTITY_ID_STATE = 'info.entityIds';
const ROOT_ANCHOR_STATE = 'info.rootAnchors';
/** A failed discovery is retried after 5 s, 10 s, 20 s ... and at most every 5 minutes. */
const DISCOVERY_RETRY_FIRST_MS = 5_000;
const DISCOVERY_RETRY_MAX_MS = 300_000;

class HomeTiles extends utils.Adapter {
  private options!: AdapterOptions;
  private mqtt!: HomeTilesMqttClient;
  private registry!: EntityRegistry;
  private panels!: PanelManager;
  private panelObjects!: PanelObjects;
  private dispatcher!: Dispatcher;
  private persistedIds: Record<string, string> = {};
  private rootAnchors: RootAnchors = {};
  private devices: DeviceInput[] = [];
  /** Until a discovery has succeeded in this run, panels get no configuration (Ruling 56). */
  private discovered = false;
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

    this.mqtt = new HomeTilesMqttClient(options, this.log4);
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
        publish: (request) => this.mqtt.publish(request),
        subscribe: (topic) => this.mqtt.subscribe(topic),
        unsubscribe: (topic) => this.mqtt.unsubscribe(topic),
      },
      dispatcher: this.dispatcher,
      log: this.log4,
      entities: () => this.panelEntities(),
      onSessionsChanged: async () => {
        await this.syncPanelObjects();
      },
      onPanelRemoved: (deviceId) => this.panelObjects.remove(deviceId),
    });

    this.mqtt.onConnectionChange((connected) => {
      void this.setState('info.connection', connected, true);
      if (connected) void this.mqtt.subscribe(ANNOUNCE_TOPIC_PATTERN);
    });
    this.mqtt.onMessage((topic, payload) => void this.onMqttMessage(topic, payload));

    await this.discover();
    await this.subscribeStatesAsync('panels.*');

    // A broker that is down must not stop the adapter: the client reconnects.
    await this.mqtt.connect();
    this.log.info(
      this.discovered
        ? `[HomeTiles] Ready. ${this.devices.length} devices detected, ${this.registry.all().length} entities published`
        : '[HomeTiles] Ready. Devices are published once a discovery succeeds',
    );
  }

  /**
   * One malformed object anywhere in the installation must not keep the
   * adapter from serving panels: v0.1 crash-looped right here, rejecting
   * onReady before MQTT ever connected (Ruling 51). Nor may a failure publish
   * an empty world (Ruling 56): it is logged and retried with a bounded
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
      this.log.info(
        `[Registry] Discovery succeeded: ${this.devices.length} devices detected, ${this.registry.all().length} entities published`,
      );
    }
    // Panels that announced meanwhile got nothing; they get everything now.
    for (const session of this.panels.sessions()) this.pushEverything(session);
  }

  /** The entities panels may be given: none until a discovery has succeeded (Ruling 56). */
  private panelEntities(): VirtualEntity[] | null {
    return this.discovered ? this.registry.all() : null;
  }

  private pushEverything(session: PanelSession): void {
    const entities = this.panelEntities();
    session.pushConfig(entities, true);
    for (const entity of entities ?? []) session.pushEntityState(entity);
  }

  private async onUnload(callback: () => void): Promise<void> {
    try {
      this.clearTimeout(this.discoveryRetry);
      this.registry?.flush();
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

  private async onMqttMessage(topic: string, payload: string): Promise<void> {
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
    await this.panels.handleMessage(topic, payload);
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
    const { devices: detected, anchors, ignored } = await this.detectDevices();
    if (ignored.length > 0) {
      this.log.warn(
        `[Registry] Function enums left out, their members are not a list: ${ignored.join(', ')}. ` +
          'Devices typed only through them are published by their own roles until they are repaired',
      );
    }
    this.devices = applyOverrides(detected, (this.options.deviceOverrides ?? []) as DeviceOverride[]);
    this.rootAnchors = anchors;
    await this.saveJsonMap(ROOT_ANCHOR_STATE, 'Root anchors: the state each root id stays with', anchors);

    const result = this.registry.rebuild(this.devices, this.persistedIds);
    this.persistedIds = result.entityIds;
    await this.saveJsonMap(ENTITY_ID_STATE, 'Persisted entity ids', result.entityIds);

    for (const objectId of result.unsubscribe) await this.unsubscribeForeignStatesAsync(objectId);
    for (const objectId of result.subscribe) await this.subscribeForeignStatesAsync(objectId);

    // Seed the registry with the values the sources already hold, so a panel
    // that connects later finds retained state rather than an empty dashboard.
    for (const objectId of result.subscribe) {
      const state = await this.getForeignStateAsync(objectId);
      this.registry.applyStateChange(
        objectId,
        state ? { val: state.val, ack: state.ack, q: state.q ?? 0, ts: state.ts } : null,
      );
    }
    this.registry.flush();

    for (const entityId of result.removed) {
      for (const session of this.panels.sessions()) session.clearEntityState(entityId);
    }

    await this.setState('info.entities', this.registry.all().length, true);
  }

  private async detectDevices(): Promise<Discovery> {
    const objects = {
      ...(await this.objectsOfType('state')),
      ...(await this.objectsOfType('channel')),
      ...(await this.objectsOfType('device')),
      // The detector reads function enums from the same map (a lamp in "Licht").
      ...(await this.objectsOfType('enum', 'enum.functions.')),
    };
    return discoverDevices(objects, this.namespace, this.rootAnchors);
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

      case 'previewEntity': {
        const objectId = String((message.message as { objectId?: string })?.objectId ?? '');
        const device = this.devices.find((candidate) => candidate.objectId === objectId);
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
