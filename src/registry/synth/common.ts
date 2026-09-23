import type { ChannelCodec, ChannelInput, DeviceInput, SourceValue } from '../types';
import { STATE_OFF, STATE_ON, STATE_UNAVAILABLE, STATE_UNKNOWN } from '../types';

export type Values = Readonly<Record<string, SourceValue | null | undefined>>;

export interface ChannelRead {
  channel: ChannelInput;
  value: SourceValue | null;
}

/**
 * Reads one logical channel. Returns null when the channel is not configured at
 * all, which is a different condition from a configured channel with no value.
 */
export function readChannel(device: DeviceInput, name: string, values: Values): ChannelRead | null {
  const channel = device.channels[name];
  if (!channel) return null;
  return { channel, value: values[channel.objectId] ?? null };
}

/** A value is usable only when it exists, is non-null and its quality is good. */
export function isUsable(value: SourceValue | null | undefined): value is SourceValue {
  if (!value) return false;
  if (value.val === null || value.val === undefined) return false;
  return !value.q;
}

export function toBoolState(raw: unknown): string {
  if (typeof raw === 'boolean') return raw ? STATE_ON : STATE_OFF;
  if (typeof raw === 'number') return raw !== 0 ? STATE_ON : STATE_OFF;
  if (typeof raw === 'string') {
    const text = raw.trim().toLowerCase();
    if (['true', 'on', '1', 'open', 'yes'].includes(text)) return STATE_ON;
    if (['false', 'off', '0', 'closed', 'no'].includes(text)) return STATE_OFF;
    return STATE_UNKNOWN;
  }
  return STATE_UNKNOWN;
}

export function numberToState(raw: unknown): string {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? String(raw) : STATE_UNKNOWN;
  }
  // Number('') and Number('   ') are both 0. Coercing here would turn a present
  // but empty value into a confident "0" on a wall panel, which is exactly the
  // swallowed zero this module exists to prevent. Blank is unknown, not zero.
  const text = String(raw).trim();
  if (!text) return STATE_UNKNOWN;
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return STATE_UNKNOWN;
  return String(numeric);
}

/**
 * A numeric channel's reading. Number('') and Number('  ') are both 0 and
 * finite, so a blank reading resolves to undefined ("unknown"), never a
 * confident zero. String(true)/String(false) are "true"/"false", and Number of
 * either is NaN, so a boolean channel's value is refused too -- load-bearing
 * for cover's toggle-kind SET (synth/cover.ts's setChannelKind).
 */
export function readNumber(device: DeviceInput, name: string, values: Values): number | undefined {
  const read = readChannel(device, name, values);
  if (!read || !isUsable(read.value)) return undefined;
  const raw = read.value.val;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : undefined;
}

/** Reads a boolean-shaped channel as a real tri-state -- never a guessed default. */
export function readBool(device: DeviceInput, name: string, values: Values): boolean | undefined {
  const read = readChannel(device, name, values);
  if (!read || !isUsable(read.value)) return undefined;
  const state = toBoolState(read.value.val);
  if (state === STATE_ON) return true;
  if (state === STATE_OFF) return false;
  return undefined;
}

/**
 * A channel's reading as the panel's percentage, in that channel's OWN
 * declared range (Ruling 49): raw 200 of a 0..255 blind is 78%, never 200,
 * which the firmware would clamp to fully open. None for a channel whose
 * bounds cannot be scaled (Ruling 55).
 *
 * The nearest WHOLE percent (Task 7 round 2, N1): the cover firmware's
 * read_int truncates a fraction (item.as<int>(), cover/renderer.cpp:57), so a
 * write of 75% landing as raw 191 of 255 (74.9%) came back as 74 -- the 75%
 * preset never highlighted -- and on most ranges positions drifted down by
 * one. Clamped to 0..100 (Ruling 59.4): a 1..100 blind reporting raw 0 is -1%
 * of its range, which published position -1 -- "open" -- for a cover the
 * panel draws shut.
 */
export function readPercent(device: DeviceInput, name: string, values: Values): number | undefined {
  const raw = readNumber(device, name, values);
  const percent = raw === undefined ? undefined : toPercent(raw, device.channels[name]);
  // Math.max also turns the -0 of a reading just below min into a plain 0.
  return percent === undefined ? undefined : Math.min(100, Math.max(0, Math.round(percent)));
}

