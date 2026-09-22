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
    channelMeta[name] = { type: channel.type, states: channel.states };
    const value = values[channel.objectId];
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
 * The exact inverse of readEnum (synth/climate.ts) and toBoolState (above):
 * those decode a raw ioBroker value into an HA-style display label; this
 * turns a label back into the raw value a write actually needs. Writing a
 * decoded label back to ioBroker verbatim -- e.g. the string "heat" into a
 * MODE state that expects the number 1 -- is this project's defining bug
 * class: success reported for a write that lands on nothing, or on the wrong
 * thing. A label this function cannot faithfully re-encode returns
 * `undefined`, never a guessed value.
 *
 * The states-map reversal is case-insensitive:
 * docs/contract-climate-cover.md confirms the firmware trims+lowercases
 * hvac_mode/fan_mode/swing_mode on its own ingest, so a label built from a
 * states map in any other case (e.g. @iobroker/type-detector's own
 * upper-case defaultStates, "HIGH") comes back from a real panel already
 * lower-cased. An exact-case-only reversal would refuse the type-detector's
 * own default labels on every real round trip.
 */
export function encodeChannelValue(codec: ChannelCodec | undefined, label: string): number | boolean | string | undefined {
  let raw = label;
  if (codec?.states) {
    const match = Object.entries(codec.states).find(([, candidate]) => candidate.toLowerCase() === label.toLowerCase());
    if (!match) return undefined;
    raw = match[0];
  }

  switch (codec?.type) {
    case 'number': {
      // Number('') and Number('NaN') are both non-encodable for different
      // reasons ('' is 0 and finite -- the exact trap this project has hit
      // before; 'NaN' parses to a real NaN) -- both must refuse, neither may
      // fall through as 0.
      const text = raw.trim();
      if (!text) return undefined;
      const numeric = Number(text);
      return Number.isFinite(numeric) ? numeric : undefined;
    }
    case 'boolean':
      // toBoolState only ever EMITS 'on' or 'off' for a genuine boolean
      // channel ('unknown' means nothing boolean was recoverable at all), so
      // those are the only two labels with a faithful raw value to
      // reconstruct -- accepting more (e.g. toBoolState's lenient INPUT
      // vocabulary like "1"/"yes") would accept values decode never emits.
      if (raw === STATE_ON) return true;
      if (raw === STATE_OFF) return false;
      return undefined;
    default:
      // 'string', 'mixed', and no captured type at all: the safe default is
      // to write back exactly what arrived.
      return raw;
  }
}

export const UNAVAILABLE = STATE_UNAVAILABLE;
export const UNKNOWN = STATE_UNKNOWN;
