import { expect } from 'chai';
import type { ManualEntity } from '../../src/config/options';
import { discoverDevices } from '../../src/registry/detector';
import { EntityRegistry } from '../../src/registry/entity-registry';
import { manualDevices } from '../../src/registry/manual';
import { synthesise } from '../../src/registry/synth/index';
import type { ChannelInput, DeviceInput, SourceValue, VirtualEntity } from '../../src/registry/types';
import { Dispatcher } from '../../src/runtime/dispatcher';

/*
 * Manual entities (Task 13b, Ruling 83): one ioBroker state, declared by id
 * and domain, where detection reaches none -- above all the helper states
 * ioBroker users keep in 0_userdata.0, which lie in no channel or device
 * (Task 13 report, section 6). Every object below is shaped the way admin's
 * object browser or a script creates one.
 */

interface IoObject {
  _id: string;
  type: string;
  common: Record<string, unknown>;
  native: Record<string, unknown>;
}

const folder = (id: string, name: string): IoObject => ({ _id: id, type: 'folder', common: { name }, native: {} });
const state = (id: string, common: Record<string, unknown>): IoObject => ({ _id: id, type: 'state', common: { read: true, ...common }, native: {} });
const objects = (...list: IoObject[]): Record<string, IoObject> => Object.fromEntries(list.map((obj) => [obj._id, obj]));
const value = (val: unknown): SourceValue => ({ val, ack: true, q: 0, ts: 1_758_600_000_000 });
const QUIET = { onEntityChanged: () => undefined, onMembershipChanged: () => undefined };
const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

const NS = 'hometiles.0';
const U = '0_userdata.0';
const SOLL = `${U}.Heizung.Solltemperatur`;
const VORLAUF = `${U}.Heizung.Vorlauf_Soll`;
const MODUS = `${U}.Heizung.Modus`;
const PROFIL = `${U}.Heizung.Profil`;
const WECKZEIT = `${U}.Wecker.Weckzeit`;
const WECKER = `${U}.Wecker.Aktiv`;
const KLINGELTE = `${U}.Wecker.Zuletzt`;
const ANWESEND = `${U}.Haus.Anwesend`;
const VERBRAUCH = `${U}.Haus.Verbrauch`;
const NOTIZ = `${U}.Haus.Notiz`;
const RELAIS = `${U}.Haus.Relais`;
const NACHT = `${U}.Haus.Gute_Nacht`;
const MOND = 'data:image/svg+xml;base64,PHN2Zy8+';
const KONFIG = `${U}.Haus.Konfiguration`;
const OHNE_TYP = `${U}.Haus.Ohne_Typ`;

const USERDATA: IoObject[] = [
  folder(`${U}.Heizung`, 'Heizung'),
  state(SOLL, { name: 'Solltemperatur', role: 'level.temperature', type: 'number', unit: '°C', min: 15, max: 28, step: 0.5, write: true, def: 21 }),
  // Most states declare no step (Task 13 report, concern 1).
  state(VORLAUF, { name: 'Vorlauf Soll', role: 'level', type: 'number', unit: '°C', min: 20, max: 60, write: true }),
  state(MODUS, { name: 'Heizmodus', role: 'level.mode', type: 'number', states: { 0: 'Aus', 1: 'Eco', 2: 'Komfort' }, write: true }),
  // A script's states, in the deprecated "value:label;..." form.
  state(PROFIL, { name: 'Profil', role: 'text', type: 'string', states: 'eco:Eco;comfort:Komfort', write: true }),
  folder(`${U}.Wecker`, 'Wecker'),
  // A translated name: detection reads a name only when it is text.
  state(WECKZEIT, { name: { en: 'Wake-up time', de: 'Weckzeit' }, role: 'text', type: 'string', write: true, def: '06:45' }),
  state(WECKER, { name: 'Wecker aktiv', role: 'switch', type: 'boolean', write: true, def: false }),
  // Epoch milliseconds, ioBroker's date convention.
  state(KLINGELTE, { name: 'Zuletzt geklingelt', role: 'value.time', type: 'number', write: false }),
  folder(`${U}.Haus`, 'Haus'),
  state(ANWESEND, { name: 'Jemand zu Hause', role: 'indicator', type: 'boolean', write: false }),
  state(VERBRAUCH, { name: 'Verbrauch', role: 'value.power', type: 'number', unit: 'W', write: false }),
  state(NOTIZ, { name: 'Notiz', role: 'text', type: 'string', write: true }),
  // An old script's state that declares no write flag at all.
  state(RELAIS, { name: 'Relais', role: 'switch', type: 'boolean' }),
  state(NACHT, { name: 'Gute Nacht', role: 'button', type: 'boolean', read: false, write: true, icon: MOND }),
  state(KONFIG, { name: 'Konfiguration', role: 'json', type: 'object', write: true }),
  // A script state created without a type holds any value.
  state(OHNE_TYP, { name: 'Ohne Typ', role: 'state', write: true }),
];

