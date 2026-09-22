import { expect } from 'chai';
import type { ServiceCall } from '../../src/protocol/commands';
import { buildStatePublish } from '../../src/protocol/state-payload';
import { createIoBrokerDetector, mapControlToDevice, validStates, type ObjectMeta } from '../../src/registry/detector';
import { EntityRegistry } from '../../src/registry/entity-registry';
import { synthesise } from '../../src/registry/synth/index';
import type { DeviceInput, SourceValue, VirtualEntity } from '../../src/registry/types';
import { Dispatcher } from '../../src/runtime/dispatcher';

/*
 * Every other test hand-builds the detector's output. This suite feeds
 * ioBroker objects, shaped the way real adapters publish them, through the
 * REAL @iobroker/type-detector (via the production createIoBrokerDetector,
 * which owns the exact detect() options), then mapControlToDevice, the real
 * synth, the real payload builder and, where a behaviour is about writes, the
 * real Dispatcher (Task 5c, Rulings 34/35).
 */

type IoType = 'device' | 'channel' | 'state';
interface IoObject {
  _id: string;
  type: IoType;
  common: Record<string, unknown>;
  native: Record<string, unknown>;
}
type IoObjects = Record<string, IoObject>;

const device = (id: string, name: string): IoObject => ({ _id: id, type: 'device', common: { name }, native: {} });
const channel = (id: string, name: string): IoObject => ({ _id: id, type: 'channel', common: { name }, native: {} });
const state = (id: string, common: Record<string, unknown>): IoObject => ({
  _id: id,
  type: 'state',
  common: { name: id.split('.').pop(), read: true, ...common },
  native: {},
});
const objects = (...list: IoObject[]): IoObjects => Object.fromEntries(list.map((obj) => [obj._id, obj]));
const value = (val: unknown, ack = true): SourceValue => ({ val, ack, q: 0, ts: 1_758_000_000_000 });

/**
 * main.ts's detectDevices (src/main.ts:266-303) minus the adapter I/O: the
 * same state/channel/device objects, the same ObjectMeta from common.*, the
 * production detector, device roots before channel roots, first mapped
 * control per root.
 */
function detectDevices(all: IoObjects): DeviceInput[] {
  const byType = (type: IoType): IoObjects =>
    Object.fromEntries(Object.entries(all).filter(([, obj]) => obj.type === type));
  const devices = byType('device');
  const channels = byType('channel');
  const detector = createIoBrokerDetector({ ...byType('state'), ...channels, ...devices });
  const meta: Record<string, ObjectMeta> = {};
  for (const [id, obj] of Object.entries(all)) {
    const common = obj.common;
    meta[id] = {
      name: typeof common.name === 'string' ? common.name : id.split('.').pop() ?? id,
      role: typeof common.role === 'string' ? common.role : undefined,
      unit: typeof common.unit === 'string' ? common.unit : undefined,
      type: typeof common.type === 'string' ? common.type : undefined,
      min: typeof common.min === 'number' ? common.min : undefined,
      max: typeof common.max === 'number' ? common.max : undefined,
      states: validStates(common.states, common.type),
      write: typeof common.write === 'boolean' ? common.write : undefined,
      icon: typeof common.icon === 'string' ? common.icon : undefined,
    };
  }
  const result: DeviceInput[] = [];
  const seen = new Set<string>();
  for (const rootId of [...Object.keys(devices), ...Object.keys(channels)]) {
    if (rootId.startsWith('hometiles.0.')) continue;
    for (const control of detector.detect(rootId)) {
      const mapped = mapControlToDevice(rootId, control, meta);
      if (!mapped || seen.has(mapped.objectId)) continue;
      seen.add(mapped.objectId);
      result.push(mapped);
    }
  }
  return result;
}

interface Run {
  device: DeviceInput;
  entity: VirtualEntity | null;
  payload: string | undefined;
}

function run(all: IoObjects, values: Record<string, SourceValue> = {}): Run[] {
  return detectDevices(all).map((detected) => {
    const entity = synthesise(detected, `${detected.domain}.under_test`, values);
    return { device: detected, entity, payload: entity ? buildStatePublish('homeassistant', entity)?.payload : undefined };
  });
}

