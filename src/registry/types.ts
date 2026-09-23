export type Domain =
  | 'sensor'
  | 'binary_sensor'
  | 'switch'
  | 'light'
  | 'scene'
  | 'climate'
  | 'cover'
  | 'media_player'
  | 'weather'
  | 'number'
  | 'select'
  | 'datetime';

export const DOMAINS: readonly Domain[] = [
  'sensor',
  'binary_sensor',
  'switch',
  'light',
  'scene',
  'climate',
  'cover',
  'media_player',
  'weather',
  'number',
  'select',
  'datetime',
];

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
  /** common.step: the interval a numeric value is set in (Task 13's number). */
  step?: number;
  states?: Record<string, string>;
  write?: boolean;
}

/**
 * The subset of a channel's metadata an encoder needs to reverse a decoded
 * display label back into the raw value a write actually needs -- see
 * synth/common.ts's encodeChannelValue, the exact inverse of readEnum/
 * toBoolState. `write` is the object's own write flag: the dispatcher never
 * writes a channel whose flag is exactly false (Ruling 38). `current` is the
 * channel's newest usable raw value, so re-selecting the current value writes
 * exactly that value (Ruling 41). `min`/`max` are the declared bounds a
 * percentage is scaled over (Ruling 49), and `unit` tells a colour temperature
 * in mireds from one in kelvin (Ruling 59). `step` is the declared interval a
 * number is set in (Task 13).
 */
export type ChannelCodec = Pick<ChannelInput, 'type' | 'states' | 'write' | 'min' | 'max' | 'step' | 'unit'> & {
  current?: unknown;
};

/** A device as classified by the detector plus the admin's overrides, or declared by hand (Task 13b). */
export interface DeviceInput {
  /**
   * The key its entity id is persisted under: a detected control's root, or
   * the state anchoring a root's further control (discoverDevices); for a
   * manual entity, `manual:<state id>` (registry/manual.ts).
   */
  objectId: string;
  name: string;
  /** Raw @iobroker/type-detector type name, or 'manual', kept for diagnostics and the admin table. */
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
  /**
   * Per-role write availability, keyed by a short role name (e.g. "setpoint",
   * "hvac_mode"). Optional: only domains where writability can differ role by
   * role need it (light/switch have exactly one writable thing, discoverable
   * from `source` alone). A role absent here has nowhere to write, and a
   * command dispatcher must refuse it rather than writing nothing and still
   * reporting success.
   */
  writable?: Record<string, boolean>;
  /**
   * Per-channel ChannelCodec (type, states, write flag, bounds, unit, current
   * raw value), keyed by the same channel names as
   * `source` (NOT by role, unlike `writable`). Lets a command dispatcher
   * reverse a decoded display label back into the raw value a write needs
   * (synth/common.ts's encodeChannelValue) instead of writing the label
   * string verbatim -- e.g. "heat" into a MODE state that expects 1.
   * Optional and additive, like `writable`: no existing synth has to
   * populate it, and a channel without an entry here falls back to writing
   * the label unchanged, exactly as every climate command did before this
   * field existed.
   */
  channelMeta?: Record<string, ChannelCodec>;
}

export const STATE_UNAVAILABLE = 'unavailable';
export const STATE_UNKNOWN = 'unknown';
export const STATE_ON = 'on';
export const STATE_OFF = 'off';
