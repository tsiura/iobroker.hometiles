import type { ChannelInput, DeviceInput, Domain } from './types';

export interface DetectedChannel {
  id: string;
  /** Upper-case detector channel token, e.g. SET, ACTUAL, ON_SET, DIMMER, RED. */
  name: string;
  write?: boolean;
  defaultRole?: string;
}

export interface DetectedControl {
  type: string;
  states: DetectedChannel[];
}

export interface DetectorPort {
  detect(rootId: string): DetectedControl[];
}

export interface ObjectMeta {
  name: string;
  role?: string;
  unit?: string;
  type?: string;
  min?: number;
  max?: number;
  states?: Record<string, string>;
  write?: boolean;
  icon?: string;
}

/**
 * Detector types v0.1 understands. A type that is absent here is skipped
 * entirely rather than guessed at, so an unsupported device never turns into a
 * half-working tile.
 */
export const DETECTOR_TYPE_TO_DOMAIN: Record<string, Domain> = {
  // Names are members of the Types string enum in @iobroker/type-detector 6.x.
  socket: 'switch',
  light: 'light',
  dimmer: 'light',
  rgb: 'light',
  rgbSingle: 'light',
  rgbwSingle: 'light',
  hue: 'light',
  ct: 'light',
  cie: 'light',
  temperature: 'sensor',
  humidity: 'sensor',
  illuminance: 'sensor',
  pressure: 'sensor',
  weatherCurrent: 'sensor',
  info: 'sensor',
  window: 'binary_sensor',
  windowTilt: 'binary_sensor',
  door: 'binary_sensor',
  contact: 'binary_sensor',
  motion: 'binary_sensor',
  fireAlarm: 'binary_sensor',
  floodAlarm: 'binary_sensor',
  coAlarm: 'binary_sensor',
  warning: 'binary_sensor',
  button: 'scene',
  buttonSensor: 'scene',
};

/**
 * A lamp can satisfy several lighting patterns at once. Without this the same
 * device is detected as light and dimmer and rgb, producing three tiles for one
 * bulb. The detector resolves the group to a single best match.
 */
const LIGHTING_TYPES = ['light', 'dimmer', 'ct', 'hue', 'cie', 'rgb', 'rgbSingle', 'rgbwSingle'];

/** Channels that carry diagnostics rather than anything a tile renders. */
const IGNORED_CHANNELS = new Set([
  'UNREACH',
  'LOWBAT',
  'MAINTAIN',
  'ERROR',
  'WORKING',
  'DIRECTION',
  'CONNECTED',
]);

/**
 * A dimmer's own SET is the level, and its power channel arrives as ON_SET or
 * ON_ACTUAL. Renaming here means every downstream module can rely on one set of
 * channel names regardless of the detector type.
 */
function channelName(controlType: string, detectorName: string): string | null {
  const upper = detectorName.toUpperCase();
  if (IGNORED_CHANNELS.has(upper)) return null;

  // The writable POWER channel, which every downstream module knows as `set`.
  // The detector spells it three different ways depending on the pattern, and
  // all three must land here. Verified against
  // node_modules/@iobroker/type-detector/build/typePatterns.js:
  //   light                              -> SET(w)
  //   dimmer                             -> ON_SET(w)
  //   hue, ct, cie, rgb, rgbSingle,
  //   rgbwSingle                         -> ON(w)
  // Missing the bare ON leaves those six types with no `set` channel at all.
  // The dispatcher then plans a write to `set`, finds nothing in the entity's
  // source map, writes nothing, and still reports success — so pressing a
  // colour bulb does nothing and no error is raised anywhere.
  if (upper === 'ON_SET' || upper === 'ON') return 'set';
  if (upper === 'ON_ACTUAL') return 'actual';

  // A dimmer's own SET is the brightness LEVEL, not power. Only `dimmer` has
  // this shape; hue/ct/cie/rgb* carry their level on DIMMER and have no SET.
  if (controlType === 'dimmer') {
    if (upper === 'SET') return 'dimmer';
    if (upper === 'ACTUAL') return 'dimmer_actual';
  }

  return upper.toLowerCase();
}

