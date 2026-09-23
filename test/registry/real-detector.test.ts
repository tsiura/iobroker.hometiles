import { expect } from 'chai';
import type { ServiceCall } from '../../src/protocol/commands';
import { buildStatePublish } from '../../src/protocol/state-payload';
import { discoverDevices } from '../../src/registry/detector';
import { EntityRegistry } from '../../src/registry/entity-registry';
import { synthesise } from '../../src/registry/synth/index';
import type { DeviceInput, SourceValue, VirtualEntity } from '../../src/registry/types';
import { Dispatcher } from '../../src/runtime/dispatcher';

/*
 * Every other test hand-builds the detector's output. This suite feeds
 * ioBroker objects, shaped the way real adapters publish them, through
 * discoverDevices -- the production discovery loop main.ts calls, driving the
 * REAL @iobroker/type-detector -- then the real synth, the real payload
 * builder and, where a behaviour is about writes, the real Dispatcher
 * (Task 5c, Rulings 34/35; Task 5d).
 */

type IoType = 'device' | 'channel' | 'state' | 'enum';
interface IoObject {
  _id: string;
  type: IoType;
  common: Record<string, unknown>;
  native: Record<string, unknown>;
}
type IoObjects = Record<string, IoObject>;

const device = (id: string, name: string): IoObject => ({ _id: id, type: 'device', common: { name }, native: {} });
const channel = (id: string, name: string, common: Record<string, unknown> = {}): IoObject => ({
  _id: id,
  type: 'channel',
  common: { name, ...common },
  native: {},
});
const state = (id: string, common: Record<string, unknown>): IoObject => ({
  _id: id,
  type: 'state',
  common: { name: id.split('.').pop(), read: true, ...common },
  native: {},
});
const functionEnum = (id: string, name: string, members: string[]): IoObject => ({
  _id: id,
  type: 'enum',
  common: { name, members },
  native: {},
});
const objects = (...list: IoObject[]): IoObjects => Object.fromEntries(list.map((obj) => [obj._id, obj]));
const value = (val: unknown, ack = true): SourceValue => ({ val, ack, q: 0, ts: 1_758_000_000_000 });
const detectDevices = (all: IoObjects): DeviceInput[] => discoverDevices(all, 'hometiles.0').devices;

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

// HM-CC-RT-DN's channel 4 (CLIMATECONTROL_RT_TRANSCEIVER) with every one of
// its datapoints, roled the way hm-rpc roles them (src/lib/roles.ts dpNAME;
// a read-only level.* becomes plain `value` via readOnlyRole; ACTION
// datapoints are write-only). MANU_MODE is a second writable
// level.temperature, so SET has two candidates to choose between. Names are
// hm-rega's: the CCU name sync names each datapoint "<channel>.<datapoint>"
// (hm-rega src/main.ts:1804-1810).
const RT = 'hm-rpc.0.MEQ0123456';
const rt4 = (datapoint: string, common: Record<string, unknown>): IoObject =>
  state(`${RT}.4.${datapoint}`, { name: `Heizung Bad:4.${datapoint}`, ...common });
