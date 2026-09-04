import Aedes from 'aedes';
import { expect } from 'chai';
import mqtt, { type MqttClient } from 'mqtt';
import { createServer, type Server } from 'node:net';
import { DEFAULTS } from '../../src/config/options';
import { EntityRegistry } from '../../src/registry/entity-registry';
import type { DeviceInput } from '../../src/registry/types';
import { Dispatcher } from '../../src/runtime/dispatcher';
import { HomeTilesMqttClient } from '../../src/runtime/mqtt-client';
import { PanelManager } from '../../src/runtime/panel-manager';
import { ANNOUNCE_TOPIC_PATTERN, deviceIdFromAnnounceTopic } from '../../src/protocol/topics';

const PORT = 18841;
const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

const PLUG: DeviceInput = {
  objectId: 'shelly.0.plug',
  name: 'Kaffee',
  detectorType: 'socket',
  domain: 'switch',
  channels: { set: { objectId: 'shelly.0.plug.on', type: 'boolean', write: true } },
};

const LAMP: DeviceInput = {
  objectId: 'hue.0.decke',
  name: 'Decke',
  detectorType: 'dimmer',
  domain: 'light',
  channels: {
    set: { objectId: 'hue.0.decke.on', type: 'boolean', write: true },
    dimmer: { objectId: 'hue.0.decke.level', type: 'number', min: 0, max: 100, write: true },
  },
};

const ANNOUNCE = JSON.stringify({
  device_id: 'e2e1',
  base_topic: 'hometiles-e2e',
  ha_prefix: 'ha/e2e',
  device_name: 'E2E Panel',
  model: 'waveshare_touch_lcd_8',
  sensors: [],
  binary_sensors: [],
  scene_map: {},
  local_io: [],
});

