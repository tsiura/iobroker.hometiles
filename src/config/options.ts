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
  /**
   * The detected control's DeviceInput.objectId: its root (device or channel),
   * or for a root's further controls the state that anchors each one
   * (discoverDevices). Overrides are keyed by this, never by list index.
   */
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

type TextOption = 'brokerHost' | 'brokerUser' | 'brokerPassword' | 'clientId' | 'baseTopic' | 'haPrefix';

/**
 * Admin stores text here, but the instance config is hand-editable: one
 * number made .trim() throw in onReady on every start, a crash loop
 * (Ruling 58 A). Anything but text is replaced by the default, with a
 * warning that never repeats the value (it may be the password).
 */
function text(raw: Partial<AdapterOptions>, key: TextOption, warnings: string[]): string | undefined {
  const value: unknown = raw[key];
  if (value === undefined || value === null || typeof value === 'string') return value ?? undefined;
  warnings.push(`${key} is not text but ${Array.isArray(value) ? 'a list' : `a ${typeof value}`}; using the default`);
  return undefined;
}

/**
 * Overrides as a hand edit may leave them: applyOverrides looks up each
 * objectId and trims each name, so an entry that is no object failed every
 * discovery, and with it every panel's configuration (Ruling 58 A).
 */
function deviceOverrides(value: unknown, warnings: string[]): DeviceOverride[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push('deviceOverrides is not a list; ignoring every override');
    return [];
  }
  const overrides: DeviceOverride[] = [];
  value.forEach((entry: unknown, index) => {
    const override = entry as Partial<DeviceOverride> | null;
    if (typeof override !== 'object' || override === null || typeof override.objectId !== 'string') {
      warnings.push(`deviceOverrides entry ${index + 1} names no object id; ignoring it`);
      return;
    }
    const kept = { ...override } as DeviceOverride;
    if (typeof (kept.name ?? '') !== 'string') {
      warnings.push(`deviceOverrides entry ${index + 1} (${kept.objectId}) has a name that is not text; ignoring the name`);
      delete kept.name;
    }
    overrides.push(kept);
  });
  return overrides;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function validateOptions(raw: Partial<AdapterOptions>): {
  options: AdapterOptions;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const baseTopic = normaliseTopic(text(raw, 'baseTopic', warnings), DEFAULTS.baseTopic);
  const haPrefix = normaliseTopic(text(raw, 'haPrefix', warnings), DEFAULTS.haPrefix);

  if (/[+#]/.test(baseTopic)) errors.push('baseTopic must not contain MQTT wildcards');
  if (/[+#]/.test(haPrefix)) errors.push('haPrefix must not contain MQTT wildcards');

  const brokerPort = raw.brokerPort ?? DEFAULTS.brokerPort;
  if (!Number.isInteger(brokerPort) || brokerPort < 1 || brokerPort > 65535) {
    errors.push('brokerPort must be between 1 and 65535');
  }

  const options: AdapterOptions = {
    brokerHost: (text(raw, 'brokerHost', warnings) ?? DEFAULTS.brokerHost).trim() || DEFAULTS.brokerHost,
    brokerPort: clamp(brokerPort, 1, 65535),
    brokerTls: raw.brokerTls ?? DEFAULTS.brokerTls,
    brokerUser: text(raw, 'brokerUser', warnings) ?? DEFAULTS.brokerUser,
    brokerPassword: text(raw, 'brokerPassword', warnings) ?? DEFAULTS.brokerPassword,
    clientId: (text(raw, 'clientId', warnings) ?? DEFAULTS.clientId).trim() || DEFAULTS.clientId,
    baseTopic,
    haPrefix,
    coalesceMs: clamp(raw.coalesceMs ?? DEFAULTS.coalesceMs, 0, 5000),
    maxPublishQueue: clamp(raw.maxPublishQueue ?? DEFAULTS.maxPublishQueue, 100, 100000),
    protocolTrace: raw.protocolTrace ?? DEFAULTS.protocolTrace,
    deviceOverrides: deviceOverrides(raw.deviceOverrides, warnings),
  };

  return { options, errors, warnings };
}
