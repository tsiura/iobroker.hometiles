import Aedes from 'aedes';
import { expect } from 'chai';
import { tests, type IntegrationTestHarness } from '@iobroker/testing';
import mqtt, { type MqttClient } from 'mqtt';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type AddressInfo, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { EnergySource, type EnergyNames } from '../src/runtime/energy-source';
import { HistoryProvider, MAX_HISTORY_ROWS, type HistoryResult, type HistorySource } from '../src/runtime/history-provider';

/** Ports nothing listens on now, as the system hands them out: each held until all are known, so no two are one. */
async function freePorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => createServer());
  for (const server of servers) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const ports = servers.map((server) => (server.address() as AddressInfo).port);
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  return ports;
}

/** Two free ports written into iobroker.json, where every process of a run reads its databases' ports; none before an install made it. */
async function freshDatabasePorts(dataDir: string): Promise<{ objects: number; states: number } | undefined> {
  const file = path.join(dataDir, 'iobroker.json');
  let config: { objects: { port: number }; states: { port: number } };
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  [config.objects.port, config.states.port] = (await freePorts(2)) as [number, number];
  writeFileSync(file, JSON.stringify(config, null, 2));
  return { objects: config.objects.port, states: config.states.port };
}

/** What of @iobroker/testing's DBConnection (lib/dbConnection.js) the port fix reads and sets. */
interface HarnessDb {
  testDir: string;
  testControllerDir: string;
  testDataDir: string;
  logger: unknown;
  objectsType: string;
  statesType: string;
  _isRunning: boolean;
  emit(event: string, ...args: unknown[]): boolean;
  start(): Promise<void>;
}

/** lib/dbConnection.js createObjectsDB and createStatesDB, on the port given: the server, then a client of it that hears every change. */
async function createDatabase(db: HarnessDb, kind: 'objects' | 'states', port: number): Promise<void> {
  const type = kind === 'objects' ? db.objectsType : db.statesType;
  const connection =
    kind === 'objects'
      ? { type, host: '127.0.0.1', port, user: '', pass: '', noFileCache: false, connectTimeout: 2000 }
      : { type, host: '127.0.0.1', port, options: { auth_pass: null, retry_max_delay: 15000 } };
  const settings = { connection, logger: db.logger };
  const paths = [path.join(db.testDir, 'node_modules'), path.join(db.testControllerDir, 'node_modules')];
  const { Server, Client } = require(require.resolve(`@iobroker/db-${kind}-${type}`, { paths }));
  const fields = db as unknown as Record<string, { subscribe(pattern: string): void }>;
  await new Promise<void>((resolve) => {
    fields[`_${kind}Server`] = new Server({ ...settings, connected: () => resolve() });
  });
  await new Promise<void>((resolve) => {
    fields[`_${kind}Client`] = new Client({
      ...settings,
      connected: () => {
        fields[`_${kind}Client`]!.subscribe('*');
        resolve();
      },
      change: db.emit.bind(db, kind === 'objects' ? 'objectChange' : 'stateChange'),
    });
  });
}

/**
 * Ruling 137: no test takes a fixed port. @iobroker/testing 5 runs its databases on 19000 and
 * 19001 (lib/dbConnection.js createObjectsDB, createStatesDB) and writes those into iobroker.json
 * (lib/controllerSetup.js setupSystemConfig), where the adapter, js-controller's command line and
 * iobroker.history read them: two runs at once shared one database, and a run whose ports another
 * process held hung in `iobroker setup first` (Task 24). Each start of the databases now takes two
 * ports the system hands out, written into iobroker.json first; so does each install, whose
 * command line runs before any start. The servers take no port 0 (`port || 9000`): hence ports
 * known to be free a moment before.
 */
function useFreeDatabasePorts(): void {
  const { DBConnection } = require('@iobroker/testing/build/tests/integration/lib/dbConnection') as { DBConnection: { prototype: HarnessDb } };
  const { ControllerSetup } = require('@iobroker/testing/build/tests/integration/lib/controllerSetup') as {
    ControllerSetup: { prototype: { testDataDir: string; setupSystemConfig(): void; prepareTestDir(...args: unknown[]): Promise<void> } };
  };
  DBConnection.prototype.start = async function (this: HarnessDb): Promise<void> {
    if (this._isRunning) return;
    const ports = await freshDatabasePorts(this.testDataDir);
    if (!ports) throw new Error(`No iobroker.json in ${this.testDataDir}: js-controller is not installed there`);
    await createDatabase(this, 'objects', ports.objects);
    await createDatabase(this, 'states', ports.states);
    this._isRunning = true;
  };
  // Each start has written its ports; 19001 and 19000 written after one would send the command line elsewhere.
  ControllerSetup.prototype.setupSystemConfig = (): void => undefined;
  const prepare = ControllerSetup.prototype.prepareTestDir;
  ControllerSetup.prototype.prepareTestDir = async function (this: { testDataDir: string }, ...args: unknown[]): Promise<void> {
    await freshDatabasePorts(this.testDataDir);
    return prepare.apply(this, args);
  };
}

/**
 * @iobroker/testing installs js-controller and the packed adapter with npm and never reads the
 * outcome (lib/controllerSetup.js prepareTestDir, lib/adapterSetup.js installAdapterInTestDir):
 * an install npm could not finish surfaced only as js-controller's "Unknown packet name
 * hometiles", from the `iobroker add` that found the adapter's folder gone (Task 23 C3; npm could
 * not write in a full temp quota, EDQUOT). A failed npm install or uninstall now fails the run
 * where it happens, with npm's own last lines (Task 24).
 */
function failOnNpmErrors(): void {
  type Run = (command: string, args?: unknown, options?: unknown) => Promise<{ exitCode?: number; signal?: string; stderr?: string }>;
  const runner = require('@iobroker/testing/build/lib/executeCommand') as { executeCommand: Run };
  const run = runner.executeCommand;
  runner.executeCommand = async (command, args, options) => {
    const result = await run(command, args, options);
    const argv = Array.isArray(args) ? args.map(String) : [];
    if (command === 'npm' && ['i', 'install', 'uninstall'].includes(argv[0] ?? '') && result.exitCode !== 0) {
      const said = String(result.stderr ?? '').trim().split('\n').slice(-6).join('\n');
      throw new Error(`npm ${argv.join(' ')} failed (${result.exitCode ?? result.signal}): ${said || 'nothing on stderr'}`);
    }
    return result;
  };
}

/** A log line as js-controller forwards it (js-controller-common-db logger.js). */
interface LogRecord {
  severity: string;
  message: string;
}

/**
 * Every line the adapter logs, received the way admin's log view receives it:
 * js-controller forwards an adapter's logs to each instance whose `logging`
 * state is true (js-controller-adapter adapter.js _initLogging).
 */
async function captureLogs(harness: IntegrationTestHarness): Promise<LogRecord[]> {
  const listener = 'system.adapter.hometiles-test.0';
  const logs: LogRecord[] = [];
  harness.on('stateChange', (id: string, record: unknown) => {
    if (id === `log.${listener}` && record) logs.push(record as LogRecord);
  });
  await harness.states.setStateAsync(`${listener}.logging`, { val: true, ack: true });
  await harness.states.subscribeLog(listener);
  return logs;
}

/** Polls until `find` finds something; fails at once if the adapter process has stopped. */
async function waitFor<T>(harness: IntegrationTestHarness, find: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 60000;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (harness.didAdapterStop()) throw new Error(`the adapter stopped (${harness.adapterExit}) before ${what}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * changeAdapterConfig deep-merges (alcalzone-shared extend): a list goes
 * into the one the instance holds index by index, and one it does not hold
 * yet becomes an object. The list is set whole instead.
 */
async function setManualEntities(harness: IntegrationTestHarness, entries: object[]): Promise<void> {
  const id = 'system.adapter.hometiles.0';
  const instance = (await harness.objects.getObjectAsync(id)) as { native: Record<string, unknown> } & Record<string, unknown>;
  await harness.objects.setObjectAsync(id, { ...instance, native: { ...instance.native, manualEntities: entries } });
}

/** The Energy tab's rows, set whole as setManualEntities sets its list (Task 20b). */
async function setEnergyMeters(harness: IntegrationTestHarness, rows: object[]): Promise<void> {
  const id = 'system.adapter.hometiles.0';
  const instance = (await harness.objects.getObjectAsync(id)) as { native: Record<string, unknown> } & Record<string, unknown>;
  await harness.objects.setObjectAsync(id, { ...instance, native: { ...instance.native, energyMeters: rows } });
}

/** Native keys set whole, lists included, as setManualEntities sets its list. */
async function setNative(harness: IntegrationTestHarness, patch: Record<string, unknown>): Promise<void> {
  const id = 'system.adapter.hometiles.0';
  const instance = (await harness.objects.getObjectAsync(id)) as { native: Record<string, unknown> } & Record<string, unknown>;
  await harness.objects.setObjectAsync(id, { ...instance, native: { ...instance.native, ...patch } });
}

/**
 * A value as admin stores a field io-package.json lists in encryptedNative
 * (json-config JsonConfig.onSave, encrypt; js-controller-common-db
 * tools.encrypt): AES-192-CBC under the system secret, a 48-digit hex key.
 */
function encryptAsAdmin(secret: string, value: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-192-cbc', Buffer.from(secret, 'hex'), iv);
  return `$/aes-192-cbc:${iv.toString('hex')}:${Buffer.concat([cipher.update(value), cipher.final()]).toString('hex')}`;
}

async function setObjects(harness: IntegrationTestHarness, objects: Record<string, object>): Promise<void> {
  for (const [id, obj] of Object.entries(objects)) await harness.objects.setObjectAsync(id, { _id: id, native: {}, ...obj });
}

/**
 * The harness backs its database up once per run, from whatever the previous
 * run's last suite left behind (prepareTestDir never clears it), so a suite
 * that writes objects removes every fixture before and after itself -- its
 * value too: a helper a panel command wrote (Task 15) would otherwise hold
 * that value in the next run, where a test expects none yet.
 */
function withCleanFixtures(getHarness: () => IntegrationTestHarness): void {
  const removeAll = async (): Promise<void> => {
    for (const id of FIXTURE_IDS) {
      await getHarness().objects.delObjectAsync(id).catch(() => undefined);
      await Promise.resolve(getHarness().states.delState(id)).catch(() => undefined);
    }
  };
  before(removeAll);
  after(removeAll);
}

const ready = (logs: LogRecord[]): LogRecord | undefined => logs.find((log) => log.message.includes('[HomeTiles] Ready.'));

/** A zigbee temperature sensor, so discovery has a root to work on. */
const SENSOR = 'zigbee.0.00158d0004a1b2c3';
const SENSOR_OBJECTS: Record<string, object> = {
  [SENSOR]: { type: 'device', common: { name: 'Balkon' } },
  [`${SENSOR}.temperature`]: {
    type: 'state',
    common: { name: 'Temperature', role: 'value.temperature', type: 'number', unit: '°C', read: true, write: false },
  },
};

/**
 * A switch actuator and a hand-corrupted function enum whose members are no
 * list: getForeignObjects (js-controller adapter.js:2754) and the detector
 * (ChannelDetector.js:150) both throw on it.
 */
const CORRUPT_ENUM_OBJECTS: Record<string, object> = {
  'knx.0.Licht.Flur': { type: 'channel', common: { name: 'Flurlicht' } },
  'knx.0.Licht.Flur.Schalten': {
    type: 'state',
    common: { name: 'Schalten', role: 'switch', type: 'boolean', read: true, write: true },
  },
  'enum.functions.licht': { type: 'enum', common: { name: 'Licht', members: { length: 1 } } },
};

/**
 * One bad object each, beside the good sensor: a role that is not text (the
 * type-detector threw on it) and an alias whose target id is malformed
 * (js-controller rejects reading it, adapter.js _getForeignState). Each used
 * to stop the whole discovery. FORCED was the third: a hand-edited override
 * forcing it into a domain with no synth yet made synthesise throw. Since
 * Task 13 every domain has a synth, so it is an entity now, and no longer
 * left out.
 */
const BAD_ROLE = 'zigbee.0.00158d0004c0ffee';
const FORCED = 'zigbee.0.00158d0004f0rced';
const BAD_ALIAS = 'alias.0.Kaputt';
const BAD_OBJECTS: Record<string, object> = {
  [BAD_ROLE]: { type: 'device', common: { name: 'Kaputt' } },
  [`${BAD_ROLE}.status`]: { type: 'state', common: { name: 'Status', role: 5, type: 'number', read: true, write: false } },
  [FORCED]: { type: 'device', common: { name: 'Erzwungen' } },
  [`${FORCED}.temperature`]: {
    type: 'state',
    common: { name: 'Temperature', role: 'value.temperature', type: 'number', unit: '°C', read: true, write: false },
  },
  [BAD_ALIAS]: { type: 'channel', common: { name: 'Kaputt' } },
  [`${BAD_ALIAS}.ACTUAL`]: {
    type: 'state',
    common: {
      name: 'Temperatur',
      role: 'value.temperature',
      type: 'number',
      unit: '°C',
      read: true,
      write: false,
      alias: { id: 'zigbee.0.nirgends.' },
    },
  },
};

/**
 * A helper state in a 0_userdata.0 folder: no channel or device above it, so
 * only a manual entity reaches it (Task 13b).
 */
const HELPER = '0_userdata.0.Heizung.Vorlauf';
/**
 * Editable helpers. The panel cannot edit three: a number with no min/max, a
 * select with no states, a date in a local format -- a reason known only once
 * the value is read. It can edit a bounded number, and a text helper that has
 * no value yet but declares its kind (Ruling 92).
 */
const STUFE = '0_userdata.0.Heizung.Stufe';
const MODUS = '0_userdata.0.Heizung.Modus';
const SOLL = '0_userdata.0.Heizung.Soll';
const DATUM = '0_userdata.0.Heizung.Datum';
const ALARM = '0_userdata.0.Heizung.Alarm';
const HELPER_OBJECTS: Record<string, object> = {
  '0_userdata.0.Heizung': { type: 'folder', common: { name: 'Heizung' } },
  [HELPER]: {
    type: 'state',
    common: { name: 'Vorlauf', role: 'value.temperature', type: 'number', unit: '°C', read: true, write: false },
  },
  [STUFE]: { type: 'state', common: { name: 'Stufe', role: 'level', type: 'number', read: true, write: true } },
  [MODUS]: { type: 'state', common: { name: 'Modus', role: 'text', type: 'string', read: true, write: true } },
  [SOLL]: { type: 'state', common: { name: 'Soll', role: 'level', type: 'number', min: 15, max: 28, read: true, write: true } },
  [DATUM]: { type: 'state', common: { name: 'Datum', role: 'text', type: 'string', read: true, write: true } },
  [ALARM]: { type: 'state', common: { name: 'Alarm', role: 'text', type: 'string', read: true, write: true } },
};
/** More missing states than one warning lists (Task 13b round 1, m6). */
const MISSING = Array.from({ length: 21 }, (_, index) => `0_userdata.0.Heizung.Fehlt_${index + 1}`);

/** A socket, as type-detector finds one: a channel with one writable switch state. */
const KAFFEE = 'shelly.0.Kaffee';
const KAFFEE_SWITCH = `${KAFFEE}.Switch`;
const KAFFEE_OBJECTS: Record<string, object> = {
  [KAFFEE]: { type: 'channel', common: { name: 'Kaffee' } },
  [KAFFEE_SWITCH]: { type: 'state', common: { name: 'Schalten', role: 'switch', type: 'boolean', read: true, write: true } },
};

/** More editable numbers than a panel keeps values for (Ruling 111): 130 helpers, "Regler 000" to "Regler 129". */
const REGLER = Array.from({ length: 130 }, (_, index) => `0_userdata.0.Regler.Soll_${String(index).padStart(3, '0')}`);
const REGLER_OBJECTS: Record<string, object> = Object.fromEntries(
  REGLER.map((id, index) => [
    id,
    { type: 'state', common: { name: `Regler ${String(index).padStart(3, '0')}`, role: 'level', type: 'number', min: 0, max: 100, read: true, write: true } },
  ]),
);

/** The balcony, for the picker's room column (Task 21b): the sensor is in it. */
const ROOM_OBJECTS: Record<string, object> = {
  'enum.rooms.balkon': { type: 'enum', common: { name: 'Balkon', members: [SENSOR] } },
};

/**
 * A list of 64 choices, detected as a reading, that a user would force into a
 * select (Task 23). A panel takes 64 options (more make it read-only, no list
 * sent), each at most 255 bytes; only labels that JSON escapes, such as these
 * backslashes, can take its /control payload over the 24576 bytes it takes,
 * so it goes without them (Ruling 98). Not under alias.0: js-controller reads
 * an alias state through its target, and this one has none.
 */
const SENDER = 'mqtt.0.Radio.Sender';
const SENDER_SET = `${SENDER}.SET`;
const STATIONS = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`s${i}`, `Sender ${i} ${'\\'.repeat(240)}`]));
const SENDER_OBJECTS: Record<string, object> = {
  [SENDER]: { type: 'channel', common: { name: 'Sender' } },
  [SENDER_SET]: { type: 'state', common: { name: 'Sender', role: 'state', type: 'string', read: true, write: true, states: STATIONS } },
};

/** A second thermometer named Balkon, as people name them (review m1). */
const TWIN = 'deconz.0.Sensors.7';
const TWIN_OBJECTS: Record<string, object> = {
  [TWIN]: { type: 'device', common: { name: 'Balkon' } },
  [`${TWIN}.temperature`]: {
    type: 'state',
    common: { name: 'Temperature', role: 'value.temperature', type: 'number', unit: '°C', read: true, write: false },
  },
};

/**
 * A thermostat whose modes carry Homematic's own labels (Ruling 141): no
 * firmware hvac name among them, so no mode button unless the Climate modes
 * table maps them. Not under alias.0, whose states js-controller reads
 * through a target.
 */
const TRV = 'hm-rpc.0.000A1BE9A2B3C4';
const TRV_ROOT = `${TRV}.1`;
const TRV_MODE = `${TRV_ROOT}.SET_POINT_MODE`;
const TRV_OBJECTS: Record<string, object> = {
  [TRV]: { type: 'device', common: { name: 'Heizung Bad' } },
  [TRV_ROOT]: { type: 'channel', common: { name: 'Heizung Bad:1' } },
  [`${TRV_ROOT}.ACTUAL_TEMPERATURE`]: {
    type: 'state',
    common: { name: 'Ist', role: 'value.temperature', type: 'number', unit: '°C', read: true, write: false },
  },
  [`${TRV_ROOT}.SET_POINT_TEMPERATURE`]: {
    type: 'state',
    common: { name: 'Soll', role: 'level.temperature', type: 'number', unit: '°C', min: 4.5, max: 30.5, read: true, write: true },
  },
  [TRV_MODE]: {
    type: 'state',
    common: {
      name: 'Modus',
      role: 'level.mode.thermostat',
      type: 'number',
      read: true,
      write: true,
      states: { 0: 'AUTO-MODE', 1: 'MANU-MODE', 2: 'PARTY-MODE', 3: 'BOOST-MODE' },
    },
  },
};

/**
 * For the round trips (Task 24), a device of each v0.2 domain the TRV above
 * leaves, laid out as the adapters behind them lay them out: a KNX blind, a
 * Squeezebox player, a weather station whose temperature sits in a channel
 * (Ruling 46), a KNX ventilation level, and a heating programme and an alarm
 * clock, readings the Devices tab forces into select and datetime, which no
 * detector type yields.
 */
const BLIND = 'knx.0.Rollladen.Wohnzimmer';
const PLAYER = 'squeezeboxrpc.0.Players.Kueche';
const STATION = 'weather.0.station';
const LEVEL = 'knx.0.Lueftung';
const PROGRAM = 'mqtt.0.Heizung.Programm';
const CLOCK = 'mqtt.0.Wecker';
const readOnly = (name: string, role: string, type: string, extra: object = {}): object => ({
  type: 'state',
  common: { name, role, type, read: true, write: false, ...extra },
});
const writable = (name: string, role: string, type: string, extra: object = {}): object => ({
  type: 'state',
  common: { name, role, type, read: true, write: true, ...extra },
});
const button = (name: string, role: string): object => ({ type: 'state', common: { name, role, type: 'boolean', read: false, write: true } });
const DOMAIN_OBJECTS: Record<string, object> = {
  [BLIND]: { type: 'channel', common: { name: 'Rollladen Wohnzimmer' } },
  [`${BLIND}.SET`]: writable('Position', 'level.blind', 'number', { min: 0, max: 100, unit: '%' }),
  [`${BLIND}.ACTUAL`]: readOnly('Ist', 'value.blind', 'number', { min: 0, max: 100, unit: '%' }),
  [`${BLIND}.STOP`]: button('Stop', 'button.stop.blind'),
  [PLAYER]: { type: 'channel', common: { name: 'Kuechenradio' } },
  [`${PLAYER}.state`]: writable('Status', 'media.state', 'number', { states: { 0: 'pause', 1: 'play', 2: 'stop' } }),
  [`${PLAYER}.btnForward`]: button('Weiter', 'button.next'),
  [`${PLAYER}.btnRewind`]: button('Zurueck', 'button.prev'),
  [`${PLAYER}.Volume`]: writable('Lautstaerke', 'level.volume', 'number', { min: 0, max: 100 }),
  [`${PLAYER}.Title`]: readOnly('Titel', 'media.title', 'string'),
  [STATION]: { type: 'device', common: { name: 'Wetterstation' } },
  [`${STATION}.icon`]: readOnly('Symbol', 'weather.icon', 'string'),
  [`${STATION}.outside`]: { type: 'channel', common: { name: 'Aussen' } },
  [`${STATION}.outside.temperature`]: readOnly('Temperatur', 'value.temperature', 'number', { unit: '°C' }),
  [LEVEL]: { type: 'channel', common: { name: 'Lueftung' } },
  [`${LEVEL}.Stufe`]: writable('Stufe', 'level', 'number', { min: 0, max: 4 }),
  [PROGRAM]: { type: 'channel', common: { name: 'Heizprogramm' } },
  [`${PROGRAM}.SET`]: writable('Programm', 'state', 'number', { states: { 0: 'Aus', 1: 'Eco', 2: 'Komfort' } }),
  [CLOCK]: { type: 'channel', common: { name: 'Wecker' } },
  [`${CLOCK}.Zeit`]: writable('Zeit', 'text', 'string'),
};

/**
 * Rows that pick devices, as the picker writes them (Task 21b): nothing
 * reaches a panel without one, and only a row carrying what Refresh found
 * counts (Ruling 118). The runtime reads the detected domain only as that
 * mark, so any text does.
 */
const picked = (...objectIds: string[]): object[] => objectIds.map((objectId) => ({ objectId, include: true, detectedDomain: 'sensor' }));
/**
 * The marker a Refresh of this picker leaves in the saved form: publishing is
 * armed (Ruling 118). The version is bumped, so the true of 4cbb6d3 arms
 * no longer (Ruling 120).
 */
const PICKER = 2;
const ARMED = { pickerArmed: PICKER };

const FIXTURE_IDS = [
  ...Object.keys(SENSOR_OBJECTS),
  ...Object.keys(CORRUPT_ENUM_OBJECTS),
  ...Object.keys(BAD_OBJECTS),
  ...Object.keys(HELPER_OBJECTS),
  ...Object.keys(KAFFEE_OBJECTS),
  ...Object.keys(ROOM_OBJECTS),
  ...Object.keys(SENDER_OBJECTS),
  ...Object.keys(TWIN_OBJECTS),
  ...Object.keys(TRV_OBJECTS),
  ...Object.keys(DOMAIN_OBJECTS),
];

/** A panel as the firmware announces itself: retained on the broker, like its last configuration. */
const PANEL = 'e2e1';
const ANNOUNCE_TOPIC = `tab5_lvgl/config/${PANEL}/bridge`;
const APPLY_TOPIC = `tab5_lvgl/config/${PANEL}/bridge/apply`;
const REQUEST_TOPIC = `tab5_lvgl/config/${PANEL}/bridge/request`;
const ANNOUNCEMENT = JSON.stringify({
  device_id: PANEL,
  base_topic: 'hometiles-e2e',
  ha_prefix: 'ha/e2e',
  device_name: 'E2E Panel',
  model: 'waveshare_touch_lcd_8',
  sensors: [],
  binary_sensors: [],
  scene_map: {},
  local_io: [],
});
const LAST_GOOD_APPLY = '{"marker":"the last good configuration"}';

/** A topic of the panel's own, for settled(). */
const BARRIER_TOPIC = 'hometiles-test/barrier';

/**
 * A broker, and a panel client on it that records every apply it receives.
 * On a port the system hands out (Ruling 137), known once the suite starts.
 */
function withBrokerAndPanel(): {
  applies: string[];
  panel: () => MqttClient;
  port: () => number;
  /**
   * Resolves once the panel has received all the broker routed to it before
   * now: a message the panel sends itself comes back after it. Called once the
   * adapter has done what it would publish (a state it sets after, its log,
   * its exit), it says the panel has seen all of that, and that anything not
   * seen was not sent. No fixed sleep (Task 24).
   */
  settled: () => Promise<void>;
  /** What the broker retains on these topics, from its own store: what a panel subscribing now is sent. */
  retained: (...topics: string[]) => Promise<Record<string, string>>;
} {
  const applies: string[] = [];
  let broker: Aedes;
  let server: Server;
  let panel: MqttClient;
  let bound = 0;
  const marks = new Map<string, () => void>();
  let sent = 0;
  // Created in the hook: a broker's timers would keep a --grep run that
  // skips this suite from ever exiting.
  before(async () => {
    broker = new Aedes();
    server = createServer(broker.handle);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    bound = (server.address() as AddressInfo).port;
    panel = await mqtt.connectAsync(`mqtt://127.0.0.1:${bound}`);
    panel.on('message', (topic, payload) => {
      if (topic === APPLY_TOPIC) applies.push(payload.toString());
      if (topic === BARRIER_TOPIC) marks.get(payload.toString())?.();
    });
    await panel.subscribeAsync([APPLY_TOPIC, BARRIER_TOPIC]);
    await panel.publishAsync(ANNOUNCE_TOPIC, ANNOUNCEMENT, { retain: true });
  });
  after((done) => {
    panel.end(true);
    server.close(() => done());
    broker.close();
  });
  return {
    applies,
    panel: () => panel,
    port: () => bound,
    settled: () =>
      new Promise<void>((resolve) => {
        const mark = String(++sent);
        marks.set(mark, () => {
          marks.delete(mark);
          resolve();
        });
        panel.publish(BARRIER_TOPIC, mark);
      }),
    retained: async (...topics) => {
      const kept: Record<string, string> = {};
      // aedes types its persistence as any; the memory store streams its retained packets.
      const store = (broker as unknown as { persistence: { createRetainedStream(pattern: string): AsyncIterable<{ topic: string; payload: Buffer }> } }).persistence;
      for (const topic of topics) for await (const packet of store.createRetainedStream(topic)) kept[packet.topic] = packet.payload.toString();
      return kept;
    },
  };
}