function runFor(runs: Run[], rootId: string): Run {
  const found = runs.find((candidate) => candidate.device.objectId === rootId);
  if (!found) throw new Error(`nothing detected at ${rootId}; got ${runs.map((r) => r.device.objectId).join(', ')}`);
  return found;
}

function json(result: Run): Record<string, unknown> {
  expect(result.payload, 'a JSON state payload').to.be.a('string');
  return JSON.parse(result.payload as string) as Record<string, unknown>;
}

/**
 * The brief's minimum for every detection: the channels are exactly the
 * expected ones (no phantom from an unmatched pattern state), each one names
 * a real state object, and each one's write flag is that object's own
 * common.write whenever the object declares one.
 */
function expectRealChannels(all: IoObjects, detected: DeviceInput, expected: Record<string, string>): void {
  const got = Object.fromEntries(Object.entries(detected.channels).map(([name, ch]) => [name, ch.objectId]));
  expect(got, `${detected.objectId} channels`).to.deep.equal(expected);
  for (const [name, ch] of Object.entries(detected.channels)) {
    const obj = all[ch.objectId];
    expect(obj?.type, `${name} is backed by a state object`).to.equal('state');
    if (typeof obj?.common.write === 'boolean') {
      expect(ch.write, `${name} write follows ${ch.objectId}'s common.write`).to.equal(obj.common.write);
    }
  }
}

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

async function dispatch(entity: VirtualEntity, call: ServiceCall) {
  const writes: Array<[string, unknown]> = [];
  const dispatcher = new Dispatcher(
    { byId: (id) => (id === entity.entityId ? entity : undefined), bySceneAlias: () => undefined },
    async (objectId, written) => {
      writes.push([objectId, written]);
    },
    silentLog,
  );
  return { result: await dispatcher.dispatch(call), writes };
}

// ---- Realistic object sets ----

const PROBE = objects(
  channel('dev.0.ac', 'AC'),
  state('dev.0.ac.MODE', { role: 'level.mode.airconditioner', type: 'number', write: true, states: { 0: 'OFF', 1: 'HEAT' } }),
  state('dev.0.ac.SET', { role: 'level.temperature', type: 'number', write: false, unit: '°C' }),
);

const AQARA = 'zigbee.0.00158d0001a2b3c4';
const AQARA_SET = objects(
  device(AQARA, 'Wohnzimmer Klima'),
  state(`${AQARA}.temperature`, { role: 'value.temperature', type: 'number', unit: '°C', write: false }),
  state(`${AQARA}.humidity`, { role: 'value.humidity', type: 'number', unit: '%', write: false }),
  state(`${AQARA}.pressure`, { role: 'value.pressure', type: 'number', unit: 'hPa', write: false }),
  state(`${AQARA}.battery`, { role: 'value.battery', type: 'number', unit: '%', write: false }),
  state(`${AQARA}.link_quality`, { role: 'state', type: 'number', write: false }),
  state(`${AQARA}.available`, { role: 'indicator.reachable', type: 'boolean', write: false }),
);

const GARDEN = 'alias.0.Garten.Thermometer';
const GARDEN_SET = objects(
  channel(GARDEN, 'Garten'),
  state(`${GARDEN}.ACTUAL`, { role: 'value.temperature', type: 'number', unit: '°C', write: false }),
);

const WINDOW = 'hm-rpc.0.OEQ1234567';
const WINDOW_SET = objects(
  device(WINDOW, 'Fenster Bad'),
  channel(`${WINDOW}.0`, 'Fenster Bad:0'),
  state(`${WINDOW}.0.UNREACH`, { role: 'indicator.unreach', type: 'boolean', write: false }),
  state(`${WINDOW}.0.LOWBAT`, { role: 'indicator.lowbat', type: 'boolean', write: false }),
  channel(`${WINDOW}.1`, 'Fenster Bad:1'),
  state(`${WINDOW}.1.STATE`, { role: 'sensor.window', type: 'boolean', write: false }),
);