export function baseEntity(
  device: DeviceInput,
  entityId: string,
  values: Values,
): {
  source: Record<string, string>;
  channelMeta: Record<string, ChannelCodec>;
  lastChanged: number;
  friendly: Record<string, unknown>;
} {
  const source: Record<string, string> = {};
  const channelMeta: Record<string, ChannelCodec> = {};
  let lastChanged = 0;
  for (const [name, channel] of Object.entries(device.channels)) {
    source[name] = channel.objectId;
    const value = values[channel.objectId];
    // write: Ruling 38, for every domain. current: Ruling 41; a value the
    // decoders would not use (isUsable) is no current value either. min/max:
    // the declared range commands are scaled into and checked against
    // (Ruling 49). step: the interval a number is set in (Task 13). unit:
    // what a colour temperature is stored in (Ruling 59).
    channelMeta[name] = {
      type: channel.type,
      states: channel.states,
      write: channel.write,
      current: isUsable(value) ? value.val : undefined,
      min: channel.min,
      max: channel.max,
      step: channel.step,
      unit: channel.unit,
    };
    if (value && value.ts > lastChanged) lastChanged = value.ts;
  }
  const friendly: Record<string, unknown> = { friendly_name: device.name || entityId };
  if (device.icon) friendly.icon = device.icon;
  // 0 means "never observed" and is deliberately NOT replaced with Date.now():
  // that would re-evaluate on every synthesis, so an entity whose source has
  // never produced a value would look freshly changed on every pass. Consumers
  // must treat 0 as unknown — see buildApplyPayload, which omits last_changed
  // rather than publishing a fabricated timestamp.
  return { source, channelMeta, lastChanged, friendly };
}

/**
 * The type a label role's channel is encoded as when the registry captured
 * none: type-detector declares SPEED, SPEED_LEVEL and the numeric SWING as
 * Number and the swing toggle as Boolean, with no alternative (typePatterns.js
 * FanPatterns, Ruling 24(a)). MODE is Number-or-String per device, so
 * hvac_mode and preset_mode have none. The dispatcher encodes with this and
 * synthClimate advertises with it, so the two cannot disagree (Ruling 36).
 */
const ROLE_FALLBACK_TYPE: Readonly<Record<string, ChannelCodec['type']>> = {
  fan_mode: 'number',
  swing_mode: 'number',
  swing_horizontal_mode: 'boolean',
};

export function roleCodec(role: string, codec: ChannelCodec | undefined): ChannelCodec | undefined {
  const fallback = ROLE_FALLBACK_TYPE[role];
  return codec?.type === undefined && fallback ? { ...codec, type: fallback } : codec;
}

/**
 * Ruling 33 (supersedes Ruling 24(a)'s passthrough): a label means something
 * to a channel only if it is number- or boolean-typed or has a non-empty
 * states map. Anything else would write back verbatim whatever the panel
 * sent, and when a modes list is empty the firmware still offers the CURRENT
 * value, lowercased, as a lone option (climate_popup.cpp:458-460): "auto" for
 * "AUTO", the string "1" for 1, "on" for "true" -- each with ok:true.
 */
export function acceptsLabels(codec: ChannelCodec | undefined): boolean {
  return codec?.type === 'number' || codec?.type === 'boolean' || Object.keys(codec?.states ?? {}).length > 0;
}

/**
 * Reads a channel that carries a named state (MODE, WORKING_MODE, SPEED, the
 * numeric SWING, a select's value): decodes through the channel's own ioBroker
 * `states` map when the admin configured one, otherwise falls back to the raw
 * value. type-detector declares these channels as Number-or-String, so a blank
 * string must resolve to undefined rather than an empty label — the same rule
 * readNumber applies to the purely numeric channels. It sits here beside its
 * inverse, encodeChannelValue (Task 13; select reads and writes through both).
 *
 * The map's own keys only (Task 13 M3): plain indexing found "constructor",
 * "toString" and "__proto__" in every map, and a function or an object is no
 * label any payload can carry.
 */
export function readEnum(device: DeviceInput, name: string, values: Values): string | undefined {
  const read = readChannel(device, name, values);
  if (!read || !isUsable(read.value)) return undefined;
  const raw = read.value.val;
  const states = read.channel.states;
  const key = String(raw);
  const label = states && Object.hasOwn(states, key) ? states[key] : undefined;
  if (label !== undefined) return label;
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text ? text : undefined;
  }
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : undefined;
  return undefined;
}

