import { ENERGY_CATEGORIES, type EnergyCategory } from '../protocol/energy';
import type { DatetimeKind } from '../registry/types';

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
  manualEntities: ManualEntity[];
  /**
   * The saved form holds PICKER_VERSION under this key: its Refresh set it.
   * Until then nothing is published, whatever rows or manual entities an
   * earlier version left (Ruling 118). io-package.json gives it no default,
   * so no install or upgrade sets it (js-controller extendNative adds only
   * keys io-package.json has).
   */
  pickerArmed: boolean;
  /**
   * The history, sql or influxdb instance panel history is read from (Task 19),
   * as the admin's instance select stores it; '' is the system's default
   * history instance, if one is set.
   */
  historyInstance: string;
  /** The meters energy tiles show the consumption of (Task 20b, Ruling 124). */
  energyMeters: EnergyMeterRow[];
  /** The currency the meters' prices are in: the unit of their cost entries. */
  currency: string;
}

/**
 * One cumulative meter, a counter such as a kWh total, as the Energy tab
 * stores it (Task 20b). Keyed by stateId, never by list index;
 * runtime/energy-source.ts judges whether the state can be one.
 */
export interface EnergyMeterRow {
  stateId: string;
  category: EnergyCategory;
  /** 1: import or consumption; -1: export, such as grid feed-in, which the panel shows negative. */
  sign: 1 | -1;
  name?: string;
  /** Per unit of the meter, in `currency`: a cost entry beside the meter's own. */
  price?: number;
}

/** An instance id as js-controller names one: an adapter name, a dot, a number (history.0, sql.1). */
export const INSTANCE_ID_RE = /^[a-z0-9_-]+\.\d+$/;

/**
 * What this picker's Refresh writes under native.pickerArmed. 4cbb6d3 wrote
 * true, and its rows and those of a saved 44d1111 Refresh have one shape,
 * ticks the user never set among them: bumped, both count as an earlier
 * version's until the user ticks again in this picker (Ruling 120).
 */
export const PICKER_VERSION = 2;

/**
 * One state published as one entity of the user's choosing (Task 13b), where
 * detection reaches none: a 0_userdata.0 helper, a state beside another
 * control of its channel, a channel's second loose state. Keyed by stateId,
 * never by list index; registry/manual.ts judges whether the domain suits it.
 */
export interface ManualEntity {
  stateId: string;
  /** Text as the admin stores it: manualDevices rejects anything but a domain one state can serve. */
  domain: string;
  name?: string;
  /** A datetime's kind, for a value that gives none (Ruling 92); other domains ignore it. */
  kind?: DatetimeKind;
}

const DATETIME_KINDS: readonly string[] = ['date', 'time', 'datetime'];

export interface DeviceOverride {
  /**
   * The detected control's DeviceInput.objectId: its root (device or channel),
   * or for a root's further controls the state that anchors each one
   * (discoverDevices). Overrides are keyed by this, never by list index.
   */
  objectId: string;
  /** Shown as "Show on panels": only true publishes the device (Task 21b). */
  include: boolean;
  name?: string;
  forcedDomain?: string;
  /**
   * What detection found, shown read-only in the picker (Task 21b). The
   * refresh writes these, the admin stores them, nothing else reads them.
   */
  detectedName?: string;
  detectedDomain?: string;
  /** The room enums, then the function enums, that hold the device. */
  room?: string;
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
  manualEntities: [],
  pickerArmed: false,
  historyInstance: '',
  energyMeters: [],
  currency: 'EUR',
};

export function normaliseTopic(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return fallback;
  const collapsed = trimmed.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  return collapsed || fallback;
}

type TextOption = 'brokerHost' | 'brokerUser' | 'brokerPassword' | 'clientId' | 'baseTopic' | 'haPrefix' | 'currency';

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
    // What detection found is shown as text and marked as text: a hand edit's
    // number made every Refresh fail (Ruling 119, M5).
    for (const field of ['detectedName', 'detectedDomain', 'room'] as const) {
      if (typeof (kept[field] ?? '') === 'string') continue;
      warnings.push(`deviceOverrides entry ${index + 1} (${kept.objectId}) has a ${field} that is not text; ignoring it`);
      delete kept[field];
    }
    overrides.push(kept);
  });
  return overrides;
}

