import { expect } from 'chai';
import sinon from 'sinon';
import { parseAnnouncement } from '../../src/protocol/announce';
import { buildApplyPayload } from '../../src/protocol/apply';
import { CONTROL_SESSION, controlRevision } from '../../src/protocol/editable';
import { buildDiscreteHistoryResponse, buildNumericHistoryResponse, parseHistoryRequest, type HistoryRequest, type StateSample } from '../../src/protocol/history';
import { buildWeatherPayload } from '../../src/protocol/weather';
import type { PublishRequest } from '../../src/runtime/mqtt-client';
import { Dispatcher } from '../../src/runtime/dispatcher';
import { EnergySource } from '../../src/runtime/energy-source';
import { HISTORY_BUDGET_MS, HistoryProvider, QUERY_TIMEOUT_MS, type HistoryFailure, type HistoryResult } from '../../src/runtime/history-provider';
import { PanelSession, type PanelRequests, type PanelTransport } from '../../src/runtime/panel-session';
import { synthesise } from '../../src/registry/synth/index';
import { synthMediaPlayer } from '../../src/registry/synth/media_player';
import type { DeviceInput, SourceValue, VirtualEntity } from '../../src/registry/types';
import { panelIcons, panelList, panelNames } from '../protocol/panel-scan';
import { sqlFake } from './history-ports';

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

