import { expect } from 'chai';
import { validateOptions, type ClimateModeRow, type DeviceOverride } from '../../src/config/options';
import { parseClimateCommand } from '../../src/protocol/commands';
import { discoverDevices, type IoBrokerObject } from '../../src/registry/detector';
import { idsToStore } from '../../src/registry/entity-id';
import { EntityRegistry } from '../../src/registry/entity-registry';
import { applyClimateModes, applyOverrides, detectedRows, mergeDetected, unbuiltForces, unbuiltPicks, type Detected } from '../../src/registry/overrides';
import type { HvacMode } from '../../src/registry/synth/climate';
import { synthesise } from '../../src/registry/synth/index';
import type { ChannelInput, DeviceInput } from '../../src/registry/types';
import { Dispatcher } from '../../src/runtime/dispatcher';

const DEVICES: DeviceInput[] = [
  { objectId: 'a', name: 'A', detectorType: 'socket', domain: 'switch', channels: { set: { objectId: 'a.set' } } },
  { objectId: 'b', name: 'B', detectorType: 'temperature', domain: 'sensor', channels: { actual: { objectId: 'b.val' } } },
];

describe('registry/overrides', () => {
  /**
   * A row as the picker writes it: Refresh fills in what detection found, and
   * only then does a ticked row count as a pick (Ruling 118).
   */
  const pick = (objectId: string, extra: Partial<DeviceOverride> = {}): DeviceOverride => ({
    objectId,
    include: true,
    detectedName: objectId.toUpperCase(),
    detectedDomain: 'switch',
    ...extra,
  });

  describe('selection: nothing reaches the panels unless the user picks it (Task 21b)', () => {
    it('publishes no detected device that has no row', () => {
      expect(applyOverrides(DEVICES, [])).to.deep.equal([]);
    });

    it('publishes exactly the devices whose picker row says include true', () => {
      expect(applyOverrides(DEVICES, [pick('b')])).to.deep.equal([DEVICES[1]]);
      expect(applyOverrides(DEVICES, [pick('a'), pick('b')])).to.deep.equal(DEVICES);
    });

    it('publishes nothing for a row whose include is false, absent, or anything but true', () => {
      // A hand edit can leave any of these; only the admin checkbox's true picks.
      for (const include of [false, undefined, 'true', 1, null]) {
        const row = { ...pick('a'), include } as unknown as DeviceOverride;
        expect(applyOverrides(DEVICES, [row]), String(include)).to.deep.equal([]);
      }
    });

    it('counts no row the picker did not write, however ticked (Ruling 118)', () => {
      // An earlier version's row: its include was ticked by default and meant "not excluded".
      expect(applyOverrides(DEVICES, [{ objectId: 'a', include: true, name: 'Kaffee', forcedDomain: 'switch' }])).to.deep.equal([]);
      // A row added with "+" and ticked: the admin leaves every column it has no default for null.
      const added = { include: true, detectedName: null, name: null, detectedDomain: null, forcedDomain: null, room: null, objectId: 'a' };
      expect(applyOverrides(DEVICES, [added as unknown as DeviceOverride])).to.deep.equal([]);
      // Nor a hand edit's empty or non-text mark.
      for (const detectedDomain of ['', 5, {}]) {
        expect(applyOverrides(DEVICES, [{ ...pick('a'), detectedDomain } as unknown as DeviceOverride]), String(detectedDomain)).to.deep.equal([]);
      }
    });

    it('renames a picked device', () => {
      const result = applyOverrides(DEVICES, [pick('a', { name: 'Kaffee' })]);
      expect(result.map((d) => [d.objectId, d.name])).to.deep.equal([['a', 'Kaffee']]);
    });

    it('forces a picked device into a different domain', () => {
      const result = applyOverrides(DEVICES, [pick('b', { forcedDomain: 'binary_sensor' })]);
      expect(result.map((d) => [d.objectId, d.domain])).to.deep.equal([['b', 'binary_sensor']]);
    });

    it('ignores a forced domain that is not a recognised domain', () => {
      // 'camera' is deliberately never a Domain member (out of scope by explicit
      // product decision), so it stays a valid negative case across releases
      // unlike a domain such as 'climate' that later became real in v0.2.
      const result = applyOverrides(DEVICES, [pick('b', { forcedDomain: 'camera' })]);
      expect(result.map((d) => [d.objectId, d.domain])).to.deep.equal([['b', 'sensor']]);
    });

    it('publishes nothing for a row whose device is detected no more', () => {
      expect(applyOverrides(DEVICES, [pick('gone')])).to.deep.equal([]);
    });

    it('matches rows by object id, never by position', () => {
      const reordered = [...DEVICES].reverse();
      const result = applyOverrides(reordered, [pick('a', { name: 'Renamed' }), pick('b')]);
      expect(result.map((d) => [d.objectId, d.name])).to.deep.equal([
        ['b', 'B'],
        ['a', 'Renamed'],
      ]);
    });

    it('ignores an empty name override rather than blanking the device name', () => {
      const result = applyOverrides(DEVICES, [pick('a', { name: '   ' })]);
      expect(result[0]!.name).to.equal('A');
    });
  });

  describe('a picked device that makes no tile', () => {
    it("names a picked device whose own detected type makes no entity, with what it lacks; a forced type stays unbuiltForces' (T9)", () => {
      // A media player whose play state discovery set aside: a Chromecast whose detection bound its …paused.
      const player: DeviceInput = { objectId: 'cast', name: 'Cast', detectorType: 'media', domain: 'media_player', channels: { volume: { objectId: 'cast.volume' } } };
      const detected = [...DEVICES, player];
      const picked = applyOverrides(detected, [pick('cast', { detectedDomain: 'media_player' }), pick('b', { detectedDomain: 'sensor', forcedDomain: 'media_player' })]);
      expect(unbuiltPicks(detected, picked)).to.deep.equal([{ objectId: 'cast', domain: 'media_player', lack: 'player_state' }]);
      expect(unbuiltForces(detected, picked)).to.deep.equal([{ objectId: 'b', domain: 'media_player', lack: 'player_state' }]);
    });
  });

  describe('climate modes the panel does not name (Ruling 141)', () => {
    const MODES = { 0: 'AUTO-MODE', 1: 'MANU-MODE', 2: 'PARTY-MODE', 3: 'BOOST-MODE' };
    const thermostat = (objectId: string, mode?: ChannelInput): DeviceInput => ({
      objectId,
      name: objectId,
      detectorType: 'thermostat',
      domain: 'climate',
      channels: { set: { objectId: `${objectId}.SET`, type: 'number', write: true }, ...(mode ? { mode } : {}) },
    });
    const modeOf = (objectId: string, extra: Partial<ChannelInput> = {}): ChannelInput => ({
      objectId: `${objectId}.MODE`,
      type: 'number',
      write: true,
      states: MODES,
      ...extra,
    });
    const row = (device: string, deviceMode: string, panelMode: HvacMode): ClimateModeRow => ({ device, deviceMode, panelMode });
    const states = (devices: readonly DeviceInput[], objectId: string): Record<string, string> | undefined =>
      devices.find((device) => device.objectId === objectId)?.channels.mode?.states;

    it('relabels each mapped state with its panel mode, named by its value or by its label in any case, and leaves every other label and device as it was', () => {
      const devices = [thermostat('t1', modeOf('t1')), DEVICES[0]!];
      const { devices: mapped, rejected } = applyClimateModes(devices, [row('t1', ' manu-mode ', 'heat'), row('t1', '0', 'auto')]);
      expect(rejected).to.deep.equal([]);
      expect(states(mapped, 't1')).to.deep.equal({ 0: 'auto', 1: 'heat', 2: 'PARTY-MODE', 3: 'BOOST-MODE' });
      expect(mapped[1]).to.equal(DEVICES[0]);
      // Nothing it was given changes, and no row changes nothing.
      expect(devices[0]!.channels.mode!.states).to.deep.equal(MODES);
      expect(applyClimateModes(devices, [])).to.deep.equal({ devices, rejected: [] });
    });

    it("leaves out a row for a mode state that lists no states: nothing tells what it holds, so the panel's heat would write what was typed (review n1's probe)", async () => {
      /** What the panel's heat writes to a device holding `current`, through the real synth and dispatcher. */
      async function heat(device: DeviceInput, current: unknown): Promise<unknown[]> {
        const entity = synthesise(device, 'climate.t', { [device.channels.mode!.objectId]: { val: current, ack: true, q: 0, ts: 1 } })!;
        const writes: unknown[] = [];
        const silent = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
        const dispatcher = new Dispatcher({ byId: () => entity, bySceneAlias: () => undefined }, async (_id, value) => void writes.push(value), silent);
        await dispatcher.dispatch(parseClimateCommand('{"entity_id":"climate.t","command":"set_hvac_mode","hvac_mode":"heat"}'));
        return writes;
      }
      // Typed in another case than the state holds it; the device's own "Heat" beside a "Manual" typed as heat;
      // a number it may never hold; a mixed state, whose lone current option would write the text "1" for the number 1.
      const probes: Array<[ChannelInput['type'], string, unknown]> = [
        ['string', 'manual', 'Manual'],
        ['string', 'Manual', 'Heat'],
        ['number', '7', 1],
        ['mixed', '1', 1],
      ];
      for (const [type, deviceMode, current] of probes) {
        const device = thermostat('t', modeOf('t', { type, states: undefined }));
        const { devices, rejected } = applyClimateModes([device], [row('t', deviceMode, 'heat')]);
        expect(rejected, `${type} ${deviceMode}`).to.deep.equal([{ row: row('t', deviceMode, 'heat'), reason: 't.MODE lists no states to match a device mode against' }]);
        // As before the row: no list to press, and heat writes nothing.
        expect(devices[0], type).to.equal(device);
        expect(synthesise(devices[0]!, 'climate.t', {})!.attributes, type).to.not.have.property('hvac_modes');
        expect(await heat(devices[0]!, current), `${type} ${deviceMode}`).to.deep.equal([]);
      }
    });

    it('leaves out, each with its reason, a row whose device is no picked climate device, whose device has no mode state, or whose device mode is not exactly one state', () => {
      const devices = [thermostat('t1', modeOf('t1', { states: { ...MODES, 4: 'manu-mode' } })), thermostat('t2'), DEVICES[1]!];
      const rows = [
        row('nirgends', 'AUTO-MODE', 'auto'),
        row('b', 'AUTO-MODE', 'auto'),
        row('t2', 'AUTO-MODE', 'auto'),
        row('t1', 'ECO', 'auto'),
        // Two states have this label, case aside: the codec could not tell them apart either.
        row('t1', 'MANU-MODE', 'heat'),
        row('t1', 'AUTO-MODE', 'auto'),
      ];
      const { devices: mapped, rejected } = applyClimateModes(devices, rows);
      expect(rejected).to.deep.equal([
        { row: rows[0], reason: 'no climate device of this id is picked on the Devices tab' },
        { row: rows[1], reason: 'no climate device of this id is picked on the Devices tab' },
        { row: rows[2], reason: 'the device has no mode state' },
        { row: rows[3], reason: 'not exactly one value or label of t1.MODE' },
        { row: rows[4], reason: 'not exactly one value or label of t1.MODE' },
      ]);
      expect(states(mapped, 't1')).to.deep.equal({ ...MODES, 0: 'auto', 4: 'manu-mode' });
    });

    it('leaves out every row that maps one state twice, and every row whose panel mode would stand for more than one device mode, a label that is that name already included', () => {
      const devices = [thermostat('t1', modeOf('t1', { states: { ...MODES, 4: 'Heat' } })), thermostat('t2', modeOf('t2'))];
      const rows = [
        // One state twice, by label and by value.
        row('t1', 'AUTO-MODE', 'auto'),
        row('t1', '0', 'auto'),
        // Two states as heat: which one the panel's heat writes would be a guess.
        row('t2', 'MANU-MODE', 'heat'),
        row('t2', 'BOOST-MODE', 'heat'),
        // Heat is the label of state 4 already, case aside, as the codec reads it.
        row('t1', 'MANU-MODE', 'heat'),
        row('t1', 'PARTY-MODE', 'fan_only'),
        row('t2', 'AUTO-MODE', 'auto'),
      ];
      const { devices: mapped, rejected } = applyClimateModes(devices, rows);
      expect(rejected).to.deep.equal([
        { row: rows[0], reason: 'this device mode is mapped more than once' },
        { row: rows[1], reason: 'this device mode is mapped more than once' },
        { row: rows[2], reason: 'heat would stand for more than one device mode' },
        { row: rows[3], reason: 'heat would stand for more than one device mode' },
        { row: rows[4], reason: 'heat would stand for more than one device mode' },
      ]);
      expect(states(mapped, 't1')).to.deep.equal({ ...MODES, 2: 'fan_only', 4: 'Heat' });
      expect(states(mapped, 't2')).to.deep.equal({ ...MODES, 0: 'auto' });
    });

    it('checks again once a row is left out: the state it would have renamed keeps its own label, which can clash in turn', () => {
      // 0 and 2 both as cool clash; left out, state 0 is heat again, the panel mode row 3 gives state 1.
      const own = { 0: 'heat', 1: 'MANU', 2: 'X' };
      const devices = [thermostat('t1', modeOf('t1', { states: own }))];
      const rows = [row('t1', '0', 'cool'), row('t1', '2', 'cool'), row('t1', '1', 'heat')];
      const { devices: mapped, rejected } = applyClimateModes(devices, rows);
      expect(rejected).to.deep.equal([
        { row: rows[0], reason: 'cool would stand for more than one device mode' },
        { row: rows[1], reason: 'cool would stand for more than one device mode' },
        { row: rows[2], reason: 'heat would stand for more than one device mode' },
      ]);
      expect(states(mapped, 't1')).to.deep.equal(own);
    });
  });

  describe('the refresh merge (Task 21b)', () => {
    const found = (objectId: string, detectedName: string, detectedDomain: string, room = ''): Detected => ({
      objectId,
      detectedName,
      detectedDomain,
      room,
    });
    /** A form this version of the picker armed: its ticks are the user's. */
    const ARMED = { armed: true };

    it("unticks every row of a form this picker did not arm, a 44d1111 Refresh's too, and keeps the ticks of one it did (Ruling 120, N2)", () => {
      // What a saved 44d1111 Refresh left: the row filled in and still ticked
      // from the earlier version, the user never having ticked it. A 4cbb6d3
      // Refresh leaves the same shape: only the form's marker tells them apart.
      const row: DeviceOverride = { objectId: 'zigbee.0.a', include: true, name: 'Draußen', detectedName: 'Balkon', detectedDomain: 'sensor', room: '' };
      const again = [found('zigbee.0.a', 'Balkon', 'sensor')];
      expect(mergeDetected([row], again)).to.deep.equal([{ ...row, include: false }]);
      expect(mergeDetected([row], again, { armed: false })).to.deep.equal([{ ...row, include: false }]);
      // Ticked again by the user in a form this picker armed, it stays ticked.
      expect(mergeDetected([row], again, ARMED)).to.deep.equal([row]);
    });

    it('keeps a row it cannot read -- an object id that is not text, or no object at all -- where it stands, as it is (Ruling 120, N4)', () => {
      const unreadable = [{ objectId: null, include: true, forcedDomain: 'switch' }, 'x', null, { objectId: 5 }];
      const rows = [...unreadable, { objectId: 'hue.0.a', include: true, forcedDomain: 'light', detectedDomain: 'light' }];
      const merged = mergeDetected(rows, [found('hue.0.a', 'A', 'light'), found('hue.0.b', 'B', 'light')], ARMED);
      expect(merged).to.deep.equal([
        ...unreadable,
        { objectId: 'hue.0.a', include: true, forcedDomain: 'light', detectedName: 'A', detectedDomain: 'light', room: '' },
        { objectId: 'hue.0.b', include: false, name: '', forcedDomain: '', detectedName: 'B', detectedDomain: 'light', room: '' },
      ]);
      // validateOptions leaves each of them out: none selects anything.
      expect(validateOptions({ deviceOverrides: unreadable as unknown as DeviceOverride[] }).options.deviceOverrides).to.deep.equal([]);
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

    it("keeps a picker row's include, name and forced domain, brings what detection found up to date, and shows an earlier version's row unticked (Ruling 118)", () => {
      const rows: DeviceOverride[] = [
        { objectId: 'hue.0.decke', include: true, name: 'Licht oben', forcedDomain: 'switch', detectedName: 'Alt', detectedDomain: 'switch', room: '' },
        // An earlier version's row: ticked by default, it meant "not excluded".
        { objectId: 'zigbee.0.flur', include: true, name: 'Flur', forcedDomain: 'binary_sensor' },
      ];
      const merged = mergeDetected(rows, [
        found('hue.0.decke', 'Decke', 'light', 'Wohnzimmer'),
        found('zigbee.0.flur', 'Flur Bewegung', 'binary_sensor', 'Flur'),
      ], ARMED);
      expect(merged).to.deep.equal([
        { objectId: 'hue.0.decke', include: true, name: 'Licht oben', forcedDomain: 'switch', detectedName: 'Decke', detectedDomain: 'light', room: 'Wohnzimmer' },
        { objectId: 'zigbee.0.flur', include: false, name: 'Flur', forcedDomain: 'binary_sensor', detectedName: 'Flur Bewegung', detectedDomain: 'binary_sensor', room: 'Flur' },
      ]);
      // Unticked, it is no pick; ticked again by the user, it is one.
      const flur: DeviceInput = { objectId: 'zigbee.0.flur', name: 'Flur Bewegung', detectorType: 'motion', domain: 'binary_sensor', channels: {} };
      expect(applyOverrides([flur], merged)).to.deep.equal([]);
      expect(applyOverrides([flur], [{ ...merged[1]!, include: true }]).map((d) => d.name)).to.deep.equal(['Flur']);
    });

    it('keeps the row of a device detected no more, its choices as they were, and marks it in its detected name (Ruling 117)', () => {
      const gone: DeviceOverride = { objectId: 'hm-rpc.0.weg', include: true, name: 'Weg', forcedDomain: '', detectedName: 'Weg', detectedDomain: 'switch', room: 'Keller' };
      expect(mergeDetected([gone], [found('hue.0.decke', 'Decke', 'light')], ARMED)).to.deep.equal([
        { objectId: 'hm-rpc.0.weg', include: true, name: 'Weg', forcedDomain: '', detectedName: 'Weg (not detected)', detectedDomain: 'switch', room: 'Keller' },
        { objectId: 'hue.0.decke', include: false, name: '', forcedDomain: '', detectedName: 'Decke', detectedDomain: 'light', room: '' },
      ]);
    });

    it('marks a missing device once, in the text it is given, and unmarks it once it is detected again (Ruling 117)', () => {
      // A row typed by hand, never detected, has no name to mark: the mark is all it shows.
      const rows: DeviceOverride[] = [
        { objectId: 'hm-rpc.0.weg', include: true, detectedName: 'Weg', detectedDomain: 'switch' },
        { objectId: 'knx.0.alt', include: false, name: 'Alt' },
      ];
      const once = mergeDetected(rows, [], { ...ARMED, mark: '(nicht erkannt)' });
      expect(once.map((row) => row.detectedName)).to.deep.equal(['Weg (nicht erkannt)', '(nicht erkannt)']);
      // A second refresh adds no second mark.
      expect(mergeDetected(once, [], { ...ARMED, mark: '(nicht erkannt)' })).to.deep.equal(once);
      // Back again: detection's name, and nothing else changed.
      const back = mergeDetected(once, [found('hm-rpc.0.weg', 'Weg', 'switch', 'Keller')], { ...ARMED, mark: '(nicht erkannt)' });
      expect(back[0]).to.deep.equal({ objectId: 'hm-rpc.0.weg', include: true, detectedName: 'Weg', detectedDomain: 'switch', room: 'Keller' });
    });

    it("drops every language's mark before marking again, so a language change stacks none (Ruling 119, M4)", () => {
      const marks = ['(not detected)', '(nicht erkannt)'];
      const rows: DeviceOverride[] = [
        { objectId: 'a.0.x', include: false, detectedName: 'Weg (nicht erkannt)' },
        // What 44d1111 left after a language change, and after two.
        { objectId: 'a.0.y', include: false, detectedName: 'Weg (nicht erkannt) (not detected)' },
        { objectId: 'a.0.w', include: false, detectedName: 'Weg (not detected) (nicht erkannt) (not detected)' },
        { objectId: 'a.0.z', include: false, detectedName: '(nicht erkannt)' },
      ];
      expect(mergeDetected(rows, [], { mark: '(not detected)', marks }).map((row) => row.detectedName)).to.deep.equal([
        'Weg (not detected)',
        'Weg (not detected)',
        'Weg (not detected)',
        '(not detected)',
      ]);
    });

    it("moves none of the form's rows and puts new devices after them by object id, whatever order detection found them in", () => {
      // The order the admin shows and stores; its cells are keyed by row index.
      const rows: DeviceOverride[] = [
        { objectId: 'zigbee.0.b', include: true },
        { objectId: 'alias.0.weg', include: false },
        { objectId: 'hue.0.a', include: false, name: 'A' },
      ];
      const detected = [
        found('zigbee.0.c', 'C', 'sensor'),
        found('hue.0.a', 'A', 'light'),
        found('zigbee.0.b', 'B', 'switch'),
        found('Zigbee.0.upper', 'U', 'sensor'),
        found('alias.0.neu', 'N', 'sensor'),
      ];
      const merged = mergeDetected(rows, detected);
      // New ones in code-unit order, the same under every locale: capitals first.
      const order = ['zigbee.0.b', 'alias.0.weg', 'hue.0.a', 'Zigbee.0.upper', 'alias.0.neu', 'zigbee.0.c'];
      expect(merged.map((row) => row.objectId)).to.deep.equal(order);
      expect(mergeDetected(rows, [...detected].reverse())).to.deep.equal(merged);
      // A second refresh changes nothing, and an empty table fills sorted.
      expect(mergeDetected(merged, detected)).to.deep.equal(merged);
      expect(mergeDetected([], detected).map((row) => row.objectId)).to.deep.equal(['Zigbee.0.upper', 'alias.0.neu', 'hue.0.a', 'zigbee.0.b', 'zigbee.0.c']);
    });

    it('keeps every row where it stands, blank and duplicate ones too, so none moves under the cell that shows it (Ruling 119, M3)', () => {
      const rows = [
        { objectId: 'hue.0.a', include: false, name: 'first', detectedDomain: 'light' },
        { objectId: '  ', include: true },
        { objectId: '', include: true },
        { objectId: 'hue.0.a', include: true, name: 'last', detectedDomain: 'light' },
        { objectId: 'hue.0.b', include: false, name: 'after' },
      ];
      const merged = mergeDetected(rows, [found('hue.0.a', 'A', 'light'), found('hue.0.b', 'B', 'light')], ARMED);
      expect(merged).to.deep.equal([
        { objectId: 'hue.0.a', include: false, name: 'first', detectedName: 'A', detectedDomain: 'light', room: '' },
        // A blank row names no device: it stays as it is, and selects nothing.
        { objectId: '  ', include: true },
        { objectId: '', include: true },
        { objectId: 'hue.0.a', include: true, name: 'last', detectedName: 'A', detectedDomain: 'light', room: '' },
        { objectId: 'hue.0.b', include: false, name: 'after', detectedName: 'B', detectedDomain: 'light', room: '' },
      ]);
      // Of two rows for one device the selection reads the last.
      const device: DeviceInput = { objectId: 'hue.0.a', name: 'A', detectorType: 'light', domain: 'light', channels: {} };
      expect(applyOverrides([device], merged).map((d) => d.name)).to.deep.equal(['last']);
    });

    it('changes none of the rows it is given', () => {
      const rows: DeviceOverride[] = [
        { objectId: 'hue.0.a', include: true, name: 'A', detectedName: 'Alt' },
        { objectId: 'hue.0.weg', include: true, detectedName: 'Weg' },
      ];
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
        pick(HUE),
        pick(`${BALKON}.pressure`),
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
      const save = (...objectIds: string[]): ReturnType<EntityRegistry['rebuild']> => {
        const result = registry.rebuild(applyOverrides(detected, objectIds.map((objectId) => pick(objectId))), stored);
        stored = idsToStore(stored, detected, result.entityIds);
        return result;
      };

      save(BALKON);
      expect(stored).to.deep.equal({ [BALKON]: 'sensor.balkon' });

      // Un-picked: the entity leaves through the removal path, its id stays stored.
      expect(save().removed).to.deep.equal(['sensor.balkon']);
      expect(registry.all()).to.deep.equal([]);
      expect(stored).to.deep.equal({ [BALKON]: 'sensor.balkon' });

      // The other "Balkon", picked on its own, cannot take that id.
      save(BALKON_2);
      expect(stored).to.deep.equal({ [BALKON]: 'sensor.balkon', [BALKON_2]: 'sensor.balkon_2' });

      save(BALKON, BALKON_2);
      expect(registry.all().map((entity) => entity.entityId)).to.have.members(['sensor.balkon', 'sensor.balkon_2']);
      expect(stored).to.deep.equal({ [BALKON]: 'sensor.balkon', [BALKON_2]: 'sensor.balkon_2' });

      // A device detected no more loses its stored id, as before the picker.
      const without = detected.filter((device) => device.objectId !== BALKON);
      expect(idsToStore(stored, without, {})).to.deep.equal({ [BALKON_2]: 'sensor.balkon_2' });
      // Only an id the store itself holds: never an inherited property.
      expect(idsToStore({}, [{ ...detected[0]!, objectId: 'constructor' }], {})).to.deep.equal({});

      // Forced into another domain, a picked device gets an id there, and the
      // store holds the id in use, not the one before (Task 13b's rule).
      const forced = registry.rebuild(applyOverrides(detected, [pick(BALKON, { forcedDomain: 'binary_sensor' })]), stored);
      stored = idsToStore(stored, detected, forced.entityIds);
      expect(stored).to.deep.equal({ [BALKON]: 'binary_sensor.balkon', [BALKON_2]: 'sensor.balkon_2' });
    });
  });
});
