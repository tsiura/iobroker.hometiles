import type { ChannelInput, DatetimeKind, DeviceInput, Domain, VirtualEntity } from '../types';
import { STATE_UNAVAILABLE, STATE_UNKNOWN } from '../types';
import {
  baseEntity,
  encodeChannelValue,
  isUsable,
  numberToState,
  percentScale,
  readChannel,
  readEnum,
  type Values,
} from './common';

/**
 * Editable values: the panel's Number, Select and Date/Time tiles
 * (docs/contract-editable.md). The registry side only. What reaches the
 * panel is the /control payload (Task 14): min, max, step, unit and the
 * option list travel there, never in editable_meta, which carries entity_id
 * and name alone (contract §2). The attributes below use Home Assistant's
 * names for the same things -- number: min, max, step, unit_of_measurement;
 * select: options; input_datetime: has_date, has_time -- so Task 14 reads them
 * as the Bridge reads Home Assistant's (editable_helpers.py
 * build_editable_payload).
 *
 * `writable.value` says whether the panel may edit the value at all, and a
 * value command (Task 15) must refuse any entity where it is not true: a
 * read-only channel, a number without a complete valid range, a select whose
 * option list was dropped, a date or time in a shape this adapter cannot
 * write back. A channel is read-only only when its object says `write: false`
 * (Ruling 89): ioBroker's default is writable, the dispatcher refuses only
 * that (Ruling 38), and a manual entity's channel has no pattern to fill a
 * silent flag in, as detection's has (channelInput).
 *
 * Each rule below yields why the value is read-only, in English, or nothing:
 * `writable.value` is exactly "no reason", and `readOnly` carries the reason,
 * which main.ts names for a manual entity (Task 13b round 1, m2).
 */

/** Only an explicit `write: false` makes a channel read-only (Ruling 89). */
const writes = (channel: ChannelInput): boolean => channel.write !== false;
const READ_ONLY = 'write is false';

/**
 * The one channel an editable entity shows and writes, decided once by which
 * channel is configured (Ruling 25): a slider's SET, else the reading of a
 * device a user forced into the domain -- the catch-all info's ACTUAL. The
 * value command resolves it the same way, from the entity's `source`, and
 * encodes through `channelMeta` under that name.
 *
 * SET wins over a reading beside it: the panel confirms a command only when
 * the state it then receives equals the value it sent (value_control.cpp:
 * 320-335), and only the channel written converges to that. A forced
 * thermostat's room temperature never would.
 */
export function valueChannel(channels: Readonly<Record<string, unknown>>): 'set' | 'actual' | undefined {
  if (channels.set !== undefined) return 'set';
  return channels.actual !== undefined ? 'actual' : undefined;
}

interface ValueRead {
  name: 'set' | 'actual';
  channel: ChannelInput;
  /** ioBroker's quality marks the value untrustworthy (q other than 0). */
  bad: boolean;
  /** isUsable: present, not null, good quality. */
  usable: boolean;
  raw: unknown;
}

function readValue(device: DeviceInput, values: Values): ValueRead | undefined {
  const name = valueChannel(device.channels);
  const read = name ? readChannel(device, name, values) : null;
  if (!name || !read) return undefined;
  const usable = isUsable(read.value);
  return { name, channel: read.channel, bad: !!read.value?.q, usable, raw: usable ? read.value?.val : undefined };
}

/**
 * Availability follows quality, not presence (Ruling 88): a value ioBroker
 * flags as bad is unavailable; no value yet, or a null one, is `unknown` and
 * available, as Home Assistant keeps such an entity, so the panel can still
 * set the first one -- it drafts from min, or from a blank calendar
 * (value_control.cpp:416-417, :852-860). The panel treats a null state as
 * never available (:76), so Task 14 must send `unknown` as text. The
 * sensor's rule is its own.
 */
function editableEntity(
  domain: Domain,
  device: DeviceInput,
  entityId: string,
  values: Values,
  read: ValueRead,
  state: string,
  extra: Record<string, unknown>,
  readOnly: string | undefined,
): VirtualEntity {
  const { source, channelMeta, lastChanged, friendly } = baseEntity(device, entityId, values);
  return {
    entityId,
    domain,
    source,
    state: read.bad ? STATE_UNAVAILABLE : read.usable ? state : STATE_UNKNOWN,
    attributes: { ...friendly, ...extra },
    available: !read.bad,
    lastChanged,
    writable: { value: readOnly === undefined },
    ...(readOnly === undefined ? {} : { readOnly }),
    channelMeta,
  };
}