// A zigbee motion sensor with a power switch. Detection gives the root id to
// the motion sensor and keys the switch, the root's second control, by its
// own state (discoverDevices).
const MELDER = 'zigbee.0.00158d0001a2b3c4';
const MELDER_TREE: IoObject[] = [
  { _id: MELDER, type: 'device', common: { name: 'Flur Melder' }, native: {} },
  state(`${MELDER}.state`, { name: 'Schalten', role: 'switch', type: 'boolean', write: true }),
  state(`${MELDER}.occupancy`, { name: 'Bewegung', role: 'sensor.motion', type: 'boolean', write: false }),
];

const OWN = state(`${NS}.info.panels`, { name: 'Announced panels', role: 'value', type: 'number', write: false });
const ALL = objects(...USERDATA, ...MELDER_TREE, OWN);

function only(entry: ManualEntity): DeviceInput {
  const { devices, rejected } = manualDevices([entry], ALL, NS);
  expect(rejected, JSON.stringify(rejected)).to.deep.equal([]);
  expect(devices).to.have.length(1);
  return devices[0]!;
}

/** The entity of a one-state device, its state holding `val`. */
function entityOf(device: DeviceInput, val: unknown): VirtualEntity | null {
  const [channel] = Object.values(device.channels);
  return synthesise(device, `${device.domain}.under_test`, { [channel!.objectId]: value(val) });
}

const manualDevice = (stateId: string, name: string, domain: DeviceInput['domain'], channels: Record<string, ChannelInput>): DeviceInput => ({
  objectId: `manual:${stateId}`,
  name,
  detectorType: 'manual',
  domain,
  channels,
});

