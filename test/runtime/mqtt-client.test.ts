import Aedes from 'aedes';
import { expect } from 'chai';
import { createServer, type Server } from 'node:net';
import { DEFAULTS } from '../../src/config/options';
import { HomeTilesMqttClient, type Logger } from '../../src/runtime/mqtt-client';

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

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
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
  const PORT = 18831;
  let broker: Aedes;
  let server: Server;

  beforeEach(async () => {
    broker = new Aedes();
    server = createServer(broker.handle);
    await listen(server, PORT);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  });

  it('connects, subscribes and delivers a message to the handler', async () => {
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: PORT }, silentLogger());
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

  it('reports connection changes', async () => {
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: PORT }, silentLogger());
    const changes: boolean[] = [];
    client.onConnectionChange((connected) => changes.push(connected));

    await client.connect();
    await client.disconnect();

    expect(changes[0]).to.equal(true);
    expect(changes[changes.length - 1]).to.equal(false);
  });

  it('queues publishes made before the connection is up and flushes them afterwards', async () => {
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: PORT }, silentLogger());
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
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: PORT, maxPublishQueue: 100 }, logger);
    // Never connected, so nothing drains: every publish stays queued.
    for (let i = 0; i < 150; i++) {
      client.publish({ topic: 't', payload: String(i), retain: false });
    }
    expect(client.droppedPublishes).to.equal(50);
    expect(client.queueDepth).to.equal(100);
    expect(logger.warnings.length).to.be.greaterThan(0);
    expect(logger.warnings.length).to.be.lessThan(10, 'drop warnings must be rate-limited');
  });

  it('is idempotent on repeated disconnect', async () => {
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: PORT }, silentLogger());
    await client.connect();
    await client.disconnect();
    await client.disconnect();
    expect(client.connected).to.equal(false);
  });
});
