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
import { discoverDevices } from './registry/detector';
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

class HomeTiles extends utils.Adapter {
  private options!: AdapterOptions;
  private mqtt!: HomeTilesMqttClient;
  private registry!: EntityRegistry;
  private panels!: PanelManager;
  private panelObjects!: PanelObjects;
  private dispatcher!: Dispatcher;
  private persistedIds: Record<string, string> = {};
  private devices: DeviceInput[] = [];

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
    const { options, errors } = validateOptions(this.config as unknown as Partial<AdapterOptions>);
    for (const error of errors) this.log.error(`[Config] ${error}`);
    this.options = options;

    await this.setState('info.connection', false, true);
    this.persistedIds = await this.loadPersistedIds();

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
      entities: () => this.registry.all(),
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

    await this.rebuildRegistry();
    await this.subscribeStatesAsync('panels.*');

    // A broker that is down must not stop the adapter: the client reconnects.
    await this.mqtt.connect();
    this.log.info(
      `[HomeTiles] Ready. ${this.devices.length} devices detected, ${this.registry.all().length} entities published`,
    );
  }

  private async onUnload(callback: () => void): Promise<void> {
    try {
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
      session.pushConfig(this.registry.all(), true);
      for (const entity of this.registry.all()) session.pushEntityState(entity);
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
    const detected = await this.detectDevices();
    this.devices = applyOverrides(detected, (this.options.deviceOverrides ?? []) as DeviceOverride[]);

    const result = this.registry.rebuild(this.devices, this.persistedIds);
    this.persistedIds = result.entityIds;
    await this.savePersistedIds(result.entityIds);

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

  private async detectDevices(): Promise<DeviceInput[]> {
    const objects = (await this.getForeignObjectsAsync('*', 'state')) as Record<string, ioBroker.Object>;
    const channels = (await this.getForeignObjectsAsync('*', 'channel')) as Record<string, ioBroker.Object>;
    const devices = (await this.getForeignObjectsAsync('*', 'device')) as Record<string, ioBroker.Object>;
    return discoverDevices({ ...objects, ...channels, ...devices }, this.namespace);
  }

  private publishEntity(entity: VirtualEntity): void {
    for (const session of this.panels.sessions()) session.pushEntityState(entity);
  }

  private pushConfigToAllPanels(): void {
    for (const session of this.panels.sessions()) session.pushConfig(this.registry.all());
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

  private async loadPersistedIds(): Promise<Record<string, string>> {
    const state = await this.getStateAsync(ENTITY_ID_STATE);
    if (!state || typeof state.val !== 'string') return {};
    try {
      return JSON.parse(state.val) as Record<string, string>;
    } catch {
      this.log.warn('[Registry] Stored entity id map is corrupt, starting from scratch');
      return {};
    }
  }

  private async savePersistedIds(map: Record<string, string>): Promise<void> {
    await this.setObjectNotExistsAsync(ENTITY_ID_STATE, {
      type: 'state',
      common: { name: 'Persisted entity ids', type: 'string', role: 'json', read: true, write: false, def: '{}' },
      native: {},
    } as ioBroker.SettableObject);
    await this.setState(ENTITY_ID_STATE, JSON.stringify(map), true);
  }

  // ---- Admin messages ----

  private async onMessage(message: ioBroker.Message): Promise<void> {
    const reply = (payload: unknown): void => {
      if (message.callback) this.sendTo(message.from, message.command, payload, message.callback);
    };

    switch (message.command) {
      case 'listDetected': {
        const detected = await this.detectDevices();
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
