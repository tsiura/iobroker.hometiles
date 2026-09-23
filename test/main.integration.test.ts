import Aedes from 'aedes';
import { expect } from 'chai';
import { tests, type IntegrationTestHarness } from '@iobroker/testing';
import mqtt, { type MqttClient } from 'mqtt';
import { createServer, type Server } from 'node:net';
import path from 'node:path';

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
 * changeAdapterConfig deep-merges (alcalzone-shared extend), which turns a
 * list the instance's native does not hold yet into an object. manualEntities
 * has no io-package.json default until its admin table exists (Task 23), so
 * it is set whole.
 */
async function setManualEntities(harness: IntegrationTestHarness, entries: object[]): Promise<void> {
  const id = 'system.adapter.hometiles.0';
  const instance = (await harness.objects.getObjectAsync(id)) as { native: Record<string, unknown> } & Record<string, unknown>;
  await harness.objects.setObjectAsync(id, { ...instance, native: { ...instance.native, manualEntities: entries } });
}

async function setObjects(harness: IntegrationTestHarness, objects: Record<string, object>): Promise<void> {
  for (const [id, obj] of Object.entries(objects)) await harness.objects.setObjectAsync(id, { _id: id, native: {}, ...obj });
}

/**
 * The harness backs its database up once per run, from whatever the previous
 * run's last suite left behind (prepareTestDir never clears it), so a suite
 * that writes objects removes every fixture before and after itself.
 */
