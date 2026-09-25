import { expect } from 'chai';
import type { ManualEntity } from '../../src/config/options';
import { buildStatePublish } from '../../src/protocol/state-payload';
import { discoverDevices } from '../../src/registry/detector';
import { EntityRegistry } from '../../src/registry/entity-registry';
import { listed, manualDevices } from '../../src/registry/manual';
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
// Its last segment matches no translation of its name (m7a).
const WECKZEIT = `${U}.Wecker.T1`;
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
      // The id's last segment, neither translation (objectMeta).
      const device = only({ stateId: WECKZEIT, domain: 'datetime' });
      expect(device).to.deep.equal(manualDevice(WECKZEIT, 'T1', 'datetime', { set: { objectId: WECKZEIT, role: 'text', type: 'string', write: true } }));
      const entity = entityOf(device, '06:45')!;
      expect(entity).to.include({ domain: 'datetime', state: '06:45', available: true });
      expect(entity.attributes).to.include({ friendly_name: 'T1', has_date: false, has_time: true });
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
    it('land where the dispatcher writes: set, for a writable state and one declaring no write flag (Ruling 38)', async () => {
      const { devices } = manualDevices(
        [
          { stateId: WECKER, domain: 'switch' },
          { stateId: NACHT, domain: 'scene' },
          { stateId: RELAIS, domain: 'switch' },
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
      expect(await dispatcher.dispatch({ kind: 'turn_on', entityId: 'switch.relais' })).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([
        [WECKER, false],
        [NACHT, true],
        [RELAIS, true],
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

    it('refuses a read-only state as a switch or a scene, whose every press would act on nothing (m3)', () => {
      // One call each: a state listed twice is a duplicate.
      expect(manualDevices([{ stateId: ANWESEND, domain: 'switch' }], ALL, NS)).to.deep.equal({
        devices: [],
        rejected: [{ stateId: ANWESEND, reason: 'switch cannot use a read-only state (write false); declare it as binary_sensor' }],
      });
      expect(manualDevices([{ stateId: ANWESEND, domain: 'scene' }], ALL, NS)).to.deep.equal({
        devices: [],
        rejected: [{ stateId: ANWESEND, reason: 'scene cannot use a read-only state (write false)' }],
      });
      // Only an explicit false: no write flag at all stays writable (Ruling 38).
      expect(manualDevices([{ stateId: RELAIS, domain: 'scene' }], ALL, NS).rejected).to.deep.equal([]);
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

    it('reports a state listed twice once, at any scale: its time grows linearly (m6)', () => {
      // Missing states, each listed twice: scanning the reports for each
      // duplicate took seconds at 50,000. Timed at two sizes, not against a
      // wall clock: four times the entries take about four times as long
      // when linear, sixteen times when quadratic.
      const time = (count: number): number => {
        const ids = Array.from({ length: count }, (_, i) => `${U}.Fehlt.S${i}`);
        const entries: ManualEntity[] = [...ids, ...ids].map((stateId) => ({ stateId, domain: 'sensor' }));
        const started = performance.now();
        const { rejected } = manualDevices(entries, ALL, NS);
        const elapsed = performance.now() - started;
        expect(rejected).to.have.length(count);
        expect(rejected[count - 1]).to.deep.equal({ stateId: ids[count - 1], reason: 'no such object' });
        return elapsed;
      };
      const small = time(25_000);
      const large = time(100_000);
      expect(large, `${large.toFixed(0)} ms for 100,000, ${small.toFixed(0)} ms for 25,000`).to.be.below(8 * small + 50);
    });

    it('lists at most 20 in a log line, then how many more (m6)', () => {
      const items = Array.from({ length: 23 }, (_, i) => `${U}.Fehlt.S${i} (no such object)`);
      expect(listed(items.slice(0, 20))).to.equal(items.slice(0, 20).join(', '));
      expect(listed(items)).to.equal(`${items.slice(0, 20).join(', ')}, and 3 more`);
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

    it("follow the table's edits: a rename keeps the id, a new domain gives one in it, other rows leave it alone (m7b)", () => {
      const soll: ManualEntity = { stateId: SOLL, domain: 'number', name: 'Soll' };
      const notiz: ManualEntity = { stateId: NOTIZ, domain: 'sensor' };
      const first = rebuild(new EntityRegistry(QUIET, 0), [soll, notiz], {});
      expect(first).to.deep.equal({ [`manual:${SOLL}`]: 'number.soll', [`manual:${NOTIZ}`]: 'sensor.notiz' });

      // Renamed: the tile keeps its id and shows the new name.
      const registry = new EntityRegistry(QUIET, 0);
      expect(rebuild(registry, [{ ...soll, name: 'Wohnzimmer' }, notiz], first)).to.deep.equal(first);
      expect(registry.byId('number.soll')?.attributes.friendly_name).to.equal('Wohnzimmer');

      // Another domain: an id in that domain, since the firmware routes by the prefix.
      expect(rebuild(new EntityRegistry(QUIET, 0), [{ ...soll, domain: 'sensor' }, notiz], first)).to.deep.equal({
        [`manual:${SOLL}`]: 'sensor.soll',
        [`manual:${NOTIZ}`]: 'sensor.notiz',
      });

      // A row added -- listed first, and wanting the very same id -- or one
      // removed: every other id stays.
      const added = rebuild(new EntityRegistry(QUIET, 0), [{ stateId: VORLAUF, domain: 'number', name: 'Soll' }, soll, notiz], first);
      expect(added).to.deep.equal({ ...first, [`manual:${VORLAUF}`]: 'number.soll_2' });
      expect(rebuild(new EntityRegistry(QUIET, 0), [notiz], added)).to.deep.equal({ [`manual:${NOTIZ}`]: 'sensor.notiz' });
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

  // Task 13 fix round 1: the editable synths' rules reach a manual entity
  // through the same synths and the same channel builder.
  describe('inherits the editable rules of Task 13 fix round 1', () => {
    const STUFE = `${U}.Lueftung.Stufe`;
    const NAECHSTER = `${U}.Wecker.Naechster`;
    const EXTRA = objects(
      ...USERDATA,
      folder(`${U}.Lueftung`, 'Lüftung'),
      // A percent helper as admin's object browser creates one: no bounds.
      state(STUFE, { name: 'Lüftungsstufe', role: 'level', type: 'number', unit: '%', write: true }),
      // A script's next alarm, in epoch milliseconds, and settable.
      state(NAECHSTER, { name: 'Nächster Wecker', role: 'value.time', type: 'number', write: true }),
    );
    const device = (entry: ManualEntity): DeviceInput => {
      const { devices, rejected } = manualDevices([entry], EXTRA, NS);
      expect(rejected, JSON.stringify(rejected)).to.deep.equal([]);
      return devices[0]!;
    };

    it("a number without common.step takes Home Assistant's derived step and is editable (Ruling 81)", () => {
      const entity = entityOf(device({ stateId: VORLAUF, domain: 'number' }), 45)!;
      expect(entity.attributes).to.include({ min: 20, max: 60, step: 1, unit_of_measurement: '°C' });
      expect(entity.writable).to.deep.equal({ value: true });
    });

    it('a number whose object declares no write flag is writable, as ioBroker defaults it; write false stays read-only (Ruling 89)', () => {
      // No pattern fills a manual channel's write flag, as detection's does
      // (channelInput), so the synth's own rule decides: only write false is
      // read-only, as for the dispatcher (Ruling 38).
      const X = '0_userdata.0.P.x';
      const silent = objects(state(X, { type: 'number', role: 'level', min: 5, max: 30, step: 0.5 }));
      const [open] = manualDevices([{ stateId: X, domain: 'number' }], silent, NS).devices;
      expect(open!.channels).to.deep.equal({ set: { objectId: X, role: 'level', type: 'number', min: 5, max: 30, step: 0.5 } });
      expect(entityOf(open!, 12)!.writable).to.deep.equal({ value: true });

      const closed = objects(state(X, { type: 'number', role: 'level', min: 5, max: 30, step: 0.5, write: false }));
      const [locked] = manualDevices([{ stateId: X, domain: 'number' }], closed, NS).devices;
      expect(entityOf(locked!, 12)!.writable).to.deep.equal({ value: false });
    });

    it('a percent number without bounds is 0..100 (Ruling 82)', () => {
      const entity = entityOf(device({ stateId: STUFE, domain: 'number' }), 40)!;
      expect(entity).to.include({ state: '40', available: true });
      expect(entity.attributes).to.include({ friendly_name: 'Lüftungsstufe', min: 0, max: 100, step: 1, unit_of_measurement: '%' });
      expect(entity.writable).to.deep.equal({ value: true });
    });

    describe('in a pinned host zone', () => {
      let zone: string | undefined;
      before(() => {
        zone = process.env.TZ;
        process.env.TZ = 'Europe/Berlin';
      });
      after(() => {
        if (zone === undefined) delete process.env.TZ;
        else process.env.TZ = zone;
      });

      it('an epoch-ms datetime shows the local date and time and is editable (Ruling 84)', () => {
        const entity = entityOf(device({ stateId: NAECHSTER, domain: 'datetime' }), 1_758_600_000_000)!;
        expect(entity).to.include({ domain: 'datetime', state: '2025-09-23 06:00:00', available: true });
        expect(entity.attributes).to.include({ friendly_name: 'Nächster Wecker', has_date: true, has_time: true });
        expect(entity.writable).to.deep.equal({ value: true });
      });
    });

    it('a helper whose value is still null is unknown, available and editable, through the registry (Ruling 88)', () => {
      // A new 0_userdata helper holds no value until something writes one.
      const entries: ManualEntity[] = [
        { stateId: VORLAUF, domain: 'number' },
        { stateId: MODUS, domain: 'select' },
        { stateId: NAECHSTER, domain: 'datetime' },
      ];
      const registry = new EntityRegistry(QUIET, 0);
      const { entityIds } = registry.rebuild(manualDevices(entries, EXTRA, NS).devices, {});
      for (const entry of entries) registry.applyStateChange(entry.stateId, value(null));
      for (const entry of entries) {
        const entity = registry.byId(entityIds[`manual:${entry.stateId}`]!)!;
        expect(entity, entry.domain).to.include({ state: 'unknown', available: true });
        expect(entity.writable, entry.domain).to.deep.equal({ value: true });
      }
    });
  });

  // Task 13b fix round 1, m2: an editable value the synth leaves read-only
  // says why, so main.ts can name what the object lacks. The reasons follow
  // the synths' own rules; a missing step is none since Ruling 81.
  describe('says why a manual number, select or datetime is read-only (m2)', () => {
    const SIXTY_FIVE = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), `Stufe ${i}`]));
    const cases: Array<[string, string, Record<string, unknown>, unknown, string | undefined]> = [
      ['a number without min and max', 'number', { type: 'number', role: 'level', write: true }, 3, 'no min/max'],
      ['a number with a min only', 'number', { type: 'number', role: 'level', min: 0, write: true }, 3, 'no min/max'],
      ['a number whose min is not below its max', 'number', { type: 'number', role: 'level', min: 30, max: 5, write: true }, 3, 'min not below max'],
      ['a percent number whose min is 100', 'number', { type: 'number', role: 'level', unit: '%', min: 100, write: true }, 3, 'min not below max'],
      ['a number whose range is too wide', 'number', { type: 'number', role: 'level', min: -1e308, max: 1e308, write: true }, 3, 'range too wide'],
      ['a number with step 0', 'number', { type: 'number', role: 'level', min: 0, max: 10, step: 0, write: true }, 3, 'invalid step'],
      ['a number whose step is text', 'number', { type: 'number', role: 'level', min: 0, max: 10, step: '0.5', write: true }, 3, 'invalid step'],
      ['a number that refuses writes', 'number', { type: 'number', role: 'value', min: 0, max: 10, write: false }, 3, 'write is false'],
      ['a number without a step', 'number', { type: 'number', role: 'level', min: 0, max: 10, write: true }, 3, undefined],
      ['a select without states', 'select', { type: 'string', role: 'text', write: true }, 'a', 'no states'],
      ['a select of 65 states', 'select', { type: 'number', role: 'level.mode', states: SIXTY_FIVE, write: true }, 1, 'more than 64 states'],
      ['a select with a label on two lines', 'select', { type: 'string', role: 'text', states: { a: 'Eins\nZwei' }, write: true }, 'a', 'an empty, over-long, multi-line or malformed state label'],
      // Task 14 review m1: a lone UTF-16 surrogate, 0 or 4 bytes on the panel.
      ['a select with a broken label', 'select', { type: 'string', role: 'text', states: { a: 'Eins\udc00' }, write: true }, 'a', 'an empty, over-long, multi-line or malformed state label'],
      ['a select with one label twice', 'select', { type: 'number', role: 'level.mode', states: { 0: 'Aus', 1: 'aus' }, write: true }, 0, 'states that do not map one to one'],
      ['a select that refuses writes', 'select', { type: 'number', role: 'value', states: { 0: 'Aus' }, write: false }, 0, 'write is false'],
      ['a select with its states', 'select', { type: 'number', role: 'level.mode', states: { 0: 'Aus' }, write: true }, 0, undefined],
      ['a text datetime with no value and no kind declared', 'datetime', { type: 'string', role: 'text', write: true }, null, 'no value, and no kind declared'],
      ['a text datetime in a local format', 'datetime', { type: 'string', role: 'text', write: true }, '23.09.2026', 'a value that is no date or time'],
      ['a number datetime that is no epoch-ms date', 'datetime', { type: 'number', role: 'value', write: true }, 42, 'a number that is no epoch-ms date'],
      ['a datetime that refuses writes', 'datetime', { type: 'string', role: 'text', write: false }, '06:45', 'write is false'],
      ["a datetime in the panel's grammar", 'datetime', { type: 'string', role: 'text', write: true }, '06:45', undefined],
    ];
    for (const [what, domain, common, raw, why] of cases) {
      it(`${what}: ${why ?? 'editable'}`, () => {
        const id = `${U}.Pruefung.Wert`;
        const [device] = manualDevices([{ stateId: id, domain }], objects(state(id, { name: what, ...common })), NS).devices;
        const entity = entityOf(device!, raw)!;
        expect([entity.writable?.value, entity.readOnly]).to.deep.equal([why === undefined, why]);
      });
    }
  });

  describe('a declared datetime kind (Ruling 92)', () => {
    const ALARM = `${U}.Wecker.Alarm`;
    const NAECHSTER = `${U}.Wecker.Naechster`;
    const tree = objects(
      // A fresh text helper, as admin's object browser creates one: no value yet.
      state(ALARM, { name: 'Alarm', role: 'text', type: 'string', write: true }),
      state(NAECHSTER, { name: 'Nächster Wecker', role: 'value.time', type: 'number', write: true }),
    );
    const declared = (stateId: string, kind: 'date' | 'time' | 'datetime'): DeviceInput => {
      const { devices, rejected } = manualDevices([{ stateId, domain: 'datetime', kind }], tree, NS);
      expect(rejected).to.deep.equal([]);
      return devices[0]!;
    };
    const shown = (entity: VirtualEntity): unknown[] => [entity.attributes.has_date, entity.attributes.has_time, entity.writable?.value, entity.readOnly];

    it('makes a fresh null text helper editable as a time', () => {
      const device = declared(ALARM, 'time');
      expect(device).to.deep.equal({
        ...manualDevice(ALARM, 'Alarm', 'datetime', { set: { objectId: ALARM, role: 'text', type: 'string', write: true } }),
        kind: 'time',
      });
      const registry = new EntityRegistry(QUIET, 0);
      const { entityIds } = registry.rebuild([device], {});
      registry.applyStateChange(ALARM, value(null));
      const entity = registry.byId(entityIds[`manual:${ALARM}`]!)!;
      expect(entity).to.include({ domain: 'datetime', state: 'unknown', available: true });
      expect(shown(entity)).to.deep.equal([false, true, true, undefined]);
    });

    it('stands in only while the value gives no kind: an empty text takes it, a value of another kind is read-only', () => {
      const device = declared(ALARM, 'time');
      expect(shown(entityOf(device, '')!)).to.deep.equal([false, true, true, undefined]);
      expect(shown(entityOf(device, '06:45')!)).to.deep.equal([false, true, true, undefined]);
      expect(shown(entityOf(device, '2026-12-24')!)).to.deep.equal([true, false, false, 'a date value, declared kind time']);
      expect(shown(entityOf(device, '23.09.2026')!)).to.deep.equal([undefined, undefined, false, 'a value that is no date or time']);
    });

    it('an epoch number is a date and time: another declared kind leaves it read-only', () => {
      expect(shown(entityOf(declared(NAECHSTER, 'datetime'), null)!)).to.deep.equal([true, true, true, undefined]);
      expect(shown(entityOf(declared(NAECHSTER, 'time'), null)!)).to.deep.equal([
        true,
        true,
        false,
        'an epoch number is a date and time, declared kind time',
      ]);
    });

    it("is a datetime's alone: an entry of another domain keeps none", () => {
      expect(only({ stateId: SOLL, domain: 'number', kind: 'time' })).to.not.have.property('kind');
    });
  });

  describe('to the panel: the /control payload of a helper (Task 14)', () => {
    /** The path main.ts takes: the registry's entity, then buildStatePublish. Tokens are checked, then set aside. */
    function published(entry: ManualEntity, val: unknown, q = 0): { topic: string; fields: Record<string, unknown>; text: string } {
      const device = only(entry);
      const registry = new EntityRegistry(QUIET, 0);
      const { entityIds } = registry.rebuild([device], {});
      const [channel] = Object.values(device.channels);
      registry.applyStateChange(channel!.objectId, { val, ack: true, q, ts: 1_758_600_000_000 });
      const publish = buildStatePublish('ha/statestream', registry.byId(entityIds[device.objectId]!)!)!;
      expect(publish.retain).to.equal(true);
      const { session, revision, ...fields } = JSON.parse(publish.payload) as Record<string, unknown>;
      expect(session).to.match(/^[0-9a-f]{32}$/);
      expect(revision).to.match(/^[0-9a-f]{16}$/);
      return { topic: publish.topic, fields, text: publish.payload };
    }

    it('number: the value, its range, step and unit, writable, on the control leaf', () => {
      expect(published({ stateId: SOLL, domain: 'number' }, 21.5)).to.deep.include({
        topic: 'ha/statestream/number/solltemperatur/control',
        fields: {
          version: 1,
          kind: 'number',
          state: '21.5',
          available: true,
          writable: true,
          min: 15,
          max: 28,
          step: 0.5,
          mode: 'auto',
          unit: '°C',
          last_changed: 1_758_600_000,
        },
      });
    });

    it('a helper that holds no value yet goes out as "unknown", available and writable -- never null (Rulings 88, 91)', () => {
      // A JSON null would make the panel show "--" and refuse every edit
      // (value_control.cpp:72, :76), so a fresh helper could never be set.
      expect(published({ stateId: SOLL, domain: 'number' }, null).fields).to.include({ state: 'unknown', available: true, writable: true });
      expect(published({ stateId: MODUS, domain: 'select' }, null).fields).to.deep.include({
        state: 'unknown',
        available: true,
        writable: true,
        options: ['Aus', 'Eco', 'Komfort'],
      });
    });

    it('a value ioBroker flags as bad goes out as "unavailable", neither available nor writable', () => {
      expect(published({ stateId: SOLL, domain: 'number' }, 21.5, 0x42).fields).to.include({
        state: 'unavailable',
        available: false,
        writable: false,
        min: 15,
      });
    });

    it('select: the value as its label, the labels as a complete option list', () => {
      expect(published({ stateId: MODUS, domain: 'select' }, 2)).to.deep.include({
        topic: 'ha/statestream/select/heizmodus/control',
        fields: {
          version: 1,
          kind: 'select',
          state: 'Komfort',
          available: true,
          writable: true,
          options_complete: true,
          options: ['Aus', 'Eco', 'Komfort'],
          last_changed: 1_758_600_000,
        },
      });
    });

    it('datetime: a time text as kind time', () => {
      expect(published({ stateId: WECKZEIT, domain: 'datetime' }, '06:45').fields).to.include({ kind: 'time', state: '06:45', writable: true });
    });

    it('a read-only helper is not writable, and why stays in the log', () => {
      // A text with no states: no option list (Task 13b m2's "no states").
      const { fields, text } = published({ stateId: NOTIZ, domain: 'select' }, 'Fenster putzen');
      expect(fields).to.include({ kind: 'select', state: 'Fenster putzen', writable: false });
      expect(fields).to.not.have.any.keys('options', 'options_complete');
      expect(text).to.not.include('no states');
    });

    describe('the revision through the real synth (Task 14 review m3)', () => {
      /** State, kind and revision published after each value in turn, through one registry. */
      function sequence(entry: ManualEntity, values: unknown[], all: Record<string, IoObject> = ALL): Array<[unknown, unknown, unknown]> {
        const device = manualDevices([entry], all, NS).devices[0]!;
        const registry = new EntityRegistry(QUIET, 0);
        const { entityIds } = registry.rebuild([device], {});
        const [channel] = Object.values(device.channels);
        return values.map((val, index) => {
          registry.applyStateChange(channel!.objectId, { val, ack: true, q: 0, ts: 1_758_600_000_000 + index * 60_000 });
          const publish = buildStatePublish('ha/statestream', registry.byId(entityIds[device.objectId]!)!)!;
          const { state: shown, kind, revision } = JSON.parse(publish.payload) as Record<string, unknown>;
          return [shown, kind, revision];
        });
      }

      it('keeps it while only the value changes: a new one would make the panel give up an edit (value_control.cpp:816-817)', () => {
        const EPOCH = `${U}.Wecker.Epoch`;
        const runs: Array<[string, ManualEntity, unknown[], Record<string, IoObject>?]> = [
          ['number', { stateId: SOLL, domain: 'number' }, [21.5, 22, null]],
          ['select, one value without a label', { stateId: MODUS, domain: 'select' }, [0, 1, 2, 7, null]],
          // The panel writes a time back as HH:MM:SS (value_control.cpp:398-406)
          // into a helper that may hold HH:MM: both must be one kind of time.
          ['text time', { stateId: WECKZEIT, domain: 'datetime' }, ['06:45', '07:00:00', '23:59']],
          [
            'epoch datetime',
            { stateId: EPOCH, domain: 'datetime' },
            [1_758_600_000_000, 1_758_700_000_000, null],
            objects(state(EPOCH, { name: 'Epoch', role: 'value.time', type: 'number', write: true })),
          ],
        ];
        for (const [label, entry, values, all] of runs) {
          const published = sequence(entry, values, all);
          expect(new Set(published.map(([shown]) => shown)).size, `${label}: every value shown`).to.equal(values.length);
          expect(new Set(published.map(([, , revision]) => revision)), label).to.have.property('size', 1);
        }
      });

      it('changes it when a text changes shape: its kind is a constraint, not a value', () => {
        // A time that becomes a date is laid out anew (value_control.cpp:824),
        // and an edit in progress is given up (:816-817): its fields no longer apply.
        const [time, date] = sequence({ stateId: WECKZEIT, domain: 'datetime' }, ['06:45', '2026-09-23']);
        expect([time![1], date![1]]).to.deep.equal(['time', 'date']);
        expect(date![2]).to.not.equal(time![2]);
      });

      it('changes it with a constraint the object declares, the value the same', () => {
        const soll = (max: number): IoObject =>
          state(SOLL, { name: 'Solltemperatur', role: 'level.temperature', type: 'number', unit: '°C', min: 15, max, step: 0.5, write: true });
        const modus = (states: Record<string, string>): IoObject => state(MODUS, { name: 'Heizmodus', role: 'level.mode', type: 'number', states, write: true });
        const revision = (entry: ManualEntity, val: unknown, obj: IoObject): unknown => sequence(entry, [val], objects(obj))[0]![2];
        expect(revision({ stateId: SOLL, domain: 'number' }, 21.5, soll(30))).to.not.equal(revision({ stateId: SOLL, domain: 'number' }, 21.5, soll(28)));
        expect(revision({ stateId: MODUS, domain: 'select' }, 1, modus({ 0: 'Aus', 1: 'Eco', 2: 'Komfort', 3: 'Boost' }))).to.not.equal(
          revision({ stateId: MODUS, domain: 'select' }, 1, modus({ 0: 'Aus', 1: 'Eco', 2: 'Komfort' })),
        );
      });
    });
  });
});
