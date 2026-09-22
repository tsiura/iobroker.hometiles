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
  // buttonSensor is deliberately NOT mapped: its detector pattern is
  // PRESS(r) PRESS_LONG(r) (see typePatterns.js) — both read-only, so it can
  // never produce a writable `set` channel. Mapping it to scene would create
  // a tile whose press resolves to zero writes; the dispatcher now rejects
  // that outright rather than reporting success, but the tile should not
  // exist in the first place. `button`, which has SET(w), stays.
  button: 'scene',
  // thermostat has NO required channel at all, and airCondition requires only
  // MODE (docs/contract-iobroker-types.md) — a detected climate device may
  // therefore expose nothing this adapter can read or write. This map only
  // decides the domain; src/registry/synth/climate.ts is the layer that
  // refuses to synthesise an entity with nothing usable behind it.
  thermostat: 'climate',
  airCondition: 'climate',
  // The trap (docs/contract-iobroker-types.md): the pattern object is keyed
  // 'blinds', but its Types VALUE -- what DetectedControl.type actually
  // carries at runtime -- is 'blind' (verified directly against
  // node_modules/@iobroker/type-detector/build/types.js: Types["blind"] =
  // "blind"; there is no Types["blinds"] at all). Keying this map on
  // 'blinds' would leave every real blind unmapped: mapControlToDevice sees
  // `domain` come back undefined and returns null, silently, with no error.
  // blindButtons and gate already agree with their own pattern keys.
  blind: 'cover',
  blindButtons: 'cover',
  gate: 'cover',
};

/**
 * A lamp can satisfy several lighting patterns at once. Without this the same
 * device is detected as light and dimmer and rgb, producing three tiles for one
 * bulb. The detector resolves the group to a single best match.
 */
const LIGHTING_TYPES = ['light', 'dimmer', 'ct', 'hue', 'cie', 'rgb', 'rgbSingle', 'rgbwSingle'];

/**
 * Channels no v0.1 tile renders. Dropping them is not cosmetic: every channel
 * that survives becomes a foreign-state subscription and an entity recompute
 * on each change. A power-metering bulb reports ELECTRIC_POWER every few
 * seconds, so keeping it would wake the registry constantly to recompute an
 * entity whose rendered state cannot have changed.
 *
 * Two groups:
 *  - diagnostics and telemetry the panel never shows
 *  - writable capabilities v0.1 exposes no control for
 * Add a name back here the day a tile actually renders it.
 */
const IGNORED_CHANNELS = new Set([
  // diagnostics
  'UNREACH',
  'LOWBAT',
  'MAINTAIN',
  'ERROR',
  'WORKING',
  'DIRECTION',
  // blind/blindButtons/gate's alternate-role sibling of DIRECTION (verified
  // against typePatterns.js: SharedPatterns.direction_enum, always listed
  // alongside SharedPatterns.direction). Neither has an HA Cover attribute
  // behind it; keeping it would only add a foreign-state subscription and a
  // recompute on every direction change.
  'DIRECTION_ENUM',
  'CONNECTED',
  'RSSI',
  'BATTERY',
  // energy telemetry, and the noisiest of the lot
  'ELECTRIC_POWER',
  'CURRENT',
  'VOLTAGE',
  'CONSUMPTION',
  'FREQUENCY',
  // writable, but no v0.1 control drives them
  'EFFECT',
  'TRANSITION_TIME',
  'ON_TIME',
  // thermostat's notable-optional channels (docs/contract-iobroker-types.md):
  // none of the three is in synthClimate's mapped-role table, and VALVE in
  // particular is a live analog percentage on a real device — exactly the
  // ELECTRIC_POWER-style churn this set exists to stop. Each name is unique
  // to the thermostat pattern (verified against typePatterns.js), so this
  // cannot shadow an unrelated channel on another device type.
  'VALVE',
  'WINDOW',
  'PARTY',
]);

/**
 * A dimmer's own SET is the level, and its power channel arrives as ON_SET or
 * ON_ACTUAL. Renaming here means every downstream module can rely on one set of
 * channel names regardless of the detector type.
 */
function channelName(controlType: string, state: DetectedChannel): string | null {
  const upper = state.name.toUpperCase();
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

  // airCondition's states array carries two distinct state definitions both
  // named SWING (verified against node_modules/@iobroker/type-detector/build/
  // typePatterns.js: FanPatterns.swing and FanPatterns.swingBoolean). Both
  // match the same role-matching regex (/swing$/), so `defaultRole` — the
  // pattern's own semantic tag, copied onto every detected state — is the
  // only field that tells them apart: 'level.mode.swing' is the numeric
  // multi-position control, 'switch.mode.swing' is a plain on/off toggle.
  // Keying on name alone, like every other channel here, would let the
  // second SWING silently overwrite the first in the map below.
  if (upper === 'SWING') {
    return state.defaultRole === 'switch.mode.swing' ? 'swing_toggle' : 'swing';
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
    const name = channelName(control.type, state);
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