const RT_SET = objects(
  device(RT, 'Heizung Bad'),
  channel(`${RT}.4`, 'Heizung Bad:4'),
  rt4('ACTUAL_TEMPERATURE', { role: 'value.temperature', type: 'number', unit: '°C', write: false }),
  rt4('AUTO_MODE', { role: 'button', type: 'boolean', read: false, write: true }),
  rt4('BATTERY_STATE', { role: 'value.voltage', type: 'number', unit: 'V', write: false }),
  rt4('BOOST_MODE', { role: 'switch.mode.boost', type: 'boolean', read: false, write: true }),
  rt4('BOOST_STATE', { role: 'value', type: 'number', unit: 'min', write: false }),
  rt4('COMFORT_MODE', { role: 'button', type: 'boolean', read: false, write: true }),
  rt4('CONTROL_MODE', {
    role: 'indicator',
    type: 'number',
    write: false,
    states: { 0: 'AUTO-MODE', 1: 'MANU-MODE', 2: 'PARTY-MODE', 3: 'BOOST-MODE' },
  }),
  rt4('FAULT_REPORTING', { role: 'indicator', type: 'number', write: false }),
  rt4('LOWERING_MODE', { role: 'button', type: 'boolean', read: false, write: true }),
  rt4('MANU_MODE', { role: 'level.temperature', type: 'number', unit: '°C', min: 4.5, max: 30.5, read: false, write: true }),
  rt4('SET_TEMPERATURE', { role: 'level.temperature', type: 'number', unit: '°C', min: 4.5, max: 30.5, write: true }),
  rt4('VALVE_STATE', { role: 'value.valve', type: 'number', unit: '%', write: false }),
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

// A Homematic shutter contact exactly as hm-rpc builds it: the device, its
// MAINTENANCE channel 0 and its SHUTTER_CONTACT channel 1 (channel role from
// hm-rpc's chTYPE, datapoint roles from dpNAME/dpCONTROL).
const SCO = 'hm-rpc.0.NEQ0987654';
const SCO_SET = objects(
  device(SCO, 'Terrassentür'),
  channel(`${SCO}.0`, 'Terrassentür:0'),
  state(`${SCO}.0.AES_KEY`, { role: 'state', type: 'number', write: false }),
  state(`${SCO}.0.CONFIG_PENDING`, { role: 'indicator', type: 'boolean', write: false }),
  state(`${SCO}.0.LOWBAT`, { role: 'indicator.lowbat', type: 'boolean', write: false }),
  state(`${SCO}.0.RSSI_DEVICE`, { role: 'value.rssi', type: 'number', unit: 'dBm', write: false }),
  state(`${SCO}.0.RSSI_PEER`, { role: 'value.rssi', type: 'number', unit: 'dBm', write: false }),
  state(`${SCO}.0.STICKY_UNREACH`, { role: 'indicator.unreach.sticky', type: 'boolean', write: true }),
  state(`${SCO}.0.UNREACH`, { role: 'indicator.unreach', type: 'boolean', write: false }),
  state(`${SCO}.0.UPDATE_PENDING`, { role: 'indicator', type: 'boolean', write: false }),
  channel(`${SCO}.1`, 'Terrassentür:1', { role: 'sensor' }),
  state(`${SCO}.1.ERROR`, { role: 'indicator.error', type: 'number', write: false }),
  state(`${SCO}.1.INSTALL_TEST`, { role: 'indicator', type: 'boolean', write: false }),
  state(`${SCO}.1.STATE`, { role: 'sensor.window', type: 'boolean', write: false }),
);

// A Shelly Plug S (gen 1) as ioBroker.shelly builds it: the device object
// keeps its default name (src/lib/protocol/base.ts), the relay channel
// carries the relay's own name (setChannelName in src/lib/shelly-helper.ts),
// and the datapoints come from src/lib/devices/gen1/shellyplugs.ts and the
// gen-1 defaults in src/lib/devices/default.ts.
const SHELLY = 'shelly.0.SHPLG-S#6A1B2C#1';
const SHELLY_SET = objects(
  device(SHELLY, 'Device SHPLG-S#6A1B2C#1'),
  channel(`${SHELLY}.Relay0`, 'Kaffeemaschine'),
  state(`${SHELLY}.Relay0.Switch`, { role: 'switch', type: 'boolean', write: true }),
  state(`${SHELLY}.Relay0.ChannelName`, { role: 'text', type: 'string', write: true }),
  state(`${SHELLY}.Relay0.AutoTimerOff`, { role: 'level.timer', type: 'number', unit: 's', write: true }),
  state(`${SHELLY}.Relay0.Power`, { role: 'value.power', type: 'number', unit: 'W', write: false }),
  state(`${SHELLY}.Relay0.Energy`, { role: 'value.energy.consumed', type: 'number', unit: 'Wh', write: false }),
  state(`${SHELLY}.temperatureC`, { role: 'value.temperature', type: 'number', unit: '°C', write: false }),
  state(`${SHELLY}.temperatureF`, { role: 'value.temperature', type: 'number', unit: '°F', write: false }),
  state(`${SHELLY}.led_power_disable`, { role: 'state', type: 'boolean', write: true }),
  state(`${SHELLY}.online`, { role: 'indicator.reachable', type: 'boolean', write: false }),
  state(`${SHELLY}.firmwareupdate`, { role: 'button', type: 'boolean', read: false, write: true }),
  state(`${SHELLY}.reboot`, { role: 'button', type: 'boolean', read: false, write: true }),
  state(`${SHELLY}.rssi`, { role: 'value', type: 'number', unit: 'dBm', write: false }),
  state(`${SHELLY}.uptime`, { role: 'value.interval', type: 'number', unit: 'sec', write: false }),
  channel(`${SHELLY}.Sys`, 'Channel Sys'),
  state(`${SHELLY}.Sys.eco`, { role: 'state', type: 'boolean', write: true }),
  channel(`${SHELLY}.Cloud`, 'Channel Cloud'),
  state(`${SHELLY}.Cloud.enabled`, { role: 'switch.enable', type: 'boolean', write: false }),
);

// A switch actuator whose generic `switch` role says nothing about what it
// drives: only its membership in a "Licht" function enum makes it a lamp
// (roleOrEnumLight in type-detector's roleEnumUtils.js).
const LAMP = 'knx.0.Licht.Flur';
const LAMP_SET = objects(
  channel(LAMP, 'Flurlicht'),
  state(`${LAMP}.Schalten`, { role: 'switch', type: 'boolean', write: true }),
  functionEnum('enum.functions.licht', 'Licht', [LAMP]),
);

// A DWD weather warning exactly as ioBroker.dwd declares it (io-package.json
// instanceObjects): the detector's `warning` pattern requires LEVEL.
const DWD = 'dwd.0.warning';
const DWD_SET = objects(
  channel(DWD, '', { role: 'forecast' }),
  state(`${DWD}.begin`, { role: 'value.time', type: 'number', write: false }),
  state(`${DWD}.end`, { role: 'value.time', type: 'number', write: false }),
  state(`${DWD}.severity`, { role: 'value.severity', type: 'number', write: false, states: { 0: 'None', 1: 'Minor', 2: 'Moderate', 3: 'Severe', 4: 'Extreme' } }),
  state(`${DWD}.level`, {
    role: 'value.warning',
    type: 'number',
    write: false,
    states: { 1: 'Preliminary info', 2: 'Minor', 3: 'Moderate', 4: 'Severe', 5: 'Extreme' },
  }),
  state(`${DWD}.type`, { role: 'weather.type', type: 'number', write: false }),
  state(`${DWD}.text`, { role: 'weather.title.short', type: 'string', write: false }),
  state(`${DWD}.headline`, { role: 'weather.title', type: 'string', write: false }),
  state(`${DWD}.description`, { role: 'weather.state', type: 'string', write: false }),
  state(`${DWD}.map`, { role: 'weather.chart.url', type: 'string', write: false }),
);

// A zigbee weather sensor on the balcony: temperature and pressure, flat
// under the device, so both are controls of one root (Ruling 45).
const BALKON = 'zigbee.0.00158d0004a1b2c3';
const balkonSet = (...extra: IoObject[]): IoObjects =>
  objects(
    device(BALKON, 'Balkon'),
    state(`${BALKON}.temperature`, { role: 'value.temperature', type: 'number', unit: '°C', write: false }),
    state(`${BALKON}.pressure`, { role: 'value.pressure', type: 'number', unit: 'hPa', write: false }),
    ...extra,
  );

// An alias channel nested inside another: both are roots, and the outer one
// sees the inner one's switch as well (Ruling 45 / M1). In INSTALLATION the
// outer "Garten" channel also holds GARDEN's thermometer channel.
const GARDEN_PUMP = 'alias.0.Garten.Pumpe';
const NESTED_SET = objects(
  channel('alias.0.Garten', 'Garten'),
  channel(GARDEN_PUMP, 'Pumpe'),
  state(`${GARDEN_PUMP}.SET`, { role: 'switch', type: 'boolean', write: true }),
);

// A weather station whose icon sits on the device and whose temperature sits
// in a channel: only the device root sees both, which weatherCurrent requires
// (ACTUAL and ICON), while the channel alone is a temperature (Ruling 46).
const STATION = 'weather.0.station';
const WEATHER_SET = objects(
  device(STATION, 'Wetterstation'),
  state(`${STATION}.icon`, { role: 'weather.icon', type: 'string', write: false }),
  channel(`${STATION}.outside`, 'Außen'),
  state(`${STATION}.outside.temperature`, { role: 'value.temperature', type: 'number', unit: '°C', write: false }),
);

// An alias room: a channel holding a CO2 channel (no pattern but the
// catch-all info reads a value.co2 alone) and, optionally, a light channel.
// The room root sees both inner channels, the channel objects included
// (Ruling 52).
const ROOM = 'alias.0.Wohnzimmer';
const roomSet = (withLight: boolean, room = ROOM): IoObjects =>
  objects(
    channel(room, room.split('.').pop()!),
    channel(`${room}.CO2`, 'CO2'),
    state(`${room}.CO2.ACTUAL`, { role: 'value.co2', type: 'number', unit: 'ppm', write: false }),
    ...(withLight
      ? [channel(`${room}.Licht`, 'Licht'), state(`${room}.Licht.SET`, { role: 'switch.light', type: 'boolean', write: true })]
      : []),
  );

// A hallway alias channel with one value of its own and a sub-channel that
// holds nothing (yet): no pattern but info reads the value, and the empty
// channel object sorts before it.
const HALL = 'alias.0.Flur';
const HALL_SET = objects(
  channel(HALL, 'Flur'),
  channel(`${HALL}.Bewegungsmelder`, 'Bewegungsmelder'),
  state(`${HALL}.co2`, { role: 'value.co2', type: 'number', unit: 'ppm', write: false }),
);

// A kitchen alias channel holding a CO2 channel and a value of its own: the
// kitchen's catch-all info spans the CO2 reading and its own value.
const KITCHEN = 'alias.0.Kueche';
const KITCHEN_SET = objects(
  channel(KITCHEN, 'Küche'),
  channel(`${KITCHEN}.CO2`, 'CO2 Küche'),
  state(`${KITCHEN}.CO2.ACTUAL`, { role: 'value.co2', type: 'number', unit: 'ppm', write: false }),
  state(`${KITCHEN}.Hinweis`, { role: 'text', type: 'string', write: false }),
);

// A bathroom sensor whose pressure state's own name starts with the root's
// name, but as a longer word.
const BATH = 'zigbee.0.00158d0004b5d6e7';
const BATH_SET = objects(
  device(BATH, 'Bad'),
  state(`${BATH}.temperature`, { name: 'Temperatur', role: 'value.temperature', type: 'number', unit: '°C', write: false }),
  state(`${BATH}.pressure`, { name: 'Badezimmer Luftdruck', role: 'value.pressure', type: 'number', unit: 'hPa', write: false }),
);

// An alias channel whose temperature later gains a setpoint: the new
// thermostat lists the old temperature as its optional ACTUAL.
const HEATER = 'alias.0.Buero.Heizung';
const heaterSet = (withSetpoint: boolean): IoObjects =>
  objects(
    channel(HEATER, 'Heizung Büro'),
    state(`${HEATER}.ACTUAL`, { role: 'value.temperature', type: 'number', unit: '°C', write: false }),
    ...(withSetpoint ? [state(`${HEATER}.SET`, { role: 'level.temperature', type: 'number', unit: '°C', write: true })] : []),
  );

// A cooling-only climate alias that later gains, then loses, a heating
// setpoint: one thermostat throughout, requiring SET_COOLING throughout.
const DUAL = 'alias.0.Keller.Klima';
const dualSet = (withHeating: boolean): IoObjects =>
  objects(
    channel(DUAL, 'Klima Keller'),
    state(`${DUAL}.ACTUAL`, { role: 'value.temperature', type: 'number', unit: '°C', write: false }),
    state(`${DUAL}.SET_COOLING`, { role: 'level.temperature.cooling', type: 'number', unit: '°C', write: true }),
    ...(withHeating
      ? [state(`${DUAL}.SET_HEATING`, { role: 'level.temperature.heating', type: 'number', unit: '°C', write: true })]
      : []),
  );

const INSTALLATION: IoObjects = Object.assign(
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
  SCO_SET,
  SHELLY_SET,
  LAMP_SET,
  DWD_SET,
  NESTED_SET,
  WEATHER_SET,
  // Info-only: in INSTALLATION alias.0.Wohnzimmer also holds AC and BLIND.
  roomSet(false, 'alias.0.Arbeitszimmer'),
  BATH_SET,
);

/** Every detected device one of whose channels is this state object. */
const backedBy = (runs: Run[], objectId: string): string[] =>
  runs
    .filter(({ device: detected }) => Object.values(detected.channels).some((ch) => ch.objectId === objectId))
    .map(({ device: detected }) => detected.objectId);

/**
 * One entity per physical control: no REQUIRED state backs two entities.
 * Each entity is identified by a state it requires -- the anchor recorded for
 * its root, or the state it is keyed by -- and no two entities share one.
 * Other states may be shared: a composite shares ACTUAL with the temperature
 * sensor beside it, as a Home Assistant weather entity does (Ruling 46).
 */
function expectNoRequiredStateBacksTwoEntities(all: IoObjects): void {
  const { devices, anchors } = discoverDevices(all, 'hometiles.0');
  const owners = new Map<string, string>();
  for (const detected of devices) {
    const anchor = anchors[detected.objectId] ?? detected.objectId;
    const backing = Object.values(detected.channels).map((ch) => ch.objectId);
    expect(backing, `${detected.objectId} is backed by its anchor`).to.include(anchor);
    expect(owners.get(anchor) ?? detected.objectId, `${anchor} backs two entities`).to.equal(detected.objectId);
    owners.set(anchor, detected.objectId);
  }
}

// ---- Tests ----

describe('real type-detector end to end (Task 5c)', () => {
  it("the controller's probe: no id-less detected state becomes a channel, and a read-only SET stays read-only", () => {
    const [ac] = run(PROBE);
    // ACTUAL is the SET object again: the detector's searchInParent pass
    // matches a read-only level.temperature against ACTUAL's pattern too.
    expectRealChannels(PROBE, ac!.device, { set: 'dev.0.ac.SET', mode: 'dev.0.ac.MODE', actual: 'dev.0.ac.SET' });
    expect(ac!.device.channels.set!.write).to.equal(false);
    // That binding is the setpoint, not a reading: it is the target, and it
    // must never be published as the current temperature too (Task 5b round
    // 1, Task 5c finding (e)). The binding above stays -- it is what the
    // detector does -- and synthClimate is what refuses to read it.
    const payload = json(runFor(run(PROBE, { 'dev.0.ac.SET': value(21) }), 'dev.0.ac'));
    expect(payload.temperature).to.equal(21);
    expect(payload).to.not.have.property('current_temperature');
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

    it('Ruling 38: turn_on at that read-only status is refused, with nothing written', async () => {
      // The repro that was ok:true and written before Task 8.
      const result = runFor(run(KNX_SET, { [`${KNX}.Status`]: value(false) }), KNX);
      const { result: outcome, writes } = await dispatch(result.entity!, { kind: 'turn_on', entityId: result.entity!.entityId });
      expect(outcome).to.deep.equal({ ok: false, reason: 'no_writable_channel', applied: 0 });
      expect(writes).to.deep.equal([]);
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
      // SET had two candidates carrying its defaultRole, MANU_MODE and
      // SET_TEMPERATURE; the detector keeps the later id of the two
      // (ChannelDetector.js:261-269, 305-307), so SET_TEMPERATURE wins.
      const expected = { set: `${RT}.4.SET_TEMPERATURE`, actual: `${RT}.4.ACTUAL_TEMPERATURE`, boost: `${RT}.4.BOOST_MODE` };
      // One thermostat, from the channel that holds it (Task 5d (b)).
      const climate = runs.filter(({ device: detected }) => detected.domain === 'climate');
      expect(climate.map(({ device: detected }) => detected.objectId)).to.deep.equal([`${RT}.4`]);
      expectRealChannels(RT_SET, climate[0]!.device, expected);
      expect(backedBy(runs, `${RT}.4.MANU_MODE`)).to.deep.equal([]);
      // Every control the channel yields is kept (Task 5d (c)): the detector
      // finds `button` once per root, and of AUTO/COMFORT/LOWERING_MODE the
      // later id wins, so the channel also publishes one scene. It is named
      // after its own datapoint, not after the root alone (Ruling 44), and
      // hm-rega's "<channel>.<datapoint>" name does not repeat the channel.
      const scenes = runs.filter(({ device: detected }) => detected.domain === 'scene');
      expect(scenes.map(({ device: detected }) => [detected.name, detected.channels.set?.objectId])).to.deep.equal([
        ['Heizung Bad:4 LOWERING_MODE', `${RT}.4.LOWERING_MODE`],
      ]);
      const result = runFor(runs, `${RT}.4`);
      expect(result.entity!.writable).to.deep.equal({ setpoint: true, boost: true });
      expect(json(result)).to.deep.equal({
        friendly_name: 'Heizung Bad:4',
        boost: 'off',
        available: true,
        temperature: 21,
        current_temperature: 19.5,
        supported_features: 1,
        // Task 8 round 1: SET_TEMPERATURE's declared 4.5..30.5, so the panel
        // offers exactly the setpoints the dispatcher accepts.
        min_temp: 4.5,
        max_temp: 30.5,
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

    it('Task 5b round 1: a setpoint the detector also binds to ACTUAL is never published as the current temperature', () => {
      // With no separate temperature object, ACTUAL's pattern (write:false,
      // role /temperature(\..*)?$/, searchInParent) also matches a setpoint
      // object that is read-only or declares no write flag, so the detector
      // binds ACTUAL to that setpoint's own object.
      const setpointOnly = (root: string, role: string, write?: boolean): IoObjects =>
        objects(
          channel(root, 'Heizung'),
          state(`${root}.SP`, { role, type: 'number', unit: '°C', ...(write === undefined ? {} : { write }) }),
        );
      const cases: Array<[string, IoObjects, string]> = [
        ['read-only SET_HEATING', setpointOnly('alias.0.h', 'level.temperature.heating', false), 'alias.0.h'],
        ['read-only SET_COOLING', setpointOnly('alias.0.c', 'level.temperature.cooling', false), 'alias.0.c'],
        ['SET with no write flag', setpointOnly('alias.0.n', 'level.temperature'), 'alias.0.n'],
      ];
      for (const [label, set, root] of cases) {
        const result = runFor(run(set, { [`${root}.SP`]: value(21) }), root);
        expect(result.device.channels.actual?.objectId, `${label}: the detector's own binding`).to.equal(`${root}.SP`);
        const payload = json(result);
        expect(payload.temperature, label).to.equal(21);
        expect(payload, label).to.not.have.property('current_temperature');
      }

      // A real temperature object next to a read-only setpoint is still the reading.
      const withReading = runFor(
        run(circuitSet(false), { [`${CIRCUIT}.DesiredRoomTemp`]: value(21), [`${CIRCUIT}.RoomTemp`]: value(20) }),
        CIRCUIT,
      );
      expect(json(withReading).current_temperature).to.equal(20);
    });

    it("Task 8 round 1: an air conditioner's setpoint range reaches the panel, and a setpoint outside it is refused", async () => {
      const result = runFor(run(AC_SET, { [`${AC}.MODE`]: value(3), [`${AC}.SET`]: value(23) }), AC);
      expect(json(result)).to.include({ min_temp: 16, max_temp: 30 });
      const entityId = result.entity!.entityId;
      const refused = await dispatch(result.entity!, { kind: 'set_temperature', entityId, value: 31 });
      expect(refused.result).to.deep.equal({ ok: false, reason: 'value_out_of_range', applied: 0 });
      expect(refused.writes).to.deep.equal([]);
      const landed = await dispatch(result.entity!, { kind: 'set_temperature', entityId, value: 30 });
      expect(landed.writes).to.deep.equal([[`${AC}.SET`, 30]]);
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

    it('Task 8: a real blind and a real gate take exactly the commands they advertise, on the right objects', async () => {
      const blind = runFor(run(BLIND_SET, { [`${BLIND}.ACTUAL`]: value(40) }), BLIND).entity!;
      const gate = runFor(run(GATE_SET, { [`${GATE}.SET`]: value(true) }), GATE).entity!;
      const entityId = 'cover.under_test';
      const cases: Array<[string, VirtualEntity, ServiceCall, Array<[string, unknown]>]> = [
        ['blind', blind, { kind: 'open_cover', entityId }, [[`${BLIND}.OPEN`, true]]],
        ['blind', blind, { kind: 'close_cover', entityId }, [[`${BLIND}.CLOSE`, true]]],
        ['blind', blind, { kind: 'stop_cover', entityId }, [[`${BLIND}.STOP`, true]]],
        ['blind', blind, { kind: 'set_cover_position', entityId, value: 25 }, [[`${BLIND}.SET`, 25]]],
        ['blind', blind, { kind: 'open_cover_tilt', entityId }, []],
        ['gate', gate, { kind: 'open_cover', entityId }, [[`${GATE}.SET`, true]]],
        ['gate', gate, { kind: 'close_cover', entityId }, [[`${GATE}.SET`, false]]],
        ['gate', gate, { kind: 'stop_cover', entityId }, [[`${GATE}.STOP`, true]]],
        ['gate', gate, { kind: 'set_cover_position', entityId, value: 25 }, []],
        // Open (SET true), so the toggle closes it.
        ['gate', gate, { kind: 'toggle_cover', entityId }, [[`${GATE}.SET`, false]]],
      ];
      for (const [label, entity, call, landed] of cases) {
        const { result: outcome, writes } = await dispatch(entity, call);
        expect(outcome.ok, `${label} ${call.kind}`).to.equal(landed.length > 0);
        expect(writes, `${label} ${call.kind}`).to.deep.equal(landed);
      }
    });
  });

  it('the registry asks main.ts to subscribe only real state objects', () => {
    // main.ts hands every id here to subscribeForeignStatesAsync, and
    // js-controller turns an undefined pattern into '*' (every state).
    const registry = new EntityRegistry({ onEntityChanged: () => undefined, onMembershipChanged: () => undefined }, 0);
    const { subscribe } = registry.rebuild(detectDevices(INSTALLATION), {});
    expect(subscribe.filter((id) => INSTALLATION[id]?.type !== 'state')).to.deep.equal([]);
  });
});

describe('discovery orchestration (Task 5d)', () => {
  it('(b) a Homematic device -> channel -> state tree yields its contact once, from the channel that holds it', () => {
    const runs = run(SCO_SET, { [`${SCO}.1.STATE`]: value(false) });
    expect(backedBy(runs, `${SCO}.1.STATE`)).to.deep.equal([`${SCO}.1`]);
    expect(runFor(runs, `${SCO}.1`).payload).to.equal('off');
    expectNoRequiredStateBacksTwoEntities(SCO_SET);
  });

  it('(b) a Shelly device -> relay channel tree yields the relay once, named after its channel', () => {
    const runs = run(SHELLY_SET, { [`${SHELLY}.Relay0.Switch`]: value(true) });
    expect(backedBy(runs, `${SHELLY}.Relay0.Switch`)).to.deep.equal([`${SHELLY}.Relay0`]);
    const relay = runFor(runs, `${SHELLY}.Relay0`);
    expect(relay.device.name).to.equal('Kaffeemaschine');
    expect(relay.payload).to.equal('on');
    expectNoRequiredStateBacksTwoEntities(SHELLY_SET);
    // The device root's first control is the relay again, so the root id is
    // anchored to the relay; with that repeat dropped, the id passes to none
    // of the root's other controls.
    expect(runs.map(({ device: detected }) => detected.objectId)).to.not.include(SHELLY);
    // Those other controls are named after their own state, not the root
    // alone (Ruling 44): the reboot button is no second "Device SHPLG-...".
    const names = runs.map(({ device: detected }) => detected.name);
    expect(names).to.include('Device SHPLG-S#6A1B2C#1 reboot');
    expect(new Set(names).size, names.join(' | ')).to.equal(names.length);
  });

  it('(b) across a whole installation, no required state backs two entities', () => {
    expectNoRequiredStateBacksTwoEntities(INSTALLATION);
  });

  it('(c) an Aqara multisensor keeps temperature (with its humidity) and pressure', () => {
    const runs = run(AQARA_SET, {
      [`${AQARA}.temperature`]: value(21.5),
      [`${AQARA}.humidity`]: value(48),
      [`${AQARA}.pressure`]: value(1013),
    });
    expect(runs.map(({ device: detected }) => [detected.objectId, detected.detectorType, detected.name])).to.deep.equal([
      [AQARA, 'temperature', 'Wohnzimmer Klima'],
      // A root's further controls are keyed by the state that anchors them,
      // and named after it too (Ruling 44).
      [`${AQARA}.pressure`, 'pressure', 'Wohnzimmer Klima pressure'],
    ]);
    expectRealChannels(AQARA_SET, runs[0]!.device, { actual: `${AQARA}.temperature`, second: `${AQARA}.humidity` });
    expectRealChannels(AQARA_SET, runs[1]!.device, { pressure: `${AQARA}.pressure` });
    // Kept is not enough: each one publishes its own reading.
    expect(runs.map((r) => r.payload)).to.deep.equal(['21.5', '1013']);
    expect(runs[1]!.entity!.attributes).to.include({ device_class: 'pressure', unit_of_measurement: 'hPa' });

    // Two entities, not two devices collapsed under one key in the registry.
    const registry = new EntityRegistry({ onEntityChanged: () => undefined, onMembershipChanged: () => undefined }, 0);
    registry.rebuild(detectDevices(AQARA_SET), {});
    expect(registry.all().map((entity) => entity.attributes.device_class)).to.have.members(['temperature', 'pressure']);
  });

  it('(c) a DWD warning publishes its level: on while a warning is active, off without one', () => {
    const warning = (level: number): Run => runFor(run(DWD_SET, { [`${DWD}.level`]: value(level) }), DWD);
    const active = warning(3);
    expect(active.device).to.include({ detectorType: 'warning', domain: 'binary_sensor' });
    expect(active.entity!.attributes.device_class).to.equal('problem');
    expect(active.payload).to.equal('on');
    expect(warning(0).payload).to.equal('off');
  });

  it('(d) a fan-coil whose control the adapter does not map is not published as a sensor', () => {
    // The detector finds `fan` (unmapped) and then the catch-all `info` over
    // the leftover boost switch; neither may stand in for the fan.
    expect(run(FANCOIL_SET).map(({ device: detected }) => detected.objectId)).to.deep.equal([]);
  });

  it('(f) a lamp known only through a function enum is detected as a light', () => {
    const [lamp] = run(LAMP_SET);
    expect(lamp!.device).to.include({ objectId: LAMP, detectorType: 'light', domain: 'light' });
    expectRealChannels(LAMP_SET, lamp!.device, { set: `${LAMP}.Schalten` });

    // Without the enum the same channel is only a socket: the enum decides.
    const withoutEnum = Object.fromEntries(Object.entries(LAMP_SET).filter(([, obj]) => obj.type !== 'enum'));
    expect(run(withoutEnum).map(({ device: detected }) => detected.domain)).to.deep.equal(['switch']);
  });

  it('(f) a lamp saved as a socket before its enum existed is not published under the socket id', () => {
    const registry = new EntityRegistry({ onEntityChanged: () => undefined, onMembershipChanged: () => undefined }, 0);
    const { entityIds } = registry.rebuild(detectDevices(LAMP_SET), { [LAMP]: 'switch.flurlicht' });
    expect(entityIds[LAMP]).to.equal('light.flurlicht');
    const lamp = registry.byId('light.flurlicht')!;
    expect(buildStatePublish('ha/statestream', lamp)?.topic).to.equal('ha/statestream/light/flurlicht/state');
  });

  it('(Ruling 45) adding an unrelated state does not move sensor.balkon off temperature', () => {
    const first = discoverDevices(balkonSet(), 'hometiles.0');
    const before = new EntityRegistry({ onEntityChanged: () => undefined, onMembershipChanged: () => undefined }, 0);
    const { entityIds } = before.rebuild(first.devices, {});
    expect(before.byId('sensor.balkon')!.source).to.deep.equal({ actual: `${BALKON}.temperature` });

    // indicator.working is a state of the pressure pattern only, so pressure
    // now matches more states and the detector sorts it first
    // (ChannelDetector.js:742-744): the root id used to follow it there.
    const working = state(`${BALKON}.working`, { role: 'indicator.working', type: 'boolean', write: false });
    const second = discoverDevices(balkonSet(working), 'hometiles.0', first.anchors);
    const after = new EntityRegistry({ onEntityChanged: () => undefined, onMembershipChanged: () => undefined }, 0);
    after.rebuild(second.devices, entityIds);
    expect(after.byId('sensor.balkon')!.source).to.deep.equal({ actual: `${BALKON}.temperature` });
    expect(after.byId('sensor.balkon')!.attributes.friendly_name).to.equal('Balkon');
    expect(after.byId('sensor.balkon_pressure')!.source).to.deep.equal({ pressure: `${BALKON}.pressure` });
  });

  it('(Ruling 45) when the control a root id stays with disappears, the id goes to no other control', () => {
    const first = discoverDevices(balkonSet(), 'hometiles.0');
    const before = new EntityRegistry({ onEntityChanged: () => undefined, onMembershipChanged: () => undefined }, 0);
    const { entityIds } = before.rebuild(first.devices, {});

    const withoutTemperature = Object.fromEntries(
      Object.entries(balkonSet()).filter(([id]) => id !== `${BALKON}.temperature`),
    );
    const second = discoverDevices(withoutTemperature, 'hometiles.0', first.anchors);
    // Pressure stays keyed by its own state; sensor.balkon is not repointed
    // to it, and the record waits for the temperature to come back.
    expect(second.devices.map(({ objectId }) => objectId)).to.deep.equal([`${BALKON}.pressure`]);
    expect(second.anchors[BALKON]).to.equal(`${BALKON}.temperature`);
    const after = new EntityRegistry({ onEntityChanged: () => undefined, onMembershipChanged: () => undefined }, 0);
    expect(after.rebuild(second.devices, entityIds).entityIds).to.deep.equal({ [`${BALKON}.pressure`]: 'sensor.balkon_pressure' });
  });

  it('(Ruling 45) reversing the object order changes no entity id', () => {
    const entityIds = (all: IoObjects): Record<string, string> =>
      new EntityRegistry({ onEntityChanged: () => undefined, onMembershipChanged: () => undefined }, 0).rebuild(
        detectDevices(all),
        {},
      ).entityIds;
    const forward = entityIds(INSTALLATION);
    expect(entityIds(Object.fromEntries(Object.entries(INSTALLATION).reverse()))).to.deep.equal(forward);
    // Deepest root first: the nested pump channel holds its own switch.
    expect(forward[GARDEN_PUMP]).to.equal('switch.pumpe');
  });

  it('(Ruling 46) a composite that needs a state no channel holds survives beside the channel control', () => {
    const runs = run(WEATHER_SET, { [`${STATION}.outside.temperature`]: value(7.5), [`${STATION}.icon`]: value('rain') });
    expect(runs.map(({ device: detected }) => [detected.objectId, detected.detectorType])).to.deep.equal([
      [`${STATION}.outside`, 'temperature'],
      // Its ACTUAL is the channel's temperature, which the channel claimed
      // first; its ICON nobody claimed, so it is not a repeat.
      [STATION, 'weatherCurrent'],
    ]);
    expectRealChannels(WEATHER_SET, runs[1]!.device, {
      actual: `${STATION}.outside.temperature`,
      icon: `${STATION}.icon`,
    });
    expectNoRequiredStateBacksTwoEntities(WEATHER_SET);
  });

  it('(Ruling 52) an alias room that loses its light keeps sensor.co2 on the CO2 state', () => {
    const first = discoverDevices(roomSet(true), 'hometiles.0');
    const before = new EntityRegistry({ onEntityChanged: () => undefined, onMembershipChanged: () => undefined }, 0);
    const { entityIds } = before.rebuild(first.devices, {});
    expect(entityIds[`${ROOM}.CO2`]).to.equal('sensor.co2');

    // The light removed, a restart: the room's recorded control is gone, and
    // its catch-all info (over the CO2 state the CO2 channel already holds,
    // and the channel objects) must not take the CO2 channel's place.
    const second = discoverDevices(roomSet(false), 'hometiles.0', first.anchors);
    expect(second.devices.map(({ objectId }) => objectId)).to.deep.equal([`${ROOM}.CO2`]);
    const after = new EntityRegistry({ onEntityChanged: () => undefined, onMembershipChanged: () => undefined }, 0);
    after.rebuild(second.devices, entityIds);
    after.applyStateChange(`${ROOM}.CO2.ACTUAL`, value(612));
    after.flush();
    expect(after.byId('sensor.co2')!.source).to.deep.equal({ actual: `${ROOM}.CO2.ACTUAL` });
    expect(after.byId('sensor.co2')!.state).to.equal('612');
  });

  it('(Ruling 52) an info-only room publishes no entity backed by a channel object', () => {
    // info's ACTUAL matches any object below its root (ChannelDetector.js:
    // 35-37), so at the room it bound the CO2 channel object itself.
    expect(discoverDevices(roomSet(false), 'hometiles.0').devices.map(({ objectId }) => objectId)).to.deep.equal([`${ROOM}.CO2`]);
  });

  it('(Ruling 52) a channel object never becomes an entity reading', () => {
    const [hall, ...rest] = run(HALL_SET, { [`${HALL}.co2`]: value(540) });
    expect(rest).to.deep.equal([]);
    expectRealChannels(HALL_SET, hall!.device, { actual: `${HALL}.co2` });
    expect(hall!.payload).to.equal('540');
  });

  it('(Ruling 52) a catch-all that spans a state another control holds is a repeat', () => {
    // The kitchen's info reads the CO2 channel's state as well as its own
    // note: publishing it would show the CO2 reading twice, once as "Küche".
    expect(run(KITCHEN_SET).map(({ device: detected }) => detected.objectId)).to.deep.equal([`${KITCHEN}.CO2`]);
  });

  it("strips the root's name from a state name only as a whole word", () => {
    expect(run(BATH_SET).map(({ device: detected }) => detected.name)).to.deep.equal(['Bad', 'Bad Badezimmer Luftdruck']);
  });

  it('(Ruling 45) a control that lists the recorded state only as optional does not take the root id', () => {
    const first = discoverDevices(heaterSet(false), 'hometiles.0');
    expect(first.anchors[HEATER]).to.equal(`${HEATER}.ACTUAL`);
    // The new thermostat requires SET and merely reads ACTUAL: it is not the
    // temperature sensor the root id was given to.
    const second = discoverDevices(heaterSet(true), 'hometiles.0', first.anchors);
    expect(second.devices.map(({ objectId, domain }) => [objectId, domain])).to.deep.equal([[`${HEATER}.SET`, 'climate']]);
    expect(second.anchors[HEATER]).to.equal(`${HEATER}.ACTUAL`);
  });

  it('(Ruling 45) the recorded state does not drift within its control', () => {
    const first = discoverDevices(dualSet(false), 'hometiles.0');
    expect(first.anchors[DUAL]).to.equal(`${DUAL}.SET_COOLING`);
    // SET_HEATING now comes first among the states the thermostat requires;
    // the record stays on SET_COOLING, so removing SET_HEATING again loses
    // nothing.
    const second = discoverDevices(dualSet(true), 'hometiles.0', first.anchors);
    expect(second.anchors[DUAL]).to.equal(`${DUAL}.SET_COOLING`);
    const third = discoverDevices(dualSet(false), 'hometiles.0', second.anchors);
    expect(third.devices.map(({ objectId }) => objectId)).to.deep.equal([DUAL]);
  });
});
