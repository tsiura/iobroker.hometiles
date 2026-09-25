import { validateOptions, type AdapterOptions } from '../../src/config/options';

/**
 * The ports io-package.json's broker defaults to, plain and TLS: a real broker may listen there,
 * and take a suite's retained applies to real panels (Ruling 145, I1).
 */
export const DEFAULT_BROKER_PORTS: readonly number[] = [1883, 8883];

/**
 * The default broker port an instance's native settings connect the adapter to, or undefined for any
 * other: the port as the adapter computes it (validateOptions), so no port at all is 1883.
 */
export function defaultBrokerPort(native: unknown): number | undefined {
  const port = validateOptions((native ?? {}) as Partial<AdapterOptions>).options.brokerPort;
  return DEFAULT_BROKER_PORTS.includes(port) ? port : undefined;
}