const MOTION = 'zigbee.0.000d6ffffe1a2b3c';
const MOTION_SET = objects(
  device(MOTION, 'Flur Bewegung'),
  state(`${MOTION}.occupancy`, { role: 'sensor.motion', type: 'boolean', write: false }),
  state(`${MOTION}.battery`, { role: 'value.battery', type: 'number', unit: '%', write: false }),
  state(`${MOTION}.available`, { role: 'indicator.reachable', type: 'boolean', write: false }),
);

const PLUG = 'shelly.0.SHPLG-S#6A1B2C#1';
const PLUG_SET = objects(
  device(PLUG, 'Kaffeemaschine'),
  channel(`${PLUG}.Relay0`, 'Relay0'),
  state(`${PLUG}.Relay0.Switch`, { role: 'switch', type: 'boolean', write: true }),
  state(`${PLUG}.Relay0.Power`, { role: 'value.power', type: 'number', unit: 'W', write: false }),
  state(`${PLUG}.Relay0.Energy`, { role: 'value.power.consumption', type: 'number', unit: 'Wh', write: false }),
);

const KNX = 'knx.0.Steckdosen.Kueche';
const KNX_SET = objects(
  channel(KNX, 'Steckdose Küche'),
  state(`${KNX}.Status`, { role: 'switch', type: 'boolean', write: false }),
);

const HUE = 'hue.0.Wohnzimmer_Decke';
const HUE_SET = objects(
  channel(HUE, 'Wohnzimmer Decke'),
  state(`${HUE}.on`, { role: 'switch.light', type: 'boolean', write: true }),
  state(`${HUE}.level`, { role: 'level.dimmer', type: 'number', min: 0, max: 100, unit: '%', write: true }),
  state(`${HUE}.ct`, { role: 'level.color.temperature', type: 'number', min: 2200, max: 6500, unit: 'K', write: true }),
  state(`${HUE}.reachable`, { role: 'indicator.reachable', type: 'boolean', write: false }),
);

const KEY = 'hm-rpc.1.BidCoS-RF';
const KEY_SET = objects(
  device(KEY, 'Virtuelle Taster'),
  channel(`${KEY}.1`, 'Szene Abend'),
  state(`${KEY}.1.PRESS_SHORT`, { role: 'button', type: 'boolean', read: false, write: true }),
  state(`${KEY}.1.PRESS_LONG`, { role: 'button.long', type: 'boolean', read: false, write: true }),
);

const RT = 'hm-rpc.0.MEQ0123456';
const RT_SET = objects(
  device(RT, 'Heizung Bad'),
  channel(`${RT}.4`, 'Heizung Bad:4'),
  state(`${RT}.4.SET_TEMPERATURE`, { role: 'level.temperature', type: 'number', unit: '°C', min: 4.5, max: 30.5, write: true }),
  state(`${RT}.4.ACTUAL_TEMPERATURE`, { role: 'value.temperature', type: 'number', unit: '°C', write: false }),
  state(`${RT}.4.VALVE_STATE`, { role: 'value.valve', type: 'number', unit: '%', write: false }),
  state(`${RT}.4.BOOST_MODE`, { role: 'switch.boost', type: 'boolean', write: true }),
);

const FLOOR = 'alias.0.Bad.Fussbodenheizung';
const FLOOR_SET = objects(
  channel(FLOOR, 'Fußbodenheizung Bad'),
  state(`${FLOOR}.SET_HEATING`, { role: 'level.temperature.heating', type: 'number', unit: '°C', write: true }),
  state(`${FLOOR}.ACTUAL`, { role: 'value.temperature', type: 'number', unit: '°C', write: false }),
);

const FANCOIL = 'modbus.0.fancoil';
const FANCOIL_SET = objects(
  channel(FANCOIL, 'Fancoil'),
  state(`${FANCOIL}.power`, { role: 'switch.power', type: 'boolean', write: true }),
  state(`${FANCOIL}.boost`, { role: 'switch.boost', type: 'boolean', write: true }),
  state(`${FANCOIL}.fan`, { role: 'level.mode.fan', type: 'number', write: true, states: { 0: 'auto', 1: 'low', 2: 'high' } }),
);

