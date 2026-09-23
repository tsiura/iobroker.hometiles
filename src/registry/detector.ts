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
  // The same trap: the pattern is keyed 'mediaPlayer', its Types value is
  // 'media' (types.js: Types["media"] = "media").
  media: 'media_player',
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
  // mediaPlayer's, each unique to that pattern: IGNORE is how it sets
  // Chromecast's …paused/…playerState aside; the panel has no shuffle or
  // repeat control (mqtt_handlers.cpp:2020-2122 sends only transport, seek,
  // volume and mute) and shows no track, episode, season or player metadata.
  'IGNORE',
  'SHUFFLE',
  'REPEAT',
  'TRACK',
  'EPISODE',
  'SEASON',
  'PLAYER_NAME',
  'PLAYER_TYPE',
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

  // mediaPlayer sets Chromecast's …paused and …playerState aside by name
  // (its IGNORE, /\.(paused|playerState)$/), yet its STATE can still take one:
  // two media.state objects tie on role and the later id wins, so an
  // isPlaying is replaced by paused -- and paused: true read as "playing".
  // Neither is the play state; without one there is no media player.
  if (upper === 'STATE' && controlType === 'media' && /\.(paused|playerState)$/.test(state.id ?? '')) return null;

  return upper.toLowerCase();
}

function lastSegment(objectId: string): string {
  return objectId.split('.').pop() ?? objectId;
}

/**
 * mediaPlayer declares COVER twice (typePatterns.js): /^media\.cover(\.big)?$/
 * with defaultRole media.cover, then any other /^media\.cover(\..*)$/. With
 * type-detector 6.0.1 the detector decides, not this: it returns one COVER
 * only (ChannelDetector.js:201-204) -- a media.cover or media.cover.big object
 * before any other size, since that pattern is tried first, and between those
 * two whichever id sorts first. The object it drops never reaches this
 * mapping, so nothing here can prefer it. coverRank only acts on a control
 * carrying two COVERs (a later detector without that exception): the object's
 * own role then decides, in the pattern's order, not the order they arrive
 * in -- its defaultRole is the first slot's, whatever its role.
 */