/** Manual entities as a hand edit may leave them, the shape only (Ruling 58 A). */
function manualEntities(value: unknown, warnings: string[]): ManualEntity[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push('manualEntities is not a list; ignoring every manual entity');
    return [];
  }
  const entries: ManualEntity[] = [];
  value.forEach((raw: unknown, index) => {
    const entry = raw as Partial<Record<keyof ManualEntity, unknown>> | null;
    if (typeof entry !== 'object' || entry === null || typeof entry.stateId !== 'string' || !entry.stateId.trim()) {
      warnings.push(`manualEntities entry ${index + 1} names no state id; ignoring it`);
      return;
    }
    // No object picker leaves spaces around an id; a hand edit can (m5).
    const stateId = entry.stateId.trim();
    const where = `manualEntities entry ${index + 1} (${stateId})`;
    if (typeof entry.domain !== 'string') {
      warnings.push(`${where} names no domain; ignoring it`);
      return;
    }
    const kept: ManualEntity = { stateId, domain: entry.domain };
    if (typeof entry.name === 'string') kept.name = entry.name;
    else if (entry.name !== undefined && entry.name !== null) warnings.push(`${where} has a name that is not text; ignoring the name`);
    // An empty kind is an admin select's "none"; a wrong one costs the kind, not the entry.
    if (typeof entry.kind === 'string' && DATETIME_KINDS.includes(entry.kind)) kept.kind = entry.kind as DatetimeKind;
    else if (entry.kind !== undefined && entry.kind !== null && entry.kind !== '') {
      warnings.push(`${where} has a kind that is not date, time or datetime; ignoring the kind`);
    }
    entries.push(kept);
  });
  return entries;
}

/**
 * Energy meters as the Energy tab or a hand edit leaves them, the shape only
 * (Task 20b): a row without a state, a category the panel draws or a sign is
 * dropped, the first row of a state is used, and a name or price that is no
 * name or price costs itself, not the row. The admin stores a cleared number
 * as '' (json-config ConfigNumber) and a sign as the number its select holds.
 */
function energyMeters(value: unknown, warnings: string[]): EnergyMeterRow[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnings.push('energyMeters is not a list; ignoring every energy meter');
    return [];
  }
  const meters: EnergyMeterRow[] = [];
  const seen = new Set<string>();
  value.forEach((raw: unknown, index) => {
    const row = raw as Partial<Record<keyof EnergyMeterRow, unknown>> | null;
    if (typeof row !== 'object' || row === null || typeof row.stateId !== 'string' || !row.stateId.trim()) {
      warnings.push(`energyMeters entry ${index + 1} names no state id; ignoring it`);
      return;
    }
    const stateId = row.stateId.trim();
    const where = `energyMeters entry ${index + 1} (${stateId})`;
    if (!ENERGY_CATEGORIES.includes(row.category as EnergyCategory)) {
      warnings.push(`${where} has no category of ${ENERGY_CATEGORIES.join(', ')}; ignoring it`);
      return;
    }
    const sign = row.sign === 1 || row.sign === '1' ? 1 : row.sign === -1 || row.sign === '-1' ? -1 : undefined;
    if (!sign) {
      warnings.push(`${where} has a sign that is neither 1 (import) nor -1 (export); ignoring it`);
      return;
    }
    if (seen.has(stateId)) {
      warnings.push(`${where} is listed more than once; the first entry is used`);
      return;
    }
    seen.add(stateId);
    const kept: EnergyMeterRow = { stateId, category: row.category as EnergyCategory, sign };
    if (typeof row.name === 'string') {
      if (row.name.trim()) kept.name = row.name.trim();
    } else if (row.name !== undefined && row.name !== null) warnings.push(`${where} has a name that is not text; ignoring the name`);
    if (typeof row.price === 'number' && Number.isFinite(row.price) && row.price >= 0) kept.price = row.price;
    else if (row.price !== undefined && row.price !== null && row.price !== '') {
      warnings.push(`${where} has a price that is no number of 0 or more; ignoring the price`);
    }
    meters.push(kept);
  });
  return meters;
}

/** The admin's field allows 8 characters; the currency goes into every cost name and unit (review m4). */
const CURRENCY_CHARS = 8;

/** The currency, trimmed, EUR when there is none, at most CURRENCY_CHARS characters (not UTF-16 units). */
function currency(raw: Partial<AdapterOptions>, warnings: string[]): string {
  const value = (text(raw, 'currency', warnings) ?? DEFAULTS.currency).trim() || DEFAULTS.currency;
  const chars = Array.from(value);
  if (chars.length <= CURRENCY_CHARS) return value;
  warnings.push(`currency has more than ${CURRENCY_CHARS} characters; using its first ${CURRENCY_CHARS}`);
  return chars.slice(0, CURRENCY_CHARS).join('');
}

/** The admin's instance select, or a hand edit: anything but an instance id is none, never a guess. */
function historyInstance(value: unknown, warnings: string[]): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string' && INSTANCE_ID_RE.test(value.trim())) return value.trim();
  warnings.push("historyInstance names no instance like history.0; using the system's default history instance");
  return '';
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
    manualEntities: manualEntities(raw.manualEntities, warnings),
    // Only this picker's Refresh arms: not a hand edit's "2", nor 4cbb6d3's true.
    pickerArmed: (raw.pickerArmed as unknown) === PICKER_VERSION,
    historyInstance: historyInstance(raw.historyInstance, warnings),
    energyMeters: energyMeters(raw.energyMeters, warnings),
    currency: currency(raw, warnings),
  };

  return { options, errors, warnings };
}