/** An admin request as admin sends one (sendTo with a callback), and the adapter's answer; one at a time. */
async function askAdapter(harness: IntegrationTestHarness, command: string, message: unknown): Promise<unknown> {
  let answer: unknown;
  harness.sendTo('hometiles.0', command, message, (reply: unknown) => {
    answer = reply;
  });
  return waitFor(harness, () => answer, `the answer to ${command}`);
}

/**
 * Commands some client left retained, one per leaf (Ruling 101). The switch
 * and light ones would switch the socket on (a light's on reaches a switch
 * too); the others name no scene, or a call a switch does not take, and
 * would be refused with a warning.
 */
const RETAINED_COMMANDS: Array<[string, string]> = [
  ['switch', '{"entity_id":"switch.kaffee","state":"on"}'],
  ['light', '{"entity_id":"switch.kaffee","state":"on"}'],
  ['scene', 'gute nacht'],
  ['climate', '{"entity_id":"switch.kaffee","command":"set_hvac_mode","hvac_mode":"heat"}'],
  ['cover', '{"entity_id":"switch.kaffee","command":"open_cover"}'],
  ['media', '{"entity_id":"switch.kaffee","command":"next"}'],
];

/** A state change as the harness reports it. */
type Change = { val: unknown; ack: boolean } | null | undefined;

/** Every value written to `id` as a command (ack false), in order, from now on. */
function commandsTo(harness: IntegrationTestHarness, id: string): unknown[] {
  const written: unknown[] = [];
  harness.on('stateChange', (changed: string, state: Change) => {
    if (changed === id && state && !state.ack) written.push(state.val);
  });
  return written;
}

/** Every value `id` takes from now on. */
function valuesOf(harness: IntegrationTestHarness, id: string): unknown[] {
  const values: unknown[] = [];
  harness.on('stateChange', (changed: string, state: Change) => {
    if (changed === id && state) values.push(state.val);
  });
  return values;
}

/**
 * Objects that cannot be read at all: the object view discovery reads each
 * device through is gone from the objects database. The one systemic failure
 * a test can cause without touching the adapter's code (Ruling 60(2)).
 */
type DesignDocument = { views: Record<string, unknown> } & Record<string, unknown>;
async function breakDeviceView(harness: IntegrationTestHarness): Promise<DesignDocument> {
  const design = (await harness.objects.getObjectAsync('_design/system')) as DesignDocument;
  const views = { ...design.views };
  delete views.device;
  await harness.objects.setObjectAsync('_design/system', { ...design, views });
  return design;
}

/**
 * A real iobroker.history beside the harness's js-controller (Task 19): the
 * provider's queries meet the adapter itself, not a port of it. It is
 * installed once under the harness's test directory but outside its
 * node_modules, which the harness's own `npm i` would prune; its adapter-core
 * finds the harness's js-controller further up. js-controller looks for an
 * adapter's directory beside itself, or where require finds it
 * (js-controller-common-db tools.js getAdapterDir): the suite starts it with
 * NODE_PATH naming its node_modules. A link there instead changed the harness's
 * node_modules after npm's last install, every run (Task 24).
 */
const HISTORY_VERSION = '5.0.1';
const HISTORY_DIR = path.join(os.tmpdir(), 'test-iobroker.hometiles', 'history-adapter');
/** The harness's js-controller, whose command line a suite runs as an install or upgrade does (Ruling 143). */
const CONTROLLER_DIR = path.join(os.tmpdir(), 'test-iobroker.hometiles', 'node_modules', 'iobroker.js-controller');
const HISTORY_STORE = path.join(HISTORY_DIR, 'store');
const HISTORY_PACKAGE = path.join(HISTORY_DIR, 'node_modules', 'iobroker.history');
const HISTORY_MAIN = path.join(HISTORY_PACKAGE, 'build', 'main.js');

type HistoryRow = { ts: number; val: unknown; ack: boolean; q: number };

/** Rows written where iobroker.history reads them: one JSON file per local day (getHistory.js:119-136). */
function plantHistory(id: string, rows: HistoryRow[]): void {
  const days = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    const date = new Date(row.ts);
    const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(2, '0')).join('');
    days.set(day, [...(days.get(day) ?? []), row]);
  }
  for (const [day, dayRows] of days) {
    mkdirSync(path.join(HISTORY_STORE, day), { recursive: true });
    writeFileSync(path.join(HISTORY_STORE, day, `history.${id}.json`), JSON.stringify(dayRows));
  }
}

/**
 * The adapter's getHistoryAsync as js-controller runs it (adapter.js
 * _getHistory): a getHistory message to the instance named, `end` now + 5000 s
 * when not given, an `error` in the answer a rejection. The harness sends it
 * in the adapter's place.
 */
