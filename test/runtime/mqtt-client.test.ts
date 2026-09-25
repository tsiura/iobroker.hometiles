import Aedes from 'aedes';
import { expect } from 'chai';
import mqtt from 'mqtt';
import { createServer, type AddressInfo, type Server } from 'node:net';
import sinon from 'sinon';
import { DEFAULTS } from '../../src/config/options';
import {
  ERROR_REPEAT_INTERVAL_MS,
  HomeTilesMqttClient,
  LOGIN_HINT_INTERVAL_MS,
  LOGIN_REFUSED_HINT,
  probeBroker,
  type Logger,
} from '../../src/runtime/mqtt-client';

function silentLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    info: () => undefined,
    debug: () => undefined,
    error: () => undefined,
    warn: (message: string) => {
      warnings.push(message);
    },
  };
}

/**
 * Polls until a condition holds, instead of sleeping a fixed interval. A fixed
 * sleep encodes an assumption about how fast a loopback round trip is, which is
 * exactly what degrades on a loaded CI runner — the classic source of a test
 * that passes locally and fails intermittently in CI.
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the expected message');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('runtime/mqtt-client', () => {
  /** One the system hands out (Ruling 137): two runs at once never meet on it. */
  let port = 0;
  let broker: Aedes;
  let server: Server;

  beforeEach(async () => {
    broker = new Aedes();
    server = createServer(broker.handle);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  });

  it('connects, subscribes and delivers a message to the handler', async () => {
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: port }, silentLogger());
    const received: Array<[string, string]> = [];
    client.onMessage((topic, payload) => received.push([topic, payload]));

    await client.connect();
    expect(client.connected).to.equal(true);
    await client.subscribe('test/topic');

    client.publish({ topic: 'test/topic', payload: 'hello', retain: false });
    await waitUntil(() => received.length > 0);

    expect(received).to.deep.equal([['test/topic', 'hello']]);
    await client.disconnect();
  });

  it('tells a retained message, replayed on subscribing, from a live one (Task 15)', async () => {
    // A retained cmnd/value would run again at every subscription; the value
    // command ignores it, as the Bridge does (__init__.py:1550). MQTT 3.1.1
    // marks retained only what a new subscription replays (§3.3.1.3).
    const other = await mqtt.connectAsync(`mqtt://127.0.0.1:${port}`);
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: port }, silentLogger());
    // Closed however the test ends: an open connection keeps the broker from closing.
    try {
      await other.publishAsync('kept/topic', 'stale', { retain: true });
      const received: Array<[string, string, boolean]> = [];
      client.onMessage((topic, payload, retain) => received.push([topic, payload, retain]));
      await client.connect();
      await client.subscribe('kept/topic');
      await waitUntil(() => received.length > 0);
      await other.publishAsync('kept/topic', 'live, retained', { retain: true });
      await other.publishAsync('kept/topic', 'live', { retain: false });
      await waitUntil(() => received.length > 2);
      expect(received).to.deep.equal([
        ['kept/topic', 'stale', true],
        ['kept/topic', 'live, retained', false],
        ['kept/topic', 'live', false],
      ]);
    } finally {
      await other.endAsync(true);
      await client.disconnect();
    }
  });

  it('reports connection changes', async () => {
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: port }, silentLogger());
    const changes: boolean[] = [];
    client.onConnectionChange((connected) => changes.push(connected));

    await client.connect();
    await client.disconnect();

    expect(changes[0]).to.equal(true);
    expect(changes[changes.length - 1]).to.equal(false);
  });

  it('queues publishes made before the connection is up and flushes them afterwards', async () => {
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: port }, silentLogger());
    const received: string[] = [];
    client.onMessage((_topic, payload) => received.push(payload));

    client.publish({ topic: 'early/topic', payload: 'queued-before-connect', retain: false });
    await client.connect();
    await client.subscribe('early/topic');
    // Re-publish after subscribing so the assertion does not race the flush.
    client.publish({ topic: 'early/topic', payload: 'after', retain: false });
    await waitUntil(() => received.includes('after'));

    expect(received).to.include('after');
    await client.disconnect();
  });

  it('drops the oldest entry when the queue overflows and counts the drop', async () => {
    const logger = silentLogger();
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: port, maxPublishQueue: 100 }, logger);
    // Never connected, so nothing drains: every publish stays queued.
    for (let i = 0; i < 150; i++) {
      client.publish({ topic: 't', payload: String(i), retain: false });
    }
    expect(client.droppedPublishes).to.equal(50);
    expect(client.queueDepth).to.equal(100);
    expect(logger.warnings.length).to.be.greaterThan(0);
    expect(logger.warnings.length).to.be.lessThan(10, 'drop warnings must be rate-limited');
  });

  it('survives a throwing message handler instead of crashing the process', async () => {
    // mqtt.js emits synchronously, so an unguarded throw here escapes into the
    // library and kills the adapter. The protocol parsers these handlers feed
    // throw by design on malformed input arriving from the network.
    const logger = silentLogger();
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: port }, logger);
    const seen: string[] = [];
    client.onMessage((_topic, payload) => {
      seen.push(payload);
      throw new Error('handler exploded');
    });

    await client.connect();
    await client.subscribe('boom/topic');
    client.publish({ topic: 'boom/topic', payload: 'first', retain: false });
    await waitUntil(() => seen.length > 0);

    // Still alive and still delivering after the throw.
    client.publish({ topic: 'boom/topic', payload: 'second', retain: false });
    await waitUntil(() => seen.length > 1);
    expect(seen).to.deep.equal(['first', 'second']);
    expect(client.connected).to.equal(true);

    await client.disconnect();
  });

  it('lets go of a topic at once while the broker is unreachable, not at the next reconnect (final review I-4)', async () => {
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: port }, silentLogger());
    try {
      await client.connect();
      await client.subscribe('gone/topic');
      // No new connection is taken, and the broker closes the one there is.
      server.close();
      await new Promise<void>((resolve) => broker.close(() => resolve()));
      await waitUntil(() => !client.connected);
      const started = Date.now();
      await client.unsubscribe('gone/topic');
      expect(Date.now() - started).to.be.below(200);
    } finally {
      await client.disconnect();
    }
  });

  it('is idempotent on repeated disconnect', async () => {
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: port }, silentLogger());
    await client.connect();
    await client.disconnect();
    await client.disconnect();
    expect(client.connected).to.equal(false);
  });
});

