export interface AdapterOptions {
  brokerHost: string;
  brokerPort: number;
  brokerTls: boolean;
  brokerUser: string;
  brokerPassword: string;
  clientId: string;
  baseTopic: string;
  haPrefix: string;
  coalesceMs: number;
  maxPublishQueue: number;
  protocolTrace: boolean;
  deviceOverrides: DeviceOverride[];
}

export interface DeviceOverride {
  /** ioBroker object id of the device root. Overrides are keyed by this, never by list index. */
  objectId: string;
  include: boolean;
  name?: string;
  forcedDomain?: string;
}

export const DEFAULTS: AdapterOptions = {
  brokerHost: '127.0.0.1',
  brokerPort: 1883,
  brokerTls: false,
  brokerUser: '',
  brokerPassword: '',
  clientId: 'iobroker-hometiles',
  baseTopic: 'hometiles',
  haPrefix: 'ha/statestream',
  coalesceMs: 200,
  maxPublishQueue: 2000,
  protocolTrace: false,
  deviceOverrides: [],
};

export function normaliseTopic(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return fallback;
  const collapsed = trimmed.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  return collapsed || fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function validateOptions(raw: Partial<AdapterOptions>): {
  options: AdapterOptions;
  errors: string[];
} {
  const errors: string[] = [];
  const baseTopic = normaliseTopic(raw.baseTopic, DEFAULTS.baseTopic);
  const haPrefix = normaliseTopic(raw.haPrefix, DEFAULTS.haPrefix);

  if (/[+#]/.test(baseTopic)) errors.push('baseTopic must not contain MQTT wildcards');
  if (/[+#]/.test(haPrefix)) errors.push('haPrefix must not contain MQTT wildcards');

  const brokerPort = raw.brokerPort ?? DEFAULTS.brokerPort;
  if (!Number.isInteger(brokerPort) || brokerPort < 1 || brokerPort > 65535) {
    errors.push('brokerPort must be between 1 and 65535');
  }

  const options: AdapterOptions = {
    brokerHost: (raw.brokerHost ?? DEFAULTS.brokerHost).trim() || DEFAULTS.brokerHost,
    brokerPort: clamp(brokerPort, 1, 65535),
    brokerTls: raw.brokerTls ?? DEFAULTS.brokerTls,
    brokerUser: raw.brokerUser ?? DEFAULTS.brokerUser,
    brokerPassword: raw.brokerPassword ?? DEFAULTS.brokerPassword,
    clientId: (raw.clientId ?? DEFAULTS.clientId).trim() || DEFAULTS.clientId,
    baseTopic,
    haPrefix,
    coalesceMs: clamp(raw.coalesceMs ?? DEFAULTS.coalesceMs, 0, 5000),
    maxPublishQueue: clamp(raw.maxPublishQueue ?? DEFAULTS.maxPublishQueue, 100, 100000),
    protocolTrace: raw.protocolTrace ?? DEFAULTS.protocolTrace,
    deviceOverrides: raw.deviceOverrides ?? [],
  };

  return { options, errors };
}