function withCleanFixtures(getHarness: () => IntegrationTestHarness): void {
  const removeAll = async (): Promise<void> => {
    for (const id of FIXTURE_IDS) await getHarness().objects.delObjectAsync(id).catch(() => undefined);
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

const FIXTURE_IDS = [
  ...Object.keys(SENSOR_OBJECTS),
  ...Object.keys(CORRUPT_ENUM_OBJECTS),
  ...Object.keys(BAD_OBJECTS),
  ...Object.keys(HELPER_OBJECTS),
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

/** A broker, and a panel client on it that records every apply it receives. */
function withBrokerAndPanel(port: number): { applies: string[]; panel: () => MqttClient } {
  const applies: string[] = [];
  let broker: Aedes;
  let server: Server;
  let panel: MqttClient;
  // Created in the hook: a broker's timers would keep a --grep run that
  // skips this suite from ever exiting.
  before(async () => {
    broker = new Aedes();
    server = createServer(broker.handle);
    await new Promise<void>((resolve) => server.listen(port, resolve));
    panel = await mqtt.connectAsync(`mqtt://127.0.0.1:${port}`);
    panel.on('message', (topic, payload) => {
      if (topic === APPLY_TOPIC) applies.push(payload.toString());
    });
    await panel.subscribeAsync(APPLY_TOPIC);
    await panel.publishAsync(ANNOUNCE_TOPIC, ANNOUNCEMENT, { retain: true });
  });
  after((done) => {
    panel.end(true);
    server.close(() => done());
    broker.close();
  });
  return { applies, panel: () => panel };
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

// Opt-in: this downloads and runs a real js-controller, so it stays out of the
// default suite. Run it with HOMETILES_INTEGRATION=1 npm test.
if (process.env.HOMETILES_INTEGRATION === '1') {
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
          await harness.changeAdapterConfig('hometiles', { native: { clientId: 42 } });
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
        const port = 18851;
        // Created in the hook: a broker's timers would keep a --grep run
        // that skips this suite from ever exiting.
        let broker: Aedes;
        let server: Server;
        before((done) => {
          broker = new Aedes();
          server = createServer(broker.handle);
          server.listen(port, done);
        });
        after((done) => {
          server.close(() => done());
          broker.close();
        });

        it('is left out with a warning, and discovery still publishes every device', async function () {
          this.timeout(120000);
          const harness = getHarness();
          const logs = await captureLogs(harness);
          await harness.changeAdapterConfig('hometiles', { native: { brokerHost: '127.0.0.1', brokerPort: port } });
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
        const port = 18852;
        let broker: Aedes;
        let server: Server;
        let panel: MqttClient;
        const applies: string[] = [];
        let design: DesignDocument | undefined;
        // Never leave the objects database without its view: the harness
        // backs up whatever the last suite of a run left behind.
        after(async () => {
          if (design) await getHarness().objects.setObjectAsync('_design/system', design);
        });
        before(async () => {
          broker = new Aedes();
          server = createServer(broker.handle);
          await new Promise<void>((resolve) => server.listen(port, resolve));
          panel = await mqtt.connectAsync(`mqtt://127.0.0.1:${port}`);
          await panel.publishAsync(APPLY_TOPIC, LAST_GOOD_APPLY, { retain: true });
          await panel.publishAsync(ANNOUNCE_TOPIC, ANNOUNCEMENT, { retain: true });
          panel.on('message', (topic, payload) => {
            if (topic === APPLY_TOPIC) applies.push(payload.toString());
          });
          await panel.subscribeAsync(APPLY_TOPIC);
        });
        after((done) => {
          panel.end(true);
          server.close(() => done());
          broker.close();
        });

        it('publishes no apply while discovery fails, and says what failed and what happens next', async function () {
          this.timeout(120000);
          const harness = getHarness();
          const logs = await captureLogs(harness);
          await harness.changeAdapterConfig('hometiles', { native: { brokerHost: '127.0.0.1', brokerPort: port } });
          await setObjects(harness, SENSOR_OBJECTS);
          design = await breakDeviceView(harness);
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
          // prune the panel's tile bindings and save that to flash.
          await new Promise((resolve) => setTimeout(resolve, 1000));
          expect(applies).to.deep.equal([LAST_GOOD_APPLY]);
        });

        it('answers an admin request with the error meanwhile, and keeps running (Ruling 58 E)', async function () {
          this.timeout(120000);
          const harness = getHarness();
          await harness.enableSendTo();
          let answer: { error?: string } | undefined;
          harness.sendTo('hometiles.0', 'listDetected', {}, (reply: unknown) => {
            answer = reply as { error?: string };
          });
          await waitFor(harness, () => answer, 'the answer to listDetected');
          expect(answer?.error).to.include('"device"');
          await new Promise((resolve) => setTimeout(resolve, 1000));
          expect(harness.didAdapterStop(), 'the adapter keeps running').to.equal(false);
        });

        it('publishes the normal apply once a retry succeeds', async function () {
          this.timeout(120000);
          const harness = getHarness();
          if (design) await harness.objects.setObjectAsync('_design/system', design);
          const apply = await waitFor(harness, () => applies.find((payload) => payload.includes('sensor.balkon')), 'the normal apply');
          expect(JSON.parse(apply).sensors).to.deep.equal(['sensor.balkon']);
          expect(applies[0]).to.equal(LAST_GOOD_APPLY);
        });
      });

      suite('one bad object is left out, not the whole installation (Rulings 60, 62)', (getHarness) => {
        withCleanFixtures(getHarness);
        const port = 18853;
        const { applies, panel } = withBrokerAndPanel(port);
        const balkonState: string[] = [];
        let logs: LogRecord[] = [];

        it('publishes every other device with its value, and logs no error', async function () {
          this.timeout(120000);
          const harness = getHarness();
          logs = await captureLogs(harness);
          await harness.changeAdapterConfig('hometiles', {
            native: {
              brokerHost: '127.0.0.1',
              brokerPort: port,
              deviceOverrides: [{ objectId: FORCED, forcedDomain: 'number' }],
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
        });
      });

      suite('manual entities (Task 13b)', (getHarness) => {
        withCleanFixtures(getHarness);
        const port = 18855;
        const { applies, panel } = withBrokerAndPanel(port);
        const helperState: string[] = [];
        let logs: LogRecord[] = [];

        it('publishes a 0_userdata state beside the detected devices, with its value', async function () {
          this.timeout(120000);
          const harness = getHarness();
          logs = await captureLogs(harness);
          await harness.changeAdapterConfig('hometiles', {
            native: {
              brokerHost: '127.0.0.1',
              brokerPort: port,
              // Overrides are for detected devices: neither key removes it.
              deviceOverrides: [
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
          });
          await panel().subscribeAsync('ha/e2e/sensor/vorlauf/state');
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

      suite('stopping the adapter (Ruling 62 B)', (getHarness) => {
        withCleanFixtures(getHarness);
        const port = 18854;
        const { applies, panel } = withBrokerAndPanel(port);

        it('publishes no empty configuration, however many requests arrive while it stops', async function () {
          this.timeout(120000);
          const harness = getHarness();
          const logs = await captureLogs(harness);
          await harness.changeAdapterConfig('hometiles', { native: { brokerHost: '127.0.0.1', brokerPort: port } });
          await setObjects(harness, SENSOR_OBJECTS);
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
          await new Promise((resolve) => setTimeout(resolve, 500));
          const empty = applies.filter((payload) => !payload.includes('sensor.balkon'));
          expect(empty, `${empty.length} of ${applies.length} applies without the sensor`).to.deep.equal([]);
          // Nor does the log claim one was pushed.
          const pushed = logs.map((log) => log.message).filter((message) => message.includes('Configuration pushed'));
          expect(pushed.filter((message) => !message.endsWith(', 1 entities')), pushed.join('\n')).to.deep.equal([]);
        });
      });
    },
  });
}