const finite = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

function declaredRange({ min, max }: ChannelInput): { min: number; max: number } | undefined {
  return finite(min) && finite(max) && min < max ? { min, max } : undefined;
}

/**
 * Home Assistant's step for a number that declares none
 * (NumberEntity._calculate_step, DEFAULT_STEP 1): divided by 10 while the
 * range is at most the step, by repeated division -- bit for bit the value
 * the Bridge relays (Ruling 81, T81-3). For a range above 0 only: Home
 * Assistant skips the loop at 0, where it would never end (T81-1).
 */
function derivedStep(range: number): number {
  let step = 1;
  while (range <= step) step /= 10;
  return step;
}

/**
 * The published range, complete or none: the panel edits a number only with
 * a finite min, max and step, min < max, step > 0 and a finite width; anything
 * else forces writable false (contract §3, value_control.cpp:82-86).
 *
 * - Bounds are the object's own. A percent value's missing bound is its
 *   unit's, 0 or 100, each on its own (Ruling 82, percentScale): the unit %
 *   decides, never a missing bound as such (T82-3).
 * - An absent step is Home Assistant's (Ruling 81). A declared one stays the
 *   object's, even an invalid one, which leaves the number read-only (T81-2).
 * - `step` here is the one source of truth for the panel and for the value
 *   command; channelMeta keeps the step the object declares (T81-4).
 *
 * Without one, why not, in words.
 */
function numberRange(channel: ChannelInput): { min: number; max: number; step: number } | string {
  const percent = channel.unit?.trim() === '%';
  const bounds = percent ? percentScale(channel) : declaredRange(channel);
  if (!bounds) return percent || (finite(channel.min) && finite(channel.max)) ? 'min not below max' : 'no min/max';
  if (!Number.isFinite(bounds.max - bounds.min)) return 'range too wide';
  const step = channel.step ?? derivedStep(bounds.max - bounds.min);
  return finite(step) && step > 0 ? { ...bounds, step } : 'invalid step';
}

/** Why a channel of another type cannot hold the value the panel sends. */
const notOfType = (channel: ChannelInput, types: string): string => `type ${channel.type ?? 'none'}, not ${types}`;

export function synthNumber(device: DeviceInput, entityId: string, values: Values): VirtualEntity | null {
  const read = readValue(device, values);
  if (!read) return null;
  const range = numberRange(read.channel);
  const extra: Record<string, unknown> = typeof range === 'string' ? {} : { ...range };
  const unit = read.channel.unit?.trim();
  if (unit) extra.unit_of_measurement = unit;
  const readOnly = !writes(read.channel)
    ? READ_ONLY
    : read.channel.type !== 'number'
      ? notOfType(read.channel, 'number')
      : typeof range === 'string'
        ? range
        : undefined;
  return editableEntity('number', device, entityId, values, read, numberToState(read.raw), extra, readOnly);
}

/** contract §6/§8: 1 to 64 options (value_control.cpp:92), each 1 to 255 bytes (:97). */
const MAX_OPTIONS = 64;
const MAX_OPTION_BYTES = 255;

/**
 * What the panel cannot take in a text it shows, an option or a state
 * (protocol/editable.ts uses this too): a line break, which splits its
 * dropdown into rows (value_control.cpp:97, :845); NUL, where its copy ends
 * (:96); and a lone UTF-16 surrogate, which ArduinoJson 7.4.3 decodes to 0
 * or 4 bytes where Node counts 3 (Utf16.hpp:36-50), so a text of 255 bytes
 * here is longer there (Task 14 review m1). With the u flag a valid pair is
 * one code point, never \p{Cs}.
 */
export const UNSHOWABLE = /[\r\n\0]|\p{Cs}/u;

