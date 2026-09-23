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
    // (Ruling 49).
    channelMeta[name] = {
      type: channel.type,
      states: channel.states,
      write: channel.write,
      current: isUsable(value) ? value.val : undefined,
      min: channel.min,
      max: channel.max,
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
 * The exact inverse of readEnum (synth/climate.ts) and toBoolState (above):
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
 * An absolute channel's declared bounds -- a setpoint, a humidity, a colour
 * temperature. Each finite bound counts on its own, and none is invented; an
 * equal or inverted pair means nothing and is ignored whole (Ruling 55).
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

export const UNAVAILABLE = STATE_UNAVAILABLE;
export const UNKNOWN = STATE_UNKNOWN;