function harnessHistory(harness: IntegrationTestHarness): HistorySource {
  return {
    getHistoryAsync: (id, options) =>
      new Promise((resolve, reject) => {
        const message = { id, options: { ...options, end: options.end || Date.now() + 5e6 } };
        harness.sendTo(options.instance ?? '', 'getHistory', message, (reply: unknown) => {
          const answer = reply as { result?: unknown; error?: unknown } | undefined;
          if (answer?.error) reject(new Error(String(answer.error)));
          else resolve({ result: answer?.result });
        });
      }),
    getForeignObjectAsync: (id) => harness.objects.getObjectAsync(id),
    getForeignStateAsync: (id) => harness.states.getStateAsync(id),
  };
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const row = (ts: number, val: unknown, q = 0, ack = true): HistoryRow => ({ ts, val, ack, q });

/** A kWh counter every 10 minutes, 0.1 a row, from 20:00 yesterday to two minutes before `until` (Task 20b). */
const meterRows = (until: number): HistoryRow[] => {
  const eightPm = new Date(until).setHours(-4, 0, 0, 0);
  return Array.from({ length: Math.floor((until - 120_000 - eightPm) / 600_000) + 1 }, (_, i) => row(eightPm + i * 600_000, 900 + i / 10));
};

/**
 * A real iobroker.history for the suite it is called in (Task 19). Installed
 * once, and again for another version; without the network the install
 * fails and the suite is skipped, saying why (M-7). Run with NODE_PATH where
 * js-controller finds it (HISTORY_DIR). The `planted()` rows go into its store,
 * each of those states and of `unlogged` gets its object, all but `unlogged`
 * logged by history.0, and it runs until it answers for the first planted
 * state. Afterwards it is stopped and all it added removed: the next run's
 * database starts from what the last suite leaves.
 */
function withHistoryAdapter(
  getHarness: () => IntegrationTestHarness,
  planted: () => Record<string, HistoryRow[]>,
  unlogged: readonly string[] = [],
): void {
  let adapter: ChildProcess | undefined;
  let systemConfig: Record<string, unknown> | null | undefined;
  let ids: string[] = [];

  before(async function () {
    this.timeout(300000);
    const installed = (): unknown => {
      try {
        return JSON.parse(readFileSync(path.join(HISTORY_PACKAGE, 'package.json'), 'utf8')).version;
      } catch {
        return undefined;
      }
    };
    if (installed() !== HISTORY_VERSION) {
      mkdirSync(HISTORY_DIR, { recursive: true });
      try {
        execFileSync('npm', ['install', '--prefix', HISTORY_DIR, '--omit=dev', '--no-audit', '--no-fund', `iobroker.history@${HISTORY_VERSION}`], {
          stdio: 'pipe',
        });
      } catch (error) {
        const reason = String((error as { stderr?: unknown }).stderr ?? error).trim().split('\n').slice(-3).join(' ');
        process.stderr.write(`Skipping the iobroker.history suite: installing iobroker.history@${HISTORY_VERSION} failed: ${reason}\n`);
        this.skip();
      }
    }
    rmSync(HISTORY_STORE, { recursive: true, force: true });
    const rows = planted();
    for (const [id, list] of Object.entries(rows)) plantHistory(id, list);
    ids = [...Object.keys(rows), ...unlogged];

    const harness = getHarness();
    systemConfig = await harness.objects.getObjectAsync('system.config');
    const custom = { 'history.0': { enabled: true, changesOnly: true, debounce: 0, retention: 31536000, maxLength: 960 } };
    for (const id of ids) {
      const common = { name: id, type: 'mixed', role: 'value', read: true, write: false, ...(unlogged.includes(id) ? {} : { custom }) };
      await harness.objects.setObjectAsync(id, { _id: id, type: 'state', common, native: {} });
    }
    const io = JSON.parse(readFileSync(path.join(HISTORY_PACKAGE, 'io-package.json'), 'utf8'));
    await harness.objects.setObjectAsync('system.adapter.history.0', {
      _id: 'system.adapter.history.0',
      type: 'instance',
      common: { ...io.common, enabled: true },
      native: { ...io.native, storeDir: HISTORY_STORE, writeNulls: false },
    });
    const log = openSync(path.join(HISTORY_DIR, 'history.0.log'), 'w');
    adapter = spawn(process.execPath, [HISTORY_MAIN, '--force', '--console'], {
      cwd: HISTORY_DIR,
      stdio: ['ignore', log, log],
      env: { ...process.env, NODE_PATH: path.join(HISTORY_DIR, 'node_modules') },
    });
    closeSync(log);

    // Alive comes before its ready handler has set the store directory:
    // asked earlier, it reads nothing, so wait for a first real answer.
    const provider = new HistoryProvider(harnessHistory(harness), { info() {}, warn() {}, error() {}, debug() {} }, 'history.0');
    const deadline = Date.now() + 60000;
    for (;;) {
      if (adapter.exitCode !== null) throw new Error(`iobroker.history exited with ${adapter.exitCode}; see ${HISTORY_DIR}/history.0.log`);
      const result = await provider.query(ids[0]!, { start: Date.now() - 24 * 3_600_000, kind: 'numeric', panel: 'e2e' });
      if (result.available && result.rows.length > 0) break;
      if (Date.now() > deadline) throw new Error(`iobroker.history never answered (${result.reason ?? 'no rows'})`);
      await pause(500);
    }
  });

  after(async function () {
    this.timeout(30000);
    if (adapter && adapter.exitCode === null) {
      const exited = new Promise((resolve) => adapter!.once('exit', resolve));
      adapter.kill('SIGTERM');
      await Promise.race([exited, pause(10000)]);
      if (adapter.exitCode === null) adapter.kill('SIGKILL');
    }
    const harness = getHarness();
    for (const id of [...ids, 'system.adapter.history.0']) await harness.objects.delObjectAsync(id).catch(() => undefined);
    if (systemConfig) await harness.objects.setObjectAsync('system.config', systemConfig);
  });
}

// Opt-in: this downloads and runs a real js-controller, so it stays out of the
// default suite. Run it with HOMETILES_INTEGRATION=1 npm test.
if (process.env.HOMETILES_INTEGRATION === '1') {
  useFreeDatabasePorts();
  failOnNpmErrors();
  tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
      suite('startup', (getHarness) => {
        it('starts with no reachable broker and reports info.connection false', async function () {
          this.timeout(120000);
          const harness = getHarness();
          await harness.startAdapterAndWait();
          const state = await harness.states.getStateAsync('hometiles.0.info.connection');
          expect(state?.val).to.equal(false);
        });
      });

      suite('a hand-edited id store and option (Rulings 51, 58)', (getHarness) => {
        withCleanFixtures(getHarness);

        it('starts normally, warns about each, and writes both stores back valid', async function () {
          this.timeout(120000);
          const harness = getHarness();
          const logs = await captureLogs(harness);
          // A number where text belongs made validateOptions throw in onReady.
          await harness.changeAdapterConfig('hometiles', { native: { clientId: 42, ...ARMED, deviceOverrides: picked(SENSOR) } });
          await setObjects(harness, SENSOR_OBJECTS);
          // JSON null used to throw inside discovery; a non-string id would
          // throw in resolveEntityIds. Both stopped the adapter from starting.
          const rejected = { 'info.rootAnchors': 'null', 'info.entityIds': `{"${SENSOR}":5}` };
          for (const [id, val] of Object.entries(rejected)) await harness.states.setStateAsync(`hometiles.0.${id}`, { val, ack: true });
          await harness.startAdapterAndWait();
          await waitFor(harness, () => ready(logs), 'onReady to finish');

          const warnings = logs.filter((log) => log.severity === 'warn').map((log) => log.message);
          expect(warnings.some((message) => message.includes('[Config] clientId ')), warnings.join('\n')).to.equal(true);
          // Each rejected value is in the log before the first save overwrites it.
          for (const [id, val] of Object.entries(rejected)) {
            expect(warnings.some((message) => message.includes(id) && message.endsWith(`It held: ${val}`)), warnings.join('\n')).to.equal(true);
          }
          const stored = async (id: string): Promise<unknown> =>
            JSON.parse(String((await harness.states.getStateAsync(`hometiles.0.${id}`))?.val));
          expect(await stored('info.rootAnchors')).to.deep.equal({ [SENSOR]: `${SENSOR}.temperature` });
          expect(await stored('info.entityIds')).to.deep.equal({ [SENSOR]: 'sensor.balkon' });
          expect(harness.didAdapterStop(), 'the adapter keeps running').to.equal(false);
        });
      });

      suite('a corrupt function enum (Ruling 58 D)', (getHarness) => {
        withCleanFixtures(getHarness);
        /** One the system hands out (Ruling 137). */
        let port = 0;
        // Created in the hook: a broker's timers would keep a --grep run
        // that skips this suite from ever exiting.
        let broker: Aedes;
        let server: Server;
        before((done) => {
          broker = new Aedes();
          server = createServer(broker.handle);
          server.listen(0, '127.0.0.1', () => {
            port = (server.address() as AddressInfo).port;
            done();
          });
        });
        after((done) => {
          server.close(() => done());
          broker.close();
        });

        it('is left out with a warning, and discovery still publishes every device', async function () {
          this.timeout(120000);
          const harness = getHarness();
          const logs = await captureLogs(harness);
          await harness.changeAdapterConfig('hometiles', {
            native: { brokerHost: '127.0.0.1', brokerPort: port, ...ARMED, deviceOverrides: picked('knx.0.Licht.Flur') },
          });
          await setObjects(harness, CORRUPT_ENUM_OBJECTS);
          // Resolves once info.connection is true: MQTT connected.
          await harness.startAdapterAndWait(true);
          await waitFor(harness, () => ready(logs), 'onReady to finish');

          const own = logs.filter((log) => log.message.startsWith('hometiles.0 '));
          const warnings = own.filter((log) => log.severity === 'warn').map((log) => log.message);
          expect(warnings.some((message) => message.includes('enum.functions.licht')), warnings.join('\n')).to.equal(true);
          const errors = own.filter((log) => log.severity === 'error').map((log) => log.message);
          expect(errors, errors.join('\n')).to.deep.equal([]);
          // Without its only function enum the lamp is a socket, but it is there.
          const ids = JSON.parse(String((await harness.states.getStateAsync('hometiles.0.info.entityIds'))?.val));
          expect(ids).to.deep.equal({ 'knx.0.Licht.Flur': 'switch.flurlicht' });
        });
      });

      suite('a discovery that fails, then recovers (Ruling 56)', (getHarness) => {
        withCleanFixtures(getHarness);
        const { applies, panel, port, settled } = withBrokerAndPanel();
        /** An entity the last run published and this run's selection leaves out (Task 21b). */
        const ALT_STATE = 'ha/e2e/sensor/alt/state';
        const altState: string[] = [];
        let design: DesignDocument | undefined;
        // Never leave the objects database without its view: the harness
        // backs up whatever the last suite of a run left behind.
        after(async () => {
          if (design) await getHarness().objects.setObjectAsync('_design/system', design);
        });
        before(async () => {
          // What the panel holds: its last good configuration, and a state it was given.
          await panel().publishAsync(APPLY_TOPIC, LAST_GOOD_APPLY, { retain: true });
          await panel().publishAsync(ALT_STATE, '7', { retain: true });
          panel().on('message', (topic, payload) => {
            if (topic === ALT_STATE) altState.push(payload.toString());
          });
          await panel().subscribeAsync(ALT_STATE);
          await settled();
        });

        it('publishes no apply while discovery fails, and says what failed and what happens next', async function () {
          this.timeout(120000);
          const harness = getHarness();
          const logs = await captureLogs(harness);
          await harness.changeAdapterConfig('hometiles', {
            native: { brokerHost: '127.0.0.1', brokerPort: port(), ...ARMED, deviceOverrides: picked(SENSOR) },
          });
          await setObjects(harness, SENSOR_OBJECTS);
          const lastRun = JSON.stringify({ 'zigbee.0.alt': 'sensor.alt' });
          await harness.states.setStateAsync('hometiles.0.info.publishedIds', { val: lastRun, ack: true });
          design = await breakDeviceView(harness);
          const panels = valuesOf(harness, 'hometiles.0.info.panels');
          await harness.startAdapterAndWait(true);
          await waitFor(harness, () => logs.find((log) => log.message.includes(`[Panel ${PANEL}] Session started`)), 'the panel');
          const failure = await waitFor(
            harness,
            () => logs.find((log) => log.severity === 'error' && log.message.includes('Discovering devices failed')),
            'the discovery error',
          );
          expect(failure.message).to.include('"device"');
          expect(failure.message).to.include('Panels keep their last configuration; retrying in 5 s');
          // A retained apply with every list empty would make the firmware
          // prune the panel's tile bindings and save that to flash. The
          // session's first push is over once info.panels counts it
          // (panel-manager.ts); what it sent, the panel then holds.
          await waitFor(harness, () => (panels.includes(1) ? true : undefined), 'the panel session');
          await settled();
          expect(applies).to.deep.equal([LAST_GOOD_APPLY]);
        });

        it('answers an admin request with the error meanwhile, and keeps running (Ruling 58 E)', async function () {
          this.timeout(120000);
          const harness = getHarness();
          await harness.enableSendTo();
          expect(((await askAdapter(harness, 'listDetected', {})) as { error?: string }).error).to.include('"device"');
          // Still running: the next request is answered too. A crash after the
          // first answer would leave it unanswered, and waitFor names the stop.
          expect(((await askAdapter(harness, 'listDetected', {})) as { error?: string }).error).to.include('"device"');
          expect(harness.didAdapterStop(), 'the adapter keeps running').to.equal(false);
        });

        it('publishes the normal apply once a retry succeeds', async function () {
          this.timeout(120000);
          const harness = getHarness();
          if (design) await harness.objects.setObjectAsync('_design/system', design);
          const apply = await waitFor(harness, () => applies.find((payload) => payload.includes('sensor.balkon')), 'the normal apply');
          expect(JSON.parse(apply).sensors).to.deep.equal(['sensor.balkon']);
          expect(applies[0]).to.equal(LAST_GOOD_APPLY);
          // The panel announced while discovery failed, so it is told now what
          // the last run published and this one does not (Task 21b).
          await waitFor(harness, () => (altState.includes('') ? true : undefined), 'the cleared state');
          expect(altState).to.deep.equal(['7', '']);
        });
      });

      suite('one bad object is left out, not the whole installation (Rulings 60, 62)', (getHarness) => {
        withCleanFixtures(getHarness);
        const { applies, panel, port } = withBrokerAndPanel();
        const balkonState: string[] = [];
        let logs: LogRecord[] = [];

        it('publishes every other device with its value, and logs no error', async function () {
          this.timeout(120000);
          const harness = getHarness();
          logs = await captureLogs(harness);
          await harness.changeAdapterConfig('hometiles', {
            native: {
              brokerHost: '127.0.0.1',
              brokerPort: port(),
              // The alias picked too: only a picked device's values are read.
              ...ARMED,
              deviceOverrides: [...picked(SENSOR, BAD_ALIAS), { objectId: FORCED, include: true, detectedDomain: 'sensor', forcedDomain: 'number' }],
            },
          });
          await setObjects(harness, { ...SENSOR_OBJECTS, ...BAD_OBJECTS });
          await harness.states.setStateAsync(`${SENSOR}.temperature`, { val: 21.5, ack: true });
          panel().on('message', (topic, payload) => {
            if (topic === 'ha/e2e/sensor/balkon/state') balkonState.push(payload.toString());
          });
          await panel().subscribeAsync('ha/e2e/sensor/balkon/state');
          await harness.startAdapterAndWait(true);

          const apply = await waitFor(harness, () => applies.find((payload) => payload.includes('sensor.balkon')), 'the apply');
          expect(JSON.parse(apply).sensors).to.deep.equal(['sensor.balkon', 'sensor.kaputt']);
          // The value the sensor held when discovery read it: a failed read of
          // the alias before it left it unread for good.
          await waitFor(harness, () => balkonState.find((payload) => payload === '21.5'), "the sensor's value");
          const errors = logs.filter((log) => log.severity === 'error').map((log) => log.message);
          expect(errors, errors.join('\n')).to.deep.equal([]);
        });

        it('names each of them in a warning', () => {
          const warnings = logs.filter((log) => log.severity === 'warn').map((log) => log.message);
          const named = (text: string): boolean => warnings.some((message) => message.includes('[Registry]') && message.includes(text));
          expect(named(`${BAD_ROLE}.status`), warnings.join('\n')).to.equal(true);
          expect(named(`${BAD_ALIAS}.ACTUAL`), warnings.join('\n')).to.equal(true);
          // Task 13: the device forced into number is an entity, not left out.
          expect(named(FORCED), warnings.join('\n')).to.equal(false);
          // A number fits a temperature: no forced type here is one that made no tile (Ruling 139).
          expect(warnings.filter((message) => message.includes('Forced types that produced no tile'))).to.deep.equal([]);
        });
      });

      suite('manual entities (Task 13b)', (getHarness) => {
        withCleanFixtures(getHarness);
        const { applies, panel, port } = withBrokerAndPanel();
        const helperState: string[] = [];
        /** topic -> the last /control payload on it */
        const controls = new Map<string, string>();
        let logs: LogRecord[] = [];

        it('publishes a 0_userdata state beside the detected devices, with its value', async function () {
          this.timeout(120000);
          const harness = getHarness();
          logs = await captureLogs(harness);
          await harness.changeAdapterConfig('hometiles', {
            native: {
              brokerHost: '127.0.0.1',
              brokerPort: port(),
              ...ARMED,
              // Overrides are for detected devices: neither key removes it,
              // and a manual entity needs no row to be published (Task 21b).
              deviceOverrides: [
                ...picked(SENSOR),
                { objectId: HELPER, include: false },
                { objectId: `manual:${HELPER}`, include: false },
              ],
            },
          });
          await setManualEntities(harness, [
            { stateId: HELPER, domain: 'sensor' },
            // The detected sensor's own state, under the detected sensor's
            // own name: the detected one keeps its id.
            { stateId: `${SENSOR}.temperature`, domain: 'sensor', name: 'Balkon' },
            { stateId: HELPER, domain: 'number' },
            { stateId: '0_userdata.0.Heizung.Fehlt', domain: 'sensor' },
            { stateId: STUFE, domain: 'number' },
            { stateId: MODUS, domain: 'select' },
            { stateId: SOLL, domain: 'number' },
            { stateId: DATUM, domain: 'datetime' },
            { stateId: ALARM, domain: 'datetime', kind: 'time' },
            ...MISSING.map((stateId) => ({ stateId, domain: 'sensor' })),
          ]);
          await setObjects(harness, { ...SENSOR_OBJECTS, ...HELPER_OBJECTS });
          await harness.states.setStateAsync(HELPER, { val: 41.5, ack: true });
          await harness.states.setStateAsync(DATUM, { val: '23.09.2026', ack: true });
          panel().on('message', (topic, payload) => {
            if (topic === 'ha/e2e/sensor/vorlauf/state') helperState.push(payload.toString());
            if (topic.endsWith('/control')) controls.set(topic, payload.toString());
          });
          await panel().subscribeAsync(['ha/e2e/sensor/vorlauf/state', 'ha/e2e/+/+/control']);
          await harness.startAdapterAndWait(true);

          const apply = await waitFor(harness, () => applies.find((payload) => payload.includes('sensor.vorlauf')), 'the apply');
          expect(JSON.parse(apply).sensors).to.deep.equal(['sensor.balkon', 'sensor.balkon_2', 'sensor.vorlauf']);
          const ids = JSON.parse(String((await harness.states.getStateAsync('hometiles.0.info.entityIds'))?.val));
          expect(ids).to.deep.equal({
            [SENSOR]: 'sensor.balkon',
            [`manual:${SENSOR}.temperature`]: 'sensor.balkon_2',
            [`manual:${HELPER}`]: 'sensor.vorlauf',
            [`manual:${STUFE}`]: 'number.stufe',
            [`manual:${MODUS}`]: 'select.modus',
            [`manual:${SOLL}`]: 'number.soll',
            [`manual:${DATUM}`]: 'datetime.datum',
            [`manual:${ALARM}`]: 'datetime.alarm',
          });
          await waitFor(harness, () => helperState.find((payload) => payload === '41.5'), "the helper's value");
        });

        it('publishes the new value when the state changes', async function () {
          this.timeout(60000);
          const harness = getHarness();
          await harness.states.setStateAsync(HELPER, { val: 42, ack: true });
          await waitFor(harness, () => helperState.find((payload) => payload === '42'), 'the new value');
        });

        it('publishes each editable helper retained on its control leaf, "unknown" until it holds a value (Task 14)', async function () {
          this.timeout(60000);
          const harness = getHarness();
          const control = async (entityId: string): Promise<Record<string, unknown>> => {
            const topic = `ha/e2e/${entityId.replace('.', '/')}/control`;
            return JSON.parse(await waitFor(harness, () => controls.get(topic), `${entityId}'s /control`)) as Record<string, unknown>;
          };
          // No value yet: the string "unknown", available and editable, never
          // a null the panel would lock (Ruling 91). Step 1: Home Assistant's
          // for a range of 13 (Ruling 81).
          const soll = await control('number.soll');
          expect(soll).to.deep.include({ version: 1, kind: 'number', state: 'unknown', available: true, writable: true, min: 15, max: 28, step: 1 });
          expect(await control('datetime.alarm')).to.include({ kind: 'time', state: 'unknown', available: true, writable: true });
          // The three the panel cannot edit (the m2 warning below).
          expect(await control('number.stufe')).to.include({ kind: 'number', state: 'unknown', writable: false }).and.not.have.property('min');
          expect(await control('select.modus')).to.include({ kind: 'select', state: 'unknown', writable: false }).and.not.have.property('options');
          expect(await control('datetime.datum')).to.include({ kind: 'datetime', state: '23.09.2026', writable: false });
          const all = await Promise.all(['number.stufe', 'number.soll', 'select.modus', 'datetime.datum', 'datetime.alarm'].map(control));
          // One session for the process, and never a read-only reason on the wire.
          expect(new Set(all.map((payload) => payload.session))).to.deep.equal(new Set([soll.session]));
          expect(soll.session).to.match(/^[0-9a-f]{32}$/);
          expect(JSON.stringify(all)).to.not.match(/no min\/max|no states|no date or time/);

          // Retained: a panel that subscribes later gets it from the broker.
          const late = await mqtt.connectAsync(`mqtt://127.0.0.1:${port()}`);
          try {
            const retained = new Promise<string>((resolve) => {
              late.on('message', (_topic, payload, packet) => {
                if (packet.retain) resolve(payload.toString());
              });
            });
            await late.subscribeAsync('ha/e2e/number/soll/control');
            expect(JSON.parse(await retained)).to.deep.equal(soll);
          } finally {
            late.end(true);
          }
        });

        it("confirms a panel's command on a 0_userdata helper that no adapter acks (Task 15, Ruling 100)", async function () {
          // Longer than one wait, so a wait that runs out says what it waited for.
          this.timeout(120000);
          const harness = getHarness();
          const topic = 'ha/e2e/number/soll/control';
          const acks: Array<Record<string, unknown>> = [];
          panel().on('message', (messageTopic, payload) => {
            if (messageTopic === 'hometiles-e2e/stat/value') acks.push(JSON.parse(payload.toString()) as Record<string, unknown>);
          });
          await panel().subscribeAsync('hometiles-e2e/stat/value');
          const shown = (): Record<string, unknown> => JSON.parse(controls.get(topic) ?? '{}') as Record<string, unknown>;

          // The second command carries the revision of the /control the first one's change produced.
          for (const [value, id] of [
            [21, '1a2b3c4d-0002b1c8-00000001'],
            [22, '1a2b3c4d-0002b1c8-00000002'],
          ] as const) {
            const { session, revision } = shown();
            const deadline = Math.floor(Date.now() / 1000) + 10;
            await panel().publishAsync('hometiles-e2e/cmnd/value', JSON.stringify({ entity_id: 'number.soll', session, revision, value, id, deadline }));
            const ack = await waitFor(harness, () => acks.find((answer) => answer.id === id), `the answer to ${value}`);
            expect(ack).to.deep.equal({ entity_id: 'number.soll', id, status: 'ok' });
            // Written as a command, and nothing acks a 0_userdata state.
            expect(await harness.states.getStateAsync(SOLL)).to.include({ val: value, ack: false });
            // That change reached the entity (main.ts:277): the /control the panel waits for.
            await waitFor(harness, () => (shown().state === String(value) ? true : undefined), `the /control showing ${value}`);
          }
          const noisy = logs.filter((log) => log.message.startsWith('hometiles.0 ') && log.severity !== 'debug' && log.message.includes('number.soll'));
          expect(noisy.map((log) => log.message)).to.deep.equal([]);
        });

        /** The adapter's own warnings that contain `text`, from their `[Registry]` tag on. */
        const warned = (text: string): string[] =>
          logs
            .filter((log) => log.message.startsWith('hometiles.0 ') && log.severity === 'warn' && log.message.includes(text))
            .map((log) => log.message.slice(log.message.indexOf('[Registry]')));

        it('names each entry left out once, the first 20 in one warning, and logs no error', () => {
          const missing = MISSING.slice(0, 18).map((id) => `${id} (no such object)`);
          expect(warned('Manual entities left out')).to.deep.equal([
            `[Registry] Manual entities left out: ${HELPER} (listed more than once; the first entry is used), ` +
              `0_userdata.0.Heizung.Fehlt (no such object), ${missing.join(', ')}, and 3 more`,
          ]);
          const errors = logs.filter((log) => log.message.startsWith('hometiles.0 ') && log.severity === 'error').map((log) => log.message);
          expect(errors, errors.join('\n')).to.deep.equal([]);
        });

        it('names the manual editable values shown read-only, and what each lacks, in one warning (m2)', () => {
          // The date's reason is its value's; the alarm is editable by its kind.
          expect(warned('Manual entities shown read-only')).to.deep.equal([
            `[Registry] Manual entities shown read-only: ${STUFE} (no min/max), ${MODUS} (no states), ` +
              `${DATUM} (a value that is no date or time)`,
          ]);
        });
      });

      // One broker for both suites: what the panel and a client retained
      // survives the adapter's restart between them.
      describe('retained panel messages across an adapter restart (Task 15, Ruling 101)', () => {
        const { applies, panel, port } = withBrokerAndPanel();
        const commandWarnings = (logs: LogRecord[]): string[] =>
          logs
            .filter((log) => log.message.startsWith('hometiles.0 ') && log.severity === 'warn' && /command/i.test(log.message))
            .map((log) => log.message);

        async function start(harness: IntegrationTestHarness): Promise<{ logs: LogRecord[]; written: unknown[] }> {
          const logs = await captureLogs(harness);
          await harness.changeAdapterConfig('hometiles', {
            native: { brokerHost: '127.0.0.1', brokerPort: port(), ...ARMED, deviceOverrides: picked(KAFFEE) },
          });
          await setObjects(harness, KAFFEE_OBJECTS);
          await harness.states.setStateAsync(KAFFEE_SWITCH, { val: false, ack: true });
          const written = commandsTo(harness, KAFFEE_SWITCH);
          const seen = applies.length;
          await harness.startAdapterAndWait(true);
          await waitFor(harness, () => applies.slice(seen).find((payload) => payload.includes('switch.kaffee')), 'the apply');
          return { logs, written };
        }

        suite('before the restart', (getHarness) => {
          withCleanFixtures(getHarness);

          it('runs a command a client publishes retained while the adapter listens: it arrives live, once', async function () {
            this.timeout(120000);
            const harness = getHarness();
            const { written } = await start(harness);
            for (const [leaf, payload] of RETAINED_COMMANDS) {
              await panel().publishAsync(`hometiles-e2e/cmnd/${leaf}`, payload, { retain: true });
            }
            await panel().publishAsync('hometiles-e2e/stat/connected', 'online', { retain: true });
            await panel().publishAsync('hometiles-e2e/stat/ip', '192.168.1.40', { retain: true });
            await waitFor(harness, () => (written.length >= 2 ? true : undefined), 'the switch and light commands');
            expect(written).to.deep.equal([true, true]);
          });
        });

        suite('after the restart', (getHarness) => {
          withCleanFixtures(getHarness);

          it('starts from the replayed announcement, reads the replayed presence and IP, and runs no replayed command', async function () {
            this.timeout(120000);
            const harness = getHarness();
            const connected = valuesOf(harness, `hometiles.0.panels.${PANEL}.info.connected`);
            const ip = valuesOf(harness, `hometiles.0.panels.${PANEL}.info.ip`);
            const { logs, written } = await start(harness);
            await waitFor(harness, () => (connected.includes(true) ? true : undefined), 'the replayed presence');
            await waitFor(harness, () => (ip.includes('192.168.1.40') ? true : undefined), 'the replayed IP');
            // Every command leaf is subscribed before presence, so each retained
            // command was replayed by now; a live one after them runs.
            await panel().publishAsync('hometiles-e2e/cmnd/switch', '{"entity_id":"switch.kaffee","state":"off"}');
            await waitFor(harness, () => (written.length ? true : undefined), 'the live command');
            expect(written).to.deep.equal([false]);
            expect(commandWarnings(logs)).to.deep.equal([]);
          });
        });
      });

      suite('stopping the adapter (Ruling 62 B)', (getHarness) => {
        withCleanFixtures(getHarness);
        const { applies, panel, port, settled } = withBrokerAndPanel();
        const ZAEHLER = '0_userdata.0.Energie.Zaehler';
        after(async () => {
          await getHarness().objects.delObjectAsync(ZAEHLER).catch(() => undefined);
          await setEnergyMeters(getHarness(), []);
        });

        it('publishes no empty configuration, however many requests arrive while it stops, an energy meter set or not (Ruling 131)', async function () {
          this.timeout(120000);
          const harness = getHarness();
          const logs = await captureLogs(harness);
          await harness.changeAdapterConfig('hometiles', {
            native: { brokerHost: '127.0.0.1', brokerPort: port(), ...ARMED, deviceOverrides: picked(SENSOR) },
          });
          // A meter alone is worth an apply (Ruling 131); an emptied registry beside it is not.
          await setEnergyMeters(harness, [{ stateId: ZAEHLER, category: 'grid', sign: 1 }]);
          await setObjects(harness, {
            ...SENSOR_OBJECTS,
            [ZAEHLER]: { type: 'state', common: { name: 'Zähler', role: 'value.energy.consumed', type: 'number', unit: 'kWh', read: true, write: false } },
          });
          await harness.startAdapterAndWait(true);
          await waitFor(harness, () => applies.find((payload) => payload.includes('sensor.balkon')), 'the normal apply');

          // The adapter empties its registry while it stops. A panel that asks
          // for its configuration meanwhile must not be told that everything
          // is gone: the firmware would prune every tile and save that.
          const flood = setInterval(() => void panel().publishAsync(REQUEST_TOPIC, 'force'), 1);
          try {
            await harness.stopAdapter();
          } finally {
            clearInterval(flood);
          }
          // The process has exited: all it sent, the panel holds once its own message is back.
          await settled();
          const empty = applies.filter((payload) => !payload.includes('sensor.balkon'));
          expect(empty, `${empty.length} of ${applies.length} applies without the sensor`).to.deep.equal([]);
          // Nor does the log claim one was pushed.
          const pushed = logs.map((log) => log.message).filter((message) => message.includes('Configuration pushed'));
          expect(pushed.filter((message) => !message.includes('Configuration pushed, 1 entities, ')), pushed.join('\n')).to.deep.equal([]);
        });
      });

      suite('more numbers, selects and datetimes than a panel keeps (Ruling 111)', (getHarness) => {
        withCleanFixtures(getHarness);
        const { applies, port } = withBrokerAndPanel();
        const removeRegler = async (): Promise<void> => {
          for (const id of REGLER) await getHarness().objects.delObjectAsync(id).catch(() => undefined);
        };
        before(removeRegler);
        after(async () => {
          await removeRegler();
          await setManualEntities(getHarness(), []);
        });

        it('lists the first 128 by entity id, and names in one warning how many were left out', async function () {
          this.timeout(120000);
          const harness = getHarness();
          const logs = await captureLogs(harness);
          await harness.changeAdapterConfig('hometiles', { native: { brokerHost: '127.0.0.1', brokerPort: port(), ...ARMED } });
          await setManualEntities(harness, REGLER.map((stateId) => ({ stateId, domain: 'number' })));
          await setObjects(harness, REGLER_OBJECTS);
          await harness.startAdapterAndWait(true);

          const apply = await waitFor(harness, () => applies.find((payload) => payload.includes('number.regler_000')), 'the apply');
          const { numbers, editable_meta: meta } = JSON.parse(apply) as { numbers: string[]; editable_meta: Array<{ entity_id: string }> };
          expect(numbers).to.deep.equal(REGLER.slice(0, 128).map((_, index) => `number.regler_${String(index).padStart(3, '0')}`));
          expect(meta.map((entry) => entry.entity_id)).to.deep.equal(numbers);
          const capped = logs.filter((log) => log.message.includes('at most 128'));
          expect(capped.map((log) => log.severity), capped.map((log) => log.message).join('\n')).to.deep.equal(['warn']);
          expect(capped[0]!.message).to.include('[Registry] 2 ').and.include('number.regler_128, number.regler_129');
          // Manual entities alone are a selection: no hint to pick devices (Task 21b).
          expect(logs.filter((log) => log.message.includes('No devices selected yet'))).to.deep.equal([]);
        });
      });

      suite('energy meters in the apply (Task 20b)', (getHarness) => {
        withCleanFixtures(getHarness);
        const { applies, port } = withBrokerAndPanel();
        const BEZUG = '0_userdata.0.Energie.Bezug';
        const EINSPEISUNG = '0_userdata.0.Energie.Einspeisung';
        /** Not electric: the house's consumption does not wait for it (Task 23). */
        const GAS = '0_userdata.0.Energie.Gas';
        const counter = (name: string, unit = 'kWh'): object => ({
          type: 'state',
          common: { name, role: 'value.energy.consumed', type: 'number', unit, read: true, write: false },
        });
        const METER_OBJECTS = { [BEZUG]: counter('Bezug'), [EINSPEISUNG]: counter('Einspeisung'), [GAS]: counter('Gas', 'm³') };
        let system: ({ common: Record<string, unknown> } & Record<string, unknown>) | undefined;
        const removeMeters = async (): Promise<void> => {
          for (const id of Object.keys(METER_OBJECTS)) await getHarness().objects.delObjectAsync(id).catch(() => undefined);
        };
        before(removeMeters);
        after(async () => {
          await removeMeters();
          await setEnergyMeters(getHarness(), []);
          if (system) await getHarness().objects.setObjectAsync('system.config', system);
        });

        it('lists each meter, its cost entry and its category total in bridge/apply, in the system language, under ids it keeps, and names what it cannot use', async function () {
          this.timeout(120000);
          const harness = getHarness();
          const logs = await captureLogs(harness);
          system = (await harness.objects.getObjectAsync('system.config')) as typeof system;
          await harness.objects.setObjectAsync('system.config', { ...system!, common: { ...system!.common, language: 'de' } });
          await harness.changeAdapterConfig('hometiles', {
            native: { brokerHost: '127.0.0.1', brokerPort: port(), ...ARMED, deviceOverrides: picked(SENSOR), historyInstance: 'history.0', currency: 'EUR' },
          });
          await setEnergyMeters(harness, [
            { stateId: BEZUG, category: 'grid', sign: 1, name: 'Hausanschluss [Bezug]', price: 0.3 },
            { stateId: EINSPEISUNG, category: 'grid', sign: -1 },
            { stateId: '0_userdata.0.Energie.Fehlt', category: 'solar', sign: 1 },
            { stateId: GAS, category: 'gas', sign: 1 },
          ]);
          await setObjects(harness, { ...SENSOR_OBJECTS, ...METER_OBJECTS });
          await harness.startAdapterAndWait(true);

          const apply = await waitFor(harness, () => applies.find((payload) => payload.includes('energy.')), 'the apply with the catalog');
          expect(JSON.parse(apply).sensors).to.deep.equal(['sensor.balkon']);
          expect(JSON.parse(apply).energy).to.deep.equal([
            // The house's consumption, in the system language too (Ruling 132).
            { id: 'consumption_total', name: 'Gesamtverbrauch', unit: 'kWh', category: 'consumption' },
            { id: 'energy.hausanschluss_bezug', name: 'Hausanschluss (Bezug)', unit: 'kWh', category: 'grid' },
            { id: 'energy.hausanschluss_bezug_cost', name: 'Hausanschluss (Bezug) (EUR)', unit: 'EUR', category: 'grid' },
            { id: 'energy.einspeisung', name: 'Einspeisung', unit: 'kWh', category: 'grid' },
            { id: 'energy.gas', name: 'Gas', unit: 'm³', category: 'gas' },
            { id: 'grid_total', name: 'Netz gesamt', unit: 'kWh', category: 'grid' },
          ]);
          const stored = JSON.parse(String((await harness.states.getStateAsync('hometiles.0.info.entityIds'))?.val)) as Record<string, string>;
          expect(stored).to.include({ [`energy:${BEZUG}`]: 'energy.hausanschluss_bezug', [`energy:${EINSPEISUNG}`]: 'energy.einspeisung' });
          const energy = logs.filter((log) => log.message.includes('[Energy]'));
          expect(energy.map((log) => log.severity), energy.map((log) => log.message).join('\n')).to.deep.equal(['warn', 'warn']);
          expect(energy[0]!.message).to.include('0_userdata.0.Energie.Fehlt (no such object)');
          expect(energy[1]!.message).to.include('history.0').and.include(BEZUG).and.include(EINSPEISUNG).and.include(GAS);
          // The grid meters unknown, the house's totals are too (energy round 2 C2); the gas meter is no part of them.
          const house = energy[1]!.message.slice(energy[1]!.message.indexOf("The house's"));
          expect(house).to.equal(
            // No device meter: no untracked consumption to name (review m3).
            `The house's total consumption shows 0.000 as well while any grid, solar or battery meter is unknown: ${BEZUG}, ${EINSPEISUNG}. ` +
              'Enable history.0 in the settings of each of these states',
          );
        });
      });

      // Ruling 131: a meter is content for Ruling 116, once armed (Ruling 118).
      for (const armed of [true, false]) {
        suite(`energy meters, no entity in a list, ${armed ? 'armed' : 'before the Devices tab is used'} (Ruling 131)`, (getHarness) => {
          withCleanFixtures(getHarness);
          const { applies, panel, port, settled } = withBrokerAndPanel();
          const ZAEHLER = '0_userdata.0.Energie.Zaehler';
          const removeMeter = async (): Promise<void> => {
            await getHarness().objects.delObjectAsync(ZAEHLER).catch(() => undefined);
          };
          before(removeMeter);
          after(async () => {
            await removeMeter();
            await setEnergyMeters(getHarness(), []);
            await setManualEntities(getHarness(), []);
          });

          const title = armed
            ? 'publishes the apply for the meter beside a scene, which lands in no list: every entity list empty, no hint, the scene counted'
            : 'publishes nothing, answers no request, and names the meter and the manual sensor among what waits';
          it(title, async function () {
            this.timeout(120000);
            const harness = getHarness();
            const logs = await captureLogs(harness);
            // Only a scene picked: on its own it holds the apply back (M7).
            const scene = [{ objectId: KAFFEE, include: true, detectedDomain: 'switch', forcedDomain: 'scene' }];
            await harness.changeAdapterConfig('hometiles', {
              native: { brokerHost: '127.0.0.1', brokerPort: port(), ...(armed ? ARMED : {}), deviceOverrides: scene, historyInstance: 'history.0' },
            });
            await setEnergyMeters(harness, [{ stateId: ZAEHLER, category: 'grid', sign: 1, name: 'Zähler' }]);
            // Unarmed, a manual sensor waits as well (Ruling 118): armed, its graph is answered with its value.
            if (!armed) await setManualEntities(harness, [{ stateId: ZAEHLER, domain: 'sensor', name: 'Fenster' }]);
            await setObjects(harness, {
              ...KAFFEE_OBJECTS,
              [ZAEHLER]: { type: 'state', common: { name: 'Zähler', role: 'value.energy.consumed', type: 'number', unit: 'kWh', read: true, write: false } },
            });
            await harness.states.setStateAsync(ZAEHLER, { val: 1234.5, ack: true });
            const panels = valuesOf(harness, 'hometiles.0.info.panels');
            await harness.startAdapterAndWait(true);
            await waitFor(harness, () => ready(logs), 'onReady to finish');
            // The session's first push is over once info.panels counts it; what it sent, the panel then holds.
            await waitFor(harness, () => (panels.includes(1) ? true : undefined), 'the panel session');
            await settled();
            const hints = (): string[] =>
              logs.map((log) => log.message).filter((message) => message.includes('No devices selected yet') || message.includes('Nothing picked shows in a panel list'));
            const published = async (): Promise<unknown> => JSON.parse(String((await harness.states.getStateAsync('hometiles.0.info.publishedIds'))?.val));
            if (!armed) {
              // Nor is a history or an energy request answered (Task 22). The
              // graph asked for is the manual sensor's, under the id it gets once
              // armed: were the sensor given to the panel, the graph would be
              // answered with its value, as an armed run answers it (review m3,
              // Ruling 138). The session says it ignored it; the presence sent
              // after the energy request, which is read, marks that one handled.
              const answers: string[] = [];
              panel().on('message', (topic) => void (topic.endsWith('/response') && answers.push(topic)));
              await panel().subscribeAsync([`tab5_lvgl/config/${PANEL}/history/response`, `tab5_lvgl/config/${PANEL}/energy/response`]);
              const ignored = (): boolean => logs.some((log) => log.message.includes('History request for sensor.fenster ignored'));
              await panel().publishAsync(`tab5_lvgl/config/${PANEL}/history/request`, '{"entity_id":"sensor.fenster","hours":24,"period_minutes":5}');
              await waitFor(harness, () => (ignored() || answers.length > 0 ? true : undefined), 'the graph request handled');
              const connected = valuesOf(harness, `hometiles.0.panels.${PANEL}.info.connected`);
              await panel().publishAsync(`tab5_lvgl/config/${PANEL}/energy/request`, '{"period":"day"}');
              await panel().publishAsync('hometiles-e2e/stat/connected', 'online');
              await waitFor(harness, () => (connected.includes(true) ? true : undefined), 'the presence');
              expect(answers).to.deep.equal([]);
              expect(ignored(), 'the graph request said to be ignored').to.equal(true);

              expect(applies, 'no apply').to.deep.equal([]);
              expect(hints()).to.have.lengthOf(1);
              expect(hints()[0]).to.include('Held back until then: 1 manual entities, 1 device rows of an earlier version, 1 energy meters');
              expect(await harness.states.getStateAsync('hometiles.0.info.entities')).to.include({ val: 0 });
              expect(await published()).to.deep.equal({});
              return;
            }
            expect(applies, 'an apply').to.not.deep.equal([]);
            const apply = JSON.parse(applies.at(-1)!) as Record<string, unknown>;
            for (const list of ['sensors', 'binary_sensors', 'lights', 'switches', 'media_players', 'climates', 'covers', 'weathers', 'numbers', 'selects', 'datetimes']) {
              expect(apply[list], list).to.deep.equal([]);
            }
            expect((apply.energy as Array<{ id: string }>).map((entry) => entry.id)).to.include('energy.zahler');
            expect(hints()).to.deep.equal([]);
            // What went out is what the adapter reports and records (Ruling 119 M7).
            expect(ready(logs)!.message).to.include('1 picked (manual entities included), 1 entities published');
            expect(await harness.states.getStateAsync('hometiles.0.info.entities')).to.include({ val: 1 });
            expect(await published()).to.deep.equal({ [KAFFEE]: 'scene.kaffee' });
          });
        });
      }

      // One broker for these suites: what a run retained on it survives the
      // restart that saving a selection causes (js-controller restarts an
      // instance whose object changes). The harness restores the database for
      // each suite, so the stores a run leaves are carried into the next, and
      // so is the form a suite "saves", as the admin writes it (JsonConfig.onSave).
      describe('opt-in selection (Task 21b)', () => {
        const { applies, panel, port, settled, retained } = withBrokerAndPanel();
        const UNARMED = 'No devices selected yet — open the Devices tab and click Refresh detected devices';
        const NOTHING = 'No devices selected yet — pick devices in the adapter settings (Devices tab)';
        const ICONS_TOPIC = `tab5_lvgl/config/${PANEL}/bridge/icons`;
        const BALKON_STATE = 'ha/e2e/sensor/balkon/state';
        const LISTS = ['sensors', 'binary_sensors', 'lights', 'switches', 'media_players', 'climates', 'covers', 'weathers', 'numbers', 'selects', 'datetimes', 'energy'];
        const EMPTY = Object.fromEntries(LISTS.map((key) => [key, []]));
        const lists = (apply: string | undefined): Record<string, unknown> => {
          expect(apply, 'an apply').to.be.a('string');
          const parsed = JSON.parse(apply as string) as Record<string, unknown>;
          return Object.fromEntries(LISTS.map((key) => [key, parsed[key]]));
        };
        /** The icons of the panel's last layout, retained beside LAST_GOOD_APPLY: a Home Assistant bridge's, say. */
        const OLD_ICONS = '{"light.flur":"mdi:ceiling-light"}';
        /** Every payload on the sensor's state topic and on bridge/icons, in order, across the runs. */
        const balkonState: string[] = [];
        const icons: string[] = [];
        /** The id and publish stores the last run left, which the next one starts from. */
        const stores: Record<string, string> = {};
        /** The instance config as a suite's admin form saved it, for the next suite's run. */
        let saved: Record<string, unknown> = {};

        before(async () => {
          panel().on('message', (topic, payload) => {
            if (topic === BALKON_STATE) balkonState.push(payload.toString());
            if (topic === ICONS_TOPIC) icons.push(payload.toString());
          });
          await panel().subscribeAsync([BALKON_STATE, ICONS_TOPIC]);
          await panel().publishAsync(APPLY_TOPIC, LAST_GOOD_APPLY, { retain: true });
          await panel().publishAsync(ICONS_TOPIC, OLD_ICONS, { retain: true });
          await settled();
          expect([applies, icons]).to.deep.equal([[LAST_GOOD_APPLY], [OLD_ICONS]]);
        });

        /**
         * Starts a run on this instance config and these manual entities, from
         * the stores the last run left, and waits until the panel's session is
         * set up: its first push made or held back. Its logs, and its apply if
         * it published one.
         */
        async function run(
          harness: IntegrationTestHarness,
          native: Record<string, unknown>,
          manual: object[] = [],
          objects: Record<string, object> = SENSOR_OBJECTS,
        ): Promise<{ logs: LogRecord[]; apply: string | undefined }> {
          const logs = await captureLogs(harness);
          await harness.changeAdapterConfig('hometiles', { native: { brokerHost: '127.0.0.1', brokerPort: port(), ...native } });
          await setManualEntities(harness, manual);
          await setObjects(harness, { ...objects, ...KAFFEE_OBJECTS, ...ROOM_OBJECTS, ...HELPER_OBJECTS });
          await harness.states.setStateAsync(`${SENSOR}.temperature`, { val: 21.5, ack: true });
          for (const [id, val] of Object.entries(stores)) await harness.states.setStateAsync(`hometiles.0.${id}`, { val, ack: true });
          const panels = valuesOf(harness, 'hometiles.0.info.panels');
          const seen = applies.length;
          await harness.startAdapterAndWait(true);
          await waitFor(harness, () => ready(logs), 'onReady to finish');
          // info.panels counts the session once its first push is done (panel-manager.ts); what it sent, the panel then holds.
          await waitFor(harness, () => (panels.includes(1) ? true : undefined), 'the panel session');
          await settled();
          return { logs, apply: applies[seen] };
        }

        /** The stores this run left, parsed, kept for the next run. */
        async function keepStores(harness: IntegrationTestHarness): Promise<Record<string, unknown>> {
          for (const id of ['info.entityIds', 'info.publishedIds']) {
            stores[id] = String((await harness.states.getStateAsync(`hometiles.0.${id}`))?.val);
          }
          return Object.fromEntries(Object.entries(stores).map(([id, val]) => [id, JSON.parse(val)]));
        }

        /** An admin request, sent as admin sends one, and the adapter's answer. */
        async function ask(harness: IntegrationTestHarness, command: string, message: unknown): Promise<unknown> {
          let answer: unknown;
          harness.sendTo('hometiles.0', command, message, (reply: unknown) => {
            answer = reply;
          });
          return waitFor(harness, () => answer, `the answer to ${command}`);
        }

        const hints = (logs: LogRecord[]): string[][] =>
          logs
            .filter((log) => log.message.includes('No devices selected yet'))
            .map((log) => [log.severity, log.message.slice(log.message.indexOf('[Registry]'))]);

        /** How many entities the adapter reports published (info.entities). */
        const reported = async (harness: IntegrationTestHarness): Promise<unknown> => (await harness.states.getStateAsync('hometiles.0.info.entities'))?.val;

        suite('a fresh install, before the Devices tab is used', (getHarness) => {
          withCleanFixtures(getHarness);

          it('publishes no apply and no icons, leaves what the broker retains, and says to open the Devices tab (Rulings 116, 118)', async function () {
            this.timeout(120000);
            const harness = getHarness();
            const seenIcons = icons.length;
            const { logs, apply } = await run(harness, {});
            expect(apply, 'no apply').to.equal(undefined);
            expect(icons.slice(seenIcons), 'no icons').to.deep.equal([]);
            expect(hints(logs)).to.deep.equal([['info', `[Registry] ${UNARMED}, then pick devices and save`]]);
            expect(ready(logs)!.message).to.include('Ready. 2 devices detected, 0 picked (manual entities included), 0 entities published');
            expect(await reported(harness)).to.equal(0);
            expect(await keepStores(harness)).to.deep.equal({ 'info.entityIds': {}, 'info.publishedIds': {} });
            expect(balkonState).to.deep.equal([]);
            // The panel keeps its layout: the broker retains what it had.
            expect(await retained(APPLY_TOPIC, ICONS_TOPIC)).to.deep.equal({ [APPLY_TOPIC]: LAST_GOOD_APPLY, [ICONS_TOPIC]: OLD_ICONS });
          });

          it('fills the picker from detection -- each device unticked, with its name, domain and room -- and arms publishing in the form', async function () {
            this.timeout(60000);
            const reply = await ask(getHarness(), 'refreshDetected', { rows: [] });
            expect(reply).to.deep.equal({
              native: {
                deviceOverrides: [
                  { objectId: KAFFEE, include: false, name: '', forcedDomain: '', detectedName: 'Kaffee', detectedDomain: 'switch', room: '' },
                  { objectId: SENSOR, include: false, name: '', forcedDomain: '', detectedName: 'Balkon', detectedDomain: 'sensor', room: 'Balkon' },
                ],
                pickerArmed: PICKER,
              },
              result: 'refreshed',
              args: ['2', '2'],
            });
          });

          it("keeps the form's rows where they stand, marks a row whose device is gone in the system's language, adds what is new, and publishes nothing", async function () {
            this.timeout(60000);
            const harness = getHarness();
            // The adapter reads its own admin translations (Ruling 117).
            const system = (await harness.objects.getObjectAsync('system.config')) as { common: Record<string, unknown> } & Record<string, unknown>;
            await harness.objects.setObjectAsync('system.config', { ...system, common: { ...system.common, language: 'de' } });
            const seen = applies.length;
            const rows = [
              { objectId: SENSOR, include: true, name: 'Draußen', forcedDomain: '', detectedDomain: 'sensor' },
              // A row the table's "+" added: blank, it stays where it is.
              { objectId: '', include: false },
              // An earlier version's "+" row never typed into: its object id is null. It stays too (N4).
              { objectId: null, include: true, forcedDomain: 'switch' },
              { objectId: 'zigbee.0.weg', include: true, name: '', forcedDomain: '', detectedName: 'Weg (not detected)', detectedDomain: 'sensor' },
            ];
            // The form the first Refresh armed, the user having ticked since.
            const reply = (await ask(harness, 'refreshDetected', { rows, pickerArmed: PICKER })) as { native: { deviceOverrides: object[] }; args: string[] };
            expect(reply.native.deviceOverrides).to.deep.equal([
              { objectId: SENSOR, include: true, name: 'Draußen', forcedDomain: '', detectedName: 'Balkon', detectedDomain: 'sensor', room: 'Balkon' },
              { objectId: '', include: false },
              { objectId: null, include: true, forcedDomain: 'switch' },
              // The English mark gone, the system language's in its place.
              { objectId: 'zigbee.0.weg', include: true, name: '', forcedDomain: '', detectedName: 'Weg (nicht erkannt)', detectedDomain: 'sensor' },
              { objectId: KAFFEE, include: false, name: '', forcedDomain: '', detectedName: 'Kaffee', detectedDomain: 'switch', room: '' },
            ]);
            expect(reply.args).to.deep.equal(['2', '1']);
            // A choice applies once saved, which restarts the adapter: what the
            // request made it send, it sent before its answer.
            await settled();
            expect(applies.length).to.equal(seen);
          });

          it('still answers listDetected, testBroker and previewEntity, which shows a device before it is picked', async function () {
            this.timeout(60000);
            const harness = getHarness();
            const found = (await ask(harness, 'listDetected', {})) as Array<{ objectId: string; entityId: string }>;
            expect(found.map((device) => [device.objectId, device.entityId])).to.have.deep.members([
              [SENSOR, ''],
              [KAFFEE, ''],
            ]);
            // Nothing typed sent, as a script might ask: the saved broker, which this suite runs (Ruling 140).
            expect(await ask(harness, 'testBroker', {})).to.deep.include({ connected: true, result: 'connected', args: [`127.0.0.1:${port()}`] });
            // A script's request, the object id alone: the device as detected, under the id picking it would give (Task 23).
            const preview = (await ask(harness, 'previewEntity', { objectId: SENSOR })) as { entity: object; publish: object };
            expect(preview.entity).to.include({ entityId: 'sensor.balkon', state: '21.5' });
            expect(preview.publish).to.include({ topic: 'ha/statestream/sensor/balkon/state', payload: '21.5' });
          });
        });

        /** An instance as 50f4c18 left it: rows ticked by default, a manual entity added by hand, every detected id stored. */
        const LEGACY_ROWS = [
          { objectId: SENSOR, include: true, name: 'Draußen' },
          { objectId: KAFFEE, include: true, forcedDomain: 'switch' },
        ];
        const LEGACY_MANUAL = [{ stateId: HELPER, domain: 'sensor' }];

        suite('an upgrade from 50f4c18, before the Devices tab is used', (getHarness) => {
          withCleanFixtures(getHarness);

          it('publishes nothing -- not its rows, not its manual entity -- and names what waits for the Devices tab (Ruling 118)', async function () {
            this.timeout(120000);
            const harness = getHarness();
            // 50f4c18 stored the manual entity's id beside the devices' (N1).
            stores['info.entityIds'] = JSON.stringify({ [SENSOR]: 'sensor.balkon', [KAFFEE]: 'switch.kaffee', [`manual:${HELPER}`]: 'sensor.vorlauf' });
            delete stores['info.publishedIds'];
            const seenIcons = icons.length;
            const seenStates = balkonState.length;
            const { logs, apply } = await run(harness, { deviceOverrides: LEGACY_ROWS }, LEGACY_MANUAL);
            expect(apply, 'no apply').to.equal(undefined);
            expect(icons.slice(seenIcons), 'no icons').to.deep.equal([]);
            expect(balkonState.slice(seenStates), 'no state').to.deep.equal([]);
            expect(hints(logs)).to.deep.equal([
              ['info', `[Registry] ${UNARMED}, then pick devices and save. Held back until then: 1 manual entities, 2 device rows of an earlier version`],
            ]);
            expect(ready(logs)!.message).to.include('0 picked (manual entities included), 0 entities published');
            expect(await retained(APPLY_TOPIC, ICONS_TOPIC)).to.deep.equal({ [APPLY_TOPIC]: LAST_GOOD_APPLY, [ICONS_TOPIC]: OLD_ICONS });
            // Every stored id is kept for a later pick, the manual entity's too (N1).
            expect(await keepStores(harness)).to.deep.equal({
              'info.entityIds': { [SENSOR]: 'sensor.balkon', [KAFFEE]: 'switch.kaffee', [`manual:${HELPER}`]: 'sensor.vorlauf' },
              'info.publishedIds': {},
            });
          });

          it('shows the rows of the earlier version unticked after a Refresh, their names and forced types kept, and arms publishing', async function () {
            this.timeout(60000);
            const reply = (await ask(getHarness(), 'refreshDetected', { rows: LEGACY_ROWS })) as { native: Record<string, unknown> };
            expect(reply.native).to.deep.equal({
              deviceOverrides: [
                { objectId: SENSOR, include: false, name: 'Draußen', detectedName: 'Balkon', detectedDomain: 'sensor', room: 'Balkon' },
                { objectId: KAFFEE, include: false, forcedDomain: 'switch', detectedName: 'Kaffee', detectedDomain: 'switch', room: '' },
              ],
              pickerArmed: PICKER,
            });
            // The user ticks the sensor and saves: the admin writes the form whole.
            const rows = reply.native.deviceOverrides as Array<Record<string, unknown>>;
            saved = { ...reply.native, deviceOverrides: rows.map((row) => (row.objectId === SENSOR ? { ...row, include: true } : row)) };
          });
        });

        /** The ticked, filled-in rows a Refresh of 44d1111 or 4cbb6d3 left: the same shape, whichever wrote them. */
        const EARLIER_REFRESH = [
          { objectId: SENSOR, include: true, name: 'Draußen', detectedName: 'Balkon', detectedDomain: 'sensor', room: 'Balkon' },
          { objectId: KAFFEE, include: true, forcedDomain: 'switch', detectedName: 'Kaffee', detectedDomain: 'switch', room: '' },
        ];

        for (const [version, marker] of [
          ['44d1111', {}],
          ['4cbb6d3', { pickerArmed: true }],
        ] as const) {
          suite(`a Refresh saved by ${version}, before this picker is used (Ruling 120, N2)`, (getHarness) => {
            withCleanFixtures(getHarness);

            it('publishes nothing: ticked rows in picker shape do not arm, only this picker\'s marker does', async function () {
              this.timeout(120000);
              const harness = getHarness();
              const { logs, apply } = await run(harness, { ...marker, deviceOverrides: EARLIER_REFRESH });
              expect(apply, 'no apply').to.equal(undefined);
              expect(hints(logs)).to.deep.equal([
                ['info', `[Registry] ${UNARMED}, then pick devices and save. Held back until then: 2 device rows of an earlier version`],
              ]);
              expect(await reported(harness)).to.equal(0);
            });

            it('shows those rows unticked after a Refresh: no tick of an earlier version counts until the user ticks again', async function () {
              this.timeout(60000);
              const reply = (await ask(getHarness(), 'refreshDetected', { rows: EARLIER_REFRESH, ...marker })) as { native: Record<string, unknown> };
              expect(reply.native).to.deep.equal({
                deviceOverrides: EARLIER_REFRESH.map((row) => ({ ...row, include: false })),
                pickerArmed: PICKER,
              });
            });
          });
        }

        suite('armed by that Refresh, one device picked', (getHarness) => {
          withCleanFixtures(getHarness);

          it('publishes exactly the pick and the manual entity the Devices tab showed, under the ids they had, and no hint', async function () {
            this.timeout(120000);
            const harness = getHarness();
            const seenIcons = icons.length;
            // Renamed before arming: the stored id still holds (N1).
            const { logs, apply } = await run(harness, saved, [{ ...LEGACY_MANUAL[0], name: 'Vorlauftemperatur' }]);
            // The earlier version's switch row stayed unticked: no switch.
            expect(lists(apply)).to.deep.equal({ ...EMPTY, sensors: ['sensor.balkon', 'sensor.vorlauf'] });
            expect(icons.slice(seenIcons).map((payload) => JSON.parse(payload))).to.deep.equal([{ 'sensor.balkon': '', 'sensor.vorlauf': '' }]);
            await waitFor(harness, () => (balkonState.includes('21.5') ? true : undefined), "the sensor's value");
            expect(hints(logs)).to.deep.equal([]);
            expect(ready(logs)!.message).to.include('Ready. 2 devices detected, 2 picked (manual entities included), 2 entities published');
            expect(await reported(harness)).to.equal(2);
            expect(await keepStores(harness)).to.deep.equal({
              'info.entityIds': { [SENSOR]: 'sensor.balkon', [KAFFEE]: 'switch.kaffee', [`manual:${HELPER}`]: 'sensor.vorlauf' },
              'info.publishedIds': { [SENSOR]: 'sensor.balkon', [`manual:${HELPER}`]: 'sensor.vorlauf' },
            });
          });
        });

        suite('everything un-picked, after the restart its save causes', (getHarness) => {
          withCleanFixtures(getHarness);

          it('holds the apply back again: the panel keeps its layout and values, the broker what it retains, the ids stay stored (Ruling 116)', async function () {
            this.timeout(120000);
            const harness = getHarness();
            const before = await retained(APPLY_TOPIC, ICONS_TOPIC, BALKON_STATE);
            // "unavailable": the last suite's cleanup deleted the state while its run still watched it.
            expect(before[BALKON_STATE], 'a retained state').to.be.a('string').and.not.equal('');
            const seenStates = balkonState.length;
            const seenIcons = icons.length;
            const rows = (saved.deviceOverrides as Array<Record<string, unknown>>).map((row) => ({ ...row, include: false }));
            const { logs, apply } = await run(harness, { ...saved, deviceOverrides: rows });
            expect(apply, 'no apply').to.equal(undefined);
            expect(icons.slice(seenIcons), 'no icons').to.deep.equal([]);
            // No clear either: the panel still shows the sensor.
            expect(balkonState.slice(seenStates), 'no clear').to.deep.equal([]);
            expect(await retained(APPLY_TOPIC, ICONS_TOPIC, BALKON_STATE)).to.deep.equal(before);
            expect(hints(logs)).to.deep.equal([['info', `[Registry] ${NOTHING}`]]);
            expect(await reported(harness)).to.equal(0);
            // The record still names what the panels hold, to clear it once an apply goes out.
            expect(await keepStores(harness)).to.deep.equal({
              'info.entityIds': { [SENSOR]: 'sensor.balkon', [KAFFEE]: 'switch.kaffee' },
              'info.publishedIds': { [SENSOR]: 'sensor.balkon', [`manual:${HELPER}`]: 'sensor.vorlauf' },
            });
          });
        });

        suite('another device picked', (getHarness) => {
          withCleanFixtures(getHarness);

          it('publishes that one, and only now clears the retained state of the one un-picked before', async function () {
            this.timeout(120000);
            const harness = getHarness();
            const seenStates = balkonState.length;
            // And a hand edit that is no entity id: it must not stop the panel's start (Ruling 51).
            stores['info.publishedIds'] = JSON.stringify({ ...JSON.parse(stores['info.publishedIds'] ?? '{}'), 'zigbee.0.weg': 'kaputt' });
            const { logs, apply } = await run(harness, { ...ARMED, deviceOverrides: picked(KAFFEE) });
            expect(lists(apply)).to.deep.equal({ ...EMPTY, switches: ['switch.kaffee'] });
            await waitFor(harness, () => (balkonState.slice(seenStates).includes('') ? true : undefined), 'the cleared state');
            const failed = logs.filter((log) => log.message.includes('failed'));
            expect(failed.map((log) => log.message)).to.deep.equal([]);
            expect(await keepStores(harness)).to.deep.equal({
              'info.entityIds': { [SENSOR]: 'sensor.balkon', [KAFFEE]: 'switch.kaffee' },
              'info.publishedIds': { [KAFFEE]: 'switch.kaffee' },
            });
            // Nothing is left retained for a panel that subscribes later.
            expect(await retained(BALKON_STATE)).to.deep.equal({});
          });
        });

        suite('picked again', (getHarness) => {
          withCleanFixtures(getHarness);

          it('publishes it under the id it had, though its name now derives another', async function () {
            this.timeout(120000);
            const renamed = { ...SENSOR_OBJECTS, [SENSOR]: { type: 'device', common: { name: 'Terrasse' } } };
            const { apply } = await run(getHarness(), { ...ARMED, deviceOverrides: picked(SENSOR) }, [], renamed);
            expect(lists(apply)).to.deep.equal({ ...EMPTY, sensors: ['sensor.balkon'] });
          });
        });

        suite('only a scene picked', (getHarness) => {
          withCleanFixtures(getHarness);

          it('holds the apply back as well, a scene being in no list, says why, and reports nothing published (M7)', async function () {
            this.timeout(120000);
            const harness = getHarness();
            const scene = [{ objectId: KAFFEE, include: true, detectedDomain: 'switch', forcedDomain: 'scene' }];
            const { logs, apply } = await run(harness, { ...ARMED, deviceOverrides: scene });
            expect(apply, 'no apply').to.equal(undefined);
            const held = logs.filter((log) => log.message.includes('[Registry] Nothing picked shows in a panel list'));
            expect(held.map((log) => log.severity)).to.deep.equal(['info']);
            expect(hints(logs)).to.deep.equal([]);
            expect(ready(logs)!.message).to.include('1 picked (manual entities included), 0 entities published');
            expect(await reported(harness)).to.equal(0);
          });
        });
      });

      suite('a forced type the device cannot serve (Ruling 139)', (getHarness) => {
        withCleanFixtures(getHarness);

        it('is no tile, as Task 13 pinned, and one warning per start names each such override and what the device lacks; a fit one is not named', async function () {
          this.timeout(120000);
          const harness = getHarness();
          const en = JSON.parse(readFileSync(path.join(__dirname, '../admin/i18n/en.json'), 'utf8')) as Record<string, string>;
          const logs = await captureLogs(harness);
          const forced = (objectId: string, detectedDomain: string, forcedDomain: string): object => ({ objectId, include: true, detectedDomain, forcedDomain });
          await harness.changeAdapterConfig('hometiles', {
            native: {
              ...ARMED,
              deviceOverrides: [
                // A switch has no temperature, a temperature no playback state.
                forced(KAFFEE, 'switch', 'weather'),
                forced(SENSOR, 'sensor', 'media_player'),
                // A reading with states makes a select.
                forced(SENDER, 'sensor', 'select'),
              ],
            },
          });
          await setObjects(harness, { ...SENSOR_OBJECTS, ...KAFFEE_OBJECTS, ...SENDER_OBJECTS });
          await harness.startAdapterAndWait();
          await waitFor(harness, () => ready(logs), 'onReady to finish');

          const lines = logs.filter((log) => log.message.includes('Forced types that produced no tile'));
          expect(lines.map((log) => log.severity)).to.deep.equal(['warn']);
          const line = lines[0]!.message.slice(lines[0]!.message.indexOf('[Registry]'));
          // In English whatever the system language, each reason the synth's own (lacks).
          expect(line)
            .to.include(`weather on ${KAFFEE} (${en.lack_weather_reading})`)
            .and.include(`media_player on ${SENSOR} (${en.lack_player_state})`)
            .and.not.include(SENDER);
          // Neither is an entity: the select alone reaches the panels.
          expect(await harness.states.getStateAsync('hometiles.0.info.entities')).to.include({ val: 1 });
          expect(JSON.parse(String((await harness.states.getStateAsync('hometiles.0.info.publishedIds'))?.val))).to.deep.equal({ [SENDER]: 'select.sender' });
        });
      });

      suite("the Connection tab's Test broker and the Panels tab's Pair buttons, with what is typed (Ruling 140)", (getHarness) => {
        withCleanFixtures(getHarness);
        /** Typed on the Connection tab and never saved; no log line may hold it. */
        const TYPED_PASSWORD = 'ge"heim\\ `1` ${data.x}';
        const SAVED_PASSWORD = 'gespeichert-9f2c41';
        /** The saved password as admin stores it: encrypted (Ruling 143). Set as the suite starts. */
        let stored = '';
        /** What the broker was asked to let in, in order. */
        const seen: Array<{ user: string | undefined; password: string | undefined }> = [];
        /** Each credentials form the panel's setup page received, and the status it answers /mqtt with. */
        const posted: string[] = [];
        let panelStatus = 303;
        let broker: Aedes;
        let brokerServer: Server;
        let panelServer: HttpServer;
        let brokerPort = 0;
        let panelPort = 0;
        let closedPort = 0;
        /** A port that takes the connection and never answers it, as a broker that hangs would. */
        let silent: Server;
        let silentPort = 0;
        /** A port that reads each connection's CONNECT and hangs up without a word: mqtt.js retries it for ever (Ruling 143). */
        let dropping: Server;
        let droppingPort = 0;
        let logs: LogRecord[] = [];
        /** A port the system picks (Ruling 137). */
        const listen = (server: Server | HttpServer): Promise<number> =>
          new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

        before(async function () {
          this.timeout(120000);
          // A broker that lets one user in.
          broker = new Aedes({
            authenticate: (_client, username, password, done) => {
              seen.push({ user: username, password: password?.toString() });
              if (username === 'panel' && password?.toString() === TYPED_PASSWORD) return done(null, true);
              done(Object.assign(new Error('Bad username or password'), { returnCode: 4 as const }), false);
            },
          });
          brokerServer = createServer(broker.handle);
          brokerPort = await listen(brokerServer);
          // A port nothing listens on: taken, then let go.
          const spare = createServer();
          closedPort = await listen(spare);
          await new Promise((resolve) => spare.close(resolve));
          silent = createServer(() => undefined);
          silentPort = await listen(silent);
          dropping = createServer((socket) => socket.on('data', () => socket.end()));
          droppingPort = await listen(dropping);
          // A panel's setup page, as pairing.ts posts to it: the form to /mqtt, then /restart.
          panelServer = createHttpServer((request, response) => {
            let body = '';
            request.on('data', (chunk: Buffer) => (body += chunk.toString()));
            request.on('end', () => {
              if (request.url === '/mqtt') posted.push(body);
              response.writeHead(request.url === '/mqtt' ? panelStatus : 200);
              response.end();
            });
          });
          panelPort = await listen(panelServer);

          const harness = getHarness();
          logs = await captureLogs(harness);
          // As installing or upgrading does (iobroker upload: js-controller-cli setupUpload.js upgradeAdapterObjects),
          // encryptedNative and protectedNative go from io-package.json onto the adapter and its instance. The
          // harness's database keeps the adapter object of the run that first installed it, lists and all. Not
          // execFileSync: the database runs in this process, and a blocked one would never answer the upload.
          await promisify(execFile)(process.execPath, ['iobroker.js', 'upload', 'hometiles'], { cwd: CONTROLLER_DIR, timeout: 120000 });
          // Saved: a broker that is not there, under other credentials, the password encrypted as admin saves it.
          const secret = ((await harness.objects.getObjectAsync('system.config')) as { native: { secret: string } }).native.secret;
          expect(secret, 'a secret AES-192 takes').to.match(/^[0-9a-f]{48}$/);
          stored = encryptAsAdmin(secret, SAVED_PASSWORD);
          await harness.changeAdapterConfig('hometiles', {
            native: { brokerHost: '127.0.0.1', brokerPort: closedPort, brokerUser: 'gespeichert', brokerPassword: stored, ...ARMED },
          });
          await harness.startAdapterAndWait();
          await waitFor(harness, () => ready(logs), 'onReady to finish');
          await harness.enableSendTo();
        });
        after((done) => {
          panelServer.close();
          silent.close();
          dropping.close();
          broker.close();
          brokerServer.close(() => done());
        });

        type Answer = Record<string, unknown> & { args?: string[] };
        /** A request as the button sends it, and the answer; one at a time. */
        async function ask(command: string, message: unknown): Promise<Answer> {
          const harness = getHarness();
          let answer: Answer | undefined;
          harness.sendTo('hometiles.0', command, message, (reply: unknown) => {
            answer = reply as Answer;
          });
          return waitFor(harness, () => answer, `the answer to ${command}`);
        }
        const typed = (): Record<string, unknown> => ({
          brokerHost: ' 127.0.0.1 ',
          brokerPort,
          brokerTls: false,
          brokerUser: 'panel',
          brokerPassword: TYPED_PASSWORD,
          clientId: 'getippt',
        });

        it('tests the broker and credentials as typed, not the saved ones, and says it connected', async function () {
          this.timeout(60000);
          const answer = await ask('testBroker', typed());
          // json-config shows a mapped result (schema.result) and, the native branch taken, nothing more.
          expect(answer).to.deep.equal({ connected: true, result: 'connected', args: [`127.0.0.1:${brokerPort}`], native: {} });
          expect(seen.at(-1)).to.deep.equal({ user: 'panel', password: TYPED_PASSWORD });
        });

        it('shows why it could not connect: the refusal, a port nobody listens on, a port that is none', async function () {
          this.timeout(60000);
          const refused = await ask('testBroker', { ...typed(), brokerPassword: 'falsch' });
          expect(refused).to.include({ connected: false, error: 'failed' });
          expect(refused.args![0]).to.equal(`127.0.0.1:${brokerPort}`);
          expect(refused.args![1]).to.match(/^Connection refused/);
          const nobody = await ask('testBroker', { ...typed(), brokerPort: closedPort });
          expect(nobody).to.include({ connected: false, error: 'failed' });
          expect(nobody.args).to.have.lengthOf(2);
          expect(nobody.args![1]).to.include('ECONNREFUSED');
          // A cleared number field ('') and one out of range: validateOptions refuses both.
          expect(await ask('testBroker', { ...typed(), brokerPort: '' })).to.deep.equal({ connected: false, error: 'invalid_port' });
          expect(await ask('testBroker', { ...typed(), brokerPort: 70000 })).to.deep.equal({ connected: false, error: 'invalid_port' });
        });

        it('says so when the broker takes the connection and never answers it, after the 10 s the client waits', async function () {
          this.timeout(60000);
          const started = Date.now();
          expect(await ask('testBroker', { ...typed(), brokerPort: silentPort })).to.deep.equal({
            connected: false,
            error: 'timeout',
            args: [`127.0.0.1:${silentPort}`],
          });
          expect(Date.now() - started).to.be.within(9000, 30000);
        });

        it('gives up after 12 s on a broker that hangs up on each connection without a word, which mqtt.js would retry for ever, and says so (Ruling 143)', async function () {
          this.timeout(60000);
          const started = Date.now();
          expect(await ask('testBroker', { ...typed(), brokerPort: droppingPort })).to.deep.equal({
            connected: false,
            error: 'timeout',
            args: [`127.0.0.1:${droppingPort}`],
          });
          expect(Date.now() - started).to.be.within(11000, 30000);
        });

        it('saves nothing it tested, and logs no password, typed or saved', async function () {
          this.timeout(60000);
          const instance = (await getHarness().objects.getObjectAsync('system.adapter.hometiles.0')) as { native: Record<string, unknown> };
          expect(instance.native).to.include({ brokerPort: closedPort, brokerUser: 'gespeichert', brokerPassword: stored });
          const tested = logs.filter((log) => log.message.includes('[Admin] Broker test'));
          expect(tested.map((log) => log.severity)).to.deep.equal(['info', 'info', 'info', 'info', 'info']);
          const leaked = logs.filter((log) => [TYPED_PASSWORD, 'falsch', SAVED_PASSWORD].some((secret) => log.message.includes(secret)));
          expect(leaked.map((log) => log.message)).to.deep.equal([]);
        });

        it('keeps the broker password encrypted and hidden from other adapters, as io-package.json declares it (Ruling 143)', async function () {
          this.timeout(60000);
          // `iobroker add` copies both lists from io-package.json (js-controller-cli setupUpload.js upgradeAdapterObjects).
          const instance = (await getHarness().objects.getObjectAsync('system.adapter.hometiles.0')) as Record<string, unknown>;
          expect(instance).to.deep.include({ encryptedNative: ['brokerPassword'], protectedNative: ['brokerPassword'] });
          expect(stored).to.match(/^\$\/aes-192-cbc:/).and.not.include(SAVED_PASSWORD);
        });

        it('pairs the panel at the typed address with the saved credentials, the password as saved before admin encrypted it, and says so', async function () {
          this.timeout(60000);
          const host = `127.0.0.1:${panelPort}`;
          expect(await ask('pairPanel', { host: ` ${host} ` })).to.deep.equal({ ok: true, result: 'paired', args: [host], native: {} });
          // js-controller hands the adapter its config decrypted (adapter.js, encryptedNative): the panel gets the password itself.
          expect(Object.fromEntries(new URLSearchParams(posted.at(-1)))).to.include({
            mqtt_host: '127.0.0.1',
            mqtt_port: String(closedPort),
            mqtt_user: 'gespeichert',
            mqtt_pass: SAVED_PASSWORD,
          });
        });

        it('names why pairing failed: no address, a panel that does not answer, credentials it refused', async function () {
          this.timeout(60000);
          expect(await ask('pairPanel', { host: '' })).to.deep.include({ ok: false, error: 'invalid_host' });
          // The old button's message: none at all.
          expect(await ask('pairPanel', null)).to.deep.include({ ok: false, error: 'invalid_host' });
          expect(await ask('pairPanel', { host: `127.0.0.1:${closedPort}` })).to.deep.include({
            ok: false,
            error: 'unreachable',
            args: [`127.0.0.1:${closedPort}`, ''],
          });
          panelStatus = 401;
          expect(await ask('pairPanel', { host: `127.0.0.1:${panelPort}` })).to.deep.include({
            ok: false,
            error: 'credentials_rejected',
            args: [`127.0.0.1:${panelPort}`, '401'],
          });
        });
      });

      suite("the preview of a Detected devices row, as its button asks for it (Task 23)", (getHarness) => {
        withCleanFixtures(getHarness);
        /** The adapter's own English texts: what its answers carry, in the system language. */
        const en = JSON.parse(readFileSync(path.join(__dirname, '../admin/i18n/en.json'), 'utf8')) as Record<string, string>;
        type Preview = {
          entity?: { entityId: string };
          publish?: { topic: string; payload: string; retain: boolean } | null;
          note?: string;
          copyDialog?: { title: string; type: string; text: string };
          error?: string;
        };
        /** A previewEntity request as a row's button sends it (jsonConfig, _preview), and the answer; one at a time. */
        async function preview(message: unknown): Promise<Preview> {
          const harness = getHarness();
          let answer: Preview | undefined;
          harness.sendTo('hometiles.0', 'previewEntity', message, (reply: unknown) => {
            answer = reply as Preview;
          });
          return waitFor(harness, () => answer, 'the preview');
        }
        const row = (objectId: string, forcedDomain = '', name = ''): object => ({ objectId, forcedDomain, name });

        before(async function () {
          this.timeout(120000);
          const harness = getHarness();
          const logs = await captureLogs(harness);
          // Armed, nothing picked: a row is previewed as it would publish, ticked or not. No broker is needed.
          await harness.changeAdapterConfig('hometiles', { native: { ...ARMED } });
          await setObjects(harness, { ...SENSOR_OBJECTS, ...KAFFEE_OBJECTS, ...SENDER_OBJECTS });
          await harness.states.setStateAsync(`${SENSOR}.temperature`, { val: 21.5, ack: true });
          await harness.states.setStateAsync(SENDER_SET, { val: 's1', ack: true });
          // The sensor was once picked as a thermostat: its id is kept for it (Task 21b rule 6).
          await harness.states.setStateAsync('hometiles.0.info.entityIds', { val: JSON.stringify({ [SENSOR]: 'climate.balkon' }), ack: true });
          await harness.startAdapterAndWait();
          await waitFor(harness, () => ready(logs), 'onReady to finish');
          await harness.enableSendTo();
        });

        it('shows what a row publishes as it stands: its topic, retained payload and the id picking it gives, in the dialog admin opens', async function () {
          this.timeout(60000);
          const answer = await preview(row(SENSOR));
          const publish = { topic: 'ha/statestream/sensor/balkon/state', payload: '21.5', retain: true };
          expect(answer.publish).to.deep.equal(publish);
          expect(answer).to.not.have.property('note');
          // json-config's sendTo shows a copyDialog as a titled text in an editor (ConfigSendto.renderCopyDialog).
          expect(answer.copyDialog).to.deep.include({ title: 'column_preview', type: 'json' });
          expect(JSON.parse(answer.copyDialog!.text)).to.deep.equal({ entity_id: 'sensor.balkon', ...publish });
        });

        it("shows the row's unsaved type and name as saving them would publish: another id, its topic and its payload", async function () {
          this.timeout(60000);
          const answer = await preview(row(SENSOR, 'number', 'Terrasse'));
          expect(answer.entity).to.include({ entityId: 'number.terrasse' });
          expect(answer.publish).to.include({ topic: 'ha/statestream/number/terrasse/control', retain: true });
          expect(JSON.parse(answer.publish!.payload)).to.include({ kind: 'number', state: '21.5' });
          expect(JSON.parse(answer.copyDialog!.text).payload).to.include({ kind: 'number', state: '21.5' });
          // Forced back into the type its stored id has, it gets that id again, as picking it would (resolveEntityIds).
          const climate = await preview(row(SENSOR, 'climate'));
          expect(climate.entity).to.include({ entityId: 'climate.balkon' });
          expect(climate.publish).to.include({ topic: 'ha/statestream/climate/balkon/state' });
          expect(JSON.parse(climate.publish!.payload)).to.include({ current_temperature: 21.5 });
        });

        it("turns the internal degraded flag into a note: the list of choices, over the panel's limit, goes without its options (Task 14 N1)", async function () {
          this.timeout(60000);
          const answer = await preview(row(SENDER, 'select'));
          expect(Object.keys(answer.publish!).sort()).to.deep.equal(['payload', 'retain', 'topic']);
          expect(answer.publish!.topic).to.equal('ha/statestream/select/sender/control');
          expect(JSON.parse(answer.publish!.payload)).to.include({ kind: 'select', writable: false, state: STATIONS.s1 }).and.not.have.property('options');
          expect(answer.note).to.equal(en.preview_degraded);
          expect(JSON.parse(answer.copyDialog!.text)).to.include({ note: en.preview_degraded });
          expect(JSON.stringify(answer)).to.not.include('degraded');
        });

        it('says a scene publishes no state, where its payload would be', async function () {
          this.timeout(60000);
          const answer = await preview(row(KAFFEE, 'scene'));
          expect(answer.entity).to.include({ entityId: 'scene.kaffee' });
          expect(answer.publish).to.equal(null);
          expect(answer.note).to.equal(en.preview_no_state);
          expect(JSON.parse(answer.copyDialog!.text)).to.deep.equal({ entity_id: 'scene.kaffee', note: en.preview_no_state });
        });

        it('answers with an error, which the button shows in words, for a type the device cannot serve and for a device it did not detect', async function () {
          this.timeout(60000);
          // A temperature reading has no player state (synthMediaPlayer).
          // What the device lacks, as the synth tests it, the rebuild's warning too (Ruling 139).
          expect(await preview(row(SENSOR, 'media_player'))).to.deep.equal({ error: 'no_usable_channel', args: [en.lack_player_state] });
          expect(await preview(row('zigbee.0.nirgends'))).to.deep.equal({ error: 'device_not_detected' });
          // The message the old button sent: none at all (Task 21b C5).
          expect(await preview(null)).to.deep.equal({ error: 'device_not_detected' });
        });
      });

      describe('the preview of a row, as saving the whole form would publish it (review m1, m2)', () => {
        type Preview = { entity?: { entityId: string; state: string }; publish?: { topic: string; payload: string; retain: boolean } | null; error?: string };
        /** A previewEntity request, and the answer; one at a time. */
        async function preview(harness: IntegrationTestHarness, message: unknown): Promise<Preview> {
          let answer: Preview | undefined;
          harness.sendTo('hometiles.0', 'previewEntity', message, (reply: unknown) => {
            answer = reply as Preview;
          });
          return waitFor(harness, () => answer, 'the preview');
        }
        /** A ticked picker row. */
        const ticked = (objectId: string, forcedDomain = ''): object => ({ objectId, include: true, detectedDomain: 'sensor', forcedDomain, name: '' });
        /** The form that saves both thermometers named Balkon (review m1). */
        const FORM = [ticked(SENSOR), ticked(TWIN)];
        /** The ids of the sensor and its twin as a preview of each row of this form gives them. */
        async function previewedIds(harness: IntegrationTestHarness, rows: object[] | null): Promise<string[]> {
          const ids: string[] = [];
          for (const objectId of [SENSOR, TWIN]) ids.push((await preview(harness, { objectId, forcedDomain: '', name: '', rows })).entity!.entityId);
          return ids;
        }
        /** Starts a run on these rows and this id store; its logs. */
        async function start(harness: IntegrationTestHarness, deviceOverrides: object[], store?: string): Promise<LogRecord[]> {
          const logs = await captureLogs(harness);
          await setNative(harness, { ...ARMED, deviceOverrides });
          await setObjects(harness, { ...SENSOR_OBJECTS, ...TWIN_OBJECTS, ...BAD_OBJECTS });
          await harness.states.setStateAsync(`${SENSOR}.temperature`, { val: 21.5, ack: true });
          await harness.states.setStateAsync(`${TWIN}.temperature`, { val: 19, ack: true });
          if (store !== undefined) await harness.states.setStateAsync('hometiles.0.info.entityIds', { val: store, ack: true });
          await harness.startAdapterAndWait();
          await waitFor(harness, () => ready(logs), 'onReady to finish');
          await harness.enableSendTo();
          return logs;
        }
        const publishedIds = async (harness: IntegrationTestHarness): Promise<unknown> =>
          JSON.parse(String((await harness.states.getStateAsync('hometiles.0.info.publishedIds'))?.val));
        /** What the previews of the first run gave, and the id store it left, for the run after saving the form. */
        let previewed: string[] = [];
        let store = '';

        suite('before the form is saved', (getHarness) => {
          withCleanFixtures(getHarness);
          let logs: LogRecord[] = [];

          before(async function () {
            this.timeout(120000);
            // Saved: the sensor forced into a number (review m2).
            logs = await start(getHarness(), [ticked(SENSOR, 'number')]);
          });

          it('shows a picked device switched back to Auto, not saved yet, as that saves it: the sensor, not the number saved (review m2)', async function () {
            this.timeout(60000);
            const harness = getHarness();
            expect(await publishedIds(harness)).to.deep.equal({ [SENSOR]: 'number.balkon' });
            const publish = { topic: 'ha/statestream/sensor/balkon/state', payload: '21.5', retain: true };
            // The row as its button sends it, the form's rows with it, and as a script sends it: the saved rows stand in.
            for (const rows of [[ticked(SENSOR)], null]) {
              const answer = await preview(harness, { objectId: SENSOR, forcedDomain: '', name: '', rows, climateModes: null });
              expect(answer.entity, JSON.stringify(rows)).to.include({ entityId: 'sensor.balkon' });
              expect(answer.publish, JSON.stringify(rows)).to.deep.equal(publish);
            }
          });

          it('gives each row the id saving the whole form gives it: two new devices of one name, ticked together, get two ids (review m1)', async function () {
            this.timeout(60000);
            const harness = getHarness();
            previewed = await previewedIds(harness, FORM);
            expect([...previewed].sort()).to.deep.equal(['sensor.balkon', 'sensor.balkon_2']);
            // Each alone, nothing else ticked, takes the name's own id.
            expect(await previewedIds(harness, [])).to.deep.equal(['sensor.balkon', 'sensor.balkon']);
            store = String((await harness.states.getStateAsync('hometiles.0.info.entityIds'))?.val);
          });

          it('previews a device whose state cannot be read as the adapter publishes it, unavailable, not as an error (review m1 b)', async function () {
            this.timeout(60000);
            // js-controller refuses to read an alias whose target id is malformed (adapter.js _getForeignState).
            const answer = await preview(getHarness(), { objectId: BAD_ALIAS, forcedDomain: '', name: '', rows: null });
            expect(answer).to.not.have.property('error');
            expect(answer.entity).to.include({ entityId: 'sensor.kaputt', state: 'unavailable' });
            expect(answer.publish).to.deep.equal({ topic: 'ha/statestream/sensor/kaputt/state', payload: 'unavailable', retain: true });
            expect(logs.filter((log) => log.message.includes('previewEntity failed')).map((log) => log.message)).to.deep.equal([]);
          });
        });

        suite('after the form is saved', (getHarness) => {
          withCleanFixtures(getHarness);

          it('starts with the ids the previews gave, and previews give them again (review m1)', async function () {
            this.timeout(120000);
            expect(previewed, 'the previews before saving').to.have.lengthOf(2);
            const harness = getHarness();
            await start(harness, FORM, store);
            expect(await publishedIds(harness)).to.deep.equal({ [SENSOR]: previewed[0], [TWIN]: previewed[1] });
            expect(await previewedIds(harness, FORM)).to.deep.equal(previewed);
          });
        });
      });

      suite('a thermostat whose modes carry names of its own, mapped on the Climate modes table (Ruling 141)', (getHarness) => {
        withCleanFixtures(getHarness);
        const { applies, panel, port } = withBrokerAndPanel();
        const STATE_TOPIC = 'ha/e2e/climate/heizung_bad/state';
        const NAMES = 'off, heat, cool, heat_cool, auto, dry, fan_only';
        /** The table as admin stores it: MANU as heat, AUTO as auto, and rows it must leave out. */
        const TABLE = [
          { device: TRV_ROOT, deviceMode: 'MANU-MODE', panelMode: 'heat' },
          { device: TRV_ROOT, deviceMode: '0', panelMode: 'auto' },
          { device: SENSOR, deviceMode: '1', panelMode: 'cool' },
          { device: TRV_ROOT, deviceMode: 'PARTY-MODE', panelMode: 'boost' },
        ];
        const states: string[] = [];
        let logs: LogRecord[] = [];
        let written: unknown[] = [];
        /** An admin request, and the answer; one at a time. */
        async function ask(command: string, message: unknown): Promise<unknown> {
          const harness = getHarness();
          let answer: unknown;
          harness.sendTo('hometiles.0', command, message, (reply: unknown) => {
            answer = reply;
          });
          return waitFor(harness, () => answer, `the answer to ${command}`);
        }

        before(async function () {
          this.timeout(120000);
          const harness = getHarness();
          logs = await captureLogs(harness);
          panel().on('message', (topic, payload) => {
            if (topic === STATE_TOPIC) states.push(payload.toString());
          });
          await panel().subscribeAsync(STATE_TOPIC);
          await setNative(harness, {
            brokerHost: '127.0.0.1',
            brokerPort: port(),
            ...ARMED,
            deviceOverrides: [
              { objectId: TRV_ROOT, include: true, detectedDomain: 'climate', name: 'Heizung Bad' },
              { objectId: SENSOR, include: true, detectedDomain: 'sensor' },
            ],
            climateModes: TABLE,
          });
          await setObjects(harness, { ...TRV_OBJECTS, ...SENSOR_OBJECTS });
          await harness.states.setStateAsync(TRV_MODE, { val: 1, ack: true });
          await harness.states.setStateAsync(`${TRV_ROOT}.SET_POINT_TEMPERATURE`, { val: 21, ack: true });
          await harness.states.setStateAsync(`${TRV_ROOT}.ACTUAL_TEMPERATURE`, { val: 20.5, ack: true });
          written = commandsTo(harness, TRV_MODE);
          await harness.startAdapterAndWait(true);
          await waitFor(harness, () => applies.find((payload) => payload.includes('climate.heizung_bad')), 'the apply');
          await harness.enableSendTo();
        });

        it("lists MANU as heat and AUTO as auto, shows the current MANU as heat, and the panel's buttons write each one's raw value", async function () {
          this.timeout(60000);
          const harness = getHarness();
          const shown = await waitFor(harness, () => states.at(-1), 'the thermostat state');
          expect(JSON.parse(shown)).to.include({ hvac_mode: 'heat' });
          expect(JSON.parse(shown).hvac_modes).to.deep.equal(['heat', 'auto']);
          const press = (mode: string): Promise<unknown> =>
            panel().publishAsync('hometiles-e2e/cmnd/climate', JSON.stringify({ entity_id: 'climate.heizung_bad', command: 'set_hvac_mode', hvac_mode: mode }));
          await press('auto');
          await waitFor(harness, () => (written.length === 1 ? true : undefined), 'the auto write');
          await press('heat');
          await waitFor(harness, () => (written.length === 2 ? true : undefined), 'the heat write');
          expect(written).to.deep.equal([0, 1]);
        });

        it('names each row it leaves out and why, in English, once per start: an unknown panel mode, and a device that is no picked thermostat', async function () {
          this.timeout(60000);
          const warned = (text: string): string[] => logs.filter((log) => log.message.includes(text)).map((log) => `${log.severity} ${log.message.slice(log.message.indexOf('['))}`);
          expect(warned('climateModes entry')).to.deep.equal([`warn [Config] climateModes entry 4 (${TRV_ROOT}) has no panel mode of ${NAMES}; ignoring it`]);
          expect(warned('Climate modes left out')).to.deep.equal([
            `warn [Registry] Climate modes left out: ${SENSOR}: 1 as cool (no climate device of this id is picked on the Devices tab)`,
          ]);
        });

        it("offers the detected thermostats for the table's device column, by name and object id", async function () {
          this.timeout(60000);
          expect(await ask('climateDevices', null)).to.deep.equal([{ label: `Heizung Bad (${TRV_ROOT})`, value: TRV_ROOT }]);
        });

        it("previews the thermostat with the form's Climate modes, unsaved rows included", async function () {
          this.timeout(60000);
          const rows = [{ objectId: TRV_ROOT, include: true, detectedDomain: 'climate', name: 'Heizung Bad' }];
          const answer = (await ask('previewEntity', {
            objectId: TRV_ROOT,
            forcedDomain: '',
            name: 'Heizung Bad',
            rows,
            climateModes: [{ device: TRV_ROOT, deviceMode: 'BOOST-MODE', panelMode: 'heat' }],
          })) as { publish: { topic: string; payload: string } };
          expect(answer.publish.topic).to.equal('ha/statestream/climate/heizung_bad/state');
          // The current MANU is unmapped in that form, BOOST is heat.
          expect(JSON.parse(answer.publish.payload)).to.include({ hvac_mode: 'MANU-MODE' });
          expect(JSON.parse(answer.publish.payload).hvac_modes).to.deep.equal(['heat']);
        });
      });

      // Task 24: every v0.2 domain end to end, picked as a user picks it --
      // Refresh on the Devices tab (the real sendTo), tick, Save -- with nothing
      // published before. Saving restarts the adapter (js-controller restarts an
      // instance whose object changes); the harness runs one adapter per suite,
      // so the Refresh is one suite and the saved form the next, on one broker
      // and panel. No fixed sleeps: each wait is on something the panel or the
      // database shows.
      describe('round trips per domain, picked on the Devices tab (Task 24)', () => {
        const { applies, panel, port, settled } = withBrokerAndPanel();
        const HOUR = 3_600_000;
        /** A manual sensor's readings and an energy counter, in iobroker.history's store. */
        const TEMPERATURE = '0_userdata.0.t24.temperature';
        const METER = '0_userdata.0.t24.meter';
        /** The form as the admin saves it after the Refresh (JsonConfig.onSave), for the next suite's start. */
        let saved: Record<string, unknown> = {};

        suite('Refresh, tick and Save on the Devices tab', (getHarness) => {
          withCleanFixtures(getHarness);

          it('publishes nothing until the form is saved, and Refresh lists each device unticked under its detected domain', async function () {
            this.timeout(120000);
            const harness = getHarness();
            const logs = await captureLogs(harness);
            await setNative(harness, { brokerHost: '127.0.0.1', brokerPort: port() });
            await setObjects(harness, { ...TRV_OBJECTS, ...DOMAIN_OBJECTS });
            const panels = valuesOf(harness, 'hometiles.0.info.panels');
            await harness.startAdapterAndWait(true);
            await waitFor(harness, () => ready(logs), 'onReady to finish');
            await waitFor(harness, () => (panels.includes(1) ? true : undefined), 'the panel session');
            await settled();
            expect(applies, 'no apply before the Devices tab is used').to.deep.equal([]);

            await harness.enableSendTo();
            type Row = { objectId: string; include: boolean; detectedDomain: string };
            const reply = (await askAdapter(harness, 'refreshDetected', { rows: [] })) as { native: { deviceOverrides: Row[]; pickerArmed: unknown } };
            // No detector type yields select or datetime: the two readings are forced into them below (Task 13).
            expect(Object.fromEntries(reply.native.deviceOverrides.map((row) => [row.objectId, `${row.detectedDomain}${row.include ? ', ticked' : ''}`]))).to.deep.equal({
              [TRV_ROOT]: 'climate',
              [BLIND]: 'cover',
              [PLAYER]: 'media_player',
              [STATION]: 'weather',
              [`${STATION}.outside`]: 'sensor',
              [LEVEL]: 'number',
              [PROGRAM]: 'sensor',
              [CLOCK]: 'sensor',
            });
            // A Refresh alone publishes nothing: saving the form does.
            await settled();
            expect(applies).to.deep.equal([]);

            // One device of each domain ticked, the thermostat renamed, the readings forced, and the whole form saved
            // with a helper and a sensor of 0_userdata, a meter, the thermostat's own modes and the history instance.
            const choices: Record<string, object> = {
              [TRV_ROOT]: { name: 'Heizung Bad' },
              [BLIND]: {},
              [PLAYER]: {},
              [STATION]: {},
              [LEVEL]: {},
              [PROGRAM]: { forcedDomain: 'select' },
              [CLOCK]: { forcedDomain: 'datetime' },
            };
            saved = {
              ...reply.native,
              deviceOverrides: reply.native.deviceOverrides.map((row) => (choices[row.objectId] ? { ...row, include: true, ...choices[row.objectId] } : row)),
              manualEntities: [
                { stateId: SOLL, domain: 'number' },
                { stateId: TEMPERATURE, domain: 'sensor', name: 'Fenster' },
              ],
              energyMeters: [{ stateId: METER, category: 'grid', sign: 1, name: 'Zaehler' }],
              climateModes: [
                { device: TRV_ROOT, deviceMode: 'MANU-MODE', panelMode: 'heat' },
                { device: TRV_ROOT, deviceMode: '0', panelMode: 'auto' },
              ],
              historyInstance: 'history.0',
            };
          });
        });

        suite('saved: a round trip each', (getHarness) => {
          withCleanFixtures(getHarness);
          const now = Date.now();
          /** A reading two days old, then one every 30 minutes through the last day, the newest a quarter of an hour old. */
          const READINGS = [row(now - 48 * HOUR, 18.5), ...Array.from({ length: 48 }, (_, i) => row(now - 24 * HOUR + HOUR / 4 + (i * HOUR) / 2, 20 + i / 10))];
          /** Planted as the suite starts. */
          let counter: HistoryRow[] = [];
          withHistoryAdapter(getHarness, () => {
            counter = meterRows(Date.now());
            return { [TEMPERATURE]: READINGS, [METER]: counter };
          });
          /** What each state of the devices and the helper holds as the adapter starts. */
          const VALUES: Record<string, unknown> = {
            [`${TRV_ROOT}.ACTUAL_TEMPERATURE`]: 20.5,
            [`${TRV_ROOT}.SET_POINT_TEMPERATURE`]: 21,
            [TRV_MODE]: 0,
            [`${BLIND}.SET`]: 60,
            [`${BLIND}.ACTUAL`]: 60,
            [`${PLAYER}.state`]: 1,
            [`${PLAYER}.Volume`]: 25,
            [`${PLAYER}.Title`]: 'Hotel California',
            [`${STATION}.icon`]: 'rain',
            [`${STATION}.outside.temperature`]: 7.5,
            [`${LEVEL}.Stufe`]: 1,
            [`${PROGRAM}.SET`]: 1,
            [`${CLOCK}.Zeit`]: '2026-09-24 08:15:00',
            [SOLL]: 20,
          };
          /** Every command written to one of those states (ack false), in order: what the panel's commands did. */
          const writes: Array<[string, unknown]> = [];
          /** Every payload the panel received, by topic, in order. */
          const inbox = new Map<string, string[]>();
          const got = (topic: string): string[] => inbox.get(topic) ?? [];
          /** The newest payload the panel holds for an entity on this leaf, parsed. */
          const shown = (entityId: string, leaf = 'state'): Record<string, unknown> | undefined => {
            const last = got(`ha/e2e/${entityId.replace('.', '/')}/${leaf}`).at(-1);
            return last === undefined ? undefined : (JSON.parse(last) as Record<string, unknown>);
          };
          /** A command as the panel sends it on cmnd/<leaf> (mqtt_topics.cpp). */
          const send = (leaf: string, body: object): Promise<unknown> => panel().publishAsync(`hometiles-e2e/cmnd/${leaf}`, JSON.stringify(body));
          let serial = 0;
          /** A value command as the panel sends it (value_control.cpp:293-312), from the /control it holds; its answer. */
          async function setValue(harness: IntegrationTestHarness, entityId: string, value: unknown): Promise<Record<string, unknown>> {
            const { session, revision } = shown(entityId, 'control')!;
            const id = `1a2b3c4d-00024000-${String(++serial).padStart(8, '0')}`;
            await send('value', { entity_id: entityId, session, revision, value, id, deadline: Math.floor(Date.now() / 1000) + 10 });
            const answer = await waitFor(harness, () => got('hometiles-e2e/stat/value').find((text) => (JSON.parse(text) as { id: string }).id === id), `the answer for ${entityId}`);
            return JSON.parse(answer) as Record<string, unknown>;
          }
          /** The writes since `from`, once there is one: a command's writes follow one another at once. */
          const written = async (harness: IntegrationTestHarness, from: number): Promise<Array<[string, unknown]>> => {
            await waitFor(harness, () => (writes.length > from ? true : undefined), 'the write');
            return writes.slice(from);
          };
          /** The entity's newest payload on this leaf once `key` no longer holds `was`: what the change it got sent. */
          const changed = (harness: IntegrationTestHarness, entityId: string, key: string, was: unknown, leaf = 'state'): Promise<Record<string, unknown>> =>
            waitFor(
              harness,
              () => {
                const now = shown(entityId, leaf);
                return now && now[key] !== was ? now : undefined;
              },
              `${entityId}'s ${key} to change on the panel`,
            );
          let reports = 0;
          /**
           * Resolves once the adapter has read every message the panel sent
           * before: it mirrors an IP the panel reports into
           * panels.<id>.info.ip (main.ts mirrorPanelStat), in the order they
           * came. What it did in reply to one without awaiting anything, it has
           * done by then.
           */
          async function heard(harness: IntegrationTestHarness): Promise<void> {
            const ip = `192.0.2.${++reports}`;
            const ips = valuesOf(harness, `hometiles.0.panels.${PANEL}.info.ip`);
            await panel().publishAsync('hometiles-e2e/stat/ip', ip);
            await waitFor(harness, () => (ips.includes(ip) ? true : undefined), 'the adapter reading the panel');
          }
          let apply: Record<string, unknown> = {};
          /** The meter's live reading, just past the newest one stored. */
          let live = 0;

          before(async function () {
            this.timeout(120000);
            const harness = getHarness();
            expect(saved, 'the form the Refresh suite saved').to.have.property('pickerArmed');
            harness.on('stateChange', (id: string, state: Change) => {
              if (state && !state.ack && id in VALUES) writes.push([id, state.val]);
            });
            panel().on('message', (topic, payload) => void inbox.set(topic, [...got(topic), payload.toString()]));
            await panel().subscribeAsync(['ha/e2e/#', 'hometiles-e2e/stat/value', `tab5_lvgl/config/${PANEL}/+/response`]);
            await setNative(harness, { brokerHost: '127.0.0.1', brokerPort: port(), ...saved });
            await setObjects(harness, { ...TRV_OBJECTS, ...DOMAIN_OBJECTS, '0_userdata.0.Heizung': HELPER_OBJECTS['0_userdata.0.Heizung']!, [SOLL]: HELPER_OBJECTS[SOLL]! });
            for (const [id, val] of Object.entries(VALUES)) await harness.states.setStateAsync(id, { val, ack: true });
            live = (counter.at(-1)!.val as number) + 0.1;
            await harness.states.setStateAsync(METER, { val: live, ack: true });
            await harness.startAdapterAndWait(true);
            apply = JSON.parse(await waitFor(harness, () => applies[0], 'the apply')) as Record<string, unknown>;
            // Each entity's state goes out right after the apply (panel-manager.ts handleAnnouncement): all of them are in now.
            await settled();
          });

          it('lists each picked device, the helper and the sensor under the ids their names give, and the meter, in bridge/apply', () => {
            const lists = ['sensors', 'binary_sensors', 'lights', 'switches', 'media_players', 'climates', 'covers', 'weathers', 'numbers', 'selects', 'datetimes'];
            expect(Object.fromEntries(lists.map((key) => [key, apply[key]]))).to.deep.equal({
              sensors: ['sensor.fenster'],
              binary_sensors: [],
              lights: [],
              switches: [],
              media_players: ['media_player.kuechenradio'],
              climates: ['climate.heizung_bad'],
              covers: ['cover.rollladen_wohnzimmer'],
              weathers: ['weather.wetterstation'],
              numbers: ['number.lueftung', 'number.soll'],
              selects: ['select.heizprogramm'],
              datetimes: ['datetime.wecker'],
            });
            expect((apply.energy as Array<{ id: string }>).map((entry) => entry.id)).to.include('energy.zaehler');
          });

          it('climate: shows the thermostat, and the setpoint the panel sets lands on SET_POINT_TEMPERATURE and comes back', async function () {
            this.timeout(60000);
            const harness = getHarness();
            expect(shown('climate.heizung_bad'), 'the thermostat on the panel').to.include({ current_temperature: 20.5, temperature: 21, hvac_mode: 'auto' });
            const from = writes.length;
            await send('climate', { entity_id: 'climate.heizung_bad', command: 'set_temperature', temperature: 22.5 });
            expect(await written(harness, from)).to.deep.equal([[`${TRV_ROOT}.SET_POINT_TEMPERATURE`, 22.5]]);
            expect((await changed(harness, 'climate.heizung_bad', 'temperature', 21)).temperature).to.equal(22.5);
          });

          it("climate modes: heat on the panel writes the thermostat's own MANU-MODE, 1, as the Climate modes table maps it (Ruling 141)", async function () {
            this.timeout(60000);
            const harness = getHarness();
            expect(shown('climate.heizung_bad')).to.deep.include({ hvac_mode: 'auto', hvac_modes: ['heat', 'auto'] });
            const from = writes.length;
            await send('climate', { entity_id: 'climate.heizung_bad', command: 'set_hvac_mode', hvac_mode: 'heat' });
            expect(await written(harness, from)).to.deep.equal([[TRV_MODE, 1]]);
            expect((await changed(harness, 'climate.heizung_bad', 'hvac_mode', 'auto')).hvac_mode).to.equal('heat');
          });

          it('cover: shows the blind, and the position the panel sets lands on SET; once the blind reports it, the panel shows it', async function () {
            this.timeout(60000);
            const harness = getHarness();
            expect(shown('cover.rollladen_wohnzimmer'), 'the blind on the panel').to.include({ state: 'open', current_position: 60 });
            const from = writes.length;
            await send('cover', { entity_id: 'cover.rollladen_wohnzimmer', command: 'set_cover_position', position: 40 });
            expect(await written(harness, from)).to.deep.equal([[`${BLIND}.SET`, 40]]);
            // The blind moves and says so, as its adapter would.
            await harness.states.setStateAsync(`${BLIND}.ACTUAL`, { val: 40, ack: true });
            expect((await changed(harness, 'cover.rollladen_wohnzimmer', 'current_position', 60)).current_position).to.equal(40);
            expect(writes.slice(from), 'nothing written more').to.have.lengthOf(1);
          });

          it('media_player: shows the player, and the volume the panel sets lands on Volume, in percent, and comes back', async function () {
            this.timeout(60000);
            const harness = getHarness();
            expect(shown('media_player.kuechenradio'), 'the player on the panel').to.include({ state: 'playing', volume_level: 0.25, media_title: 'Hotel California' });
            const from = writes.length;
            await send('media', { entity_id: 'media_player.kuechenradio', command: 'volume_set', volume_level: 0.3 });
            expect(await written(harness, from)).to.deep.equal([[`${PLAYER}.Volume`, 30]]);
            expect((await changed(harness, 'media_player.kuechenradio', 'volume_level', 0.25)).volume_level).to.equal(0.3);
          });

          it("weather: shows the station on its weather leaf, and answers the popup's request with it again, writing nothing", async function () {
            this.timeout(60000);
            const harness = getHarness();
            const topic = 'ha/e2e/weather/wetterstation/weather';
            expect(got(topic), 'the station on its weather leaf').to.not.deep.equal([]);
            expect(JSON.parse(got(topic).at(-1)!)).to.include({ temperature: 7.5, name: 'Wetterstation' });
            const seen = got(topic).length;
            const from = writes.length;
            await panel().publishAsync(`tab5_lvgl/config/${PANEL}/weather/request`, '{"entity_id":"weather.wetterstation"}');
            // Answered as the adapter reads it (panel-session.ts answerWeatherRequest): by the next message, and on the panel with it.
            await heard(harness);
            await settled();
            expect(got(topic).slice(seen), 'the same state again, once').to.deep.equal([got(topic)[seen - 1]]);
            expect(writes.slice(from), 'a request is no command').to.deep.equal([]);
          });

          it('number: shows the level on its control leaf, and the value the panel sets lands on it, answered ok, and comes back', async function () {
            this.timeout(60000);
            const harness = getHarness();
            expect(shown('number.lueftung', 'control'), "the level's /control").to.include({ kind: 'number', state: '1', min: 0, max: 4, step: 1, writable: true });
            const from = writes.length;
            expect(await setValue(harness, 'number.lueftung', 3)).to.include({ status: 'ok' });
            expect(await written(harness, from)).to.deep.equal([[`${LEVEL}.Stufe`, 3]]);
            expect((await changed(harness, 'number.lueftung', 'state', '1', 'control')).state).to.equal('3');
          });

          it("select: shows the programme's options, and the option the panel picks lands as the raw value behind it, answered ok", async function () {
            this.timeout(60000);
            const harness = getHarness();
            expect(shown('select.heizprogramm', 'control'), "the programme's /control").to.deep.include({
              kind: 'select',
              state: 'Eco',
              options: ['Aus', 'Eco', 'Komfort'],
              options_complete: true,
              writable: true,
            });
            const from = writes.length;
            expect(await setValue(harness, 'select.heizprogramm', 'Komfort')).to.include({ status: 'ok' });
            expect(await written(harness, from)).to.deep.equal([[`${PROGRAM}.SET`, 2]]);
            expect((await changed(harness, 'select.heizprogramm', 'state', 'Eco', 'control')).state).to.equal('Komfort');
          });

          it('datetime: shows the alarm as its text holds it, and the time the panel sets lands in that same shape, answered ok', async function () {
            this.timeout(60000);
            const harness = getHarness();
            expect(shown('datetime.wecker', 'control'), "the alarm's /control").to.include({ kind: 'datetime', state: '2026-09-24 08:15:00', writable: true });
            const from = writes.length;
            expect(await setValue(harness, 'datetime.wecker', '2026-09-25 06:30:00')).to.include({ status: 'ok' });
            expect(await written(harness, from)).to.deep.equal([[`${CLOCK}.Zeit`, '2026-09-25 06:30:00']]);
            expect((await changed(harness, 'datetime.wecker', 'state', '2026-09-24 08:15:00', 'control')).state).to.equal('2026-09-25 06:30:00');
          });

          it('a manual entity (Task 13b): the 0_userdata helper, published once the form is saved, takes the value the panel sets', async function () {
            this.timeout(60000);
            const harness = getHarness();
            expect(shown('number.soll', 'control'), "the helper's /control").to.include({ kind: 'number', state: '20', min: 15, max: 28, writable: true });
            const from = writes.length;
            expect(await setValue(harness, 'number.soll', 21)).to.include({ status: 'ok' });
            expect(await written(harness, from)).to.deep.equal([[SOLL, 21]]);
            expect((await changed(harness, 'number.soll', 'state', '20', 'control')).state).to.equal('21');
          });

          it("an energy meter (Tasks 20, 20b): the panel's energy request is answered with the meter's day, read from the history instance", async function () {
            this.timeout(60000);
            const harness = getHarness();
            await panel().publishAsync(`tab5_lvgl/config/${PANEL}/energy/request`, '{"period":"day"}');
            const energy = JSON.parse(await waitFor(harness, () => got(`tab5_lvgl/config/${PANEL}/energy/response`)[0], 'the energy answer')) as {
              period: string;
              entries: Array<{ id: string; total?: number }>;
            };
            expect(energy.period).to.equal('day');
            const midnight = new Date().setHours(0, 0, 0, 0);
            const before = counter.filter((reading) => reading.ts < midnight).at(-1)!.val as number;
            expect(energy.entries.find((entry) => entry.id === 'energy.zaehler')?.total).to.equal(Math.round((live - before) * 1000) / 1000);
          });

          it("a graph (the brief): the manual sensor's last 24 hours in quarter hours, 96 values read from the history instance", async function () {
            this.timeout(60000);
            const harness = getHarness();
            await panel().publishAsync(`tab5_lvgl/config/${PANEL}/history/request`, '{"entity_id":"sensor.fenster","hours":24,"period_minutes":15}');
            const history = JSON.parse(await waitFor(harness, () => got(`tab5_lvgl/config/${PANEL}/history/response`)[0], 'the graph')) as Record<string, unknown>;
            expect(history).to.include({ entity_id: 'sensor.fenster', hours: 24, period_minutes: 15 });
            const values = history.values as number[];
            const planted = READINGS.map((reading) => reading.val as number);
            expect(values).to.have.lengthOf(96);
            expect(values.every((value) => planted.includes(value)), JSON.stringify(values)).to.equal(true);
            expect(values).to.deep.equal([...values].sort((a, b) => a - b));
            expect(values.at(-1)).to.equal(24.7);
          });
        });
      });

      suite("a panel's history and energy requests, answered through the adapter (Task 22)", (getHarness) => {
        const { applies, panel, port } = withBrokerAndPanel();
        const HOUR = 3_600_000;
        const TEMPERATURE = '0_userdata.0.t22.temperature';
        const METER = '0_userdata.0.t22.meter';
        const now = Date.now();
        /** A reading two days old, then one every 30 minutes through the last day, the newest a quarter of an hour old. */
        const READINGS = [row(now - 48 * HOUR, 18.5), ...Array.from({ length: 48 }, (_, i) => row(now - 24 * HOUR + HOUR / 4 + (i * HOUR) / 2, 20 + i / 10))];
        /** Planted as the suite starts. */
        let counter: HistoryRow[] = [];
        withHistoryAdapter(getHarness, () => {
          counter = meterRows(Date.now());
          return { [TEMPERATURE]: READINGS, [METER]: counter };
        });

        it('answers a numeric history request from the history instance and an energy request, each on its own response topic', async function () {
          this.timeout(120000);
          const harness = getHarness();
          await harness.changeAdapterConfig('hometiles', { native: { brokerHost: '127.0.0.1', brokerPort: port(), ...ARMED, historyInstance: 'history.0' } });
          await setManualEntities(harness, [{ stateId: TEMPERATURE, domain: 'sensor', name: 'Fenster' }]);
          await setEnergyMeters(harness, [{ stateId: METER, category: 'grid', sign: 1, name: 'Zaehler' }]);
          // The running hour ends at the live reading.
          const live = (counter.at(-1)!.val as number) + 0.1;
          await harness.states.setStateAsync(METER, { val: live, ack: true });
          const HISTORY_RESPONSE = `tab5_lvgl/config/${PANEL}/history/response`;
          const ENERGY_RESPONSE = `tab5_lvgl/config/${PANEL}/energy/response`;
          const answers: Record<string, string[]> = { [HISTORY_RESPONSE]: [], [ENERGY_RESPONSE]: [] };
          panel().on('message', (topic, payload) => answers[topic]?.push(payload.toString()));
          await panel().subscribeAsync([HISTORY_RESPONSE, ENERGY_RESPONSE]);
          await harness.startAdapterAndWait(true);

          const apply = JSON.parse(await waitFor(harness, () => applies.find((payload) => payload.includes('"energy.')), 'the apply')) as {
            sensors: string[];
            energy: Array<{ id: string; name: string }>;
          };
          const [sensor] = apply.sensors;
          const meter = apply.energy.find((entry) => entry.name === 'Zaehler')!.id;
          // As the firmware asks: a graph, the state popup, the energy tile
          // (mqtt_handlers.cpp:2410-2419, :2476-2486, :2548-2550).
          await panel().publishAsync(`tab5_lvgl/config/${PANEL}/history/request`, `{"entity_id":"${sensor}","hours":24,"period_minutes":5,"points":288,"stat":"mean"}`);
          await panel().publishAsync(`tab5_lvgl/config/${PANEL}/history/request`, `{"version":1,"kind":"state","entity_id":"${sensor}","hours":24,"max_transitions":96}`);
          await panel().publishAsync(`tab5_lvgl/config/${PANEL}/energy/request`, '{"period":"day"}');
          // A graph's answer has no kind (Task 17).
          const answered = (kind?: string): string | undefined => answers[HISTORY_RESPONSE]!.find((text) => (JSON.parse(text) as { kind?: string }).kind === kind);
          const history = JSON.parse(await waitFor(harness, () => answered(), 'the graph')) as Record<string, unknown>;
          const timeline = JSON.parse(await waitFor(harness, () => answered('state'), 'the state history')) as {
            history_available: boolean;
            current: string;
            activity: Array<{ state: string }>;
          };
          const energy = JSON.parse(await waitFor(harness, () => answers[ENERGY_RESPONSE]![0], 'the energy answer')) as {
            period: string;
            entries: Array<{ id: string; total?: number }>;
          };

          expect(history).to.include({ entity_id: sensor, hours: 24, period_minutes: 5 });
          // Every bucket a planted reading, in time order: those of the day
          // shown, the reading in effect before them carried in, the newest last.
          const values = history.values as number[];
          const planted = READINGS.map((reading) => reading.val as number);
          expect(values).to.have.lengthOf(288);
          expect(values.every((value) => planted.includes(value)), JSON.stringify(values)).to.equal(true);
          expect(values).to.deep.equal([...values].sort((a, b) => a - b));
          expect([...new Set(values)]).to.include.members(planted.slice(2));
          expect(values.at(-1)).to.equal(24.7);

          // Each row as the sensor's synth reads it, the live state unknown to the history.
          expect(timeline).to.include({ entity_id: sensor, hours: 24, history_available: true, current: 'unavailable' });
          expect(timeline.activity.map(({ state }) => Number(state)).every((value) => planted.includes(value)), JSON.stringify(timeline.activity)).to.equal(true);
          expect(timeline.activity.map(({ state }) => state)).to.include.members(planted.slice(2).map(String));
          expect(timeline.activity.at(-1)!.state).to.equal('24.7');

          expect(energy.period).to.equal('day');
          const midnight = new Date().setHours(0, 0, 0, 0);
          const total = energy.entries.find((entry) => entry.id === meter)?.total;
          expect(total).to.equal(Math.round((live - (counter.filter((reading) => reading.ts < midnight).at(-1)!.val as number)) * 1000) / 1000);
          expect(energy.entries.map((entry) => entry.id)).to.include('consumption_total');
          expect(answers[HISTORY_RESPONSE]).to.have.lengthOf(2);
          expect(answers[ENERGY_RESPONSE]).to.have.lengthOf(1);
        });
      });

      suite('the history provider against iobroker.history (Task 19)', (getHarness) => {
        const HOUR = 3_600_000;
        const now = Date.now();
        const start = now - 24 * HOUR;
        /** Local 06:00 of the day the window starts in. */
        const morning = new Date(start).setHours(6, 0, 0, 0);
        const every = (first: number, step: number, count: number): HistoryRow[] =>
          Array.from({ length: count }, (_, i) => row(first + i * step, 20 + i / 10));
        const ID = {
          window: '0_userdata.0.t19.window',
          sameDay: '0_userdata.0.t19.sameday',
          busy: '0_userdata.0.t19.busy',
          marked: '0_userdata.0.t19.marked',
          unlogged: '0_userdata.0.t19.unlogged',
          meter: '0_userdata.0.t20.meter',
          old: '0_userdata.0.t19.old',
        };
        const WINDOW = [row(start - 72 * HOUR, 18.5), ...every(start + HOUR / 4, HOUR / 2, 48)];
        /** A reading a month old, older than the week the first question covers (fix round 1, M-8). */
        const OLD = [row(start - 30 * 24 * HOUR, 17.5), ...every(start + HOUR / 4, HOUR / 2, 48)];
        const SAME_DAY = [row(morning - 5 * HOUR, 3), row(morning - 60_000, 7), ...every(morning + 60_000, 120_000, 400)];
        /** Three days back: its 42.5 hours of rows cross a midnight whatever the hour, so two day files hold them. */
        const busyStart = start - 48 * HOUR;
        const BUSY = [row(busyStart - HOUR, 1), ...every(busyStart + HOUR, 30_000, MAX_HISTORY_ROWS + 100)];
        /** Planted as the suite starts, so its newest row is minutes old when the energy test asks. */
        let METER: HistoryRow[] = [];
        const MARKED = [
          row(start - 72 * HOUR, 18.5),
          row(start - HOUR, null, 0x40),
          row(start + HOUR, 21),
          row(start + 2 * HOUR, null, 0x40),
          row(start + 3 * HOUR, 22, 0x42, false),
          row(start + 4 * HOUR, 'n/a'),
          row(start + 5 * HOUR, 23),
        ];
        withHistoryAdapter(
          getHarness,
          () => {
            METER = meterRows(Date.now());
            return { [ID.window]: WINDOW, [ID.sameDay]: SAME_DAY, [ID.busy]: BUSY, [ID.marked]: MARKED, [ID.old]: OLD, [ID.meter]: METER };
          },
          [ID.unlogged],
        );

        const ask = (provider: HistoryProvider, id: string, kind: 'numeric' | 'discrete' = 'numeric', from = start): Promise<HistoryResult> =>
          provider.query(id, { start: from, kind, panel: 'e2e' });

        const provide = (instance = 'history.0', lines: string[] = []): HistoryProvider => {
          const add = (message: string): void => void lines.push(message);
          return new HistoryProvider(harnessHistory(getHarness()), { info: add, warn: add, error: add, debug: add }, instance);
        };

        it('reads the window and, asked for on its own, the reading in effect at its start, however old', async function () {
          this.timeout(60000);
          const result = await ask(provide(), ID.window);
          expect(result.available).to.equal(true);
          expect(result.rows.map((r) => [r.ts, r.val])).to.deep.equal(WINDOW.map((r) => [r.ts, r.val]));
        });

        it('reads a reading in effect a month old, asked for again with no start when the week before holds none', async function () {
          this.timeout(60000);
          const result = await ask(provide(), ID.old);
          expect(result.rows.map((r) => [r.ts, r.val])).to.deep.equal(OLD.map((r) => [r.ts, r.val]));
        });

        it("reads the system's default history instance, which the adapter set for itself, when none is configured", async function () {
          this.timeout(60000);
          const config = await getHarness().objects.getObjectAsync('system.config');
          expect(config?.common).to.include({ defaultHistory: 'history.0' });
          const result = await ask(provide(''), ID.window);
          expect(result.rows.map((r) => r.val)).to.deep.equal(WINDOW.map((r) => r.val));
        });

        it('finds the reading in effect behind the 400 later rows of its own day file', async function () {
          this.timeout(60000);
          const result = await ask(provide(), ID.sameDay, 'numeric', morning);
          expect(result.rows.map((r) => r.val)).to.deep.equal(SAME_DAY.slice(1).map((r) => r.val));
        });

        it(`keeps the newest ${MAX_HISTORY_ROWS} rows of a busier window, with no reading carried over the rest`, async function () {
          this.timeout(60000);
          const lines: string[] = [];
          const result = await ask(provide('history.0', lines), ID.busy, 'numeric', busyStart);
          expect(result.rows.map((r) => r.ts)).to.deep.equal(BUSY.slice(-MAX_HISTORY_ROWS).map((r) => r.ts));
          expect(lines.join('\n')).to.include(ID.busy).and.include(`newest ${MAX_HISTORY_ROWS}`);
        });

        it('keeps only good numeric readings for a graph, and every row with its quality for a timeline', async function () {
          this.timeout(60000);
          const numeric = await ask(provide(), ID.marked, 'numeric');
          expect(numeric.rows.map((r) => r.val)).to.deep.equal([18.5, 21, 23]);
          const discrete = await ask(provide(), ID.marked, 'discrete');
          expect(discrete.rows.map((r) => [r.val, r.q, r.ack])).to.deep.equal(MARKED.slice(1).map((r) => [r.val, r.q, r.ack]));
        });

        it('asks nothing for a state the instance does not log', async function () {
          this.timeout(60000);
          expect(await ask(provide(), ID.unlogged)).to.deep.include({ rows: [], available: false, reason: 'not_logged' });
        });

        it("answers a day's energy request from a logged meter: each hour its increase, summing to the total, and nothing for one not logged (Task 20b)", async function () {
          this.timeout(60000);
          const harness = getHarness();
          const live = (METER.at(-1)!.val as number) + 0.1;
          await harness.states.setStateAsync(ID.meter, { val: live, ack: true });
          const totals = { grid: 'Grid total', solar: 'Solar total', battery: 'Battery total', gas: 'Gas total', water: 'Water total', device: 'Devices total', device_water: 'Water devices total' };
          const names: EnergyNames = { totals, consumption: 'Total consumption', untracked: 'Untracked consumption' };
          const lines: string[] = [];
          const source = new EnergySource(provide('history.0', lines), harnessHistory(harness), { info() {}, warn: (m) => void lines.push(m), error: (m) => void lines.push(m), debug() {} });
          source.configure({
            armed: true,
            meters: [
              { id: 'energy.meter', stateId: ID.meter, category: 'grid', sign: 1, name: 'Meter', unit: 'kWh' },
              { id: 'energy.unlogged', stateId: ID.unlogged, category: 'device', sign: 1, name: 'Unlogged' },
            ],
            currency: 'EUR',
            names,
          });
          const answer = await source.answer('e2e', '{"period":"day"}');
          expect(answer!.topic).to.equal('tab5_lvgl/config/e2e/energy/response');
          const parsed = JSON.parse(answer!.payload) as { period: string; start: string; entries: Array<{ id: string; values: Array<number | null>; total?: number }> };
          const midnight = new Date(Date.now()).setHours(0, 0, 0, 0);
          expect(parsed.period).to.equal('day');
          expect(new Date(parsed.start).getTime()).to.equal(midnight);
          const [meter, unlogged] = ['energy.meter', 'energy.unlogged'].map((id) => parsed.entries.find((entry) => entry.id === id));
          const hours = Math.floor((Date.now() - midnight) / 3_600_000);
          expect(meter!.values, lines.join('\n')).to.have.lengthOf(hours + 1);
          // A reading before midnight and one before each hour, the running hour to the live one.
          expect(meter!.values.every((value) => value !== null), JSON.stringify(meter!.values)).to.equal(true);
          expect(meter!.values.slice(0, hours)).to.deep.equal(Array(hours).fill(0.6));
          const sum = (meter!.values as number[]).reduce((total, value) => total + value, 0);
          expect(Math.round(sum * 1000) / 1000).to.equal(meter!.total);
          expect(meter!.total).to.equal(Math.round((live - (METER.filter((r) => r.ts < midnight).at(-1)!.val as number)) * 1000) / 1000);
          expect(unlogged!.values).to.deep.equal(Array(hours + 1).fill(null));
          expect(unlogged).to.not.have.property('total');
        });
      });
    },
  });
}