function coverRank(role: string | undefined): number {
  return role === 'media.cover' ? 0 : role === 'media.cover.big' ? 1 : 2;
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
    const existing = channels[name];
    if (existing && name !== 'cover') continue;

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
    if (existing && coverRank(channel.role) >= coverRank(existing.role)) continue;
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

/** Root id -> the state anchoring the control that holds the root id. */
export type RootAnchors = Record<string, string>;

export interface Discovery {
  devices: DeviceInput[];
  /** To be persisted and passed back into the next discovery. */
  anchors: RootAnchors;
  /** Function enums left out: members that are no list make the detector throw. */
  ignored: string[];
  /** Objects left out: a role that is not text makes the detector throw (Ruling 62). */
  badRoles: string[];
}

/** Ancestors before descendants would let an outer root take a nested root's controls. */
function deepestFirst(a: string, b: string): number {
  return b.split('.').length - a.split('.').length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * A root's further control is named after its own state, or the picker shows
 * the root's name twice, once for a reboot button (Ruling 44). hm-rega names
 * a datapoint "<channel>.<datapoint>", so a name that already starts with the
 * root's is not repeated -- only as a whole word, though: "Bad" must not turn
 * "Badezimmer Luftdruck" into "ezimmer Luftdruck".
 */
function controlName(rootName: string, stateName: string | undefined, anchor: string): string {
  let own = stateName ?? '';
  const rest = own.slice(rootName.length);
  if (own.startsWith(rootName) && /^([\s.:_-]|$)/.test(rest)) own = rest.replace(/^[\s.:_-]+/, '');
  return `${rootName} ${own || lastSegment(anchor)}`;
}

/**
 * The detector's own error names no object, so the root it was reading is
 * added: the log has to say where to look (Ruling 56). The objects known to
 * make it throw never reach it (discoverDevices leaves them out); this is for
 * whatever is not known yet.
 */
function detectBelow(detector: DetectorPort, rootId: string): DetectedControl[] {
  try {
    return detector.detect(rootId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`the type-detector failed on the objects below ${rootId}: ${reason}`, { cause: error });
  }
}

/** The states that make a detection its type at all: required and requiredOneOf. */
function requiredStates(control: DetectedControl): string[] {
  return control.states.flatMap((state) => (state.id && (state.required || state.requiredOneOf) ? [state.id] : []));
}

/**
 * Discovery minus the adapter I/O: the ioBroker objects main.ts fetched in,
 * one DeviceInput per physical control out, plus the root anchors to persist
 * for the next run. main.ts and the real-detector suite both call this, so
 * the suite tests the production loop rather than a copy of it. Nothing
 * inside `ownNamespace` is detected: the panel objects are not devices to
 * publish back to the panels.
 *
 * Every channel and every device is a root, and an outer root detects the
 * controls of the roots inside it over again. The detector cannot prevent
 * that: it discards a caller's used-ids list (ChannelDetector.js:697-700),
 * and detectParent, the one mode that keeps it, widens a channel root to its
 * whole device (:431-434) and fills the list with every candidate a root
 * merely rejected (:315, :328, :618), so a sibling channel's own control is
 * never found. Repeats are therefore resolved here, by the states each
 * detection requires (required/requiredOneOf: what makes it that type at
 * all). A detection is that control seen again only when an earlier one
 * already claimed EVERY state it requires; one that needs a state nobody
 * claimed is a composite and is kept (Ruling 46). The catch-all `info`
 * means nothing of its own: the states an earlier detection claimed are
 * taken out of it, and it goes when none of its own is left, or when the
 * root has a control of its own beside it -- not merely another root's
 * control seen again (Ruling 57). Only state objects count: info's ACTUAL
 * matches any object below its root (ChannelDetector.js:35-37, no
 * objectType), and a channel must never become an entity's reading
 * (Ruling 52). The deepest root goes first, so each control comes from the
 * innermost root that holds it, whatever order the objects came in.
 *
 * Identity (Ruling 45): each root id stays with the control that REQUIRES
 * the state recorded for that root -- never one merely listing it as an
 * optional state, nor a catch-all for a state a deeper root took -- however
 * the detector's sort order shifts, and the record itself never moves. A new
 * root's id goes to its first mapped control. Every other control is keyed
 * by the first state it requires that nobody claimed before it.
 *
 * An object known to make the detector throw is left out and reported, not
 * allowed to stop every discovery (Rulings 58 D, 60(2)).
 */
export function discoverDevices(
  objects: Readonly<Record<string, IoBrokerObject>>,
  ownNamespace: string,
  anchors: Readonly<RootAnchors> = {},
): Discovery {
  const detectable: Record<string, IoBrokerObject> = {};
  const meta: Record<string, ObjectMeta> = {};
  const ignored: string[] = [];
  const badRoles: string[] = [];
  for (const [id, obj] of Object.entries(objects)) {
    if (!DETECTED_OBJECT_TYPES.has(obj.type)) continue;
    const common = obj.common as { members?: unknown; role?: unknown } | null | undefined;
    if (obj.type === 'enum') {
      // The detector calls members.includes on every function enum for each
      // state it tests (ChannelDetector.js:150): one enum whose members are
      // no list failed every root. Without it only enum-based detection
      // suffers (Ruling 58 D). No members at all is valid (objects.d.ts:323),
      // and the detector passes over it (roleEnumUtils.js getFunctionEnums).
      if (common?.members !== undefined && !Array.isArray(common.members)) {
        ignored.push(id);
        continue;
      }
    } else if (common?.role && typeof common.role !== 'string') {
      // Such a role fails every root above the object (ChannelDetector.js:90),
      // so one hand-edited object stopped all discovery: only it is left out
      // (Ruling 60(2)). An empty, false or null role never reaches that call.
      badRoles.push(id);
      continue;
    }
    detectable[id] = obj;
    meta[id] = objectMeta(id, obj);
  }
  const roots = Object.keys(detectable)
    .filter((id) => detectable[id]?.type === 'channel' || detectable[id]?.type === 'device')
    .sort(deepestFirst);

  const detector = createIoBrokerDetector(detectable);
  const claimed = new Set<string>();
  const devices: DeviceInput[] = [];
  const nextAnchors: RootAnchors = {};
  for (const rootId of roots) {
    if (rootId.startsWith(`${ownNamespace}.`)) continue;
    // Only state objects count (Ruling 52), and the catch-all keeps only what
    // no deeper root claimed: the kitchen's own note, not the CO2 reading its
    // sub-channel holds (Ruling 57). Both before anything below reads a
    // detection -- the root id included, which must not stay with a catch-all
    // for a state a new sub-channel took from it.
    const controls = detectBelow(detector, rootId).map((control) => ({
      ...control,
      states: control.states.filter(
        (state) =>
          !state.id || (detectable[state.id]?.type === 'state' && !(control.type === 'info' && claimed.has(state.id))),
      ),
    }));
    // A control of the root's own requires a state no deeper root claimed;
    // any other detection is a deeper root's control seen again.
    const typed = controls.some((c) => c.type !== 'info' && requiredStates(c).some((id) => !claimed.has(id)));
    const recorded = anchors[rootId];
    let holder = recorded === undefined ? undefined : controls.find((c) => requiredStates(c).includes(recorded));
    // Kept as recorded: if its control is gone the id goes to nobody.
    if (recorded !== undefined) nextAnchors[rootId] = recorded;
    for (const control of controls) {
      // Claimed even when unmapped, so nothing less specific can later stand
      // in for it over the same states.
      const required = requiredStates(control);
      // The first required state nobody claimed before: none means every one
      // was, and this is a repeat (Ruling 46).
      const own = required.find((id) => !claimed.has(id));
      for (const id of required) claimed.add(id);
      const anchor = own ?? required[0];

      const device = mapControlToDevice(rootId, control, meta);
      if (device && !holder && recorded === undefined) holder = control;
      if (control === holder) {
        if (recorded === undefined && anchor) nextAnchors[rootId] = anchor;
      } else if (device && anchor) {
        device.objectId = anchor;
        device.name = controlName(device.name, meta[anchor]?.name, anchor);
      }
      // `info` is the catch-all: tried last (the final pattern in
      // typePatterns.js) and sorted last (ChannelDetector.js:722-729), it
      // holds only what the root's other detections left (:226, :336-361).
      // Beside a control of the root's own, mapped or not, it would publish
      // that control's leftovers as a sensor in its place. Beside a deeper
      // root's control seen again, what it holds is the root's own values.
      if (!device || !own || (control.type === 'info' && typed)) continue;
      devices.push(device);
    }
  }
  return { devices, anchors: nextAnchors, ignored, badRoles };
}