function harness(now: () => number = Date.now, requests?: PanelRequests) {
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
  const infos: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const debugs: string[] = [];
  const capturingLog = {
    info: (message: string): void => void infos.push(message),
    warn: (message: string): void => void warnings.push(message),
    error: (message: string): void => void errors.push(message),
    debug: (message: string): void => void debugs.push(message),
  };
  const session = new PanelSession(parseAnnouncement('a1', ANNOUNCE), transport, dispatcher, capturingLog, now, undefined, requests);
  return { session, published, subscribed, writes, registryEntities, infos, warnings, errors, debugs };
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

  it('re-pushes when the configuration actually changed, and the icon map with it, which names every entity (m1)', () => {
    const { session, published } = harness();
    session.pushConfig([entity({})]);
    published.length = 0;
    expect(session.pushConfig([entity({}), entity({ entityId: 'sensor.u' })])).to.equal(true);
    expect(published.map((p) => [p.topic, p.retain])).to.deep.equal([
      ['tab5_lvgl/config/a1/bridge/apply', true],
      ['tab5_lvgl/config/a1/bridge/icons', true],
    ]);
    expect(JSON.parse(published[1]!.payload)).to.deep.equal({ 'sensor.t': '', 'sensor.u': '' });
    // The same icons again: not re-sent with an apply that changed otherwise.
    published.length = 0;
    session.pushConfig([entity({ attributes: { friendly_name: 'Neu' } }), entity({ entityId: 'sensor.u' })]);
    expect(published.map((p) => p.topic)).to.deep.equal(['tab5_lvgl/config/a1/bridge/apply']);
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

  it('publishes every v0.2 list and meta section on the apply topic (Task 21)', () => {
    const { session, published } = harness();
    session.pushConfig([
      entity({}),
      entity({ entityId: 'climate.bad', domain: 'climate', attributes: { friendly_name: 'Bad', icon: 'mdi:radiator' } }),
      entity({ entityId: 'cover.tor', domain: 'cover', attributes: { friendly_name: 'Tor' } }),
      entity({ entityId: 'media_player.tv', domain: 'media_player', attributes: { friendly_name: 'TV' } }),
      entity({ entityId: 'weather.home', domain: 'weather', attributes: { friendly_name: 'Zuhause' } }),
      entity({ entityId: 'number.soll', domain: 'number', attributes: { friendly_name: 'Soll' } }),
      entity({ entityId: 'select.modus', domain: 'select', attributes: { friendly_name: 'Modus' } }),
      entity({ entityId: 'datetime.wecker', domain: 'datetime', attributes: { friendly_name: 'Wecker' } }),
    ]);
    const apply = published.find((p) => p.topic === 'tab5_lvgl/config/a1/bridge/apply')!;
    expect(apply.retain).to.equal(true);
    const lists = Object.fromEntries(
      ['sensors', 'climates', 'covers', 'media_players', 'weathers', 'numbers', 'selects', 'datetimes'].map((key) => [key, panelList(apply.payload, key)]),
    );
    expect(lists).to.deep.equal({
      sensors: ['sensor.t'],
      climates: ['climate.bad'],
      covers: ['cover.tor'],
      media_players: ['media_player.tv'],
      weathers: ['weather.home'],
      numbers: ['number.soll'],
      selects: ['select.modus'],
      datetimes: ['datetime.wecker'],
    });
    expect(panelNames(apply.payload, 'climate_meta')).to.deep.equal({ 'climate.bad': 'Bad' });
    expect(panelIcons(apply.payload, 'climate_meta')).to.deep.equal({ 'climate.bad': 'mdi:radiator' });
    expect(panelNames(apply.payload, 'cover_meta')).to.deep.equal({ 'cover.tor': 'Tor' });
    expect(panelNames(apply.payload, 'media_player_meta')).to.deep.equal({ 'media_player.tv': 'TV' });
    expect(panelNames(apply.payload, 'editable_meta')).to.deep.equal({ 'datetime.wecker': 'Wecker', 'number.soll': 'Soll', 'select.modus': 'Modus' });
    expect(JSON.parse(apply.payload).weather_meta).to.deep.equal([{ entity_id: 'weather.home', name: 'Zuhause' }]);
  });

  describe('the bridge/apply size limit (Ruling 108)', () => {
    const APPLY = 'tab5_lvgl/config/a1/bridge/apply';
    // A panel copies the apply into a 32768-byte buffer and cuts anything
    // longer to 32767 bytes, then applies the cut text anyway
    // (mqtt_handlers.cpp:1497, :1729-1742).
    const LIMIT = 32767;
    /**
     * One sensor whose name pads this session's apply payload to exactly
     * `bytes` UTF-8 bytes: 1000 of them two-byte umlauts, so the payload is
     * 1000 characters shorter than it is long in bytes.
     */
    function sized(session: PanelSession, bytes: number): VirtualEntity[] {
      const one = (name: string): VirtualEntity[] => [entity({ attributes: { friendly_name: name } })];
      const size = (name: string): number => Buffer.byteLength(buildApplyPayload({ entities: one(name), sceneMap: session.sceneMap }));
      const name = 'ü'.repeat(1000) + 'x'.repeat(1 + bytes - size('x') - 2000);
      expect(size(name)).to.equal(bytes);
      return one(name);
    }

    it('publishes an apply of exactly the panel limit', () => {
      const { session, published, errors } = harness();
      expect(session.pushConfig(sized(session, LIMIT))).to.equal(true);
      expect(Buffer.byteLength(published.find((p) => p.topic === APPLY)!.payload)).to.equal(LIMIT);
      expect(errors).to.deep.equal([]);
    });

    it('logs how close each published apply is to the limit (m3)', () => {
      const { session, infos } = harness();
      session.pushConfig(sized(session, 30000));
      expect(infos).to.deep.equal([`[Panel a1] Configuration pushed, 1 entities, 30000 of ${LIMIT} bytes`]);
    });

    it('publishes nothing one byte over, and says so once in English with the size and the largest sections', () => {
      const { session, published, errors } = harness();
      expect(session.pushConfig(sized(session, LIMIT + 1))).to.equal(false);
      // Not the icons either: the broker keeps the last good pair.
      expect(published).to.deep.equal([]);
      expect(errors).to.have.length(1);
      expect(errors[0]).to.include('[Panel a1]').and.to.include(`${LIMIT + 1} bytes`).and.to.include(`${LIMIT}`);
      expect(errors[0]).to.match(/sensor_meta \d+ bytes/);
      // The remedy names the picker (Task 21b): nothing is published unless picked.
      expect(errors[0]).to.include('Pick fewer devices on the Devices tab');
    });

    it('does not repeat the error for the same configuration, forced or not', () => {
      const { session, published, errors } = harness();
      const big = sized(session, LIMIT + 1);
      session.pushConfig(big);
      expect(session.pushConfig(big, true)).to.equal(false);
      expect(session.pushConfig(big)).to.equal(false);
      expect(published).to.deep.equal([]);
      expect(errors).to.have.length(1);
    });

    it('names a different oversized configuration in an error of its own', () => {
      const { session, errors } = harness();
      session.pushConfig(sized(session, LIMIT + 1));
      session.pushConfig(sized(session, LIMIT + 50));
      expect(errors).to.have.length(2);
      expect(errors[1]).to.include(`${LIMIT + 50} bytes`);
    });

    it('recovers once the configuration fits again, and names the next oversized one anew', () => {
      const { session, published, errors } = harness();
      const big = sized(session, LIMIT + 1);
      session.pushConfig(big);
      expect(session.pushConfig([entity({})])).to.equal(true);
      expect(JSON.parse(published.find((p) => p.topic === APPLY)!.payload).sensors).to.deep.equal(['sensor.t']);
      published.length = 0;
      session.pushConfig(big);
      expect(published).to.deep.equal([]);
      expect(errors).to.have.length(2);
    });

    it('counts the energy catalog it is given, names it among the largest sections, and says where to cut (Task 20b)', () => {
      const { session: plain } = harness();
      const small = [entity({})];
      const base = Buffer.byteLength(buildApplyPayload({ entities: small, sceneMap: plain.sceneMap }));
      // Each entry, {"id":"energy.m_0000","name":"xxx...","category":"device"} and its comma, is over 77 bytes.
      const catalog = Array.from({ length: Math.ceil((LIMIT - base) / 77) + 1 }, (_, i) => ({
        id: `energy.m_${String(i).padStart(4, '0')}`,
        name: 'x'.repeat(30),
        category: 'device',
      }));
      const published: PublishRequest[] = [];
      const errors: string[] = [];
      const transport: PanelTransport = { publish: (request) => void published.push(request), subscribe: async () => undefined, unsubscribe: async () => undefined };
      const log = { ...silentLog, error: (message: string): void => void errors.push(message) };
      const dispatcher = new Dispatcher({ byId: () => undefined, bySceneAlias: () => undefined }, async () => undefined, silentLog);
      const session = new PanelSession(parseAnnouncement('a1', ANNOUNCE), transport, dispatcher, log, Date.now, () => catalog);
      expect(session.pushConfig(small)).to.equal(false);
      expect(published).to.deep.equal([]);
      expect(errors[0]).to.match(/largest sections: energy \d+ bytes/).and.include('energy meters on the Energy tab');
      catalog.length = 2;
      expect(session.pushConfig(small)).to.equal(true);
      expect(JSON.parse(published.find((p) => p.topic === APPLY)!.payload).energy).to.deep.equal(catalog);
    });

    it('compares a later push with the configuration last published, not the one refused', () => {
      // A refused apply never reached the broker: going back to the published
      // one needs no publish, and a forced push still sends it.
      const { session, published } = harness();
      const good = [entity({})];
      session.pushConfig(good);
      session.pushConfig(sized(session, LIMIT + 1));
      published.length = 0;
      expect(session.pushConfig(good)).to.equal(false);
      expect(session.pushConfig(good, true)).to.equal(true);
      expect(published.filter((p) => p.topic === APPLY)).to.have.length(1);
    });
  });

  describe('the bridge/icons size limit (Ruling 114)', () => {
    const APPLY = 'tab5_lvgl/config/a1/bridge/apply';
    const ICONS = 'tab5_lvgl/config/a1/bridge/icons';
    // The panel copies bridge/icons into the 32768-byte LARGE_BUF and cuts it
    // at 32767 bytes, without a log; the cut map does not parse, and none of
    // it is applied (mqtt_handlers.cpp:1496, :1779-1791;
    // ha_bridge_config.cpp:736-737).
    const LIMIT = 32767;
    const bytes = (text: string): number => Buffer.byteLength(text);
    const iconsOf = (published: PublishRequest[]): PublishRequest | undefined => published.find((p) => p.topic === ICONS);
    /** A switch with a 30-character id; the first three carry an MDI icon. */
    const socket = (i: number): VirtualEntity =>
      entity({
        entityId: `switch.zwischenstecker_nr_${String(i).padStart(4, '0')}`,
        domain: 'switch',
        state: 'off',
        attributes: { friendly_name: `Zwischenstecker ${i}`, ...(i < 3 ? { icon: 'mdi:power-socket-de' } : {}) },
      });
    /** A number with an MDI icon: past the 128th in bridge/icons only, not in the apply (Ruling 111). */
    const setpoint = (i: number, id = `number.sollwert_heizkreis_nr_${String(i).padStart(4, '0')}`): VirtualEntity =>
      entity({ entityId: id, domain: 'number', attributes: { friendly_name: `Sollwert ${i}`, icon: 'mdi:thermostat' } });
    /**
     * Icon-less scenes -- in no list, so the apply stays small -- whose whole
     * icon map is exactly `size` UTF-8 bytes. The last id carries ten
     * two-byte umlauts: the map is ten characters shorter than it is long.
     */
    function scenesWithIconMapOf(size: number): VirtualEntity[] {
      const scene = (id: string): VirtualEntity => entity({ entityId: id, domain: 'scene', state: 'unknown', attributes: { friendly_name: 'S' } });
      const map = (list: VirtualEntity[]): number => bytes(JSON.stringify(Object.fromEntries(list.map((s) => [s.entityId, '']))));
      const scenes = Array.from({ length: Math.floor((size - 150) / 22) }, (_, i) => scene(`scene.szene_${String(i).padStart(4, '0')}`));
      const rest = size - map([...scenes, scene('scene.z')]);
      const all = [...scenes, scene(`scene.z${'ü'.repeat(10)}${'x'.repeat(rest - 20)}`)];
      expect(map(all)).to.equal(size);
      return all;
    }

    it('publishes the whole map, "" entries included, when it fits', () => {
      const { session, published } = harness();
      session.pushConfig([entity({}), socket(0), socket(9)]);
      expect(JSON.parse(iconsOf(published)!.payload)).to.deep.equal({
        'sensor.t': '',
        'switch.zwischenstecker_nr_0000': 'mdi:power-socket-de',
        'switch.zwischenstecker_nr_0009': '',
      });
    });

    it('publishes a whole map of exactly the limit, and warns of nothing', () => {
      const { session, published, errors, warnings } = harness();
      session.pushConfig(scenesWithIconMapOf(LIMIT));
      const icons = iconsOf(published)!;
      expect(bytes(icons.payload)).to.equal(LIMIT);
      expect(Object.values(JSON.parse(icons.payload))).to.satisfy((values: string[]) => values.every((value) => value === ''));
      expect(errors).to.deep.equal([]);
      expect(warnings).to.deep.equal([]);
    });

    it('drops the "" entries one byte over, counted in UTF-8 bytes, and says so', () => {
      const { session, published, warnings } = harness();
      const scenes = scenesWithIconMapOf(LIMIT + 1);
      session.pushConfig(scenes);
      expect(iconsOf(published)!.payload).to.equal('{}');
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.include(`${scenes.length} entities without an MDI icon`);
    });

    it('publishes the MDI icons of 940 long-id switches without their "" entries, where the apply still fits, and says what that leaves (Task 21 round 2 C1)', () => {
      const { session, published, errors, warnings } = harness();
      const sockets = Array.from({ length: 940 }, (_, i) => socket(i));
      // The premise: the apply fits, the whole map would not.
      expect(session.pushConfig(sockets)).to.equal(true);
      expect(bytes(published.find((p) => p.topic === APPLY)!.payload)).to.be.at.most(LIMIT);
      expect(bytes(JSON.stringify(Object.fromEntries(sockets.map((s) => [s.entityId, s.attributes.icon ?? '']))))).to.be.above(LIMIT);
      const icons = iconsOf(published)!;
      expect(icons.retain).to.equal(true);
      expect(JSON.parse(icons.payload)).to.deep.equal({
        'switch.zwischenstecker_nr_0000': 'mdi:power-socket-de',
        'switch.zwischenstecker_nr_0001': 'mdi:power-socket-de',
        'switch.zwischenstecker_nr_0002': 'mdi:power-socket-de',
      });
      expect(errors).to.deep.equal([]);
      // One English line: the 937 left without "" keep a stale icon until the panel restarts (Ruling 114).
      expect(warnings).to.deep.equal([
        `[Panel a1] Icons pushed without the entries that clear one: with them, bridge/icons is over the ${LIMIT} bytes a panel takes. ` +
          'The 937 entities without an MDI icon keep any icon the panel holds for them until it restarts. ' +
          'Pick fewer devices on the Devices tab of the adapter settings to send them again',
      ]);
    });

    it('warns once per configuration whose icons go without their "" entries, as the refusals do, and anew once the map has fit', () => {
      const { session, warnings } = harness();
      const sockets = (count: number): VirtualEntity[] => Array.from({ length: count }, (_, i) => socket(i));
      session.pushConfig(sockets(940));
      // The same configuration again, as a panel's refresh request forces it: no second line.
      session.pushConfig(sockets(940), true);
      expect(warnings).to.have.length(1);
      // The whole map fits: nothing to say; the same configuration as before, degraded again, is said again.
      session.pushConfig(sockets(10));
      expect(warnings).to.have.length(1);
      session.pushConfig(sockets(940));
      expect(warnings).to.have.length(2);
      // Another configuration that degrades is named too, as each refused one is.
      session.pushConfig(sockets(941));
      expect(warnings).to.have.length(3);
      expect(warnings[2]).to.include('The 938 entities');
    });

    it('publishes no icons when the MDI ones alone are over the limit, and says so once, with the byte count', () => {
      // Possible only past the 128 numbers, selects and datetimes the apply
      // takes: every other icon costs the apply more than the map.
      const { session, published, errors, warnings } = harness();
      const setpoints = Array.from({ length: 700 }, (_, i) => setpoint(i));
      const size = bytes(JSON.stringify(Object.fromEntries(setpoints.map((s) => [s.entityId, 'mdi:thermostat']))));
      // And a switch with no icon, whose "" entry goes first.
      const entities = [...setpoints, socket(9)];
      expect(session.pushConfig(entities)).to.equal(true);
      expect(published.map((p) => p.topic)).to.deep.equal([APPLY]);
      expect(errors).to.have.length(1);
      expect(errors[0]).to.include('[Panel a1]').and.to.include(`${size} bytes`).and.to.include(`${LIMIT}`);
      expect(session.pushConfig(entities, true)).to.equal(true);
      expect(published.map((p) => p.topic)).to.deep.equal([APPLY, APPLY]);
      expect(errors).to.have.length(1);
      // The error says it all: no map went out that a warning could describe.
      expect(warnings).to.deep.equal([]);
    });

    it('publishes the icons again once they fit, and names the next refusal anew', () => {
      const { session, published, errors } = harness();
      const setpoints = Array.from({ length: 700 }, (_, i) => setpoint(i));
      session.pushConfig(setpoints);
      published.length = 0;
      session.pushConfig(setpoints.slice(0, 100));
      expect(Object.keys(JSON.parse(iconsOf(published)!.payload))).to.deep.equal(setpoints.slice(0, 100).map((s) => s.entityId));
      published.length = 0;
      session.pushConfig(setpoints.slice(0, 650));
      expect(iconsOf(published)).to.equal(undefined);
      expect(errors).to.have.length(2);
    });

    it('counts UTF-8 bytes of the MDI map too, not characters', () => {
      // 500 numbers whose ids hold 26 two-byte umlauts each: about 28,500
      // characters, over 41,000 bytes.
      const { session, published, errors } = harness();
      const setpoints = Array.from({ length: 500 }, (_, i) => setpoint(i, `number.${'ü'.repeat(26)}_${String(i).padStart(4, '0')}`));
      expect(session.pushConfig(setpoints)).to.equal(true);
      expect(iconsOf(published)).to.equal(undefined);
      expect(errors).to.have.length(1);
    });
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

  describe('history and energy requests (Task 22)', () => {
    const NOW = 1_790_000_000_000;
    const HOUR = 3_600_000;
    /** When the history adapter answered: after the request came, so never the session's own now. */
    const ANSWERED = NOW + 1_500;
    const HISTORY = 'tab5_lvgl/config/a1/history/request';
    const ENERGY = 'tab5_lvgl/config/a1/energy/request';
    const RESPONSE = 'tab5_lvgl/config/a1/history/response';

    /** A temperature, a door contact, a text state, a setpoint beside its reading, a socket: as detection gives them. */
    const DEVICES: Record<string, DeviceInput> = {
      'sensor.t': {
        objectId: 'hm.0.t',
        name: 'T',
        detectorType: 'temperature',
        domain: 'sensor',
        channels: { actual: { objectId: 'hm.0.t.ACTUAL', role: 'value.temperature', type: 'number', unit: '°C' } },
      },
      'binary_sensor.door': {
        objectId: 'zigbee.0.door',
        name: 'Door',
        detectorType: 'door',
        domain: 'binary_sensor',
        channels: { actual: { objectId: 'zigbee.0.door.opened', type: 'boolean' } },
      },
      'sensor.mode': { objectId: 'hm.0.mode', name: 'Mode', detectorType: 'info', domain: 'sensor', channels: { actual: { objectId: 'hm.0.mode.STATE', type: 'string' } } },
      'number.soll': {
        objectId: 'hm.0.soll',
        name: 'Soll',
        detectorType: 'levelSlider',
        domain: 'number',
        channels: {
          actual: { objectId: 'hm.0.soll.ACTUAL', type: 'number' },
          set: { objectId: 'hm.0.soll.SET', type: 'number', min: 15, max: 28, write: true },
        },
      },
      'switch.k': { objectId: 'shelly.0.k', name: 'K', detectorType: 'socket', domain: 'switch', channels: { set: { objectId: 'shelly.0.k.on', type: 'boolean', write: true } } },
      // A reading beside a setpoint, listed first; and the two readings not named ACTUAL.
      'sensor.room': {
        objectId: 'hm.0.room',
        name: 'Room',
        detectorType: 'temperature',
        domain: 'sensor',
        channels: { set: { objectId: 'hm.0.room.SET', type: 'number' }, actual: { objectId: 'hm.0.room.ACTUAL', type: 'number' } },
      },
      'sensor.air': { objectId: 'hm.0.air', name: 'Air', detectorType: 'pressure', domain: 'sensor', channels: { pressure: { objectId: 'hm.0.air.PRESSURE', type: 'number' } } },
      'binary_sensor.window': {
        objectId: 'hm.0.window',
        name: 'Window',
        detectorType: 'window',
        domain: 'binary_sensor',
        channels: { set: { objectId: 'hm.0.window.SET', type: 'boolean' }, actual: { objectId: 'hm.0.window.ACTUAL', type: 'boolean' } },
      },
      'binary_sensor.alarm': { objectId: 'hm.0.alarm', name: 'Alarm', detectorType: 'warning', domain: 'binary_sensor', channels: { level: { objectId: 'hm.0.alarm.LEVEL', type: 'number' } } },
    };
    const row = (ts: number, val: unknown, q = 0): SourceValue => ({ ts, val, ack: true, q });
    /** The entity its synth makes of `val` on every channel, changed an hour ago. */
    const live = (entityId: string, val: unknown): VirtualEntity => {
      const device = DEVICES[entityId]!;
      return synthesise(device, entityId, Object.fromEntries(Object.values(device.channels).map((channel) => [channel.objectId, row(NOW - HOUR, val)])))!;
    };
    /** The registry's stateOf, over the same devices and the real synths. */
    const stateOf = (entityId: string, objectId: string, value: SourceValue): string | undefined => {
      const device = DEVICES[entityId];
      return device && synthesise(device, entityId, { [objectId]: value })?.state;
    };

    type Asked = { id: string } & Parameters<HistoryProvider['query']>[1];
    /** The session, its history answered by `results` and its energy by what answerEnergy sets. */
    function wired(results: (id: string) => HistoryResult | Promise<HistoryResult> = () => ({ rows: [], now: ANSWERED, available: true })) {
      const queries: Asked[] = [];
      const energy: Array<[string, string]> = [];
      let energyAnswer: { topic: string; payload: string } | null = null;
      const requests: PanelRequests = {
        history: {
          query: async (id, options) => {
            queries.push({ id, ...options });
            return results(id);
          },
        },
        stateOf,
        energy: {
          answer: async (deviceId, payload) => {
            energy.push([deviceId, payload]);
            return energyAnswer;
          },
        },
      };
      const run = harness(() => NOW, requests);
      for (const entityId of ['sensor.t', 'binary_sensor.door', 'switch.k']) run.session.pushEntityState(live(entityId, entityId === 'sensor.t' ? 21.5 : false));
      run.session.pushEntityState(live('sensor.mode', 'Komfort'));
      run.session.pushEntityState(live('number.soll', 22));
      run.published.length = 0;
      const answerEnergy = (answer: { topic: string; payload: string } | null): void => void (energyAnswer = answer);
      return { ...run, requests, queries, energy, answerEnergy };
    }

    const NUMERIC = '{"entity_id":"sensor.t","hours":24,"period_minutes":5,"points":288,"stat":"mean"}';
    const BINARY = '{"version":1,"kind":"binary","entity_id":"binary_sensor.door","hours":24,"max_transitions":96}';
    const STATE = '{"version":1,"kind":"state","entity_id":"sensor.mode","hours":168,"max_transitions":96}';
    const EDITABLE = '{"entity_id":"number.soll","kind":"editable","version":1,"hours":24,"max_transitions":96,"request_id":"1a2b3c4d-0002b1c8-00000001"}';
    const parsed = <K extends HistoryRequest['kind']>(payload: string, kind: K): Extract<HistoryRequest, { kind: K }> => {
      const request = parseHistoryRequest(payload);
      expect(request?.kind).to.equal(kind);
      return request as Extract<HistoryRequest, { kind: K }>;
    };

    it('subscribes to its own history and energy requests under the config root, never under the base topic', async () => {
      const { session, subscribed, published, warnings } = harness();
      await session.start();
      expect(session.commandTopics()).to.include.members([HISTORY, ENERGY]);
      // The base topic is hometiles: nothing of history or energy there.
      expect(subscribed.filter((topic) => /history|energy/.test(topic))).to.deep.equal([HISTORY, ENERGY]);
      // With nothing wired to answer, a request is a wiring error, and says so.
      expect(await session.handleMessage(HISTORY, NUMERIC, false)).to.equal(true);
      expect(published).to.deep.equal([]);
      expect(warnings).to.deep.equal([`[Panel a1] Request on ${HISTORY} ignored: nothing answers it here, a wiring error`]);
    });

    it("answers each kind on history/response, not retained, from the state the entity's synth reads, by a deadline 7 s on", async () => {
      const rows: Record<string, SourceValue[]> = {
        'hm.0.t.ACTUAL': [row(NOW - 30 * HOUR, 18.5), row(NOW - 2 * HOUR, 21), row(NOW - HOUR, 22)],
        'zigbee.0.door.opened': [row(NOW - 30 * HOUR, false), row(NOW - 3 * HOUR, true), row(NOW - 2 * HOUR, null, 0x40), row(NOW - HOUR, false)],
        'hm.0.mode.STATE': [row(NOW - 200 * HOUR, 'Eco'), row(NOW - 2 * HOUR, 'Komfort')],
        // A null with good quality is unknown for a number, bad quality unavailable (Ruling 88).
        'hm.0.soll.SET': [row(NOW - 30 * HOUR, 20), row(NOW - 3 * HOUR, null), row(NOW - 2 * HOUR, 21, 0x42), row(NOW - HOUR, 22)],
      };
      const run = wired((id) => ({ rows: rows[id]!, now: ANSWERED, available: true }));
      for (const payload of [NUMERIC, BINARY, STATE, EDITABLE]) expect(await run.session.handleMessage(HISTORY, payload, false)).to.equal(true);

      const asked = (id: string, hours: number, kind: 'numeric' | 'discrete'): Asked => ({ id, start: NOW - hours * HOUR, kind, panel: 'a1', deadline: NOW + HISTORY_BUDGET_MS });
      // A number's value channel, SET, not the reading beside it (valueChannel).
      expect(run.queries).to.deep.equal([
        asked('hm.0.t.ACTUAL', 24, 'numeric'),
        asked('zigbee.0.door.opened', 24, 'discrete'),
        asked('hm.0.mode.STATE', 168, 'discrete'),
        asked('hm.0.soll.SET', 24, 'discrete'),
      ]);
      const samples = (id: string, states: string[]): StateSample[] => rows[id]!.map(({ ts }, i) => ({ ts, state: states[i]! }));
      expect(run.published).to.deep.equal(
        [
          buildNumericHistoryResponse(parsed(NUMERIC, 'numeric'), rows['hm.0.t.ACTUAL']!, ANSWERED),
          buildDiscreteHistoryResponse(parsed(BINARY, 'binary'), samples('zigbee.0.door.opened', ['off', 'on', 'unavailable', 'off']), ANSWERED, live('binary_sensor.door', false), true),
          buildDiscreteHistoryResponse(parsed(STATE, 'state'), samples('hm.0.mode.STATE', ['Eco', 'Komfort']), ANSWERED, live('sensor.mode', 'Komfort'), true),
          buildDiscreteHistoryResponse(parsed(EDITABLE, 'editable'), samples('hm.0.soll.SET', ['20', 'unknown', 'unavailable', '22']), ANSWERED, live('number.soll', 22), true),
        ].map((payload) => ({ topic: RESPONSE, payload, retain: false })),
      );
      // Each row as the synth reads it, and the editable popup's own id echoed after kind, entity_id and hours.
      const [, binary, , editable] = run.published.map(({ payload }) => JSON.parse(payload) as Record<string, unknown>);
      expect((binary!.activity as Array<{ state: string }>).map(({ state }) => state)).to.deep.equal(['on', 'unavailable', 'off']);
      expect(Object.keys(editable!).slice(0, 4)).to.deep.equal(['kind', 'entity_id', 'hours', 'request_id']);
      expect(editable).to.include({ kind: 'number', request_id: '1a2b3c4d-0002b1c8-00000001' });
      expect((editable!.activity as Array<{ state: string }>).map(({ state }) => state)).to.deep.equal(['unknown', 'unavailable', '22']);
    });

    it("reads a sensor's history from its reading as its synth does: never from a setpoint beside it, and from PRESSURE or LEVEL without ACTUAL", async () => {
      const run = wired();
      run.session.pushEntityState(live('sensor.room', 21));
      run.session.pushEntityState(live('sensor.air', 1013));
      run.session.pushEntityState(live('binary_sensor.window', false));
      run.session.pushEntityState(live('binary_sensor.alarm', 0));
      await run.session.handleMessage(HISTORY, NUMERIC.replace('sensor.t', 'sensor.room'), false);
      await run.session.handleMessage(HISTORY, NUMERIC.replace('sensor.t', 'sensor.air'), false);
      await run.session.handleMessage(HISTORY, BINARY.replace('binary_sensor.door', 'binary_sensor.window'), false);
      await run.session.handleMessage(HISTORY, BINARY.replace('binary_sensor.door', 'binary_sensor.alarm'), false);
      expect(run.queries.map(({ id }) => id)).to.deep.equal(['hm.0.room.ACTUAL', 'hm.0.air.PRESSURE', 'hm.0.window.ACTUAL', 'hm.0.alarm.LEVEL']);
    });

    it('ignores a retained request, which would replay at every reconnect: no query, no answer', async () => {
      const run = wired();
      run.answerEnergy({ topic: 'tab5_lvgl/config/a1/energy/response', payload: '{"period":"day"}' });
      for (const [topic, payload] of [
        [HISTORY, NUMERIC],
        [HISTORY, EDITABLE],
        [ENERGY, '{"period":"day"}'],
      ] as const) {
        expect(await run.session.handleMessage(topic, payload, true)).to.equal(true);
      }
      expect(run.queries).to.deep.equal([]);
      expect(run.energy).to.deep.equal([]);
      expect(run.published).to.deep.equal([]);
      // The same, live, are answered.
      await run.session.handleMessage(HISTORY, NUMERIC, false);
      await run.session.handleMessage(ENERGY, '{"period":"day"}', false);
      expect(run.published.map(({ topic }) => topic)).to.deep.equal([RESPONSE, 'tab5_lvgl/config/a1/energy/response']);
    });

    it('answers only for an entity this panel was given, and asks for: no other, removed, switch, sensor as an editable, or malformed request', async () => {
      const run = wired();
      run.session.clearEntityState('number.soll');
      run.published.length = 0;
      const ignored = [
        '{"entity_id":"sensor.elsewhere","hours":24,"period_minutes":5}',
        EDITABLE,
        '{"entity_id":"switch.k","hours":24,"period_minutes":5}',
        EDITABLE.replace('number.soll', 'sensor.t'),
        'not json',
        '{"entity_id":"sensor.t"}',
        '{"entity_id":"sensor.t","kind":"trend","hours":24}',
      ];
      for (const payload of ignored) expect(await run.session.handleMessage(HISTORY, payload, false), payload).to.equal(true);
      expect(run.queries).to.deep.equal([]);
      expect(run.published).to.deep.equal([]);
      // Panels ask again every minute: one line an hour for each, and debug only.
      const lines = run.debugs.length;
      expect(lines).to.equal(ignored.length - 2);
      for (const payload of ignored) await run.session.handleMessage(HISTORY, payload, false);
      expect(run.debugs).to.have.length(lines);
      expect(run.debugs[0]).to.equal('[Panel a1] History request for sensor.elsewhere ignored: no entity of this panel whose history it can ask for');
      // Another panel's request is not this session's.
      expect(await run.session.handleMessage('tab5_lvgl/config/b2/history/request', NUMERIC, false)).to.equal(false);
      expect(await run.session.handleMessage('tab5_lvgl/config/b2/energy/request', '{"period":"day"}', false)).to.equal(false);
      expect(run.energy).to.deep.equal([]);
    });

    it('stays silent while unarmed: no entity given, and the energy source answers nothing (Rulings 116, 118)', async () => {
      let read = 0;
      const source = new EnergySource(
        { readingsBefore: async () => ((read += 1), { readings: [], available: true }) },
        { getForeignStateAsync: async () => ({ val: 5, q: 0 }) },
        silentLog,
      );
      const totals = { grid: 'Netz', solar: 'Solar', battery: 'Batterie', gas: 'Gas', water: 'Wasser', device: 'Geräte', device_water: 'Wasser Geräte' };
      source.configure({
        armed: false,
        meters: [{ id: 'energy.netz', stateId: 'shelly.0.em.total', category: 'grid', sign: 1, name: 'Netz' }],
        currency: 'EUR',
        names: { totals, consumption: 'Verbrauch', untracked: 'Rest' },
      });
      const queried: string[] = [];
      const requests: PanelRequests = { history: { query: async (id) => (queried.push(id), { rows: [], now: NOW, available: true }) }, stateOf, energy: source };
      // Unarmed, main.ts gives a panel no entity (panelEntities is null).
      const { session, published } = harness(() => NOW, requests);
      await session.handleMessage(HISTORY, NUMERIC, false);
      await session.handleMessage(ENERGY, '{"period":"day"}', false);
      expect(published).to.deep.equal([]);
      expect(queried).to.deep.equal([]);
      expect(read).to.equal(0);
    });

    it('answers by its deadline, the wait for a slot included: a popup queued behind two hung reads hears "unavailable" 7 s on', async () => {
      const clock = sinon.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      // An instance that never answers.
      const fake = sqlFake([]);
      fake.getHistoryAsync = (id, options) => {
        fake.calls.push({ id, options: { ...options } });
        return new Promise(() => undefined);
      };
      const provider = new HistoryProvider(fake, silentLog, 'sql.0');
      try {
        const { session, published } = harness(Date.now, { history: provider, stateOf, energy: { answer: async () => null } });
        for (const entity of [live('sensor.t', 21.5), live('sensor.mode', 'Komfort'), live('binary_sensor.door', false)]) session.pushEntityState(entity);
        published.length = 0;
        // The panel's two slots, then the popup's request behind them.
        void session.handleMessage(HISTORY, NUMERIC, false);
        void session.handleMessage(HISTORY, STATE, false);
        void session.handleMessage(HISTORY, BINARY, false);
        await clock.tickAsync(QUERY_TIMEOUT_MS - 1);
        expect(published).to.deep.equal([]);
        await clock.tickAsync(1);
        // The two reads time out: the state popup hears it, the graph keeps what it shows.
        expect(published.map(({ payload }) => JSON.parse(payload).entity_id)).to.deep.equal(['sensor.mode']);
        await clock.tickAsync(HISTORY_BUDGET_MS - QUERY_TIMEOUT_MS - 1);
        expect(published).to.have.length(1);
        await clock.tickAsync(1);
        expect(published[1]).to.deep.equal({
          topic: RESPONSE,
          payload: '{"kind":"binary","entity_id":"binary_sensor.door","hours":24,"history_available":false,"error":"history_unavailable"}',
          retain: false,
        });
        // Its slots held by the hung calls (M-4), the door asked nothing.
        expect(fake.calls.map(({ id }) => id)).to.deep.equal(['hm.0.t.ACTUAL', 'hm.0.mode.STATE']);
      } finally {
        provider.close();
        clock.restore();
      }
    });

    it('sends the live value at now when the entity has no history: no rows, none kept, no instance, not running', async () => {
      const values = [...Array<null>(287).fill(null), 21.5];
      for (const result of [
        { rows: [], now: ANSWERED, available: true },
        { rows: [], now: ANSWERED, available: false, reason: 'not_logged' as const },
        { rows: [], now: ANSWERED, available: false, reason: 'no_instance' as const },
        { rows: [], now: ANSWERED, available: false, reason: 'not_running' as const },
      ]) {
        const run = wired(() => result);
        await run.session.handleMessage(HISTORY, NUMERIC, false);
        expect(run.published, String(result.reason)).to.deep.equal([
          { topic: RESPONSE, payload: JSON.stringify({ entity_id: 'sensor.t', hours: 24, period_minutes: 5, values }), retain: false },
        ]);
      }
    });

    it('sends nothing for a graph whose read failed for now, so a tile graph keeps what it shows; a popup hears "unavailable"', async () => {
      for (const reason of ['timeout', 'busy', 'failed', 'malformed', 'closed'] as HistoryFailure[]) {
        const run = wired(() => ({ rows: [], now: ANSWERED, available: false, reason }));
        await run.session.handleMessage(HISTORY, NUMERIC, false);
        expect(run.published, reason).to.deep.equal([]);
        // An editable popup has no timeout of its own (value_control.cpp:179-189): it always hears.
        await run.session.handleMessage(HISTORY, EDITABLE, false);
        expect(run.published.map(({ payload }) => payload), reason).to.deep.equal([
          '{"kind":"number","entity_id":"number.soll","hours":24,"request_id":"1a2b3c4d-0002b1c8-00000001","history_available":false,"error":"history_unavailable"}',
        ]);
      }
    });

    it('answers with the entity as the panel has it once the history came, and not at all once it was taken away', async () => {
      let answer!: (result: HistoryResult) => void;
      const run = wired(() => new Promise((resolve) => (answer = resolve)));
      const pending = run.session.handleMessage(HISTORY, BINARY, false);
      await Promise.resolve();
      const opened = { ...live('binary_sensor.door', true), lastChanged: NOW - 60_000 };
      run.session.pushEntityState(opened);
      run.published.length = 0;
      answer({ rows: [], now: ANSWERED, available: true });
      await pending;
      expect(run.published).to.deep.equal([
        { topic: RESPONSE, payload: buildDiscreteHistoryResponse(parsed(BINARY, 'binary'), [], ANSWERED, opened, true), retain: false },
      ]);
      const again = run.session.handleMessage(HISTORY, BINARY, false);
      await Promise.resolve();
      run.session.clearEntityState('binary_sensor.door');
      run.published.length = 0;
      answer({ rows: [], now: ANSWERED, available: true });
      await again;
      expect(run.published).to.deep.equal([]);
    });

    it('answers an energy request with what the energy source gives, on its topic, never retained, and nothing when it gives nothing', async () => {
      const run = wired();
      const answer = { topic: 'tab5_lvgl/config/a1/energy/response', payload: '{"period":"week","start":"2026-09-19T00:00:00+02:00","entries":[]}' };
      run.answerEnergy(answer);
      expect(await run.session.handleMessage(ENERGY, '{"period":"week"}', false)).to.equal(true);
      expect(run.energy).to.deep.equal([['a1', '{"period":"week"}']]);
      expect(run.published).to.deep.equal([{ ...answer, retain: false }]);
      run.answerEnergy(null);
      await run.session.handleMessage(ENERGY, '{"period":"month"}', false);
      expect(run.published).to.have.length(1);
    });

    it('lets nothing thrown reach the MQTT handler, and says so once an hour', async () => {
      const run = wired(() => Promise.reject(new Error('history gone')));
      run.requests.energy.answer = () => Promise.reject(new Error('energy gone'));
      for (let i = 0; i < 2; i++) {
        expect(await run.session.handleMessage(HISTORY, NUMERIC, false)).to.equal(true);
        expect(await run.session.handleMessage(ENERGY, '{"period":"day"}', false)).to.equal(true);
      }
      expect(run.published).to.deep.equal([]);
      expect(run.warnings).to.deep.equal([
        `[Panel a1] Answering a request on ${HISTORY} failed: history gone`,
        `[Panel a1] Answering a request on ${ENERGY} failed: energy gone`,
      ]);
    });
  });
});
