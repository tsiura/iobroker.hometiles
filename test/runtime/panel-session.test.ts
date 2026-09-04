import { expect } from 'chai';
import { parseAnnouncement } from '../../src/protocol/announce';
import type { PublishRequest } from '../../src/runtime/mqtt-client';
import { Dispatcher } from '../../src/runtime/dispatcher';
import { PanelSession, type PanelTransport } from '../../src/runtime/panel-session';
import type { VirtualEntity } from '../../src/registry/types';

const ANNOUNCE = JSON.stringify({
  device_id: 'a1',
  base_topic: 'hometiles',
  ha_prefix: 'ha/statestream',
  device_name: 'Panel',
  model: 'waveshare_touch_lcd_8',
  sensors: [],
  binary_sensors: [],
  scene_map: { 'gute nacht': 'scene.nacht' },
  local_io: [{ id: 'relay_1', entity_id: 'switch.p_relay_1', name: 'Relay 1', type: 'relay' }],
});

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

function entity(over: Partial<VirtualEntity>): VirtualEntity {
  return {
    entityId: 'sensor.t',
    domain: 'sensor',
    source: {},
    state: '21',
    attributes: { friendly_name: 'T' },
    available: true,
    lastChanged: 1_757_000_000_000,
    ...over,
  };
}

function harness() {
  const published: PublishRequest[] = [];
  const subscribed: string[] = [];
  const transport: PanelTransport = {
    publish: (request) => published.push(request),
    subscribe: async (topic) => {
      subscribed.push(topic);
    },
    unsubscribe: async () => undefined,
  };
  const writes: Array<[string, unknown]> = [];
  const registryEntities = new Map<string, VirtualEntity>();
  const dispatcher = new Dispatcher(
    {
      byId: (id) => registryEntities.get(id),
      bySceneAlias: (alias) => (alias === 'gute nacht' ? registryEntities.get('scene.nacht') : undefined),
    },
    async (objectId, value) => {
      writes.push([objectId, value]);
    },
    silentLog,
  );
  const session = new PanelSession(parseAnnouncement('a1', ANNOUNCE), transport, dispatcher, silentLog);
  return { session, published, subscribed, writes, registryEntities };
}

describe('runtime/panel-session', () => {
  it('subscribes to every topic the panel talks on', async () => {
    const { session, subscribed } = harness();
    await session.start();
    expect(subscribed).to.include('hometiles/cmnd/light');
    expect(subscribed).to.include('hometiles/cmnd/switch');
    expect(subscribed).to.include('hometiles/cmnd/scene');
    expect(subscribed).to.include('hometiles/stat/connected');
    expect(subscribed).to.include('hometiles/stat/ip');
    expect(subscribed).to.include('tab5_lvgl/config/a1/bridge/request');
  });

  it('does not subscribe to the domains v0.1 does not implement', async () => {
    const { session, subscribed } = harness();
    await session.start();
    expect(subscribed).to.not.include('hometiles/cmnd/climate');
    expect(subscribed).to.not.include('hometiles/cmnd/cover');
    expect(subscribed).to.not.include('hometiles/cmnd/media');
    expect(subscribed).to.not.include('hometiles/cmnd/camera');
  });

  it('publishes the configuration retained to the apply topic', () => {
    const { session, published } = harness();
    expect(session.pushConfig([entity({})])).to.equal(true);
    const apply = published.find((p) => p.topic === 'tab5_lvgl/config/a1/bridge/apply');
    expect(apply).to.not.equal(undefined);
    expect(apply!.retain).to.equal(true);
    expect(JSON.parse(apply!.payload).sensors).to.deep.equal(['sensor.t']);
  });

  it('does not re-push an unchanged configuration', () => {
    const { session, published } = harness();
    const entities = [entity({})];
    expect(session.pushConfig(entities)).to.equal(true);
    published.length = 0;
    expect(session.pushConfig(entities)).to.equal(false);
    expect(published).to.have.length(0);
  });

  it('re-pushes an unchanged configuration when forced', () => {
    const { session, published } = harness();
    const entities = [entity({})];
    session.pushConfig(entities);
    published.length = 0;
    expect(session.pushConfig(entities, true)).to.equal(true);
    expect(published.some((p) => p.topic === 'tab5_lvgl/config/a1/bridge/apply')).to.equal(true);
  });

  it('re-pushes when the configuration actually changed', () => {
    const { session, published } = harness();
    session.pushConfig([entity({})]);
    published.length = 0;
    expect(session.pushConfig([entity({}), entity({ entityId: 'sensor.u' })])).to.equal(true);
    expect(published).to.have.length(1);
  });

  it('honours a forced bridge/request from the panel', async () => {
    const { session, published } = harness();
    await session.start();
    session.pushConfig([entity({})]);
    published.length = 0;
    await session.handleMessage('tab5_lvgl/config/a1/bridge/request', 'force');
    expect(published.some((p) => p.topic === 'tab5_lvgl/config/a1/bridge/apply')).to.equal(true);
  });

  it('publishes a sensor state retained as a bare string', () => {
    const { session, published } = harness();
    session.pushEntityState(entity({ entityId: 'sensor.t', state: '21.5' }));
    expect(published[0]).to.deep.equal({
      topic: 'ha/statestream/sensor/t/state',
      payload: '21.5',
      retain: true,
    });
  });

  it('publishes nothing for a scene entity', () => {
    const { session, published } = harness();
    session.pushEntityState(entity({ entityId: 'scene.nacht', domain: 'scene' }));
    expect(published).to.have.length(0);
  });

  it('clears a removed entity with an empty retained payload', () => {
    const { session, published } = harness();
    session.clearEntityState('sensor.gone');
    expect(published[0]).to.deep.equal({
      topic: 'ha/statestream/sensor/gone/state',
      payload: '',
      retain: true,
    });
  });

  it('routes a switch command to the dispatcher', async () => {
    const { session, writes, registryEntities } = harness();
    registryEntities.set(
      'switch.k',
      entity({ entityId: 'switch.k', domain: 'switch', state: 'off', source: { set: 'shelly.0.on' } }),
    );
    await session.start();
    await session.handleMessage('hometiles/cmnd/switch', '{"entity_id":"switch.k","state":"on"}');
    expect(writes).to.deep.equal([['shelly.0.on', true]]);
  });

  it('routes a plain-text scene command to the dispatcher', async () => {
    const { session, writes, registryEntities } = harness();
    registryEntities.set(
      'scene.nacht',
      entity({ entityId: 'scene.nacht', domain: 'scene', source: { set: 'scene.0.nacht' } }),
    );
    await session.start();
    await session.handleMessage('hometiles/cmnd/scene', 'Gute Nacht');
    expect(writes).to.deep.equal([['scene.0.nacht', true]]);
  });

  it('swallows a malformed command without throwing into the MQTT handler', async () => {
    const { session, writes } = harness();
    await session.start();
    await session.handleMessage('hometiles/cmnd/switch', 'not json');
    expect(writes).to.have.length(0);
  });

  it('tracks panel presence and IP from the retained stat topics', async () => {
    const { session } = harness();
    await session.start();
    await session.handleMessage('hometiles/stat/connected', 'online');
    expect(session.online).to.equal(true);
    await session.handleMessage('hometiles/stat/ip', '192.168.1.40');
    expect(session.ip).to.equal('192.168.1.40');
    await session.handleMessage('hometiles/stat/connected', 'offline');
    expect(session.online).to.equal(false);
  });

  it('exposes the local I/O channels the panel announced', () => {
    const { session } = harness();
    expect(session.localIo.map((channel) => channel.id)).to.deep.equal(['relay_1']);
  });
});
