import type { ChannelInput, DeviceInput, Domain } from './types';

export interface DetectedChannel {
  /**
   * Absent on every pattern state the detector did NOT match to an object:
   * it returns the whole pattern, matched or not (Ruling 34).
   */
  id?: string;
  /** Upper-case detector channel token, e.g. SET, ACTUAL, ON_SET, DIMMER, RED. */
  name: string;
  write?: boolean;
  defaultRole?: string;
  /** The pattern's own flags: the states that make a detection its type at all. */
  required?: boolean;
  requiredOneOf?: string;
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
 * `common.states` (with its state's `common.type`) is untrusted ioBroker
 * object configuration, not a value this adapter's own code ever produces.
 * ioBroker documents three forms of it (@iobroker/types objects.d.ts), and
 * all three are normalised here into the one `{ "internal value": "label" }`
 * map that ChannelInput.states, readEnum and encodeChannelValue work on
 * (fix-round 4, Ruling 30):
 *
 * - an object: already that map.
 * - an array, read the way ioBroker's own UI reads it (adapter-react-v5's
 *   Utils.getStates), because its meaning depends on `common.type`: on a
 *   number state the INDEX is the internal value, on a string state each
 *   element IS its own internal value (the objects schema: ['Start',
 *   'Flight'] "is the same as {'Start': 'Start', 'Flight': 'Flight'}"), on a
 *   boolean state it is [false label, true label]. Reading a string state's
 *   array by index would reverse "heat" to "1" and write "1" into a string
 *   MODE, so any other type, which defines no reading, drops the array
 *   rather than guessing one.
 * - the deprecated string "val1:text1;val2:text2": split on ";", then each
 *   part on its FIRST ":" only, so a colon inside a label survives. A
 *   JSON-looking string is not that format and is dropped, not split into a
 *   garbage value and label.
 *
 * A malformed entry -- a non-string label, a part with no ":" -- is dropped
 * individually, so one bad label does not cost every good one; nothing valid
 * left means undefined, the same as no states configured. A non-string label
 * must never reach encodeChannelValue, which calls .toLowerCase() on every
 * label (fix-round 3, finding 3: that threw a TypeError only caught several
 * layers away, in panel-session's generic command handler).
 */
export function validStates(value: unknown, type?: unknown): Record<string, string> | undefined {
  let entries: [string, unknown][];
  if (typeof value === 'string') {
    if (value.trim().startsWith('{')) return undefined;
    entries = value.split(';').flatMap((part): [string, string][] => {
      const colon = part.indexOf(':');
      return colon < 0 ? [] : [[part.slice(0, colon).trim(), part.slice(colon + 1).trim()]];
    });
  } else if (Array.isArray(value)) {
    if (type === 'number') entries = Object.entries(value);
    else if (type === 'string') entries = value.map((label): [string, unknown] => [String(label), label]);
    else if (type === 'boolean') entries = [['false', value[0]], ['true', value[1]]];
    else return undefined;
  } else if (value && typeof value === 'object') {
    entries = Object.entries(value);
  } else {
    return undefined;
  }
  const valid = entries.filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return valid.length ? Object.fromEntries(valid) : undefined;
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
  // In type-detector 6.0.1 thermostat requires one of SET, SET_HEATING or
  // SET_COOLING (requiredOneOf 'setpoint', typePatterns.js:1874, :44, :55) and
  // airCondition requires MODE as well (:1750), enforced in
  // ChannelDetector.js:479-500 and :580-611 (docs/contract-iobroker-types.md).
  // The dependency is ^6.0.1 and a later minor could relax that, so this map
  // only decides the domain; src/registry/synth/climate.ts is still the layer
  // that refuses to synthesise an entity with nothing usable behind it.
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
    // No id means no object behind it: not a channel (Ruling 34).
    if (!state.id) continue;
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
    // The object's own common.write first (Ruling 35): the detector skips its
    // write check for an object carrying the pattern's defaultRole, so a
    // match proves nothing. The pattern's write fills in only when silent.
    if (state.write !== undefined || info?.write !== undefined) {
      channel.write = info?.write ?? state.write;
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
      // No _usedIdsOptional: detect() swaps any list it is given for a fresh
      // one (ChannelDetector.js:697-700), so it cannot stop two roots claiming
      // the same states. discoverDevices resolves those repeats instead.
      const controls = detector.detect({
        id: rootId,
        objects,
        _keysOptional: keys,
        _keysOptionalSorted: true,
        ignoreIndicators: ['UNREACH_STICKY'],
        limitTypesToOneOf: [LIGHTING_TYPES],
      });
      return controls ?? [];
    },
  };
}

/** The part of an ioBroker object discovery reads. */
export interface IoBrokerObject {
  type: string;
  common?: unknown;
}

/**
 * The object types that take part in detection. The enums are function enums:
 * the detector finds them in the same object map (roleEnumUtils.js
 * getFunctionEnums), and they are what lets a generic role match a
 * role-or-enum pattern -- a `switch` in a "Licht" enum is a light
 * (ChannelDetector.js:134-139, 145-165).
 */
const DETECTED_OBJECT_TYPES = new Set(['state', 'channel', 'device', 'enum']);

function objectMeta(id: string, obj: IoBrokerObject): ObjectMeta {
  const common = (obj.common ?? {}) as Record<string, unknown>;
  return {
    name: typeof common.name === 'string' ? common.name : id.split('.').pop() ?? id,
    role: typeof common.role === 'string' ? common.role : undefined,
    unit: typeof common.unit === 'string' ? common.unit : undefined,
    type: typeof common.type === 'string' ? common.type : undefined,
    min: typeof common.min === 'number' ? common.min : undefined,
    max: typeof common.max === 'number' ? common.max : undefined,
    states: validStates(common.states, common.type),
    write: typeof common.write === 'boolean' ? common.write : undefined,
    icon: typeof common.icon === 'string' ? common.icon : undefined,
  };
}

/**
 * Discovery minus the adapter I/O: the ioBroker objects main.ts fetched in,
 * one DeviceInput per physical control out. main.ts and the real-detector
 * suite both call this, so the suite tests the production loop rather than a
 * copy of it. Nothing inside `ownNamespace` is detected: the panel objects
 * are not devices to publish back to the panels.
 *
 * Every channel and every device is a root, and a device root detects the
 * controls of its channels over again. The detector cannot prevent that: it
 * discards a caller's used-ids list (ChannelDetector.js:697-700), and
 * detectParent, the one mode that keeps it, widens a channel root to its
 * whole device (:431-434) and fills the list with every candidate a root
 * merely rejected (:315, :328, :618), so a sibling channel's own control is
 * never found. Repeats are therefore resolved here, by the states each detection
 * requires (required/requiredOneOf: what makes it that type at all). A
 * detection whose required states an earlier one already claimed is that
 * control seen again. Channels go first, so each control comes from the
 * channel that holds it, and a device root adds only what no channel holds.
 */
export function discoverDevices(objects: Readonly<Record<string, IoBrokerObject>>, ownNamespace: string): DeviceInput[] {
  const detectable: Record<string, IoBrokerObject> = {};
  const meta: Record<string, ObjectMeta> = {};
  for (const [id, obj] of Object.entries(objects)) {
    if (!DETECTED_OBJECT_TYPES.has(obj.type)) continue;
    detectable[id] = obj;
    meta[id] = objectMeta(id, obj);
  }
  const rootsOf = (type: string): string[] => Object.keys(detectable).filter((id) => detectable[id]?.type === type);

  const detector = createIoBrokerDetector(detectable);
  const claimed = new Set<string>();
  const result: DeviceInput[] = [];
  for (const rootId of [...rootsOf('channel'), ...rootsOf('device')]) {
    if (rootId.startsWith(`${ownNamespace}.`)) continue;
    const controls = detector.detect(rootId);
    let rootKeyed = false;
    for (const control of controls) {
      // Claimed even when unmapped, so nothing less specific can later stand
      // in for it over the same states.
      const required = control.states.flatMap((state) =>
        state.id && (state.required || state.requiredOneOf) ? [state.id] : [],
      );
      const repeat = required.some((id) => claimed.has(id));
      for (const id of required) claimed.add(id);

      const device = mapControlToDevice(rootId, control, meta);
      if (!device) continue;
      // The root id keys the root's first mapped control, as in v0.1, so a
      // persisted entity id never passes to a different control, not even
      // when that first control is a repeat. Further controls are keyed by
      // the first state they require (every mapped type requires one), which
      // no earlier kept control can share.
      if (rootKeyed) device.objectId = required[0] ?? device.objectId;
      rootKeyed = true;
      // `info` is the catch-all: tried last (the final pattern in
      // typePatterns.js) and sorted last (ChannelDetector.js:722-729), it
      // holds only what the root's other detections left (:226, :336-361).
      // Beside any other detection, mapped or not, it would publish that
      // control's leftovers as a sensor in its place.
      if (repeat || (control.type === 'info' && controls.length > 1)) continue;
      result.push(device);
    }
  }
  return result;
}