/**
 * The option list: every label of the channel's states map, or none at all.
 * The panel drops the whole list, and the select goes read-only, when
 * options_complete is not true or any single option is invalid -- no partial
 * acceptance (contract §6, value_control.cpp:90-104). So a list with one bad
 * option is published as no list, never trimmed to its good ones:
 *
 * - 1 to 64 options (§6, §8; :92);
 * - each 1 to 255 UTF-8 bytes, not characters (§6, §8; :97);
 * - no \n or \r in any, the panel's own separator for its dropdown (§6; :97),
 *   no NUL, where the panel's copy of an option ends (:96; M4), and no lone
 *   surrogate (UNSHOWABLE);
 * - unique (§6, §8; :98), judged the way the value command reads an option
 *   back: each must reverse through encodeChannelValue -- the shared encoder
 *   (Ruling 22), which matches trimmed and case-insensitively -- to a raw
 *   value that readEnum shows as that very option. That refuses a label two
 *   values share in any case ("High"/"HIGH"), a key the channel's type cannot
 *   hold, and a key that does not read back as itself (a number channel
 *   stores "1.50" as 1.5), for which the panel would wait on its
 *   confirmation in vain (value_control.cpp:329 compares exactly).
 *
 * A channel neither number- nor string-typed has no single native type to
 * write the raw value as, the rule climate's enumModes follows. Without a
 * list, why not, in words.
 */
function selectOptions(channel: ChannelInput): string[] | string {
  const states = channel.states ?? {};
  const labels = Object.values(states);
  if (channel.type !== 'number' && channel.type !== 'string') return notOfType(channel, 'number or string');
  if (labels.length < 1) return 'no states';
  if (labels.length > MAX_OPTIONS) return `more than ${MAX_OPTIONS} states`;
  const shown = (label: string): boolean => !!label && Buffer.byteLength(label, 'utf8') <= MAX_OPTION_BYTES && !UNSHOWABLE.test(label);
  if (!labels.every(shown)) return 'an empty, over-long, multi-line or malformed state label';
  const codec = { type: channel.type, states };
  const reversible = labels.every((label) => {
    const raw = encodeChannelValue(codec, label);
    return raw !== undefined && states[String(raw)] === label;
  });
  return reversible ? labels : 'states that do not map one to one';
}

/**
 * A select's state is its value's label (readEnum), the raw value's own text
 * when the map has no label for it; the panel then shows it above the options
 * (value_control.cpp:840-845).
 */
export function synthSelect(device: DeviceInput, entityId: string, values: Values): VirtualEntity | null {
  const read = readValue(device, values);
  if (!read) return null;
  const options = selectOptions(read.channel);
  const state = readEnum(device, read.name, values) ?? STATE_UNKNOWN;
  const readOnly = !writes(read.channel) ? READ_ONLY : typeof options === 'string' ? options : undefined;
  return editableEntity('select', device, entityId, values, read, state, typeof options === 'string' ? {} : { options }, readOnly);
}

/** Home Assistant's input_datetime flags, which name the panel's kind. */
export interface CalendarKind {
  has_date: boolean;
  has_time: boolean;
}

/** The three kinds, by the names a manual entry declares them with (Ruling 92). */
const KINDS: Readonly<Record<DatetimeKind, CalendarKind>> = {
  date: { has_date: true, has_time: false },
  time: { has_date: false, has_time: true },
  datetime: { has_date: true, has_time: true },
};
const DATE_TIME = KINDS.datetime;
const kindName = (kind: CalendarKind): DatetimeKind => (kind.has_date && kind.has_time ? 'datetime' : kind.has_date ? 'date' : 'time');

/**
 * The panel's own grammar for a date, a time and both (contract §3,
 * value_editor_model.h:28-52): Y-M-D, H:M or H:M:S, and a date, one ' ' or
 * 'T', then a time.
 */
const CALENDAR_SHAPES: ReadonlyArray<[RegExp, CalendarKind]> = [
  [/^(?<y>\d{4})-(?<mo>\d{1,2})-(?<d>\d{1,2})$/, KINDS.date],
  [/^(?<h>\d{1,2}):(?<mi>\d{1,2})(?::(?<s>\d{1,2}))?$/, KINDS.time],
  [/^(?<y>\d{4})-(?<mo>\d{1,2})-(?<d>\d{1,2})[ T](?<h>\d{1,2}):(?<mi>\d{1,2})(?::(?<s>\d{1,2}))?$/, DATE_TIME],
];

/** A month's days, by the panel's own leap rule (value_editor_model.h:17-20). */
function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * Which kind a text in the panel's grammar is, within its ranges as well
 * (M1, value_editor_model.h:46-49): year 1-9999, month 1-12, a day the month
 * has, hour 0-23, minute and second 0-59. None for any other text, which the
 * panel could show but not seed its editor from (value_control.cpp:858-859).
 */
