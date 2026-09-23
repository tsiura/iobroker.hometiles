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

const FIXTURE_IDS = [...Object.keys(SENSOR_OBJECTS), ...Object.keys(CORRUPT_ENUM_OBJECTS)];

/** The sensor, hand-corrupted: a role that is no string makes the type-detector itself throw. */
const BROKEN_SENSOR_OBJECTS: Record<string, object> = {
  ...SENSOR_OBJECTS,
  [`${SENSOR}.temperature`]: {
    type: 'state',
    common: { name: 'Temperature', role: 5, type: 'number', unit: '°C', read: true, write: false },
  },
};

/** A panel as the firmware announces itself: retained on the broker, like its last configuration. */
const PANEL = 'e2e1';
const ANNOUNCE_TOPIC = `tab5_lvgl/config/${PANEL}/bridge`;
const APPLY_TOPIC = `tab5_lvgl/config/${PANEL}/bridge/apply`;
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

        it('publishes no apply while discovery fails, and says where and what happens next', async function () {
          this.timeout(120000);
          const harness = getHarness();
          const logs = await captureLogs(harness);
          await harness.changeAdapterConfig('hometiles', { native: { brokerHost: '127.0.0.1', brokerPort: port } });
          await setObjects(harness, BROKEN_SENSOR_OBJECTS);
          await harness.startAdapterAndWait(true);
          await waitFor(harness, () => logs.find((log) => log.message.includes(`[Panel ${PANEL}] Session started`)), 'the panel');
          const failure = await waitFor(
            harness,
            () => logs.find((log) => log.severity === 'error' && log.message.includes('Discovering devices failed')),
            'the discovery error',
          );
          expect(failure.message).to.include(`the objects below ${SENSOR}`);
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
          expect(answer?.error).to.include(`the objects below ${SENSOR}`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
          expect(harness.didAdapterStop(), 'the adapter keeps running').to.equal(false);
        });

        it('publishes the normal apply once a retry succeeds', async function () {
          this.timeout(120000);
          const harness = getHarness();
          await setObjects(harness, SENSOR_OBJECTS);
          const apply = await waitFor(harness, () => applies.find((payload) => payload.includes('sensor.balkon')), 'the normal apply');
          expect(JSON.parse(apply).sensors).to.deep.equal(['sensor.balkon']);
          expect(applies[0]).to.equal(LAST_GOOD_APPLY);
        });
      });
    },
  });
}