const AC = 'alias.0.Wohnzimmer.Klima';
const AC_SET = objects(
  channel(AC, 'Klima Wohnzimmer'),
  state(`${AC}.MODE`, {
    role: 'level.mode.airconditioner',
    type: 'number',
    write: true,
    states: { 0: 'auto', 3: 'cool', 4: 'dry', 6: 'fan_only', 7: 'heat', 8: 'off' },
  }),
  state(`${AC}.SET`, { role: 'level.temperature', type: 'number', unit: '°C', min: 16, max: 30, write: true }),
  state(`${AC}.ACTUAL`, { role: 'value.temperature', type: 'number', unit: '°C', write: false }),
  state(`${AC}.SPEED_LEVEL`, { role: 'level.speed', type: 'number', write: true, states: { 0: 'auto', 1: 'low', 2: 'medium', 3: 'high' } }),
  state(`${AC}.POWER`, { role: 'switch.power', type: 'boolean', write: true }),
);

const CIRCUIT = 'ebus.0.heatingcircuit1';
const circuitSet = (setpointWritable: boolean): IoObjects =>
  objects(
    channel(CIRCUIT, 'Heizkreis 1'),
    state(`${CIRCUIT}.DesiredRoomTemp`, { role: 'level.temperature', type: 'number', unit: '°C', write: setpointWritable }),
    state(`${CIRCUIT}.RoomTemp`, { role: 'value.temperature', type: 'number', unit: '°C', write: false }),
  );

const BLIND = 'alias.0.Wohnzimmer.Rollladen';
const BLIND_SET = objects(
  channel(BLIND, 'Rollladen Wohnzimmer'),
  state(`${BLIND}.SET`, { role: 'level.blind', type: 'number', min: 0, max: 100, unit: '%', write: true }),
  state(`${BLIND}.ACTUAL`, { role: 'value.blind', type: 'number', min: 0, max: 100, unit: '%', write: false }),
  state(`${BLIND}.STOP`, { role: 'button.stop.blind', type: 'boolean', read: false, write: true }),
  state(`${BLIND}.OPEN`, { role: 'button.open.blind', type: 'boolean', read: false, write: true }),
  state(`${BLIND}.CLOSE`, { role: 'button.close.blind', type: 'boolean', read: false, write: true }),
);

const GATE = 'alias.0.Hof.Tor';
const GATE_SET = objects(
  channel(GATE, 'Hoftor'),
  state(`${GATE}.SET`, { role: 'switch.gate', type: 'boolean', write: true }),
  state(`${GATE}.ACTUAL`, { role: 'value.gate', type: 'number', min: 0, max: 100, unit: '%', write: false }),
  state(`${GATE}.STOP`, { role: 'button.stop', type: 'boolean', read: false, write: true }),
);

const GARAGE = 'alias.0.Garage.Tor';
const GARAGE_SET = objects(
  channel(GARAGE, 'Garagentor'),
  // No common.write at all: the one case where the pattern's own
  // declaration is still the only thing to go on (Ruling 35's fallback).
  state(`${GARAGE}.SET`, { role: 'switch.gate', type: 'boolean' }),
);

// ---- Tests ----