describe('registry/manual (Task 13b)', () => {
  describe('each domain one state can serve, from a 0_userdata helper', () => {
    it('number: a bounded level with a step, shown and written on set', () => {
      const device = only({ stateId: SOLL, domain: 'number' });
      expect(device).to.deep.equal(
        manualDevice(SOLL, 'Solltemperatur', 'number', {
          set: { objectId: SOLL, role: 'level.temperature', unit: '°C', type: 'number', min: 15, max: 28, step: 0.5, write: true },
        }),
      );
      const entity = entityOf(device, 21.5)!;
      expect(entity).to.include({ domain: 'number', state: '21.5', available: true });
      expect(entity.attributes).to.include({ friendly_name: 'Solltemperatur', min: 15, max: 28, step: 0.5, unit_of_measurement: '°C' });
      expect(entity.writable).to.deep.equal({ value: true });
    });

    it('number: without common.step the channel carries none, and the synth decides (Ruling 81)', () => {
      const device = only({ stateId: VORLAUF, domain: 'number' });
      expect(device.channels).to.deep.equal({
        set: { objectId: VORLAUF, role: 'level', unit: '°C', type: 'number', min: 20, max: 60, write: true },
      });
      expect(entityOf(device, 45)).to.include({ entityId: 'number.under_test', domain: 'number', state: '45', available: true });
    });

    it('select: a number with a states map', () => {
      const device = only({ stateId: MODUS, domain: 'select' });
      expect(device).to.deep.equal(
        manualDevice(MODUS, 'Heizmodus', 'select', {
          set: { objectId: MODUS, role: 'level.mode', type: 'number', states: { 0: 'Aus', 1: 'Eco', 2: 'Komfort' }, write: true },
        }),
      );
      const entity = entityOf(device, 2)!;
      expect(entity).to.include({ domain: 'select', state: 'Komfort', available: true });
      expect(entity.attributes.options).to.deep.equal(['Aus', 'Eco', 'Komfort']);
      expect(entity.writable).to.deep.equal({ value: true });
    });

    it('select: a text whose states come in the deprecated string form, read through validStates', () => {
      const device = only({ stateId: PROFIL, domain: 'select' });
      expect(device.channels).to.deep.equal({
        set: { objectId: PROFIL, role: 'text', type: 'string', states: { eco: 'Eco', comfort: 'Komfort' }, write: true },
      });
      const entity = entityOf(device, 'comfort')!;
      expect(entity).to.include({ domain: 'select', state: 'Komfort' });
      expect(entity.attributes.options).to.deep.equal(['Eco', 'Komfort']);
      expect(entity.writable).to.deep.equal({ value: true });
    });

    it('datetime: a time text, named the way detection names an object whose name is translated', () => {
      const device = only({ stateId: WECKZEIT, domain: 'datetime' });
      expect(device).to.deep.equal(manualDevice(WECKZEIT, 'Weckzeit', 'datetime', { set: { objectId: WECKZEIT, role: 'text', type: 'string', write: true } }));
      const entity = entityOf(device, '06:45')!;
      expect(entity).to.include({ domain: 'datetime', state: '06:45', available: true });
      expect(entity.attributes).to.include({ friendly_name: 'Weckzeit', has_date: false, has_time: true });
      expect(entity.writable).to.deep.equal({ value: true });
    });

    it('datetime: an epoch number is accepted, read-only on actual, its kind the synth\'s (Ruling 84)', () => {
      const device = only({ stateId: KLINGELTE, domain: 'datetime' });
      expect(device.channels).to.deep.equal({ actual: { objectId: KLINGELTE, role: 'value.time', type: 'number', write: false } });
      expect(entityOf(device, 1_758_600_000_000)).to.include({ entityId: 'datetime.under_test', domain: 'datetime' });
    });

    it('switch: a writable boolean on set', () => {
      const device = only({ stateId: WECKER, domain: 'switch' });
      expect(device).to.deep.equal(manualDevice(WECKER, 'Wecker aktiv', 'switch', { set: { objectId: WECKER, role: 'switch', type: 'boolean', write: true } }));
      expect(entityOf(device, false)).to.include({ domain: 'switch', state: 'off', available: true });
    });

    it('binary_sensor: a read-only boolean on actual', () => {
      const device = only({ stateId: ANWESEND, domain: 'binary_sensor' });
      expect(device.channels).to.deep.equal({ actual: { objectId: ANWESEND, role: 'indicator', type: 'boolean', write: false } });
      expect(entityOf(device, true)).to.include({ domain: 'binary_sensor', state: 'on', available: true });
    });

    it('sensor: a read-only number, its unit and device class from the object', () => {
      const device = only({ stateId: VERBRAUCH, domain: 'sensor' });
      expect(device.channels).to.deep.equal({ actual: { objectId: VERBRAUCH, role: 'value.power', unit: 'W', type: 'number', write: false } });
      const entity = entityOf(device, 1234.5)!;
      expect(entity).to.include({ domain: 'sensor', state: '1234.5', available: true });
      expect(entity.attributes).to.include({ unit_of_measurement: 'W', device_class: 'power', state_class: 'measurement' });
    });

    it('sensor: a writable text is still read on actual -- a sensor writes nothing', () => {
      const device = only({ stateId: NOTIZ, domain: 'sensor' });
      expect(device.channels).to.deep.equal({ actual: { objectId: NOTIZ, role: 'text', type: 'string', write: true } });
      expect(entityOf(device, 'Fenster putzen')).to.include({ domain: 'sensor', state: 'Fenster putzen' });
    });

    it('sensor: a state without a type holds any value', () => {
      const device = only({ stateId: OHNE_TYP, domain: 'sensor' });
      expect(device.channels).to.deep.equal({ actual: { objectId: OHNE_TYP, role: 'state', write: true } });
      expect(entityOf(device, 7)).to.include({ domain: 'sensor', state: '7' });
    });

    it('switch: a state declaring no write flag is on set, where the dispatcher writes it (Ruling 38)', () => {
      expect(only({ stateId: RELAIS, domain: 'switch' }).channels).to.deep.equal({ set: { objectId: RELAIS, role: 'switch', type: 'boolean' } });
    });

    it('scene: a button on set, with its icon', () => {
      const device = only({ stateId: NACHT, domain: 'scene' });
      expect(device).to.deep.equal({
        ...manualDevice(NACHT, 'Gute Nacht', 'scene', { set: { objectId: NACHT, role: 'button', type: 'boolean', write: true } }),
        icon: MOND,
      });
      expect(entityOf(device, false)).to.include({ domain: 'scene', available: true });
    });

    it("takes the entry's own name when it has one, else the object's", () => {
      expect(only({ stateId: SOLL, domain: 'number', name: '  Wohnzimmer Soll ' }).name).to.equal('Wohnzimmer Soll');
      expect(only({ stateId: SOLL, domain: 'number', name: '   ' }).name).to.equal('Solltemperatur');
    });

    it('builds its channel and icon exactly as detection builds the same state in a channel', () => {
      // The same objects, each alone in an alias channel, as detection sees
      // them: whatever type detects each, its one channel must be the manual
      // entity's channel, bar the object id, and its icon the same.
      const cases: Array<[string, string, ManualEntity['domain']]> = [
        [SOLL, 'thermostat', 'number'],
        [VORLAUF, 'slider', 'number'],
        [MODUS, 'info', 'select'],
        [PROFIL, 'info', 'select'],
        [WECKZEIT, 'info', 'datetime'],
        [KLINGELTE, 'info', 'datetime'],
        [WECKER, 'socket', 'switch'],
        [NOTIZ, 'info', 'sensor'],
        [NACHT, 'button', 'scene'],
      ];
      for (const [stateId, detectedAs, domain] of cases) {
        const root = `alias.0.Probe.${stateId.split('.').pop()}`;
        const probe = objects({ _id: root, type: 'channel', common: { name: 'Probe' }, native: {} }, { ...ALL[stateId]!, _id: `${root}.value` });
        const detected = discoverDevices(probe, NS).devices;
        expect(detected.map((d) => d.detectorType), stateId).to.deep.equal([detectedAs]);
        const [detectedChannel] = Object.values(detected[0]!.channels);
        const manual = only({ stateId, domain });
        expect({ channel: Object.values(manual.channels)[0], icon: manual.icon }, stateId).to.deep.equal({
          channel: { ...detectedChannel, objectId: stateId },
          icon: detected[0]!.icon,
        });
      }
    });
  });

  describe('writes', () => {
    it('land where the dispatcher writes: set for a writable state, and never on a read-only one', async () => {
      const { devices } = manualDevices(
        [
          { stateId: WECKER, domain: 'switch' },
          { stateId: NACHT, domain: 'scene' },
          { stateId: ANWESEND, domain: 'switch', name: 'Anwesend' },
        ],
        ALL,
        NS,
      );
      const registry = new EntityRegistry(QUIET, 0);
      registry.rebuild(devices, {});
      const writes: Array<[string, unknown]> = [];
      const dispatcher = new Dispatcher(
        { byId: (id) => registry.byId(id), bySceneAlias: (alias) => (alias === 'nacht' ? registry.byId('scene.gute_nacht') : undefined) },
        async (objectId, written) => {
          writes.push([objectId, written]);
        },
        silentLog,
      );
      expect(await dispatcher.dispatch({ kind: 'turn_off', entityId: 'switch.wecker_aktiv' })).to.deep.equal({ ok: true, writes: 1 });
      expect(await dispatcher.dispatch({ kind: 'activate_scene', alias: 'nacht' })).to.deep.equal({ ok: true, writes: 1 });
      expect(await dispatcher.dispatch({ kind: 'turn_on', entityId: 'switch.anwesend' })).to.deep.equal({
        ok: false,
        reason: 'no_writable_channel',
        applied: 0,
      });
      expect(writes).to.deep.equal([
        [WECKER, false],
        [NACHT, true],
      ]);
    });
  });

  describe('rejections', () => {
    it('rejects every entry it cannot serve, with its reason in English, and never throws', () => {
      const { devices, rejected } = manualDevices(
        [
          { stateId: SOLL, domain: 'light' },
          // Not even a domain, and a key every plain object inherits.
          { stateId: VORLAUF, domain: 'toString' },
          { stateId: `${U}.Haus.Fehlt`, domain: 'sensor' },
          { stateId: 'constructor', domain: 'sensor' },
          { stateId: `${U}.Heizung`, domain: 'sensor' },
          { stateId: MELDER, domain: 'switch' },
          { stateId: OWN._id, domain: 'sensor' },
          { stateId: VERBRAUCH, domain: 'switch' },
          { stateId: NOTIZ, domain: 'number' },
          { stateId: ANWESEND, domain: 'sensor' },
          { stateId: WECKER, domain: 'select' },
          { stateId: NACHT, domain: 'datetime' },
          { stateId: MODUS, domain: 'scene' },
          { stateId: KONFIG, domain: 'binary_sensor' },
          { stateId: OHNE_TYP, domain: 'switch' },
        ],
        ALL,
        NS,
      );
      expect(devices).to.deep.equal([]);
      const domains = 'sensor, binary_sensor, switch, scene, number, select, datetime';
      expect(rejected).to.deep.equal([
        { stateId: SOLL, reason: `"light" is not a domain one state can serve (${domains})` },
        { stateId: VORLAUF, reason: `"toString" is not a domain one state can serve (${domains})` },
        { stateId: `${U}.Haus.Fehlt`, reason: 'no such object' },
        { stateId: 'constructor', reason: 'no such object' },
        { stateId: `${U}.Heizung`, reason: 'not a state object (type folder)' },
        { stateId: MELDER, reason: 'not a state object (type device)' },
        { stateId: OWN._id, reason: "the adapter's own state" },
        { stateId: VERBRAUCH, reason: 'switch cannot use a state of type number' },
        { stateId: NOTIZ, reason: 'number cannot use a state of type string' },
        { stateId: ANWESEND, reason: 'sensor cannot use a state of type boolean' },
        { stateId: WECKER, reason: 'select cannot use a state of type boolean' },
        { stateId: NACHT, reason: 'datetime cannot use a state of type boolean' },
        { stateId: MODUS, reason: 'scene cannot use a state of type number' },
        { stateId: KONFIG, reason: 'binary_sensor cannot use a state of type object' },
        { stateId: OHNE_TYP, reason: 'switch cannot use a state of type mixed (none declared)' },
      ]);
    });

    it('keeps the first entry of a state listed twice, and reports each state once', () => {
      const { devices, rejected } = manualDevices(
        [
          { stateId: SOLL, domain: 'number' },
          { stateId: SOLL, domain: 'sensor', name: 'Zweimal' },
          { stateId: SOLL, domain: 'sensor' },
          // The first entry decides even when it is the one refused.
          { stateId: ANWESEND, domain: 'light' },
          { stateId: ANWESEND, domain: 'binary_sensor' },
        ],
        ALL,
        NS,
      );
      expect(devices.map((device) => [device.objectId, device.domain, device.name])).to.deep.equal([
        [`manual:${SOLL}`, 'number', 'Solltemperatur'],
      ]);
      expect(rejected).to.deep.equal([
        { stateId: SOLL, reason: 'listed more than once; the first entry is used' },
        { stateId: ANWESEND, reason: '"light" is not a domain one state can serve (sensor, binary_sensor, switch, scene, number, select, datetime)' },
      ]);
    });
  });

  describe('ids', () => {
    // Two helpers of one name: the second's id is the first's with a suffix,
    // so without the stored ids their order would decide which is which.
    const ENTRIES: ManualEntity[] = [
      { stateId: VERBRAUCH, domain: 'sensor', name: 'Haus' },
      { stateId: NOTIZ, domain: 'sensor', name: 'Haus' },
      { stateId: SOLL, domain: 'number' },
    ];
    const rebuild = (registry: EntityRegistry, entries: ManualEntity[], persisted: Record<string, string>): Record<string, string> =>
      registry.rebuild(manualDevices(entries, ALL, NS).devices, persisted).entityIds;

    it('are keyed by state id, and stay across rebuilds, restarts and a reordered list', () => {
      const registry = new EntityRegistry(QUIET, 0);
      const first = rebuild(registry, ENTRIES, {});
      expect(first).to.deep.equal({
        [`manual:${VERBRAUCH}`]: 'sensor.haus',
        [`manual:${NOTIZ}`]: 'sensor.haus_2',
        [`manual:${SOLL}`]: 'number.solltemperatur',
      });
      // The same registry rebuilt, then a restart: a new registry given what
      // the last run stored, as main.ts gives it.
      const second = rebuild(registry, ENTRIES, first);
      expect(second).to.deep.equal(first);
      const restarted = rebuild(new EntityRegistry(QUIET, 0), ENTRIES, second);
      expect(restarted).to.deep.equal(first);
      // The admin table reordered: each state keeps its own id.
      const reordered = [...ENTRIES].reverse();
      expect(rebuild(new EntityRegistry(QUIET, 0), reordered, {})[`manual:${NOTIZ}`], 'without the stored ids').to.equal('sensor.haus');
      expect(rebuild(new EntityRegistry(QUIET, 0), reordered, restarted)).to.deep.equal(first);
    });
  });

  describe('the registry path', () => {
    it('subscribes the state, and a change of it updates the entity the way every channel does', () => {
      const changed: VirtualEntity[] = [];
      const registry = new EntityRegistry({ onEntityChanged: (entity) => changed.push(entity), onMembershipChanged: () => undefined }, 0);
      const result = registry.rebuild(manualDevices([{ stateId: VERBRAUCH, domain: 'sensor' }], ALL, NS).devices, {});
      expect(result.subscribe).to.deep.equal([VERBRAUCH]);
      expect(registry.byId('sensor.verbrauch')).to.include({ state: 'unavailable', available: false });

      registry.applyStateChange(VERBRAUCH, value(1234.5));
      registry.applyStateChange(VERBRAUCH, value(987));
      expect(changed.map((entity) => [entity.entityId, entity.state])).to.deep.equal([
        ['sensor.verbrauch', '1234.5'],
        ['sensor.verbrauch', '987'],
      ]);
    });
  });

  describe('beside detection', () => {
    it("a state that keys a detected control still gets its manual entity, under an id of its own", () => {
      const detected = discoverDevices(ALL, NS).devices;
      expect(detected.map((device) => [device.objectId, device.domain])).to.deep.equal([
        [MELDER, 'binary_sensor'],
        [`${MELDER}.state`, 'switch'],
      ]);
      const manual = manualDevices([{ stateId: `${MELDER}.state`, domain: 'binary_sensor', name: 'Flurlicht an' }], ALL, NS).devices;
      const changed: VirtualEntity[] = [];
      const registry = new EntityRegistry({ onEntityChanged: (entity) => changed.push(entity), onMembershipChanged: () => undefined }, 0);
      const { entityIds, subscribe } = registry.rebuild([...detected, ...manual], {});
      expect(entityIds).to.deep.equal({
        [MELDER]: 'binary_sensor.flur_melder',
        [`${MELDER}.state`]: 'switch.flur_melder_schalten',
        [`manual:${MELDER}.state`]: 'binary_sensor.flurlicht_an',
      });
      expect(registry.all().map((entity) => [entity.entityId, entity.domain])).to.have.deep.members([
        ['binary_sensor.flur_melder', 'binary_sensor'],
        ['switch.flur_melder_schalten', 'switch'],
        ['binary_sensor.flurlicht_an', 'binary_sensor'],
      ]);
      // One subscription serves both entities that read the state.
      expect(subscribe).to.deep.equal([`${MELDER}.occupancy`, `${MELDER}.state`]);
      registry.applyStateChange(`${MELDER}.state`, value(true));
      expect(changed.map((entity) => [entity.entityId, entity.state])).to.have.deep.members([
        ['switch.flur_melder_schalten', 'on'],
        ['binary_sensor.flurlicht_an', 'on'],
      ]);
      // And after a restart, from the stored ids.
      expect(new EntityRegistry(QUIET, 0).rebuild([...detected, ...manual], entityIds).entityIds).to.deep.equal(entityIds);
    });

    it('reaches the states detection leaves out: one beside a control of its root, a second loose one', () => {
      // Task 13 report, section 6: no device holds these, so no override can
      // reach them. A manual entity needs no device.
      const BAD = 'alias.0.Bad';
      const WETTER = 'alias.0.Wetter';
      const tree = objects(
        { _id: BAD, type: 'channel', common: { name: 'Bad' }, native: {} },
        state(`${BAD}.Schalten`, { name: 'Schalten', role: 'switch', type: 'boolean', write: true }),
        state(`${BAD}.Modus`, { name: 'Modus', role: 'state', type: 'string', write: true, states: { eco: 'Eco', comfort: 'Komfort' } }),
        { _id: WETTER, type: 'channel', common: { name: 'Wetter' }, native: {} },
        state(`${WETTER}.Heute`, { name: 'Heute', role: 'text', type: 'string', write: false }),
        state(`${WETTER}.Morgen`, { name: 'Morgen', role: 'text', type: 'string', write: false }),
      );
      const read = discoverDevices(tree, NS).devices.flatMap((device) => Object.values(device.channels).map((channel) => channel.objectId));
      expect(read).to.include.members([`${BAD}.Schalten`, `${WETTER}.Heute`]);
      expect(read).to.not.include(`${BAD}.Modus`);
      expect(read).to.not.include(`${WETTER}.Morgen`);

      const { devices, rejected } = manualDevices(
        [
          { stateId: `${BAD}.Modus`, domain: 'select' },
          { stateId: `${WETTER}.Morgen`, domain: 'sensor' },
        ],
        tree,
        NS,
      );
      expect(rejected).to.deep.equal([]);
      expect(devices.map((device) => [device.objectId, device.domain, Object.keys(device.channels)])).to.deep.equal([
        [`manual:${BAD}.Modus`, 'select', ['set']],
        [`manual:${WETTER}.Morgen`, 'sensor', ['actual']],
      ]);
    });

    it('leaves every detected device, and the id detection alone gives it, unchanged', () => {
      const detected = discoverDevices(ALL, NS).devices;
      const before = JSON.parse(JSON.stringify(detected)) as DeviceInput[];
      const alone = new EntityRegistry(QUIET, 0).rebuild(detected, {}).entityIds;
      // A manual entity that wants the motion sensor's very id: the same
      // domain and the same name, on a first start with nothing stored.
      const manual = manualDevices([{ stateId: ANWESEND, domain: 'binary_sensor', name: 'Flur Melder' }], ALL, NS).devices;
      const merged = new EntityRegistry(QUIET, 0).rebuild([...detected, ...manual], {}).entityIds;
      expect(detected).to.deep.equal(before);
      expect(merged).to.deep.equal({ ...alone, [`manual:${ANWESEND}`]: 'binary_sensor.flur_melder_2' });
    });
  });
});
