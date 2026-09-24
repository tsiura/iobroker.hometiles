import { expect } from 'chai';
import { parseAnnouncement } from '../../src/protocol/announce';
import { CONTROL_SESSION, controlRevision } from '../../src/protocol/editable';
import { buildWeatherPayload } from '../../src/protocol/weather';
import type { PublishRequest } from '../../src/runtime/mqtt-client';
import { Dispatcher } from '../../src/runtime/dispatcher';
import { PanelSession, type PanelTransport } from '../../src/runtime/panel-session';
import { synthMediaPlayer } from '../../src/registry/synth/media_player';
import type { DeviceInput, VirtualEntity } from '../../src/registry/types';

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

function harness(now: () => number = Date.now) {
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
  const warnings: string[] = [];
  const capturingLog = { ...silentLog, warn: (message: string): void => void warnings.push(message) };
  const session = new PanelSession(parseAnnouncement('a1', ANNOUNCE), transport, dispatcher, capturingLog, now);
  return { session, published, subscribed, writes, registryEntities, warnings };
}

describe('runtime/panel-session', () => {
  it('subscribes to every topic the panel talks on', async () => {
    const { session, subscribed } = harness();
    await session.start();
    expect(subscribed).to.include('hometiles/cmnd/light');
    expect(subscribed).to.include('hometiles/cmnd/switch');
    expect(subscribed).to.include('hometiles/cmnd/scene');
    expect(subscribed).to.include('hometiles/cmnd/climate');
    // One leaf for number, select and datetime (value_control.cpp:311), not their domains (Ruling 16).
    expect(subscribed).to.include('hometiles/cmnd/value');
    for (const domain of ['number', 'select', 'datetime']) expect(subscribed).to.not.include(`hometiles/cmnd/${domain}`);
    expect(subscribed).to.include('hometiles/stat/connected');
    expect(subscribed).to.include('hometiles/stat/ip');
    expect(subscribed).to.include('tab5_lvgl/config/a1/bridge/request');
  });

  it('does not subscribe to domains this adapter does not implement yet', async () => {
    // climate (Task 5), cover (Task 8) and media (Task 10) moved out of this
    // list once they gained real commands; camera still has no ServiceCall
    // kinds at all (dispatcher.ts's ALLOWED_CALLS), so subscribing would only
    // let malformed/unhandled traffic reach the session for nothing.
    const { session, subscribed } = harness();
    await session.start();
    expect(subscribed).to.not.include('hometiles/cmnd/camera');
  });

  it('subscribes to cmnd/media and routes a real media command to the dispatcher (Task 10)', async () => {
    // The leaf is the firmware's MEDIA_CMND descriptor, "media"
    // (mqtt_topics.cpp:12) -- not the domain name, media_player.
    const { session, subscribed, writes, registryEntities, warnings } = harness();
    const device: DeviceInput = {
      objectId: 'sonos.0.root.tv',
      name: 'TV',
      detectorType: 'media',
      domain: 'media_player',
      channels: {
        state: { objectId: 'sonos.0.root.tv.state_simple', type: 'boolean', write: true },
        next: { objectId: 'sonos.0.root.tv.next', type: 'boolean', write: true },
      },
    };
    const player = synthMediaPlayer(device, 'media_player.tv', {
      'sonos.0.root.tv.state_simple': { val: true, ack: true, q: 0, ts: 1 },
    });
    registryEntities.set('media_player.tv', player!);
    await session.start();
    expect(subscribed).to.include('hometiles/cmnd/media');
    expect(subscribed).to.not.include('hometiles/cmnd/media_player');

    expect(await session.handleMessage('hometiles/cmnd/media', '{"entity_id":"media_player.tv","command":"next"}', false)).to.equal(true);
    expect(writes).to.deep.equal([['sonos.0.root.tv.next', true]]);

    // Nothing answers the panel, so a refusal lives in the log, with its reason.
    await session.handleMessage('hometiles/cmnd/media', '{"entity_id":"media_player.tv","command":"previous"}', false);
    expect(writes).to.have.length(1);
    expect(warnings).to.deep.equal(['[Panel a1] Command on media rejected: no_writable_channel']);
  });

  it('subscribes to cmnd/cover and routes a real cover command to the dispatcher (Task 8)', async () => {
    // The leaf is the firmware's COVER_CMND descriptor, "cover"
    // (mqtt_topics.cpp:14), not the domain name by coincidence.
    const { session, subscribed, writes, registryEntities } = harness();
    registryEntities.set(
      'cover.blind',
      entity({
        entityId: 'cover.blind',
        domain: 'cover',
        state: 'open',
        source: { set: 'zig.0.blind.level' },
        writable: { position: true },
        channelMeta: { set: { type: 'number' } },
      }),
    );
    await session.start();
    expect(subscribed).to.include('hometiles/cmnd/cover');
    await session.handleMessage(
      'hometiles/cmnd/cover',
      '{"entity_id":"cover.blind","command":"set_cover_position","position":30}',
      false,
    );
    expect(writes).to.deep.equal([['zig.0.blind.level', 30]]);
  });

  it('publishes no configuration while the entity list is not known yet (Ruling 56)', () => {
    // A retained apply with every list empty makes the firmware prune every
    // tile binding and save that to flash; the panel keeps its last one.
    const { session, published } = harness();
    expect(session.pushConfig(null, true)).to.equal(false);
    expect(published).to.deep.equal([]);
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

  it('honours a forced bridge/request through the wired refresh handler', async () => {
    // The manager owns the live registry, so the session delegates rather than
    // replaying a cached list — a forced refresh must carry CURRENT state.
    const { session, published } = harness();
    await session.start();
    session.pushConfig([entity({})]);
    published.length = 0;

    let forcedWith: boolean | null = null;
    session.onRefreshRequested = (forced): void => {
      forcedWith = forced;
      session.pushConfig([entity({}), entity({ entityId: 'sensor.fresh' })], true);
    };

    await session.handleMessage('tab5_lvgl/config/a1/bridge/request', 'force', false);
    expect(forcedWith).to.equal(true);
    const apply = published.find((p) => p.topic === 'tab5_lvgl/config/a1/bridge/apply');
    expect(apply).to.not.equal(undefined);
    // The republished config is the handler's current list, not a cached one.
    expect(JSON.parse(apply!.payload).sensors).to.deep.equal(['sensor.fresh', 'sensor.t']);
  });

  it('warns instead of silently doing nothing when no refresh handler is wired', async () => {
    const { session, published, warnings } = harness();
    await session.start();
    session.pushConfig([entity({})]);
    published.length = 0;
    await session.handleMessage('tab5_lvgl/config/a1/bridge/request', 'force', false);
    expect(published).to.have.length(0);
    expect(warnings.some((w) => w.includes('no handler is wired'))).to.equal(true);
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

  describe('an editable value (Task 14)', () => {
    const soll = entity({ entityId: 'number.soll', domain: 'number', state: '21.5', attributes: { min: 15, max: 28, step: 0.5 }, writable: { value: true } });
    // 64 options of 255 quotes: each quote is 2 bytes on the wire (\"), 33 kB in all.
    const options = Array.from({ length: 64 }, (_, index) => `${'"'.repeat(253)}${String(index).padStart(2, '0')}`);
    const huge = (entityId: string): VirtualEntity => entity({ entityId, domain: 'select', state: 'x', attributes: { options }, writable: { value: true } });

    it('publishes its /control payload retained on the control leaf, and clears that leaf', () => {
      const { session, published } = harness();
      session.pushEntityState(soll);
      session.clearEntityState('number.soll');
      expect(published.map(({ topic, retain }) => [topic, retain])).to.deep.equal([
        ['ha/statestream/number/soll/control', true],
        ['ha/statestream/number/soll/control', true],
      ]);
      expect(JSON.parse(published[0]!.payload)).to.include({ kind: 'number', state: '21.5', writable: true });
      expect(published[1]!.payload).to.equal('');
    });

    const fits = (state: string): VirtualEntity =>
      entity({ entityId: 'select.gross', domain: 'select', state, attributes: { options: ['Aus', 'Eco', 'Komfort'] }, writable: { value: true } });

    it('publishes a select too large for the panel without its options: read-only, its state current (Ruling 98)', () => {
      const { session, published } = harness();
      session.pushEntityState(fits('Eco'));
      session.pushEntityState({ ...huge('select.gross'), state: 'Komfort' });
      // Never an old, writable payload left on the panel, where every command
      // would be refused as "changed" (review O1).
      const shown = published.map(({ payload }) => {
        const { state, writable, options } = JSON.parse(payload) as Record<string, unknown>;
        return [state, writable, options === undefined];
      });
      expect(shown).to.deep.equal([
        ['Eco', true, false],
        ['Komfort', false, true],
      ]);
      // The transport gets a plain retained publish.
      expect(published.map((request) => Object.keys(request).sort().join())).to.deep.equal(['payload,retain,topic', 'payload,retain,topic']);
    });

    it('warns once per episode: again after a payload that fits, and again after the entity was removed (review m2)', () => {
      const { session, warnings } = harness();
      session.pushEntityState(huge('select.gross'));
      session.pushEntityState(huge('select.gross'));
      session.pushEntityState(fits('Eco'));
      session.pushEntityState(huge('select.gross'));
      session.clearEntityState('select.gross');
      session.pushEntityState(huge('select.gross'));
      session.pushEntityState(huge('select.riesig'));
      // A scene publishes nothing, and that is no reason to warn.
      session.pushEntityState(entity({ entityId: 'scene.nacht', domain: 'scene' }));
      expect(warnings.map((warning) => warning.includes('select.gross'))).to.deep.equal([true, true, true, false]);
      expect(warnings[0]).to.include('[Panel a1]').and.include('24576');
      expect(warnings[3]).to.include('select.riesig');
    });
  });

  it('routes a switch command to the dispatcher', async () => {
    const { session, writes, registryEntities } = harness();
    registryEntities.set(
      'switch.k',
      entity({ entityId: 'switch.k', domain: 'switch', state: 'off', source: { set: 'shelly.0.on' } }),
    );
    await session.start();
    await session.handleMessage('hometiles/cmnd/switch', '{"entity_id":"switch.k","state":"on"}', false);
    expect(writes).to.deep.equal([['shelly.0.on', true]]);
  });

  it('routes a climate command to the dispatcher, proving the leaf reaches parseCommand end to end', async () => {
    const { session, writes, registryEntities } = harness();
    registryEntities.set(
      'climate.hall',
      entity({
        entityId: 'climate.hall',
        domain: 'climate',
        state: 'heat',
        source: { mode: 'zig.0.hall.mode' },
        writable: { hvac_mode: true },
        // A states map says what "cool" means; an untyped MODE without one is
        // refused since Ruling 33, so this routing test must carry one.
        channelMeta: { mode: { type: 'string', states: { cool: 'Cool', heat: 'Heat' } } },
      }),
    );
    await session.start();
    await session.handleMessage(
      'hometiles/cmnd/climate',
      '{"entity_id":"climate.hall","command":"set_hvac_mode","hvac_mode":"cool"}',
      false,
    );
    expect(writes).to.deep.equal([['zig.0.hall.mode', 'cool']]);
  });

  it('routes a plain-text scene command to the dispatcher', async () => {
    const { session, writes, registryEntities } = harness();
    registryEntities.set(
      'scene.nacht',
      entity({ entityId: 'scene.nacht', domain: 'scene', source: { set: 'scene.0.nacht' } }),
    );
    await session.start();
    await session.handleMessage('hometiles/cmnd/scene', 'Gute Nacht', false);
    expect(writes).to.deep.equal([['scene.0.nacht', true]]);
  });

  it('swallows a malformed command without throwing into the MQTT handler', async () => {
    const { session, writes } = harness();
    await session.start();
    await session.handleMessage('hometiles/cmnd/switch', 'not json', false);
    expect(writes).to.have.length(0);
  });

  it('ignores an implausible reported IP that could redirect pairing credentials', async () => {
    // stat/ip feeds the pairing flow, which POSTs broker credentials to it.
    // fetch would read panel.lan@attacker.example as attacker.example.
    const { session, warnings } = harness();
    await session.start();
    await session.handleMessage('hometiles/stat/ip', '192.168.1.40', false);
    expect(session.ip).to.equal('192.168.1.40');

    await session.handleMessage('hometiles/stat/ip', 'panel.lan@attacker.example', false);
    expect(session.ip, 'the previous good value must stand').to.equal('192.168.1.40');
    expect(warnings.some((w) => w.includes('implausible reported IP'))).to.equal(true);
  });

  it('tracks panel presence and IP from the retained stat topics', async () => {
    const { session } = harness();
    await session.start();
    await session.handleMessage('hometiles/stat/connected', 'online', false);
    expect(session.online).to.equal(true);
    await session.handleMessage('hometiles/stat/ip', '192.168.1.40', false);
    expect(session.ip).to.equal('192.168.1.40');
    await session.handleMessage('hometiles/stat/connected', 'offline', false);
    expect(session.online).to.equal(false);
  });

  it('exposes the local I/O channels the panel announced', () => {
    const { session } = harness();
    expect(session.localIo.map((channel) => channel.id)).to.deep.equal(['relay_1']);
  });

  describe('retained messages (Ruling 101)', () => {
    // The broker replays a retained message at every (re)subscription, marked
    // retained; a live one never is. A retained command would run again at
    // every reconnect and restart -- a switch toggling by itself -- so every
    // command leaf ignores one (the Bridge only its value, switch and scene:
    // __init__.py:1550, :2999, :3082). The panel's own retained topics are
    // read as always (review T1).
    const NOW = 1_790_000_000_000;
    const soll = entity({
      entityId: 'number.soll',
      domain: 'number',
      state: '21.5',
      source: { set: '0_userdata.0.soll' },
      attributes: { min: 15, max: 28, step: 0.5 },
      writable: { value: true },
    });

    async function everyLeaf(): Promise<{ run: ReturnType<typeof harness>; commands: Array<[string, string, [string, unknown]]> }> {
      const run = harness(() => NOW);
      const { registryEntities, session } = run;
      registryEntities.set('light.d', entity({ entityId: 'light.d', domain: 'light', state: 'off', source: { set: 'hue.0.d.on' } }));
      registryEntities.set('switch.k', entity({ entityId: 'switch.k', domain: 'switch', state: 'off', source: { set: 'shelly.0.on' } }));
      registryEntities.set('scene.nacht', entity({ entityId: 'scene.nacht', domain: 'scene', source: { set: 'scene.0.nacht' } }));
      registryEntities.set(
        'climate.hall',
        entity({
          entityId: 'climate.hall',
          domain: 'climate',
          state: 'heat',
          source: { mode: 'zig.0.hall.mode' },
          writable: { hvac_mode: true },
          channelMeta: { mode: { type: 'string', states: { cool: 'Cool', heat: 'Heat' } } },
        }),
      );
      registryEntities.set(
        'cover.blind',
        entity({ entityId: 'cover.blind', domain: 'cover', state: 'open', source: { set: 'zig.0.blind.level' }, writable: { position: true }, channelMeta: { set: { type: 'number' } } }),
      );
      const tv: DeviceInput = {
        objectId: 'sonos.0.root.tv',
        name: 'TV',
        detectorType: 'media',
        domain: 'media_player',
        channels: {
          state: { objectId: 'sonos.0.root.tv.state_simple', type: 'boolean', write: true },
          next: { objectId: 'sonos.0.root.tv.next', type: 'boolean', write: true },
        },
      };
      registryEntities.set('media_player.tv', synthMediaPlayer(tv, 'media_player.tv', { 'sonos.0.root.tv.state_simple': { val: true, ack: true, q: 0, ts: 1 } })!);
      registryEntities.set('number.soll', soll);
      session.pushEntityState(soll);
      await session.start();
      run.published.length = 0;
      const value = {
        entity_id: 'number.soll',
        session: CONTROL_SESSION,
        revision: controlRevision(soll, CONTROL_SESSION),
        value: 22,
        id: '1a2b3c4d-0002b1c8-00000001',
        deadline: NOW / 1000 + 10,
      };
      const commands: Array<[string, string, [string, unknown]]> = [
        ['light', '{"entity_id":"light.d","state":"on"}', ['hue.0.d.on', true]],
        ['switch', '{"entity_id":"switch.k","state":"on"}', ['shelly.0.on', true]],
        ['scene', 'Gute Nacht', ['scene.0.nacht', true]],
        ['climate', '{"entity_id":"climate.hall","command":"set_hvac_mode","hvac_mode":"cool"}', ['zig.0.hall.mode', 'cool']],
        ['cover', '{"entity_id":"cover.blind","command":"set_cover_position","position":30}', ['zig.0.blind.level', 30]],
        ['media', '{"entity_id":"media_player.tv","command":"next"}', ['sonos.0.root.tv.next', true]],
        ['value', JSON.stringify(value), ['0_userdata.0.soll', 22]],
      ];
      return { run, commands };
    }

    it('ignores a retained command on every command leaf: no write, no answer, no warning, and the topic stays this panel\'s', async () => {
      const { run, commands } = await everyLeaf();
      for (const [leaf, payload] of commands) {
        expect(await run.session.handleMessage(`hometiles/cmnd/${leaf}`, payload, true), leaf).to.equal(true);
      }
      expect(run.writes).to.deep.equal([]);
      expect(run.published).to.deep.equal([]);
      expect(run.warnings).to.deep.equal([]);
      // Each is a command that runs when it arrives live.
      for (const [leaf, payload] of commands) await run.session.handleMessage(`hometiles/cmnd/${leaf}`, payload, false);
      expect(run.writes).to.deep.equal(commands.map(([, , write]) => write));
      expect(run.warnings).to.deep.equal([]);
    });

    it('ignores it before parsing: a retained malformed command warns at no reconnect (T3)', async () => {
      const { run } = await everyLeaf();
      for (const leaf of ['light', 'switch', 'scene', 'climate', 'cover', 'media', 'value']) {
        for (const payload of ['not json', '{}', '']) await run.session.handleMessage(`hometiles/cmnd/${leaf}`, payload, true);
      }
      expect(run.warnings).to.deep.equal([]);
      // Live, the same warns.
      await run.session.handleMessage('hometiles/cmnd/switch', 'not json', false);
      expect(run.warnings).to.deep.equal(['[Panel a1] Invalid command on switch: invalid_json']);
    });

    it("still reads the panel's own retained topics: presence, IP, the refresh request and the weather request (T1)", async () => {
      const { session, published } = harness(() => NOW);
      const home = entity({ entityId: 'weather.home', domain: 'weather', state: 'unknown', attributes: { friendly_name: 'Zuhause', temperature: 18.5 } });
      session.pushEntityState(home);
      published.length = 0;
      let refreshed: boolean | null = null;
      session.onRefreshRequested = (forced): void => {
        refreshed = forced;
      };
      await session.start();
      expect(await session.handleMessage('hometiles/stat/connected', 'online', true)).to.equal(true);
      expect(await session.handleMessage('hometiles/stat/ip', '192.168.1.40', true)).to.equal(true);
      expect(await session.handleMessage('tab5_lvgl/config/a1/bridge/request', 'force', true)).to.equal(true);
      expect(await session.handleMessage('tab5_lvgl/config/a1/weather/request', '{"entity_id":"weather.home"}', true)).to.equal(true);
      expect(session).to.include({ online: true, ip: '192.168.1.40' });
      expect(refreshed).to.equal(true);
      expect(published.map((request) => request.topic)).to.deep.equal(['ha/statestream/weather/home/weather']);
      // Not this panel's topic, retained or not.
      expect(await session.handleMessage('other/stat/connected', 'online', true)).to.equal(false);
    });
  });

  describe('the weather request (Task 12)', () => {
    // The popup's cold-cache nudge (mqtt_handlers.cpp:2515-2529): a request
    // with no response topic, answered by the retained weather state itself.
    const REQUEST = 'tab5_lvgl/config/a1/weather/request';
    const home = entity({
      entityId: 'weather.home',
      domain: 'weather',
      state: 'unknown',
      attributes: { friendly_name: 'Zuhause', temperature: 18.5, temperature_unit: '°C', weather_state: 'Sonnig' },
    });
    const answer = { topic: 'ha/statestream/weather/home/weather', payload: buildWeatherPayload(home), retain: true };

    async function started(now: () => number = Date.now): Promise<ReturnType<typeof harness>> {
      const run = harness(now);
      await run.session.start();
      run.session.pushEntityState(home);
      run.session.pushEntityState(entity({ entityId: 'sensor.t' }));
      run.published.length = 0;
      return run;
    }

    it("subscribes to its own device id's weather request", async () => {
      const { session, subscribed } = harness();
      await session.start();
      expect(subscribed).to.include(REQUEST);
      expect(session.commandTopics()).to.include(REQUEST);
    });

    it("answers by publishing the entity's retained weather payload again, on its weather leaf, and on no response topic", async () => {
      const { session, published } = await started();
      expect(await session.handleMessage(REQUEST, '{"entity_id":"weather.home"}', false)).to.equal(true);
      expect(published).to.deep.equal([answer]);
    });

    it('ignores malformed JSON and an id that is no weather entity this panel was given', async () => {
      const { session, published } = await started();
      for (const payload of ['not json', 'null', '[]', '{}', '{"entity_id":7}', '{"entity_id":"sensor.t"}', '{"entity_id":"weather.elsewhere"}']) {
        expect(await session.handleMessage(REQUEST, payload, false), payload).to.equal(true);
      }
      expect(published).to.deep.equal([]);
    });

    it('ignores a repeat for the same entity within a second of its answer', async () => {
      let now = 10_000;
      const { session, published } = await started(() => now);
      await session.handleMessage(REQUEST, '{"entity_id":"weather.home"}', false);
      now += 999;
      await session.handleMessage(REQUEST, '{"entity_id":"weather.home"}', false);
      expect(published).to.have.length(1);
      now += 1;
      await session.handleMessage(REQUEST, '{"entity_id":"weather.home"}', false);
      expect(published).to.deep.equal([answer, answer]);
    });

    it('answers with the newest state, and no longer once the entity is gone', async () => {
      let now = 10_000;
      const { session, published } = await started(() => now);
      const rainy = { ...home, attributes: { ...home.attributes, weather_state: 'Regen' } };
      session.pushEntityState(rainy);
      published.length = 0;
      await session.handleMessage(REQUEST, '{"entity_id":"weather.home"}', false);
      expect(published).to.deep.equal([{ ...answer, payload: buildWeatherPayload(rainy) }]);

      session.clearEntityState('weather.home');
      expect(published[1]).to.deep.equal({ topic: 'ha/statestream/weather/home/weather', payload: '', retain: true });
      published.length = 0;
      now += 1000; // past the repeat window, so only the removal can keep it silent
      await session.handleMessage(REQUEST, '{"entity_id":"weather.home"}', false);
      expect(published).to.deep.equal([]);
    });

    it("does not take another panel's weather request", async () => {
      const { session, published } = await started();
      expect(await session.handleMessage('tab5_lvgl/config/b2/weather/request', '{"entity_id":"weather.home"}', false)).to.equal(false);
      expect(published).to.deep.equal([]);
    });
  });
});