export function calendarKind(text: string): CalendarKind | undefined {
  for (const [shape, kind] of CALENDAR_SHAPES) {
    const fields = shape.exec(text)?.groups;
    if (!fields) continue;
    const at = (key: string): number => Number(fields[key] ?? 0);
    const date = !kind.has_date || (at('y') >= 1 && at('mo') >= 1 && at('mo') <= 12 && at('d') >= 1 && at('d') <= daysIn(at('y'), at('mo')));
    const time = !kind.has_time || (at('h') <= 23 && at('mi') <= 59 && at('s') <= 59);
    return date && time ? kind : undefined;
  }
  return undefined;
}

/** Below this a number is no date in epoch milliseconds: 1e11 ms is March 1973 (Ruling 84). */
const MIN_EPOCH_MS = 1e11;

/**
 * Epoch milliseconds, ioBroker's date convention, as the panel's date-time
 * text in the host zone (Ruling 84, T84-1): the local date and time,
 * zero-padded, `YYYY-MM-DD HH:MM:SS` -- the very shape the panel sends back
 * (value_control.cpp:405), never toISOString's UTC. Milliseconds below a
 * second are dropped (T84-7). None for a number that is no such date: below
 * 1e11, past the host zone's year 9999, or beyond any Date (T84-2).
 */
export function epochToCalendar(raw: unknown): string | undefined {
  if (typeof raw !== 'number' || !(raw >= MIN_EPOCH_MS)) return undefined;
  const date = new Date(Math.floor(raw));
  if (Number.isNaN(date.getTime()) || date.getFullYear() > 9999) return undefined;
  const two = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
  );
}

/**
 * Override-only: type-detector has no date or time type, and a value that
 * merely looks like a date is no reason to make one. Only a device a user
 * forced into this domain, or declared as one by hand (Task 13b), becomes a
 * datetime entity; a device as detection alone left it is none.
 *
 * - A number-typed channel holds epoch milliseconds (Ruling 84): a date and
 *   a time, a kind the channel's type gives even without a value, so the
 *   tile keeps its layout (T84-3). A number that is no such date is shown as
 *   it is and never written.
 * - A text already in the panel's grammar is shown as it is, its kind its
 *   shape's. Any other text -- ISO with a zone, a local "23.09.2026" -- is
 *   shown raw, with no kind and read-only: the value command could not write
 *   the panel's answer back in that shape.
 * - A manual entry's declared kind (Ruling 92) stands in for a text that
 *   gives none, null or empty, so a fresh helper can be set at all. A value
 *   of another kind than declared is read-only, and so is an epoch number
 *   declared a date or a time alone: the value decides, never the entry.
 */
export function synthDatetime(device: DeviceInput, entityId: string, values: Values): VirtualEntity | null {
  if (device.domain !== 'datetime') return null;
  const read = readValue(device, values);
  if (!read) return null;
  const { type } = read.channel;
  const declared = device.kind;
  if (type === 'number') {
    const text = epochToCalendar(read.raw);
    // No value yet is a date still to be set (Ruling 88); a number that is no date is not.
    const readOnly = !writes(read.channel)
      ? READ_ONLY
      : declared !== undefined && declared !== 'datetime'
        ? `an epoch number is a date and time, declared kind ${declared}`
        : read.usable && text === undefined
          ? 'a number that is no epoch-ms date'
          : undefined;
    return editableEntity('datetime', device, entityId, values, read, text ?? String(read.raw), { ...DATE_TIME }, readOnly);
  }
  const text = read.usable ? String(read.raw).trim() : '';
  const kind = text ? (typeof read.raw === 'string' ? calendarKind(text) : undefined) : declared && KINDS[declared];
  const readOnly = !writes(read.channel)
    ? READ_ONLY
    : type !== 'string'
      ? notOfType(read.channel, 'string or number')
      : !kind
        ? text
          ? 'a value that is no date or time'
          : 'no value, and no kind declared'
        : declared !== undefined && kindName(kind) !== declared
          ? `a ${kindName(kind)} value, declared kind ${declared}`
          : undefined;
  return editableEntity('datetime', device, entityId, values, read, text || STATE_UNKNOWN, { ...kind }, readOnly);
}