function lastSegment(objectId: string): string {
  return objectId.split('.').pop() ?? objectId;
}

export function mapControlToDevice(
  rootId: string,
  control: DetectedControl,
  meta: Readonly<Record<string, ObjectMeta>>,
): DeviceInput | null {
  const domain = DETECTOR_TYPE_TO_DOMAIN[control.type];
  if (!domain) return null;

  const channels: Record<string, ChannelInput> = {};
  for (const state of control.states) {
    const name = channelName(control.type, state.name);
    if (!name) continue;
    if (channels[name]) continue;

    const info = meta[state.id];
    const channel: ChannelInput = { objectId: state.id };
    if (info?.role ?? state.defaultRole) channel.role = info?.role ?? state.defaultRole;
    if (info?.unit) channel.unit = info.unit;
    if (info?.type) channel.type = info.type as ChannelInput['type'];
    if (info?.min !== undefined) channel.min = info.min;
    if (info?.max !== undefined) channel.max = info.max;
    if (info?.states) channel.states = info.states;
    if (state.write !== undefined || info?.write !== undefined) {
      channel.write = state.write ?? info?.write;
    }
    channels[name] = channel;
  }

  if (!Object.keys(channels).length) return null;

  const primaryId = channels.set?.objectId ?? channels.actual?.objectId ?? channels.dimmer?.objectId;
  const rootMeta = meta[rootId];
  const primaryMeta = primaryId ? meta[primaryId] : undefined;
  const name = (rootMeta?.name ?? primaryMeta?.name ?? '').trim() || lastSegment(rootId);

  const device: DeviceInput = { objectId: rootId, name, detectorType: control.type, domain, channels };
  const icon = rootMeta?.icon ?? primaryMeta?.icon;
  if (icon) device.icon = icon;
  return device;
}

/**
 * Thin wrapper around @iobroker/type-detector. Kept deliberately small: all
 * behaviour lives in mapControlToDevice, which needs no library and no adapter.
 */
interface DetectRequest {
  id: string;
  objects: Record<string, unknown>;
  _keysOptional?: string[];
  _keysOptionalSorted?: boolean;
  _usedIdsOptional?: string[];
  ignoreIndicators?: string[];
  limitTypesToOneOf?: string[][];
}

type DetectorCtor = new () => { detect(options: DetectRequest): DetectedControl[] | null };

export function createIoBrokerDetector(objects: Record<string, unknown>): DetectorPort {
  // Required lazily so the pure mapping stays usable in tests without the dep.
  //
  // In 6.x ChannelDetector is the DEFAULT export, not a named one: destructuring
  // `{ ChannelDetector }` yields undefined and throws at `new`. Verified against
  // the installed 6.0.1, whose module keys are roleOrEnum*, Types, StateType and
  // default. The named fallback keeps this working if a version re-adds it.
  const detectorModule = require('@iobroker/type-detector') as {
    default?: DetectorCtor;
    ChannelDetector?: DetectorCtor;
  };
  const ChannelDetector = detectorModule.default ?? detectorModule.ChannelDetector;
  if (typeof ChannelDetector !== 'function') {
    throw new Error('@iobroker/type-detector: ChannelDetector constructor not found');
  }

  const detector = new ChannelDetector();
  const keys = Object.keys(objects).sort();

  return {
    detect(rootId: string): DetectedControl[] {
      const usedIds: string[] = [];
      const controls = detector.detect({
        id: rootId,
        objects,
        _keysOptional: keys,
        _keysOptionalSorted: true,
        _usedIdsOptional: usedIds,
        ignoreIndicators: ['UNREACH_STICKY'],
        limitTypesToOneOf: [LIGHTING_TYPES],
      });
      return controls ?? [];
    },
  };
}
