import Aedes from 'aedes';
import { expect } from 'chai';
import mqtt, { type MqttClient } from 'mqtt';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { DEFAULTS } from '../../src/config/options';
import { CONTROL_SESSION, controlRevision } from '../../src/protocol/editable';
import type { IoBrokerObject } from '../../src/registry/detector';
import { EntityRegistry } from '../../src/registry/entity-registry';
import { manualDevices } from '../../src/registry/manual';
import type { DeviceInput } from '../../src/registry/types';
import { Dispatcher } from '../../src/runtime/dispatcher';
import { HomeTilesMqttClient } from '../../src/runtime/mqtt-client';
import { PanelManager } from '../../src/runtime/panel-manager';
import { ANNOUNCE_TOPIC_PATTERN, deviceIdFromAnnounceTopic } from '../../src/protocol/topics';

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

/**
 * Editable helpers in 0_userdata.0, as users keep them: no channel or device
 * above them, so only a manual entity reaches them (Task 13b), and no adapter
 * ever acks a value written to them (Ruling 100).
 */
const SOLL = '0_userdata.0.Heizung.Soll';
const MODUS = '0_userdata.0.Heizung.Modus';
const WECKZEIT = '0_userdata.0.Wecker.Zeit';
const USERDATA: Record<string, IoBrokerObject> = {
  '0_userdata.0.Heizung': { type: 'folder', common: { name: 'Heizung' } },
  [SOLL]: { type: 'state', common: { name: 'Soll', role: 'level', type: 'number', min: 15, max: 28, read: true, write: true } },
  [MODUS]: {
    type: 'state',
    common: { name: 'Modus', role: 'level.mode', type: 'number', states: { 0: 'Aus', 1: 'Eco', 2: 'Komfort' }, read: true, write: true },
  },
  '0_userdata.0.Wecker': { type: 'folder', common: { name: 'Wecker' } },
  [WECKZEIT]: { type: 'state', common: { name: 'Weckzeit', role: 'value.time', type: 'number', read: true, write: true } },
};
const HELPERS = manualDevices(
  [
    { stateId: SOLL, domain: 'number' },
    { stateId: MODUS, domain: 'select' },
    { stateId: WECKZEIT, domain: 'datetime' },
  ],
  USERDATA,
  'hometiles.0',
).devices;

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
  /** One the system hands out (Ruling 137): two runs at once never meet on it. */
  let port = 0;
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
  /** Every message the adapter's client received, with its retain flag. */
  let received: Array<{ topic: string; retain: boolean }>;
  const panelInbox = new Map<string, string>();

  beforeEach(async () => {
    broker = new Aedes();
    server = createServer(broker.handle);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;

    writes = [];
    received = [];
    adapterMqtt = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: port, coalesceMs: 0 }, silentLog);

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
        // What ioBroker does next: the write, ack false, comes back as a
        // change of the subscribed state, and main.ts:277 hands it to the
        // registry like any other.
        registry.applyStateChange(objectId, { val: value, ack: false, q: 0, ts: Date.now() });
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
      onPanelRemoved: async () => undefined,
    });

    adapterMqtt.onMessage((topic, payload, retain) => {
      received.push({ topic, retain });
      const deviceId = deviceIdFromAnnounceTopic(topic);
      if (deviceId) void manager.handleAnnouncement(deviceId, payload);
      else void manager.handleMessage(topic, payload, retain);
    });

    await adapterMqtt.connect();
    await adapterMqtt.subscribe(ANNOUNCE_TOPIC_PATTERN);

    registry.rebuild([PLUG, LAMP, ...HELPERS], {});
    registry.applyStateChange('shelly.0.plug.on', { val: false, ack: true, q: 0, ts: Date.now() });
    registry.applyStateChange('hue.0.decke.on', { val: true, ack: true, q: 0, ts: Date.now() });
    registry.applyStateChange('hue.0.decke.level', { val: 60, ack: true, q: 0, ts: Date.now() });

    panelInbox.clear();
    panelMqtt = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: 'fake-panel' });
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

    const late = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: 'late-panel' });
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

  describe('value commands (Task 15)', () => {
    const COMMAND = 'hometiles-e2e/cmnd/value';
    const ACK = 'hometiles-e2e/stat/value';
    let acks: Array<Record<string, unknown>>;
    let serial = 0;

    /** The payloads the broker keeps retained on a topic: what a panel subscribing later is replayed. */
    async function retainedOn(topic: string): Promise<string[]> {
      const kept: string[] = [];
      // aedes types its persistence as any; the memory store streams its retained packets.
      const stream = (broker as unknown as { persistence: { createRetainedStream(pattern: string): AsyncIterable<{ payload: Buffer }> } })
        .persistence.createRetainedStream(topic);
      for await (const packet of stream) kept.push(packet.payload.toString('utf8'));
      return kept;
    }

    /** The newest /control of an entity, as the panel holds it. */
    const control = (entityId: string): Record<string, unknown> | undefined => {
      const raw = panelInbox.get(`ha/e2e/${entityId.replace('.', '/')}/control`);
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    };

    /** A command as the panel sends it (value_control.cpp:293-312), from the /control it holds; its answer. */
    async function command(entityId: string, value: unknown): Promise<Record<string, unknown>> {
      const { session, revision } = await waitFor(() => control(entityId));
      serial += 1;
      const id = `1a2b3c4d-0002b1c8-${String(serial).padStart(8, '0')}`;
      const deadline = Math.floor(Date.now() / 1000) + 10;
      panelMqtt.publish(COMMAND, JSON.stringify({ entity_id: entityId, session, revision, value, id, deadline }));
      return waitFor(() => acks.find((ack) => ack.id === id));
    }

    /** The /control once it shows `state`: the panel confirms its command on it (value_control.cpp:320-335). */
    const shows = (entityId: string, state: string): Promise<Record<string, unknown>> =>
      waitFor(() => (control(entityId)?.state === state ? control(entityId) : undefined));

    beforeEach(async () => {
      acks = [];
      panelMqtt.on('message', (topic, payload) => {
        if (topic === ACK) acks.push(JSON.parse(payload.toString('utf8')) as Record<string, unknown>);
      });
      await new Promise<void>((resolve) => panelMqtt.subscribe(ACK, () => resolve()));
    });

    it('writes a 0_userdata number, answers ok, and the value it wrote comes back on /control (Ruling 100)', async () => {
      panelMqtt.publish('tab5_lvgl/config/e2e1/bridge', ANNOUNCE, { retain: true });
      const before = await waitFor(() => control('number.soll'));
      expect(before).to.include({ state: 'unknown', available: true, writable: true, min: 15, max: 28, step: 1 });

      const ack = await command('number.soll', 21);
      expect(ack).to.include({ entity_id: 'number.soll', status: 'ok' });
      expect(Object.keys(ack)).to.deep.equal(['entity_id', 'id', 'status']);
      expect(writes).to.deep.equal([[SOLL, 21]]);
      // Nothing acked the helper: the command's own change made the entity show it.
      const after = await shows('number.soll', '21');
      expect(after.revision, 'a value never moves the revision').to.equal(before.revision);

      // The next command carries the revision of that /control, and lands too.
      expect((await command('number.soll', 22)).status).to.equal('ok');
      await shows('number.soll', '22');
      expect(writes).to.deep.equal([
        [SOLL, 21],
        [SOLL, 22],
      ]);
      // The answers are gone once read; the /control stays for a panel that subscribes later.
      expect(await retainedOn(ACK)).to.deep.equal([]);
      expect((await retainedOn('ha/e2e/number/soll/control')).map((payload) => JSON.parse(payload).state)).to.deep.equal(['22']);
    });

    it('writes a select by the raw value behind its option, and a date as the local epoch milliseconds', async () => {
      panelMqtt.publish('tab5_lvgl/config/e2e1/bridge', ANNOUNCE, { retain: true });
      expect((await command('select.modus', 'Komfort')).status).to.equal('ok');
      await shows('select.modus', 'Komfort');
      expect((await command('datetime.weckzeit', '2026-09-24 08:15:00')).status).to.equal('ok');
      await shows('datetime.weckzeit', '2026-09-24 08:15:00');
      expect(writes).to.deep.equal([
        [MODUS, 2],
        [WECKZEIT, new Date(2026, 8, 24, 8, 15, 0).getTime()],
      ]);
    });

    it('answers a refused command, writes nothing, and publishes the /control again', async () => {
      panelMqtt.publish('tab5_lvgl/config/e2e1/bridge', ANNOUNCE, { retain: true });
      await waitFor(() => control('number.soll'));
      panelInbox.delete('ha/e2e/number/soll/control');
      expect((await command('select.modus', 'komfort')).status).to.equal('invalid_option');
      const { session, revision } = await waitFor(() => control('select.modus'));
      panelMqtt.publish(COMMAND, JSON.stringify({ entity_id: 'number.soll', session, revision, value: 21, id: 'stale-revision', deadline: Math.floor(Date.now() / 1000) + 10 }));
      const answer = await waitFor(() => acks.find((ack) => ack.id === 'stale-revision'));
      expect(answer.status).to.equal('changed');
      // Re-published after the refusal, as the Bridge does after every command.
      await waitFor(() => control('number.soll'));
      expect(writes).to.deep.equal([]);
    });

    it('ignores a retained command, which every new subscription replays', async () => {
      // Retained before the panel's session subscribes, so the broker replays it.
      const soll = registry.byId('number.soll')!;
      const stale = {
        entity_id: 'number.soll',
        session: CONTROL_SESSION,
        revision: controlRevision(soll, CONTROL_SESSION),
        value: 27,
        id: 'retained-00000001',
        deadline: Math.floor(Date.now() / 1000) + 10,
      };
      await new Promise<void>((resolve) => panelMqtt.publish(COMMAND, JSON.stringify(stale), { retain: true }, () => resolve()));
      panelMqtt.publish('tab5_lvgl/config/e2e1/bridge', ANNOUNCE, { retain: true });
      await waitFor(() => (received.some((message) => message.topic === COMMAND && message.retain) ? true : undefined));
      // A live command after it is answered, so the retained one was handled first.
      expect((await command('number.soll', 22)).status).to.equal('ok');
      expect(acks.map((ack) => ack.id)).to.not.include(stale.id);
      expect(writes).to.deep.equal([[SOLL, 22]]);
    });
  });

  it('after a restart: the retained announcement starts the session, retained presence is read, and no retained command runs (Ruling 101)', async () => {
    // The adapter goes down ...
    await manager.stopAll();
    await adapterMqtt.disconnect();
    // ... while the broker keeps what the panel retained, and a command on
    // every leaf that some client published retained.
    const soll = registry.byId('number.soll')!;
    const value = {
      entity_id: 'number.soll',
      session: CONTROL_SESSION,
      revision: controlRevision(soll, CONTROL_SESSION),
      value: 27,
      id: 'retained-00000002',
      deadline: Math.floor(Date.now() / 1000) + 10,
    };
    const retained: Array<[string, string]> = [
      ['tab5_lvgl/config/e2e1/bridge', ANNOUNCE],
      ['hometiles-e2e/stat/connected', 'online'],
      ['hometiles-e2e/stat/ip', '192.168.1.40'],
      ['hometiles-e2e/cmnd/switch', '{"entity_id":"switch.kaffee","state":"on"}'],
      ['hometiles-e2e/cmnd/light', '{"entity_id":"light.decke","state":"off"}'],
      ['hometiles-e2e/cmnd/scene', 'gute nacht'],
      ['hometiles-e2e/cmnd/climate', '{"entity_id":"light.decke","command":"set_hvac_mode","hvac_mode":"heat"}'],
      ['hometiles-e2e/cmnd/cover', '{"entity_id":"light.decke","command":"open_cover"}'],
      ['hometiles-e2e/cmnd/media', '{"entity_id":"light.decke","command":"next"}'],
      ['hometiles-e2e/cmnd/value', JSON.stringify(value)],
    ];
    for (const [topic, payload] of retained) {
      await new Promise<void>((resolve) => panelMqtt.publish(topic, payload, { retain: true }, () => resolve()));
    }

    // The adapter comes back: a new client and manager, as a new process has.
    const warnings: string[] = [];
    const log = { ...silentLog, warn: (message: string): void => void warnings.push(message) };
    const dispatcher = new Dispatcher(
      { byId: (id) => registry.byId(id), bySceneAlias: (alias) => registry.bySceneAlias(alias) },
      async (objectId, written) => {
        writes.push([objectId, written]);
      },
      log,
    );
    adapterMqtt = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: port, coalesceMs: 0 }, log);
    manager = new PanelManager({
      transport: {
        publish: (request) => adapterMqtt.publish(request),
        subscribe: (topic) => adapterMqtt.subscribe(topic),
        unsubscribe: (topic) => adapterMqtt.unsubscribe(topic),
      },
      dispatcher,
      log,
      entities: () => registry.all(),
      onSessionsChanged: async () => undefined,
      onPanelRemoved: async () => undefined,
    });
    adapterMqtt.onMessage((topic, payload, retain) => {
      const deviceId = deviceIdFromAnnounceTopic(topic);
      if (deviceId) void manager.handleAnnouncement(deviceId, payload);
      else void manager.handleMessage(topic, payload, retain);
    });
    await adapterMqtt.connect();
    await adapterMqtt.subscribe(ANNOUNCE_TOPIC_PATTERN);

    const session = await waitFor(() => manager.get('e2e1'));
    // Presence and IP are subscribed after every command leaf, so every
    // retained command was replayed before them.
    await waitFor(() => (session.online && session.ip === '192.168.1.40' ? true : undefined));
    // A live command after them runs: the retained ones, replayed first, did not.
    panelMqtt.publish('hometiles-e2e/cmnd/switch', '{"entity_id":"switch.kaffee","state":"off"}');
    await waitFor(() => (writes.length ? true : undefined));
    expect(writes).to.deep.equal([['shelly.0.plug.on', false]]);
    expect(warnings).to.deep.equal([]);
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