/**
 * The exact inverse of readEnum and toBoolState (both above):
 * those decode a raw ioBroker value into an HA-style display label; this
 * turns a label back into the raw value a write actually needs. Writing a
 * decoded label back to ioBroker verbatim -- e.g. the string "heat" into a
 * MODE state that expects the number 1 -- is this project's defining bug
 * class: success reported for a write that lands on nothing, or on the wrong
 * thing. A label this function cannot faithfully re-encode returns
 * `undefined`, never a guessed value.
 *
 * The states-map reversal is case-insensitive (trimmed too):
 * docs/contract-climate-cover.md confirms the firmware trims+lowercases
 * hvac_mode/fan_mode/swing_mode on its own ingest, so a label built from a
 * states map in any other case (e.g. @iobroker/type-detector's own
 * upper-case defaultStates, "HIGH") comes back from a real panel already
 * lower-cased. An exact-case-only reversal would refuse the type-detector's
 * own default labels on every real round trip.
 *
 * Ruling 41: re-selecting the current value writes the current value.
 * `currentLabel` is the role's current DECODED value -- what the panel shows,
 * and what its lone fallback option sends back -- and `codec.current` the raw
 * value it came from. When the label is that decoded value and the map did
 * not produce it (the raw value lies outside the map, or its decoder never
 * read the map: synthClimate reads SPEED_LEVEL with readNumber), the raw
 * value itself is written, coerced to the channel type, before any map
 * reversal. Everything else must reverse through the map to exactly one key.
 */
export function encodeChannelValue(
  codec: ChannelCodec | undefined,
  label: string,
  currentLabel?: unknown,
): number | boolean | string | undefined {
  // Boolean is checked FIRST and never consults a states map at all, because
  // the decoder it must invert -- toBoolState -- never reads one either: it
  // always emits exactly STATE_ON/STATE_OFF regardless of what states the
  // channel carries (fix-round 3, IMPORTANT B). Applying the states-map
  // reversal before this check made every boolean channel with ANY states
  // map -- even the literal {"true":"on","false":"off"} -- refuse both "on"
  // and "off", a real regression from the plain `true`/`false` write that
  // worked before fix-round 2. The general rule this restores: the encoder
  // consults a states map only where the decoder does.
  if (codec?.type === 'boolean') {
    if (label === STATE_ON) return true;
    if (label === STATE_OFF) return false;
    // toBoolState only ever EMITS 'on' or 'off' for a genuine boolean
    // channel ('unknown' means nothing boolean was recoverable at all), so
    // those are the only two labels with a faithful raw value to
    // reconstruct -- accepting more (e.g. toBoolState's lenient INPUT
    // vocabulary like "1"/"yes") would accept values decode never emits.
    return undefined;
  }

  if (!acceptsLabels(codec)) return undefined;

  const wanted = label.trim().toLowerCase();
  const current = codec?.current;
  if (
    current !== undefined &&
    typeof currentLabel === 'string' &&
    currentLabel.trim().toLowerCase() === wanted &&
    codec?.states?.[String(current)] !== currentLabel
  ) {
    // Before the reversal, which would resolve {B1:'Boost'} at "BOOST" to
    // the OTHER entry's key B1, and {3:'5'} at 5 to 3.
    return coerce(codec?.type, current);
  }

  // With no map (an empty one behaves as none, matching readEnum: `{}` never
  // matches any key -- fix-round 3, fold-in 1) no list is published, so the
  // panel's only option is the current value, taken above. Any other label
  // came from another MQTT client -- fan_mode "100000" into a SPEED_LEVEL
  // declared 0..100, hvac_mode "42" into an unmapped MODE -- and is refused
  // (Task 8 round 1, M1a).
  const entries = codec?.states ? Object.entries(codec.states) : [];
  if (entries.length === 0) return undefined;

  // Collect EVERY key whose label matches, not just the first, and refuse
  // unless exactly one does (fix-round 3, IMPORTANT A). `.find` returning
  // the first case-insensitive match let {"1":"High","2":"HIGH"} silently
  // resolve "high" to 1 even when the device's current raw value was 2 --
  // a user re-selecting their OWN current mode would get the wrong one
  // written, with ok:true. Two codes sharing a label are genuinely
  // ambiguous: the panel cannot distinguish them either, so refusing is
  // the only correct answer, the same as an unknown label.
  //
  // Non-string labels are skipped rather than crashing on .toLowerCase()
  // (fix-round 3, fold-in 3) -- main.ts's detectDevices now validates
  // common.states so a real device should never produce one, but a states
  // map built any other way (a test, a future caller) still cannot throw.
  const matches = entries.filter(
    ([, candidate]) => typeof candidate === 'string' && candidate.trim().toLowerCase() === wanted,
  );
  // A label outside the map is refused on every channel type. Ruling 36
  // let a number channel coerce one instead, so the panel's lone fallback
  // option (an out-of-map current value, e.g. "50") was no dead button;
  // Ruling 41 keeps that through the current-value branch above and closes
  // the rest: any MQTT client could write 7 into a SPEED mapped 0..3.
  const [onlyMatch] = matches;
  if (!onlyMatch || matches.length > 1) return undefined;
  // The key the label reversed to is the channel's own value.
  return coerce(codec?.type, onlyMatch[0]);
}