function waitFor<T>(predicate: () => T | undefined, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      const value = predicate();
      if (value !== undefined) return resolve(value);
      if (Date.now() > deadline) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('integration round trip', function () {
  this.timeout(20000);

  // aedes 0.51.3 ships Aedes as a class, not a callable factory, so
  // ReturnType<typeof Aedes> does not compile (TS2344). The class IS the type.
  let broker: Aedes;
  let server: Server;
  let adapterMqtt: HomeTilesMqttClient;
  let panelMqtt: MqttClient;
  // Tracked out here so afterEach can close it even when a test throws. Closing
  // it only on the success path means a failing assertion leaves a connection
  // open, and aedes' server.close() then waits for it forever — the suite hangs
  // instead of reporting the very regression the test exists to catch.
  let lateMqtt: MqttClient | null = null;
  let registry: EntityRegistry;
  let manager: PanelManager;
  let writes: Array<[string, unknown]>;
  const panelInbox = new Map<string, string>();

  beforeEach(async () => {
    broker = new Aedes();
    server = createServer(broker.handle);
    await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));

    writes = [];
    adapterMqtt = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: PORT, coalesceMs: 0 }, silentLog);

    registry = new EntityRegistry(
      {
        onEntityChanged: (entity) => {
          for (const session of manager.sessions()) session.pushEntityState(entity);
        },
        onMembershipChanged: () => {
          for (const session of manager.sessions()) session.pushConfig(registry.all());
        },
      },
      0,
    );

    const dispatcher = new Dispatcher(
      { byId: (id) => registry.byId(id), bySceneAlias: (alias) => registry.bySceneAlias(alias) },
      async (objectId, value) => {
        writes.push([objectId, value]);
      },
      silentLog,
    );

    manager = new PanelManager({
      transport: {
        publish: (request) => adapterMqtt.publish(request),
        subscribe: (topic) => adapterMqtt.subscribe(topic),
        unsubscribe: (topic) => adapterMqtt.unsubscribe(topic),
      },
      dispatcher,
      log: silentLog,
      entities: () => registry.all(),
      onSessionsChanged: async () => undefined,
    });

    adapterMqtt.onMessage((topic, payload) => {
      const deviceId = deviceIdFromAnnounceTopic(topic);
      if (deviceId) void manager.handleAnnouncement(deviceId, payload);
      else void manager.handleMessage(topic, payload);
    });

    await adapterMqtt.connect();
    await adapterMqtt.subscribe(ANNOUNCE_TOPIC_PATTERN);

    registry.rebuild([PLUG, LAMP], {});
    registry.applyStateChange('shelly.0.plug.on', { val: false, ack: true, q: 0, ts: Date.now() });
    registry.applyStateChange('hue.0.decke.on', { val: true, ack: true, q: 0, ts: Date.now() });
    registry.applyStateChange('hue.0.decke.level', { val: 60, ack: true, q: 0, ts: Date.now() });

    panelInbox.clear();
    panelMqtt = mqtt.connect(`mqtt://127.0.0.1:${PORT}`, { clientId: 'fake-panel' });
    await new Promise<void>((resolve) => panelMqtt.once('connect', () => resolve()));
    panelMqtt.on('message', (topic, payload) => panelInbox.set(topic, payload.toString('utf8')));
    await new Promise<void>((resolve) => {
      panelMqtt.subscribe(['tab5_lvgl/config/e2e1/bridge/apply', 'ha/e2e/#'], () => resolve());
    });
  });

  afterEach(async () => {
    await manager.stopAll();
    registry.dispose();
    await adapterMqtt.disconnect();
    await new Promise<void>((resolve) => panelMqtt.end(true, {}, () => resolve()));
    if (lateMqtt) {
      const late = lateMqtt;
      lateMqtt = null;
      await new Promise<void>((resolve) => late.end(true, {}, () => resolve()));
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  });

  it('answers an announcement with a configuration push and the current state', async () => {
    panelMqtt.publish('tab5_lvgl/config/e2e1/bridge', ANNOUNCE, { retain: true });

    const apply = await waitFor(() => panelInbox.get('tab5_lvgl/config/e2e1/bridge/apply'));
    const parsed = JSON.parse(apply);
    expect(parsed.switches).to.deep.equal(['switch.kaffee']);
    expect(parsed.lights).to.deep.equal(['light.decke']);

    const switchState = await waitFor(() => panelInbox.get('ha/e2e/switch/kaffee/state'));
    expect(switchState, 'a switch must arrive as a bare string').to.equal('off');

    const lightState = await waitFor(() => panelInbox.get('ha/e2e/light/decke/state'));
    const lightPayload = JSON.parse(lightState);
    expect(lightPayload.state).to.equal('on');
    expect(lightPayload.brightness_pct).to.equal(60);
  });

  it('turns a panel command into an ioBroker write', async () => {
    panelMqtt.publish('tab5_lvgl/config/e2e1/bridge', ANNOUNCE, { retain: true });
    await waitFor(() => panelInbox.get('tab5_lvgl/config/e2e1/bridge/apply'));

    panelMqtt.publish('hometiles-e2e/cmnd/switch', '{"entity_id":"switch.kaffee","state":"on"}');
    await waitFor(() => (writes.length ? writes : undefined));
    expect(writes).to.deep.equal([['shelly.0.plug.on', true]]);
  });

  it('propagates a later ioBroker change to the panel', async () => {
    panelMqtt.publish('tab5_lvgl/config/e2e1/bridge', ANNOUNCE, { retain: true });
    await waitFor(() => panelInbox.get('ha/e2e/light/decke/state'));

    registry.applyStateChange('hue.0.decke.level', { val: 20, ack: true, q: 0, ts: Date.now() });

    const updated = await waitFor(() => {
      const raw = panelInbox.get('ha/e2e/light/decke/state');
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as { brightness_pct?: number };
      return parsed.brightness_pct === 20 ? parsed : undefined;
    });
    expect(updated.brightness_pct).to.equal(20);
  });

  it('delivers retained state to a panel that connects afterwards', async () => {
    panelMqtt.publish('tab5_lvgl/config/e2e1/bridge', ANNOUNCE, { retain: true });
    await waitFor(() => panelInbox.get('ha/e2e/switch/kaffee/state'));

    const late = mqtt.connect(`mqtt://127.0.0.1:${PORT}`, { clientId: 'late-panel' });
    lateMqtt = late;
    await new Promise<void>((resolve) => late.once('connect', () => resolve()));
    const lateInbox = new Map<string, string>();
    late.on('message', (topic, payload) => lateInbox.set(topic, payload.toString('utf8')));
    await new Promise<void>((resolve) => late.subscribe('ha/e2e/#', () => resolve()));

    const retained = await waitFor(() => lateInbox.get('ha/e2e/switch/kaffee/state'));
    expect(retained).to.equal('off');
    // No close here on purpose — afterEach owns it, so a failing assertion
    // above still releases the connection instead of wedging the broker.
  });

  it('ignores a malformed announcement without creating a session', async () => {
    // Waiting for something NOT to happen cannot be polled, so instead publish
    // a valid announcement afterwards and wait for THAT session to appear. MQTT
    // delivers in order on one connection, so once the good one has been
    // handled the bad one certainly has been too — deterministic, and no fixed
    // sleep to tune.
    panelMqtt.publish('tab5_lvgl/config/bad1/bridge', '{"local_io":[{"id":""}]}', { retain: false });
    panelMqtt.publish('tab5_lvgl/config/good1/bridge', ANNOUNCE.replace('e2e1', 'good1'), { retain: false });

    await waitFor(() => manager.get('good1'));
    expect(manager.get('bad1'), 'a malformed announcement must not create a session').to.equal(undefined);
  });
});