describe('runtime/mqtt-client: a broker that refuses the login (Ruling 149)', () => {
  let broker: Aedes;
  let server: Server;
  let port = 0;

  beforeEach(async () => {
    broker = new Aedes({
      authenticate: (_client, _user, _password, done) =>
        done(Object.assign(new Error('Bad username or password'), { returnCode: 4 as const }), false),
    });
    server = createServer(broker.handle);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  });

  /** A logger that keeps every error, info and debug line. */
  function recording(): Logger & { errors: string[]; infos: string[]; debugs: string[] } {
    const errors: string[] = [];
    const infos: string[] = [];
    const debugs: string[] = [];
    return {
      errors,
      infos,
      debugs,
      info: (message: string) => infos.push(message),
      debug: (message: string) => debugs.push(message),
      warn: () => undefined,
      error: (message: string) => errors.push(message),
    };
  }
  const hints = (errors: string[]): number => errors.filter((line) => line === LOGIN_REFUSED_HINT).length;
  const REFUSED = '[MQTT] Connection refused: Bad username or password';

  it('logs in again after a refused login, which mqtt.js 5.16 and later retry only when asked to (Ruling 153)', async () => {
    // Refused once, as while the broker's auth backend restarts, then let in.
    let attempts = 0;
    broker.authenticate = (_client, _user, _password, done) => {
      attempts++;
      if (attempts === 1) done(Object.assign(new Error('Bad username or password'), { returnCode: 4 as const }), false);
      else done(null, true);
    };
    // mqtt.js schedules its retry, every 2 s, with setInterval (client.js _setupReconnect): the fake clock runs it.
    const clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: port, brokerUser: 'panel', brokerPassword: 'secret' }, recording());
    try {
      await client.connect();
      expect(client.connected, 'refused at first').to.equal(false);
      clock.tick(2000);
      await waitUntil(() => client.connected);
      expect(attempts).to.equal(2);
    } finally {
      await client.disconnect();
      clock.restore();
    }
  });

  it('logs a repeated error at error level once an hour and its repeats at debug, and says so once connected (Ruling 153)', async () => {
    const log = recording();
    const clock = sinon.useFakeTimers({ toFake: ['Date'] });
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: port, brokerUser: 'panel', brokerPassword: 'garbage' }, log);
    const attempt = async (): Promise<void> => {
      await client.connect();
      await client.disconnect();
    };
    try {
      for (let i = 0; i < 3; i++) await attempt();
      expect(log.errors.filter((line) => line === REFUSED), 'three refusals within the hour').to.have.lengthOf(1);
      expect(log.debugs.filter((line) => line === REFUSED)).to.have.lengthOf(2);
      clock.setSystemTime(Date.now() + ERROR_REPEAT_INTERVAL_MS);
      await attempt();
      expect(log.errors.filter((line) => line === REFUSED), 'an hour on').to.have.lengthOf(2);

      broker.authenticate = (_client, _user, _password, done) => done(null, true);
      await attempt();
      expect(log.infos).to.deep.equal(['[MQTT] Connected to broker after 2 repeated errors']);
    } finally {
      clock.restore();
      await client.disconnect();
    }
  });

  it('names the likely cause at the first refused login, and again at most once an hour', async () => {
    const log = recording();
    // The fake Date is what the hint's hour is measured by. Each attempt here is a connection of its own,
    // closed before the client's own retry, 2 s later, would come.
    const clock = sinon.useFakeTimers({ toFake: ['Date'] });
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: port, brokerUser: 'panel', brokerPassword: 'garbage' }, log);
    const attempt = async (): Promise<void> => {
      await client.connect();
      await client.disconnect();
    };
    try {
      await attempt();
      expect(log.errors).to.deep.equal(['[MQTT] Connection refused: Bad username or password', LOGIN_REFUSED_HINT]);
      await attempt();
      expect(hints(log.errors), 'refused again within the hour').to.equal(1);
      clock.setSystemTime(Date.now() + LOGIN_HINT_INTERVAL_MS);
      await attempt();
      expect(hints(log.errors), 'an hour on').to.equal(2);
    } finally {
      clock.restore();
      await client.disconnect();
    }
  });

  it('says nothing of errors that are no refused login, such as a port nobody listens on', async () => {
    // Taken, then let go.
    const spare = createServer();
    await new Promise<void>((resolve) => spare.listen(0, '127.0.0.1', resolve));
    const closed = (spare.address() as AddressInfo).port;
    await new Promise<void>((resolve) => spare.close(() => resolve()));
    const log = recording();
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: closed }, log);
    try {
      await client.connect();
      expect(log.errors).to.have.lengthOf(1);
      expect(log.errors[0]).to.include('ECONNREFUSED');
    } finally {
      await client.disconnect();
    }
  });
});