/** A raw value as a channel of this type holds it, or undefined when it cannot be one. */
function coerce(type: ChannelCodec['type'], raw: unknown): number | boolean | string | undefined {
  if (typeof raw !== 'number' && typeof raw !== 'string' && typeof raw !== 'boolean') return undefined;
  if (type === 'number') {
    // Number('') and Number('NaN') are both non-encodable for different
    // reasons ('' is 0 and finite -- the exact trap this project has hit
    // before; 'NaN' parses to a real NaN) -- both must refuse, neither may
    // fall through as 0.
    const text = String(raw).trim();
    if (!text) return undefined;
    const numeric = Number(text);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  // 'mixed' and untyped have no single native type: the value stays as it is.
  return type === 'string' ? String(raw) : raw;
}

type Bounds = Pick<ChannelCodec, 'min' | 'max'> | undefined;

const finite = (value: number | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Ruling 49: the panel speaks percent for cover position/tilt and light
 * brightness; a channel speaks its own declared min..max. One linear map
 * serves both directions, so what is published and what is written cannot
 * disagree.
 *
 * Ruling 55: 0..100 is the panel's own scale, so a percentage channel's
 * missing (or non-finite) min is 0 and its missing max is 100 -- a max-only
 * 255 blind is 0..255. Equal or inverted bounds cannot be scaled at all:
 * `undefined`, and the synth withholds the control rather than show one that
 * refuses almost everything.
 */
export function percentScale(codec: Bounds): { min: number; max: number } | undefined {
  const min = finite(codec?.min) ?? 0;
  const max = finite(codec?.max) ?? 100;
  return min < max ? { min, max } : undefined;
}

/**
 * A channel's raw value as the panel's percentage, exact -- the light needs
 * the fraction for HA's 0..255 brightness. What the panel keeps is a whole
 * percent, rounded by each synth (cover.ts's readPercent, light.ts's
 * brightness_pct). A 0..100 channel is the identity by construction.
 */
export function toPercent(raw: number, codec: Bounds): number | undefined {
  const scale = percentScale(codec);
  if (!scale) return undefined;
  if (scale.min === 0 && scale.max === 100) return raw;
  return ((raw - scale.min) * 100) / (scale.max - scale.min);
}

/**
 * The panel's percentage as a raw value for the channel. 0% and 100% are the
 * declared endpoints exactly: 0% by arithmetic (min + 0 is min), 100% by
 * construction, since 0.1 + 100 * 0.2 / 100 is 0.30000000000000004 -- above
 * a 0.3 maximum (N2). In between, the value is rounded to a whole number only
 * when the range is whole and spans at least 100: an integral device (0..255,
 * 0..254) then keeps an integral value, and every percent still lands on its
 * own step. A fractional or narrower range (0..1, a 0..10 V dimmer) keeps the
 * exact value.
 */
export function fromPercent(percent: number, codec: Bounds): number | undefined {
  const scale = percentScale(codec);
  if (!scale) return undefined;
  if (percent === 100) return scale.max;
  if (scale.min === 0 && scale.max === 100) return percent;
  const raw = scale.min + (percent * (scale.max - scale.min)) / 100;
  return Number.isInteger(scale.min) && Number.isInteger(scale.max) && scale.max - scale.min >= 100 ? Math.round(raw) : raw;
}

/**
 * An absolute channel's declared bounds -- a setpoint, a humidity. Each finite
 * bound counts on its own, and none is invented; an equal or inverted pair
 * means nothing and is ignored whole (Ruling 55).
 */
export function declaredBounds(codec: Bounds): { min?: number; max?: number } {
  const min = finite(codec?.min);
  const max = finite(codec?.max);
  return min !== undefined && max !== undefined && min >= max ? {} : { min, max };
}

/** Whether an absolute value may be written to the channel: inside every bound declaredBounds keeps. */
export function withinDeclaredRange(value: number, codec: Bounds): boolean {
  const { min, max } = declaredBounds(codec);
  return (min === undefined || value >= min) && (max === undefined || value <= max);
}

/**
 * Ruling 59: a colour-temperature channel as the panel uses it -- in whole
 * kelvin, however the channel stores it.
 *
 * The unit. A declared unit decides: K/kelvin, or mired -- ioBroker.
 * zigbee2mqtt's DEFAULT (lib/exposes.js: `unit: useKelvin ? 'K' : 'mired'`).
 * Any other declared unit (a percentage, say) is no temperature this adapter
 * can convert, so colour temperature is withheld. With no unit declared, two
 * pieces of evidence decide: ioBroker.zigbee's colortemp declares no unit and
 * no range and holds zigbee mireds (lib/models.js:230-242), and both zigbee
 * adapters' own setters read a value above 1000 as kelvin and anything else as
 * mired (utils.toMired). So the channel's positive numbers -- declared bounds
 * and current value -- decide by that same threshold; numbers on both sides
 * cannot be told apart and withhold colour temperature. With no number at
 * all, the role's documented unit applies: level.color.temperature is "color
 * temperature in K°" (ioBroker.docs, dev/stateroles.md:253).
 *
 * The range. kelvin = 1e6 / mired, so mired bounds swap. A missing bound is
 * the firmware's own default, 2000 or 6535 K (tile_renderer.cpp:1332-1353),
 * and both are whole numbers rounded INWARD: the firmware rounds what it is
 * sent, so a fractional 6535.95 became 6536, above the channel's maximum.
 * The range the panel clamps to is then exactly the range dispatch accepts,
 * and every whole kelvin inside it lands inside the channel's declared range.
 * An empty range withholds colour temperature.
 */
export interface ColorTempScale {
  unit: 'kelvin' | 'mired';
  minKelvin: number;
  maxKelvin: number;
}

type ColorTempCodec = Bounds & Pick<ChannelCodec, 'unit' | 'current'>;

const KELVIN_UNITS = new Set(['k', 'kelvin', '°k', 'k°']);
const MIRED_UNITS = new Set(['mired', 'mireds', 'mirek', 'mireks']);
/** utils.toMired in ioBroker.zigbee and ioBroker.zigbee2mqtt: above this, kelvin. */
const MIRED_MAX = 1000;
const FIRMWARE_MIN_KELVIN = 2000;
const FIRMWARE_MAX_KELVIN = 6535;

/** A positive, finite number, from a number or a numeric string. */
function positive(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function colorTempUnit(codec: ColorTempCodec): ColorTempScale['unit'] | undefined {
  const declared = codec.unit?.trim().toLowerCase();
  if (declared) return KELVIN_UNITS.has(declared) ? 'kelvin' : MIRED_UNITS.has(declared) ? 'mired' : undefined;
  const numbers = [codec.min, codec.max, codec.current].map(positive).filter((n): n is number => n !== undefined);
  if (numbers.length && numbers.every((n) => n <= MIRED_MAX)) return 'mired';
  return numbers.every((n) => n > MIRED_MAX) ? 'kelvin' : undefined;
}

export function colorTempScale(codec: ColorTempCodec | undefined): ColorTempScale | undefined {
  const unit = codec && colorTempUnit(codec);
  if (!unit) return undefined;
  const min = positive(codec?.min);
  const max = positive(codec?.max);
  const [low, high] = unit === 'mired' ? [max && 1e6 / max, min && 1e6 / min] : [min, max];
  const minKelvin = Math.ceil(low ?? FIRMWARE_MIN_KELVIN);
  const maxKelvin = Math.floor(high ?? FIRMWARE_MAX_KELVIN);
  return minKelvin < maxKelvin ? { unit, minKelvin, maxKelvin } : undefined;
}

/** A channel's reading as the whole kelvin the panel shows (it rounds anyway, tile_renderer.cpp:1324); none if not positive. */
export function colorTempToKelvin(raw: unknown, scale: ColorTempScale): number | undefined {
  const value = positive(raw);
  return value === undefined ? undefined : Math.round(scale.unit === 'mired' ? 1e6 / value : value);
}

/**
 * A whole kelvin as the raw value the channel stores. A mired value is
 * rounded when the declared mired bounds are whole (zigbee2mqtt's 150..500):
 * every whole kelvin inside the published range then rounds to a mired inside
 * them. Fractional bounds keep the exact value, which lies inside them.
 */
export function colorTempFromKelvin(kelvin: number, scale: ColorTempScale, codec: Bounds): number {
  if (scale.unit === 'kelvin') return kelvin;
  const mired = 1e6 / kelvin;
  const whole = [codec?.min, codec?.max].every((bound) => positive(bound) === undefined || Number.isInteger(bound));
  return whole ? Math.round(mired) : mired;
}

export const UNAVAILABLE = STATE_UNAVAILABLE;
export const UNKNOWN = STATE_UNKNOWN;
