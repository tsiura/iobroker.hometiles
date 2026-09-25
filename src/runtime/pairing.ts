import type { AdapterOptions } from '../config/options';
import type { Logger } from './mqtt-client';

export interface PairingCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  baseTopic: string;
  haPrefix: string;
}

/**
 * Why a pairing failed: each has a text of its own in the admin (Ruling 140). A password that could not
 * be decrypted, or credentials the adapter is not connected with, are sent to no panel (main.ts pair,
 * Rulings 144 and 149).
 */
export const PAIRING_FAILURES = [
  'invalid_host',
  'unreachable',
  'credentials_rejected',
  'restart_unreachable',
  'restart_failed',
  'password_unreadable',
  'broker_not_connected',
] as const;
export type PairingFailure = (typeof PAIRING_FAILURES)[number];

/** A failure the panel answered with an HTTP status carries it apart, for that text to name. */
export type PairingResult = { ok: true } | { ok: false; reason: PairingFailure; status?: number };

const REQUEST_TIMEOUT_MS = 5000;
const ACCEPTED_STATUS = new Set([200, 303]);

export function credentialsFromOptions(options: AdapterOptions): PairingCredentials {
  return {
    host: options.brokerHost,
    port: options.brokerPort,
    username: options.brokerUser,
    password: options.brokerPassword,
    baseTopic: options.baseTopic,
    haPrefix: options.haPrefix,
  };
}

/**
 * A bare host, optionally with a port. Deliberately strict.
 *
 * `fetch` follows URL rules, so `panel.lan@attacker.example` resolves to
 * attacker.example with `panel.lan` discarded as userinfo — one stray character
 * silently sends broker credentials to a different host. The panel's own
 * reported IP reaches this function, and that arrives over MQTT, so it is not
 * a trusted string. Anything carrying `@`, a path, a query, a fragment or
 * whitespace is refused rather than normalised.
 *
 * IPv6 literals are not accepted; the firmware reports IPv4.
 */
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?::\d{1,5})?$/;

export function isPlausibleHost(raw: string): boolean {
  return HOST_RE.test(raw.trim());
}

function normaliseHost(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

async function post(
  url: string,
  body: string | undefined,
  fetchImpl: typeof fetch,
): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      // The firmware answers the save with a redirect to its own admin page.
      // Following it would turn a success into a spurious second request.
      redirect: 'manual',
      headers: body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' },
      body: body ?? '',
      signal: controller.signal,
    });
    return response.status;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pushes broker credentials to a panel that has none, then restarts it.
 *
 * The restart is mandatory: the firmware latches mqtt_enabled at boot, so
 * without it the credentials sit in NVS and never take effect.
 */
export async function pushCredentials(
  host: string,
  credentials: PairingCredentials,
  log: Logger,
  fetchImpl: typeof fetch = fetch,
): Promise<PairingResult> {
  const target = normaliseHost(host);
  if (!target || !isPlausibleHost(target)) {
    log.warn(`[Pairing] Refused to send credentials to an implausible host`);
    return { ok: false, reason: 'invalid_host' };
  }

  const form = new URLSearchParams({
    mqtt_host: credentials.host,
    mqtt_port: String(credentials.port),
    mqtt_user: credentials.username,
    mqtt_pass: credentials.password,
    mqtt_base: credentials.baseTopic,
    ha_prefix: credentials.haPrefix,
  }).toString();

  let status: number;
  try {
    status = await post(`http://${target}/mqtt`, form, fetchImpl);
  } catch {
    log.warn(`[Pairing] Panel at ${target} is unreachable`);
    return { ok: false, reason: 'unreachable' };
  }

  if (!ACCEPTED_STATUS.has(status)) {
    log.warn(`[Pairing] Panel at ${target} rejected the credentials with status ${status}`);
    return { ok: false, reason: 'credentials_rejected', status };
  }

  let restartStatus: number;
  try {
    restartStatus = await post(`http://${target}/restart`, undefined, fetchImpl);
  } catch {
    log.warn(`[Pairing] Panel at ${target} accepted credentials but did not restart`);
    return { ok: false, reason: 'restart_unreachable' };
  }

  if (!ACCEPTED_STATUS.has(restartStatus)) {
    log.warn(`[Pairing] Panel at ${target} refused the restart with status ${restartStatus}`);
    return { ok: false, reason: 'restart_failed', status: restartStatus };
  }

  log.info(`[Pairing] Credentials pushed to panel at ${target}, restart requested`);
  return { ok: true };
}