describe("runtime/mqtt-client probeBroker: the admin's Test broker (Rulings 140, 143)", () => {
  const servers: Server[] = [];
  /** A server on a port the system picks (Ruling 137). */
  async function serve(server: Server): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('connects to a broker that lets it in, and leaves again', async () => {
    const broker = new Aedes();
    const port = await serve(createServer(broker.handle));
    try {
      expect(await probeBroker({ ...DEFAULTS, brokerPort: port }, silentLogger(), 5000)).to.deep.equal({ connected: true, error: undefined, timedOut: false });
      await waitUntil(() => broker.connectedClients === 0);
    } finally {
      await new Promise<void>((resolve) => broker.close(() => resolve()));
    }
  });

  it('says what the network said about a port nobody listens on, at once', async () => {
    // Taken, then let go.
    const spare = createServer();
    await new Promise<void>((resolve) => spare.listen(0, '127.0.0.1', resolve));
    const { port } = spare.address() as AddressInfo;
    await new Promise<void>((resolve) => spare.close(() => resolve()));
    const result = await probeBroker({ ...DEFAULTS, brokerPort: port }, silentLogger(), 5000);
    expect(result).to.include({ connected: false, timedOut: false });
    expect(result.error).to.include('ECONNREFUSED');
  });

  it('gives up at its deadline on a broker that hangs up on each connection without a word, which mqtt.js retries for ever, and retries no more', async function () {
    this.timeout(15000);
    let accepted = 0;
    // It reads the CONNECT and closes cleanly: mqtt.js sees a close, no error, and tries again.
    const port = await serve(
      createServer((socket) => {
        accepted++;
        socket.on('data', () => socket.end());
      }),
    );
    // mqtt.js schedules its retry, every 2 s, with setInterval (client.js _setupReconnect) and a closed
    // client clears it: the fake clock holds each one, so what is left once the probe answers is a retry
    // that would still run. No sleep through a retry period to see none come (Task 24).
    const clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const started = Date.now();
      expect(await probeBroker({ ...DEFAULTS, brokerPort: port }, silentLogger(), 300)).to.deep.equal({ connected: false, error: undefined, timedOut: true });
      expect(Date.now() - started).to.be.below(2000);
      expect(accepted).to.be.greaterThan(0);
      expect(clock.countTimers(), 'a retry still scheduled').to.equal(0);
    } finally {
      clock.restore();
    }
  });

  it('gives up at its deadline on a broker that takes the connection and never answers, and closes that connection', async () => {
    let closed = 0;
    // Reading what arrives, as a broker does: a paused socket would never see the client's FIN.
    const port = await serve(createServer((socket) => socket.resume().on('close', () => closed++)));
    const started = Date.now();
    expect(await probeBroker({ ...DEFAULTS, brokerPort: port }, silentLogger(), 300)).to.deep.equal({ connected: false, error: undefined, timedOut: true });
    expect(Date.now() - started).to.be.below(2000);
    await waitUntil(() => closed === 1);
  });
});
