import { expect } from 'chai';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { credentialsFromOptions, pushCredentials } from '../../src/runtime/pairing';
import { DEFAULTS } from '../../src/config/options';

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

const CREDS = {
  host: '10.0.0.5',
  port: 1883,
  username: 'iob',
  password: 'secret',
  baseTopic: 'hometiles',
  haPrefix: 'ha/statestream',
};

interface Captured {
  path: string;
  contentType: string;
  body: string;
}

function startPanel(handler: (path: string) => number): {
  server: Server;
  port: number;
  captured: Captured[];
  ready: Promise<void>;
} {
  const captured: Captured[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      captured.push({
        path: request.url ?? '',
        contentType: String(request.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(handler(request.url ?? ''));
      response.end();
    });
  });
  const port = 18900 + Math.floor(Math.random() * 500);
  const ready = new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, port, captured, ready };
}

describe('runtime/pairing', () => {
  it('posts the credentials form and then the restart', async () => {
    const panel = startPanel(() => 200);
    await panel.ready;

    const result = await pushCredentials(`127.0.0.1:${panel.port}`, CREDS, silentLog);
    expect(result).to.deep.equal({ ok: true });
    expect(panel.captured.map((c) => c.path)).to.deep.equal(['/mqtt', '/restart']);
    expect(panel.captured[0]!.contentType).to.contain('application/x-www-form-urlencoded');

    const form = new URLSearchParams(panel.captured[0]!.body);
    expect(form.get('mqtt_host')).to.equal('10.0.0.5');
    expect(form.get('mqtt_port')).to.equal('1883');
    expect(form.get('mqtt_user')).to.equal('iob');
    expect(form.get('mqtt_pass')).to.equal('secret');
    expect(form.get('mqtt_base')).to.equal('hometiles');
    expect(form.get('ha_prefix')).to.equal('ha/statestream');

    await new Promise<void>((resolve) => panel.server.close(() => resolve()));
  });

  it('accepts a 303 redirect status without following it', async () => {
    const panel = startPanel(() => 303);
    await panel.ready;
    expect(await pushCredentials(`127.0.0.1:${panel.port}`, CREDS, silentLog)).to.deep.equal({ ok: true });
    await new Promise<void>((resolve) => panel.server.close(() => resolve()));
  });

  it('fails without attempting the restart when the credentials post is rejected', async () => {
    const panel = startPanel(() => 401);
    await panel.ready;
    const result = await pushCredentials(`127.0.0.1:${panel.port}`, CREDS, silentLog);
    expect(result).to.deep.equal({ ok: false, reason: 'credentials_rejected_401' });
    expect(panel.captured.map((c) => c.path)).to.deep.equal(['/mqtt']);
    await new Promise<void>((resolve) => panel.server.close(() => resolve()));
  });

  it('reports a failed restart distinctly, because the credentials did land', async () => {
    const panel = startPanel((path) => (path === '/restart' ? 500 : 200));
    await panel.ready;
    const result = await pushCredentials(`127.0.0.1:${panel.port}`, CREDS, silentLog);
    expect(result).to.deep.equal({ ok: false, reason: 'restart_failed_500' });
    await new Promise<void>((resolve) => panel.server.close(() => resolve()));
  });

  it('reports an unreachable panel rather than throwing', async () => {
    const result = await pushCredentials('127.0.0.1:9', CREDS, silentLog);
    expect(result.ok).to.equal(false);
    expect((result as { reason: string }).reason).to.equal('unreachable');
  });

  it('strips a scheme and a trailing slash from the supplied host', async () => {
    const panel = startPanel(() => 200);
    await panel.ready;
    expect(await pushCredentials(`http://127.0.0.1:${panel.port}/`, CREDS, silentLog)).to.deep.equal({ ok: true });
    await new Promise<void>((resolve) => panel.server.close(() => resolve()));
  });

  it('rejects an empty host without making a request', async () => {
    expect(await pushCredentials('   ', CREDS, silentLog)).to.deep.equal({ ok: false, reason: 'invalid_host' });
  });

  it('refuses a host that would send credentials somewhere else', async () => {
    // fetch follows URL rules: panel.lan@attacker.example resolves to
    // attacker.example with panel.lan discarded as userinfo. The panel's own
    // reported IP reaches this function and arrives over MQTT, so it is not a
    // trusted string.
    let called = false;
    const spy: typeof fetch = async () => {
      called = true;
      return new Response('', { status: 200 });
    };
    for (const host of [
      'trusted-panel.lan@attacker.example',
      '10.0.0.5/../evil',
      '10.0.0.5?x=1',
      '10.0.0.5#frag',
      'has space',
      '@attacker.example',
    ]) {
      const result = await pushCredentials(host, CREDS, silentLog, spy);
      expect(result, `${host} must be refused`).to.deep.equal({ ok: false, reason: 'invalid_host' });
    }
    expect(called, 'no request may be attempted for a refused host').to.equal(false);
  });

  it('still accepts an ordinary host, with or without a port or scheme', async () => {
    const seen: string[] = [];
    const spy: typeof fetch = async (url) => {
      seen.push(String(url));
      return new Response('', { status: 200 });
    };
    expect(await pushCredentials('10.0.0.5', CREDS, silentLog, spy)).to.deep.equal({ ok: true });
    expect(await pushCredentials('http://panel-1.lan:8080/', CREDS, silentLog, spy)).to.deep.equal({ ok: true });
    expect(seen[0]).to.equal('http://10.0.0.5/mqtt');
    expect(seen[2]).to.equal('http://panel-1.lan:8080/mqtt');
  });

  it('derives credentials from the adapter options', () => {
    const creds = credentialsFromOptions({
      ...DEFAULTS,
      brokerHost: 'broker.lan',
      brokerPort: 8883,
      brokerUser: 'u',
      brokerPassword: 'p',
    });
    expect(creds).to.deep.equal({
      host: 'broker.lan',
      port: 8883,
      username: 'u',
      password: 'p',
      baseTopic: 'hometiles',
      haPrefix: 'ha/statestream',
    });
  });
});
