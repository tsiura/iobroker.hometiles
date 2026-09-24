import { expect } from 'chai';
import type { DeviceOverride } from '../../src/config/options';
import { discoverDevices, type IoBrokerObject } from '../../src/registry/detector';
import { idsToStore } from '../../src/registry/entity-id';
import { EntityRegistry } from '../../src/registry/entity-registry';
import { applyOverrides, detectedRows, mergeDetected, type Detected } from '../../src/registry/overrides';
import type { DeviceInput } from '../../src/registry/types';

const DEVICES: DeviceInput[] = [
  { objectId: 'a', name: 'A', detectorType: 'socket', domain: 'switch', channels: { set: { objectId: 'a.set' } } },
  { objectId: 'b', name: 'B', detectorType: 'temperature', domain: 'sensor', channels: { actual: { objectId: 'b.val' } } },
];

describe('registry/overrides', () => {
  describe('selection: nothing reaches the panels unless the user picks it (Task 21b)', () => {
    it('publishes no detected device that has no row', () => {
      expect(applyOverrides(DEVICES, [])).to.deep.equal([]);
    });

    it('publishes exactly the devices whose row says include true', () => {
      expect(applyOverrides(DEVICES, [{ objectId: 'b', include: true }])).to.deep.equal([DEVICES[1]]);
      const both = applyOverrides(DEVICES, [
        { objectId: 'a', include: true },
        { objectId: 'b', include: true },
      ]);
      expect(both).to.deep.equal(DEVICES);
    });

    it('publishes nothing for a row whose include is false, absent, or anything but true', () => {
      // A hand edit can leave any of these; only the admin checkbox's true picks.
      for (const include of [false, undefined, 'true', 1, null]) {
        const row = { objectId: 'a', include } as unknown as DeviceOverride;
        expect(applyOverrides(DEVICES, [row]), String(include)).to.deep.equal([]);
      }
    });

    it('renames a picked device', () => {
      const result = applyOverrides(DEVICES, [{ objectId: 'a', include: true, name: 'Kaffee' }]);
      expect(result.map((d) => [d.objectId, d.name])).to.deep.equal([['a', 'Kaffee']]);
    });

    it('forces a picked device into a different domain', () => {
      const result = applyOverrides(DEVICES, [{ objectId: 'b', include: true, forcedDomain: 'binary_sensor' }]);
      expect(result.map((d) => [d.objectId, d.domain])).to.deep.equal([['b', 'binary_sensor']]);
    });

    it('ignores a forced domain that is not a recognised domain', () => {
      // 'camera' is deliberately never a Domain member (out of scope by explicit
      // product decision), so it stays a valid negative case across releases
      // unlike a domain such as 'climate' that later became real in v0.2.
      const result = applyOverrides(DEVICES, [{ objectId: 'b', include: true, forcedDomain: 'camera' }]);
      expect(result.map((d) => [d.objectId, d.domain])).to.deep.equal([['b', 'sensor']]);
    });

    it('publishes nothing for a row whose device is detected no more', () => {
      expect(applyOverrides(DEVICES, [{ objectId: 'gone', include: true }])).to.deep.equal([]);
    });

    it('matches rows by object id, never by position', () => {
      const reordered = [...DEVICES].reverse();
      const result = applyOverrides(reordered, [
        { objectId: 'a', include: true, name: 'Renamed' },
        { objectId: 'b', include: true },
      ]);
      expect(result.map((d) => [d.objectId, d.name])).to.deep.equal([
        ['b', 'B'],
        ['a', 'Renamed'],
      ]);
    });

    it('ignores an empty name override rather than blanking the device name', () => {
      const result = applyOverrides(DEVICES, [{ objectId: 'a', include: true, name: '   ' }]);
      expect(result[0]!.name).to.equal('A');
    });
  });

  describe('the refresh merge (Task 21b)', () => {
    const found = (objectId: string, detectedName: string, detectedDomain: string, room = ''): Detected => ({
      objectId,
      detectedName,
      detectedDomain,
      room,
    });

    it('adds each newly detected device unticked, with no name and no forced domain', () => {
      expect(mergeDetected([], [found('hue.0.decke', 'Decke', 'light', 'Wohnzimmer')])).to.deep.equal([
        {
          objectId: 'hue.0.decke',
          include: false,
          name: '',
          forcedDomain: '',
          detectedName: 'Decke',
          detectedDomain: 'light',
          room: 'Wohnzimmer',
        },
      ]);
    });

    it("keeps a row's include, name and forced domain, and brings what detection found up to date", () => {
      const rows: DeviceOverride[] = [
        { objectId: 'hue.0.decke', include: true, name: 'Licht oben', forcedDomain: 'switch', detectedName: 'Alt', detectedDomain: 'switch', room: '' },
        // A row from before the picker, typed by hand: no detected fields yet.
        { objectId: 'zigbee.0.flur', include: false, name: 'Flur' },
      ];
      const merged = mergeDetected(rows, [
        found('hue.0.decke', 'Decke', 'light', 'Wohnzimmer'),
        found('zigbee.0.flur', 'Flur Bewegung', 'binary_sensor', 'Flur'),
      ]);
      expect(merged).to.deep.equal([
        { objectId: 'hue.0.decke', include: true, name: 'Licht oben', forcedDomain: 'switch', detectedName: 'Decke', detectedDomain: 'light', room: 'Wohnzimmer' },
        { objectId: 'zigbee.0.flur', include: false, name: 'Flur', detectedName: 'Flur Bewegung', detectedDomain: 'binary_sensor', room: 'Flur' },
      ]);
    });

    it('keeps the row of a device detected no more, exactly as it was', () => {
      const gone: DeviceOverride = { objectId: 'hm-rpc.0.weg', include: true, name: 'Weg', forcedDomain: '', detectedName: 'Weg', detectedDomain: 'switch', room: 'Keller' };
      expect(mergeDetected([gone], [found('hue.0.decke', 'Decke', 'light')])).to.deep.equal([
        { objectId: 'hm-rpc.0.weg', include: true, name: 'Weg', forcedDomain: '', detectedName: 'Weg', detectedDomain: 'switch', room: 'Keller' },
        { objectId: 'hue.0.decke', include: false, name: '', forcedDomain: '', detectedName: 'Decke', detectedDomain: 'light', room: '' },
      ]);
    });

    it('orders rows by object id, whatever order the rows and the detection came in, and a second refresh changes nothing', () => {
      const rows: DeviceOverride[] = [
        { objectId: 'zigbee.0.b', include: true },
        { objectId: 'alias.0.weg', include: false },
        { objectId: 'hue.0.a', include: false, name: 'A' },
      ];
      const detected = [found('zigbee.0.c', 'C', 'sensor'), found('hue.0.a', 'A', 'light'), found('zigbee.0.b', 'B', 'switch'), found('Zigbee.0.upper', 'U', 'sensor')];
      const merged = mergeDetected(rows, detected);
      // Code-unit order, the same under every locale: capitals first.
      expect(merged.map((row) => row.objectId)).to.deep.equal(['Zigbee.0.upper', 'alias.0.weg', 'hue.0.a', 'zigbee.0.b', 'zigbee.0.c']);
      expect(mergeDetected([...rows].reverse(), [...detected].reverse())).to.deep.equal(merged);
      expect(mergeDetected(merged, detected)).to.deep.equal(merged);
    });

    it('keeps the last of two rows for one device, the one the selection reads, and drops a row naming no object', () => {
      const rows = [
        { objectId: 'hue.0.a', include: false, name: 'first' },
        { objectId: '  ', include: true },
        { objectId: '', include: true },
        { objectId: 'hue.0.a', include: true, name: 'last' },
      ];
      const merged = mergeDetected(rows, [found('hue.0.a', 'A', 'light')]);
      expect(merged).to.deep.equal([{ objectId: 'hue.0.a', include: true, name: 'last', detectedName: 'A', detectedDomain: 'light', room: '' }]);
      // applyOverrides reads the same row.
      const device: DeviceInput = { objectId: 'hue.0.a', name: 'A', detectorType: 'light', domain: 'light', channels: {} };
      expect(applyOverrides([device], rows).map((d) => d.name)).to.deep.equal(['last']);
    });

    it('changes none of the rows it is given', () => {
      const rows: DeviceOverride[] = [{ objectId: 'hue.0.a', include: true, name: 'A', detectedName: 'Alt' }];
      const copy = JSON.parse(JSON.stringify(rows)) as DeviceOverride[];
      mergeDetected(rows, [found('hue.0.a', 'Neu', 'light')]);
      expect(rows).to.deep.equal(copy);
    });
  });

  describe('on a realistic installation, through the real detector', () => {
    type Common = Record<string, unknown>;
    const node = (type: string, common: Common): IoBrokerObject => ({ type, common });
    const state = (id: string, common: Common): [string, IoBrokerObject] => [id, node('state', { name: id.split('.').pop(), read: true, ...common })];
    const enumOf = (id: string, name: unknown, members: unknown): [string, IoBrokerObject] => [id, node('enum', { name, members })];

    const HUE = 'hue.0.Wohnzimmer_Decke';
    const MOTION = 'zigbee.0.000d6ffffe1a2b3c';
    const PLUG = 'shelly.0.SHPLG-S#6A1B2C#1';
    const RELAY = `${PLUG}.Relay0`;
    const LAMP = 'knx.0.Licht.Flur';
    const BALKON = 'zigbee.0.00158d0004a1b2c3';
    /** A second thermometer out there, named the same: people do. */
    const BALKON_2 = 'zigbee.0.00158d0004d0d0d0';
    const TREE: Record<string, IoBrokerObject> = Object.fromEntries([
      [HUE, node('channel', { name: 'Wohnzimmer Decke' })],
      state(`${HUE}.on`, { role: 'switch.light', type: 'boolean', write: true }),
      state(`${HUE}.level`, { role: 'level.dimmer', type: 'number', min: 0, max: 100, unit: '%', write: true }),
      state(`${HUE}.reachable`, { role: 'indicator.reachable', type: 'boolean', write: false }),
      [MOTION, node('device', { name: 'Flur Bewegung' })],
      state(`${MOTION}.occupancy`, { role: 'sensor.motion', type: 'boolean', write: false }),
      state(`${MOTION}.battery`, { role: 'value.battery', type: 'number', unit: '%', write: false }),
      [PLUG, node('device', { name: 'Kaffeemaschine' })],
      [RELAY, node('channel', { name: 'Relay0' })],
      state(`${RELAY}.Switch`, { role: 'switch', type: 'boolean', write: true }),
      state(`${RELAY}.Power`, { role: 'value.power', type: 'number', unit: 'W', write: false }),
      // A generic switch: only its function enum makes it a lamp.
      [LAMP, node('channel', { name: 'Flurlicht' })],
      state(`${LAMP}.Schalten`, { role: 'switch', type: 'boolean', write: true }),
      [BALKON, node('device', { name: 'Balkon' })],
      state(`${BALKON}.temperature`, { role: 'value.temperature', type: 'number', unit: '°C', write: false }),
      state(`${BALKON}.pressure`, { role: 'value.pressure', type: 'number', unit: 'hPa', write: false }),
      [BALKON_2, node('device', { name: 'Balkon' })],
      state(`${BALKON_2}.temperature`, { role: 'value.temperature', type: 'number', unit: '°C', write: false }),
      enumOf('enum.functions.licht', 'Licht', [LAMP]),
      enumOf('enum.functions.beleuchtung', { en: 'Lighting', de: 'Beleuchtung' }, [HUE]),
      enumOf('enum.rooms.living_room', { en: 'Living room', de: 'Wohnzimmer' }, [HUE]),
      enumOf('enum.rooms.hallway', 'Flur', [MOTION, LAMP]),
      // The whole plug is in the kitchen, so its relay channel is too.
      enumOf('enum.rooms.kitchen', 'Küche', [PLUG]),
      // Only the first thermometer's reading is in the room, not its pressure.
      enumOf('enum.rooms.balcony', 'Balkon', [`${BALKON}.temperature`, BALKON_2]),
      // Hand-corrupted: members that are no list, a member that is no id.
      enumOf('enum.rooms.broken', 'Kaputt', { length: 1 }),
      enumOf('enum.rooms.cellar', 'Keller', [5, null]),
    ]);
    const detected = discoverDevices(TREE, 'hometiles.0').devices;

    it('gives each detected device a row with its real name and domain, and the rooms and functions holding it', () => {
      expect(mergeDetected([], detectedRows(detected, TREE, 'de'))).to.deep.equal([
        { objectId: HUE, include: false, name: '', forcedDomain: '', detectedName: 'Wohnzimmer Decke', detectedDomain: 'light', room: 'Wohnzimmer, Beleuchtung' },
        { objectId: LAMP, include: false, name: '', forcedDomain: '', detectedName: 'Flurlicht', detectedDomain: 'light', room: 'Flur, Licht' },
        { objectId: RELAY, include: false, name: '', forcedDomain: '', detectedName: 'Relay0', detectedDomain: 'switch', room: 'Küche' },
        { objectId: MOTION, include: false, name: '', forcedDomain: '', detectedName: 'Flur Bewegung', detectedDomain: 'binary_sensor', room: 'Flur' },
        { objectId: BALKON, include: false, name: '', forcedDomain: '', detectedName: 'Balkon', detectedDomain: 'sensor', room: 'Balkon' },
        { objectId: `${BALKON}.pressure`, include: false, name: '', forcedDomain: '', detectedName: 'Balkon pressure', detectedDomain: 'sensor', room: '' },
        { objectId: BALKON_2, include: false, name: '', forcedDomain: '', detectedName: 'Balkon', detectedDomain: 'sensor', room: 'Balkon' },
      ]);
    });

    it("names a room in the system's language, else in English, else by its id", () => {
      const hue = detected.filter((device) => device.objectId === HUE);
      expect(detectedRows(hue, TREE, 'fr').map((row) => row.room)).to.deep.equal(['Living room, Lighting']);
      const unnamed = { 'enum.rooms.dachboden': node('enum', { name: { de: 'Dachboden' }, members: [HUE] }) };
      expect(detectedRows(hue, unnamed, 'fr').map((row) => row.room)).to.deep.equal(['dachboden']);
    });

    it('subscribes to the channels of the picked devices only', () => {
      const registry = new EntityRegistry({ onEntityChanged: () => undefined, onMembershipChanged: () => undefined }, 0);
      const rows: DeviceOverride[] = [
        { objectId: HUE, include: true },
        { objectId: `${BALKON}.pressure`, include: true },
        { objectId: MOTION, include: false },
      ];
      const result = registry.rebuild(applyOverrides(detected, rows), {});
      expect(result.subscribe).to.deep.equal([`${HUE}.level`, `${HUE}.on`, `${BALKON}.pressure`]);
      expect(registry.all().map((entity) => entity.entityId)).to.have.members(['light.wohnzimmer_decke', 'sensor.balkon_pressure']);
      expect(Object.keys(result.entityIds)).to.have.members([HUE, `${BALKON}.pressure`]);
    });

    it('keeps an entity id through pick, un-pick and re-pick, though another device took the name meanwhile', () => {
      // Each pick is a save, and so a rebuild: main.ts stores idsToStore's map.
      const registry = new EntityRegistry({ onEntityChanged: () => undefined, onMembershipChanged: () => undefined }, 0);
      let stored: Record<string, string> = {};
      const pick = (...objectIds: string[]): ReturnType<EntityRegistry['rebuild']> => {
        const result = registry.rebuild(applyOverrides(detected, objectIds.map((objectId) => ({ objectId, include: true }))), stored);
        stored = idsToStore(stored, detected, result.entityIds);
        return result;
      };

      pick(BALKON);
      expect(stored).to.deep.equal({ [BALKON]: 'sensor.balkon' });

      // Un-picked: the entity leaves through the removal path, its id stays stored.
      expect(pick().removed).to.deep.equal(['sensor.balkon']);
      expect(registry.all()).to.deep.equal([]);
      expect(stored).to.deep.equal({ [BALKON]: 'sensor.balkon' });

      // The other "Balkon", picked on its own, cannot take that id.
      pick(BALKON_2);
      expect(stored).to.deep.equal({ [BALKON]: 'sensor.balkon', [BALKON_2]: 'sensor.balkon_2' });

      pick(BALKON, BALKON_2);
      expect(registry.all().map((entity) => entity.entityId)).to.have.members(['sensor.balkon', 'sensor.balkon_2']);
      expect(stored).to.deep.equal({ [BALKON]: 'sensor.balkon', [BALKON_2]: 'sensor.balkon_2' });

      // A device detected no more loses its stored id, as before the picker.
      const without = detected.filter((device) => device.objectId !== BALKON);
      expect(idsToStore(stored, without, {})).to.deep.equal({ [BALKON_2]: 'sensor.balkon_2' });
      // Only an id the store itself holds: never an inherited property.
      expect(idsToStore({}, [{ ...detected[0]!, objectId: 'constructor' }], {})).to.deep.equal({});

      // Forced into another domain, a picked device gets an id there, and the
      // store holds the id in use, not the one before (Task 13b's rule).
      const forced = registry.rebuild(applyOverrides(detected, [{ objectId: BALKON, include: true, forcedDomain: 'binary_sensor' }]), stored);
      stored = idsToStore(stored, detected, forced.entityIds);
      expect(stored).to.deep.equal({ [BALKON]: 'binary_sensor.balkon', [BALKON_2]: 'sensor.balkon_2' });
    });
  });
});
