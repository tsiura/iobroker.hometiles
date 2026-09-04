export type Domain = 'sensor' | 'binary_sensor' | 'switch' | 'light' | 'scene';

export const DOMAINS: readonly Domain[] = ['sensor', 'binary_sensor', 'switch', 'light', 'scene'];

/** The subset of an ioBroker state this adapter cares about. */
export interface SourceValue {
  val: unknown;
  ack: boolean;
  /** ioBroker quality. Anything other than 0 means the value is not trustworthy. */
  q?: number;
  ts: number;
}

/** One ioBroker state backing a logical channel of a detected device. */
export interface ChannelInput {
  objectId: string;
  role?: string;
  unit?: string;
  type?: 'boolean' | 'number' | 'string' | 'mixed';
  min?: number;
  max?: number;
  states?: Record<string, string>;
  write?: boolean;
}

/** A device as classified by the detector plus the admin's overrides. */
export interface DeviceInput {
  objectId: string;
  name: string;
  /** Raw @iobroker/type-detector type name, kept for diagnostics and the admin table. */
  detectorType: string;
  domain: Domain;
  /**
   * Logical channel name to ioBroker state. Channel names are the detector's
   * state names lowercased, e.g. SET -> set, ACTUAL -> actual, DIMMER -> dimmer.
   */
  channels: Record<string, ChannelInput>;
  icon?: string;
}

export interface VirtualEntity {
  entityId: string;
  domain: Domain;
  /** Logical channel name to ioBroker state id. */
  source: Record<string, string>;
  /** Home Assistant state string. Never null, never undefined. */
  state: string;
  attributes: Record<string, unknown>;
  available: boolean;
  /** Epoch milliseconds of the last state change. */
  lastChanged: number;
}

export const STATE_UNAVAILABLE = 'unavailable';
export const STATE_UNKNOWN = 'unknown';
export const STATE_ON = 'on';
export const STATE_OFF = 'off';