describe('real type-detector end to end (Task 5c)', () => {
  it("the controller's probe: no id-less detected state becomes a channel, and a read-only SET stays read-only", () => {
    const [ac] = run(PROBE);
    // ACTUAL is the SET object again: the detector's searchInParent pass
    // matches a read-only level.temperature against ACTUAL's pattern too.
    expectRealChannels(PROBE, ac!.device, { set: 'dev.0.ac.SET', mode: 'dev.0.ac.MODE', actual: 'dev.0.ac.SET' });
    expect(ac!.device.channels.set!.write).to.equal(false);
  });

  describe('sensor', () => {
    it('a zigbee climate sensor publishes its temperature, backed only by real objects', () => {
      const result = runFor(
        run(AQARA_SET, { [`${AQARA}.temperature`]: value(21.5), [`${AQARA}.humidity`]: value(48) }),
        AQARA,
      );
      expectRealChannels(AQARA_SET, result.device, { actual: `${AQARA}.temperature`, second: `${AQARA}.humidity` });
      expect(result.entity!.attributes).to.include({ device_class: 'temperature', unit_of_measurement: '°C' });
      expect(result.payload).to.equal('21.5');
    });

    it('a temperature-only sensor gains no phantom SECOND channel', () => {
      const result = runFor(run(GARDEN_SET, { [`${GARDEN}.ACTUAL`]: value(12.3) }), GARDEN);
      expectRealChannels(GARDEN_SET, result.device, { actual: `${GARDEN}.ACTUAL` });
      expect(result.payload).to.equal('12.3');
    });
  });

  describe('binary_sensor', () => {
    it('a Homematic window contact is backed only by its STATE object', () => {
      // main.ts detects the device root AND the channel root, so this tree
      // yields the same contact twice (reported, not pinned here).
      const runs = run(WINDOW_SET, { [`${WINDOW}.1.STATE`]: value(true) });
      for (const { device: detected } of runs) {
        expectRealChannels(WINDOW_SET, detected, { actual: `${WINDOW}.1.STATE` });
      }
      const result = runFor(runs, `${WINDOW}.1`);
      expect(result.entity!.attributes.device_class).to.equal('window');
      expect(result.payload).to.equal('on');
    });

    it('a motion sensor without an illuminance state gains no phantom SECOND channel', () => {
      const result = runFor(run(MOTION_SET, { [`${MOTION}.occupancy`]: value(false) }), MOTION);
      expectRealChannels(MOTION_SET, result.device, { actual: `${MOTION}.occupancy` });
      expect(result.entity!.attributes.device_class).to.equal('motion');
      expect(result.payload).to.equal('off');
    });
  });

  describe('switch', () => {
    it('a Shelly plug is a SET-only socket: no phantom ACTUAL', () => {
      const runs = run(PLUG_SET, { [`${PLUG}.Relay0.Switch`]: value(true) });
      for (const { device: detected } of runs) expectRealChannels(PLUG_SET, detected, { set: `${PLUG}.Relay0.Switch` });
      expect(runFor(runs, `${PLUG}.Relay0`).payload).to.equal('on');
    });

    it('a read-only switch status (common.write false) is not marked writable', () => {
      // Role 'switch' is the socket SET's defaultRole, and the detector skips
      // its write check for a default role, so the object still matches SET.
      const result = runFor(run(KNX_SET, { [`${KNX}.Status`]: value(false) }), KNX);
      expectRealChannels(KNX_SET, result.device, { set: `${KNX}.Status` });
      expect(result.device.channels.set!.write).to.equal(false);
      expect(result.payload).to.equal('off');
    });
  });

  describe('light', () => {
    it('a Hue CT lamp carries exactly on, level and ct, and publishes them', () => {
      const result = runFor(
        run(HUE_SET, { [`${HUE}.on`]: value(true), [`${HUE}.level`]: value(60), [`${HUE}.ct`]: value(3000) }),
        HUE,
      );
      expectRealChannels(HUE_SET, result.device, { set: `${HUE}.on`, dimmer: `${HUE}.level`, temperature: `${HUE}.ct` });
      expect(json(result)).to.deep.equal({
        friendly_name: 'Wohnzimmer Decke',
        supported_color_modes: ['color_temp'],
        brightness: 153,
        brightness_pct: 60,
        color_temp_kelvin: 3000,
        min_color_temp_kelvin: 2200,
        max_color_temp_kelvin: 6500,
        color_mode: 'color_temp',
        state: 'on',
      });
    });
  });

  describe('scene', () => {
    it('a Homematic virtual key fires PRESS_SHORT and publishes no state', () => {
      const runs = run(KEY_SET);
      for (const { device: detected } of runs) expectRealChannels(KEY_SET, detected, { set: `${KEY}.1.PRESS_SHORT` });
      const result = runFor(runs, `${KEY}.1`);
      expect(result.device.domain).to.equal('scene');
      expect(result.payload).to.equal(undefined);
    });
  });

  describe('climate', () => {
    it('a Homematic radiator thermostat carries only its real channels and writable roles', () => {
      const runs = run(RT_SET, {
        [`${RT}.4.SET_TEMPERATURE`]: value(21),
        [`${RT}.4.ACTUAL_TEMPERATURE`]: value(19.5),
        [`${RT}.4.BOOST_MODE`]: value(false),
      });
      const expected = { set: `${RT}.4.SET_TEMPERATURE`, actual: `${RT}.4.ACTUAL_TEMPERATURE`, boost: `${RT}.4.BOOST_MODE` };
      for (const { device: detected } of runs) expectRealChannels(RT_SET, detected, expected);
      const result = runFor(runs, `${RT}.4`);
      expect(result.entity!.writable).to.deep.equal({ setpoint: true, boost: true });
      expect(json(result)).to.deep.equal({
        friendly_name: 'Heizung Bad:4',
        boost: 'off',
        available: true,
        temperature: 21,
        current_temperature: 19.5,
        supported_features: 1,
      });
    });

    it('Ruling 14: a thermostat with only SET_HEATING is a single-setpoint device', () => {
      const result = runFor(
        run(FLOOR_SET, { [`${FLOOR}.SET_HEATING`]: value(22), [`${FLOOR}.ACTUAL`]: value(20.5) }),
        FLOOR,
      );
      expectRealChannels(FLOOR_SET, result.device, { set_heating: `${FLOOR}.SET_HEATING`, actual: `${FLOOR}.ACTUAL` });
      expect(result.entity!.writable).to.deep.equal({ setpoint: true });
      expect(json(result)).to.deep.equal({
        friendly_name: 'Fußbodenheizung Bad',
        available: true,
        temperature: 22,
        current_temperature: 20.5,
        supported_features: 1,
      });
    });

    it('Rulings 15/18: the real detector cannot produce a climate device without a temperature, mode or action channel', () => {
      // thermostat requires one of SET/SET_HEATING/SET_COOLING (requiredOneOf
      // 'setpoint') and airCondition requires MODE plus one of them, so a
      // POWER/BOOST/fan-only device is never classified as climate at all.
      expect(run(FANCOIL_SET).map((r) => r.device.domain)).to.not.include('climate');
      // And every climate device it does produce carries a setpoint, so
      // synthClimate's null gate never decides for a naturally detected one.
      for (const set of [PROBE, RT_SET, FLOOR_SET, AC_SET, circuitSet(false)]) {
        for (const result of run(set).filter((r) => r.device.domain === 'climate')) {
          expect(['set', 'set_heating', 'set_cooling'].some((name) => result.device.channels[name])).to.equal(true);
          expect(result.entity, result.device.objectId).to.not.equal(null);
        }
      }
    });

    it('Ruling 25: an air conditioner with SPEED_LEVEL and no SPEED gets fan_mode, fan_modes and fan writes from SPEED_LEVEL', async () => {
      const result = runFor(
        run(AC_SET, {
          [`${AC}.MODE`]: value(3),
          [`${AC}.SET`]: value(23),
          [`${AC}.ACTUAL`]: value(24.5),
          [`${AC}.SPEED_LEVEL`]: value(2),
          [`${AC}.POWER`]: value(true),
        }),
        AC,
      );
      expectRealChannels(AC_SET, result.device, {
        mode: `${AC}.MODE`,
        set: `${AC}.SET`,
        actual: `${AC}.ACTUAL`,
        speed_level: `${AC}.SPEED_LEVEL`,
        power: `${AC}.POWER`,
      });
      const payload = json(result);
      // The raw SPEED_LEVEL value, undecoded: deferred C4.
      expect(payload.fan_mode).to.equal('2');
      expect(payload.fan_modes).to.deep.equal(['auto', 'low', 'medium', 'high']);
      // TARGET_TEMPERATURE | FAN_MODE, and no swing bit without a swing channel.
      expect(payload.supported_features).to.equal(1 | 8);

      const { result: outcome, writes } = await dispatch(result.entity!, {
        kind: 'set_fan_mode',
        entityId: result.entity!.entityId,
        mode: 'high',
      });
      expect(outcome).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([[`${AC}.SPEED_LEVEL`, 3]]);
    });

    it('Task 5b: a read-only setpoint publishes no TARGET_TEMPERATURE bit and refuses a setpoint write', async () => {
      const set = circuitSet(false);
      const result = runFor(
        run(set, { [`${CIRCUIT}.DesiredRoomTemp`]: value(21), [`${CIRCUIT}.RoomTemp`]: value(20) }),
        CIRCUIT,
      );
      expectRealChannels(set, result.device, { set: `${CIRCUIT}.DesiredRoomTemp`, actual: `${CIRCUIT}.RoomTemp` });
      const payload = json(result);
      expect(payload.temperature, 'still displayed').to.equal(21);
      expect(payload.supported_features).to.equal(0);

      const { result: outcome, writes } = await dispatch(result.entity!, {
        kind: 'set_temperature',
        entityId: result.entity!.entityId,
        value: 23,
      });
      expect(outcome).to.deep.equal({ ok: false, reason: 'no_writable_channel', applied: 0 });
      expect(writes).to.deep.equal([]);
    });

    it('Task 5b: a writable setpoint publishes the TARGET_TEMPERATURE bit', () => {
      const set = circuitSet(true);
      const result = runFor(run(set, { [`${CIRCUIT}.DesiredRoomTemp`]: value(21) }), CIRCUIT);
      expectRealChannels(set, result.device, { set: `${CIRCUIT}.DesiredRoomTemp`, actual: `${CIRCUIT}.RoomTemp` });
      expect(json(result).supported_features).to.equal(1);
    });
  });

  describe('cover', () => {
    it('Task 7: a blind with no tilt channels publishes no tilt bits', () => {
      const result = runFor(run(BLIND_SET, { [`${BLIND}.ACTUAL`]: value(40) }), BLIND);
      expectRealChannels(BLIND_SET, result.device, {
        set: `${BLIND}.SET`,
        actual: `${BLIND}.ACTUAL`,
        stop: `${BLIND}.STOP`,
        open: `${BLIND}.OPEN`,
        close: `${BLIND}.CLOSE`,
      });
      // OPEN | CLOSE | SET_POSITION | STOP; none of the tilt bits 16-128.
      expect(json(result)).to.deep.equal({
        friendly_name: 'Rollladen Wohnzimmer',
        state: 'open',
        available: true,
        current_position: 40,
        supported_features: 1 | 2 | 4 | 8,
      });
    });

    it('Rulings 27/28: a gate with a numeric ACTUAL publishes current_position without SET_POSITION', () => {
      const result = runFor(run(GATE_SET, { [`${GATE}.SET`]: value(true), [`${GATE}.ACTUAL`]: value(35) }), GATE);
      expectRealChannels(GATE_SET, result.device, { set: `${GATE}.SET`, actual: `${GATE}.ACTUAL`, stop: `${GATE}.STOP` });
      const payload = json(result);
      expect(payload.current_position).to.equal(35);
      expect(payload.supported_features).to.equal(1 | 2 | 8);
      expect((payload.supported_features as number) & 4, 'SET_POSITION').to.equal(0);
    });

    it("Ruling 35's fallback: an object that omits common.write keeps the pattern's declared write", () => {
      const result = runFor(run(GARAGE_SET, { [`${GARAGE}.SET`]: value(false) }), GARAGE);
      expectRealChannels(GARAGE_SET, result.device, { set: `${GARAGE}.SET` });
      expect(result.device.channels.set!.write).to.equal(true);
      expect(json(result).supported_features).to.equal(1 | 2);
    });
  });

  it('the registry asks main.ts to subscribe only real state objects', () => {
    // main.ts:246 hands every id here to subscribeForeignStatesAsync, and
    // js-controller turns an undefined pattern into '*' (every state).
    const installation: IoObjects = Object.assign(
      {},
      PROBE,
      AQARA_SET,
      GARDEN_SET,
      WINDOW_SET,
      MOTION_SET,
      PLUG_SET,
      KNX_SET,
      HUE_SET,
      KEY_SET,
      RT_SET,
      FLOOR_SET,
      FANCOIL_SET,
      AC_SET,
      circuitSet(false),
      BLIND_SET,
      GATE_SET,
      GARAGE_SET,
    );
    const registry = new EntityRegistry({ onEntityChanged: () => undefined, onMembershipChanged: () => undefined }, 0);
    const { subscribe } = registry.rebuild(detectDevices(installation), {});
    expect(subscribe.filter((id) => installation[id]?.type !== 'state')).to.deep.equal([]);
  });
});
