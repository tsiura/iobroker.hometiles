import type { ChannelInput, DeviceInput, Domain, VirtualEntity } from '../types';
import { STATE_UNAVAILABLE, STATE_UNKNOWN } from '../types';
import { baseEntity, encodeChannelValue, isUsable, numberToState, readChannel, readEnum, type Values } from './common';

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
 * write back.
 */

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
  /** isUsable: present, not null, good quality. */
  usable: boolean;
  raw: unknown;
}

function readValue(device: DeviceInput, values: Values): ValueRead | undefined {
  const name = valueChannel(device.channels);
  const read = name ? readChannel(device, name, values) : null;
  if (!name || !read) return undefined;
  const usable = isUsable(read.value);
  return { name, channel: read.channel, usable, raw: usable ? read.value?.val : undefined };
}

/** No usable value is unavailable, whatever the domain (a sensor's rule too). */
function editableEntity(
  domain: Domain,
  device: DeviceInput,
  entityId: string,
  values: Values,
  read: ValueRead,
  state: string,
  extra: Record<string, unknown>,
  writable: boolean,
): VirtualEntity {
  const { source, channelMeta, lastChanged, friendly } = baseEntity(device, entityId, values);
  return {
    entityId,
    domain,
    source,
    state: read.usable ? state : STATE_UNAVAILABLE,
    attributes: { ...friendly, ...extra },
    available: read.usable,
    lastChanged,
    writable: { value: writable },
    channelMeta,
  };
}

const finite = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * The declared range, complete or not at all. The panel edits a number only
 * with a finite min, max and step, min < max, step > 0 and a finite max - min;
 * anything else forces writable false (contract §3, value_control.cpp:82-86).
 * No bound is invented to rescue one -- most ioBroker states declare no step
 * -- and a partial or inconsistent set is published as none.
 */
function numberRange({ min, max, step }: ChannelInput): { min: number; max: number; step: number } | undefined {
  if (!finite(min) || !finite(max) || !finite(step)) return undefined;
  return min < max && step > 0 && Number.isFinite(max - min) ? { min, max, step } : undefined;
}

export function synthNumber(device: DeviceInput, entityId: string, values: Values): VirtualEntity | null {
  const read = readValue(device, values);
  if (!read) return null;
  const range = numberRange(read.channel);
  const extra: Record<string, unknown> = { ...range };
  const unit = read.channel.unit?.trim();
  if (unit) extra.unit_of_measurement = unit;
  const writable = read.channel.write === true && read.channel.type === 'number' && range !== undefined;
  return editableEntity('number', device, entityId, values, read, numberToState(read.raw), extra, writable);
}

/** contract §6/§8: 1 to 64 options (value_control.cpp:92), each 1 to 255 bytes (:97). */
const MAX_OPTIONS = 64;
const MAX_OPTION_BYTES = 255;

/**
 * The option list: every label of the channel's states map, or none at all.
 * The panel drops the whole list, and the select goes read-only, when
 * options_complete is not true or any single option is invalid -- no partial
 * acceptance (contract §6, value_control.cpp:90-104). So a list with one bad
 * option is published as no list, never trimmed to its good ones:
 *
 * - 1 to 64 options (§6, §8; :92);
 * - each 1 to 255 UTF-8 bytes, not characters (§6, §8; :97);
 * - no \n or \r in any, the panel's own separator for its dropdown (§6; :97);
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
 * write the raw value as, the rule climate's enumModes follows.
 */
function selectOptions(channel: ChannelInput): string[] | undefined {
  const states = channel.states ?? {};
  const labels = Object.values(states);
  if (channel.type !== 'number' && channel.type !== 'string') return undefined;
  if (labels.length < 1 || labels.length > MAX_OPTIONS) return undefined;
  const codec = { type: channel.type, states };
  const valid = labels.every((label) => {
    if (!label || Buffer.byteLength(label, 'utf8') > MAX_OPTION_BYTES || /[\r\n]/.test(label)) return false;
    const raw = encodeChannelValue(codec, label);
    return raw !== undefined && states[String(raw)] === label;
  });
  return valid ? labels : undefined;
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
  const writable = read.channel.write === true && options !== undefined;
  return editableEntity('select', device, entityId, values, read, state, options ? { options } : {}, writable);
}

/**
 * The panel's own grammar for a date, a time and both (contract §3,
 * value_editor_model.h:28-52): Y-M-D, H:M or H:M:S, and a date, one ' ' or
 * 'T', then a time. Home Assistant's input_datetime flags name the kind.
 */
const CALENDAR_SHAPES: ReadonlyArray<[RegExp, { has_date: boolean; has_time: boolean }]> = [
  [/^\d{4}-\d{1,2}-\d{1,2}$/, { has_date: true, has_time: false }],
  [/^\d{1,2}:\d{1,2}(:\d{1,2})?$/, { has_date: false, has_time: true }],
  [/^\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{1,2}(:\d{1,2})?$/, { has_date: true, has_time: true }],
];

/** Which kind a text in the panel's grammar is; none for any other text. */
export function calendarKind(text: string): { has_date: boolean; has_time: boolean } | undefined {
  return CALENDAR_SHAPES.find(([shape]) => shape.test(text))?.[1];
}

/**
 * Override-only: type-detector has no date or time type, and a value that
 * merely looks like a date is no reason to make one. Only a device a user
 * forced into this domain becomes a datetime entity; a device as detection
 * alone left it is none, whatever it holds.
 *
 * The kind comes from the value: a string already in the panel's grammar is
 * shown as it is and may be edited. Any other shape -- an epoch number,
 * whose unit and zone the object does not declare, an ISO text with a zone,
 * a local "23.09.2026" -- is shown as its raw text, with no kind and
 * read-only: the value command could not write the panel's answer back in
 * that shape.
 */
export function synthDatetime(device: DeviceInput, entityId: string, values: Values): VirtualEntity | null {
  if (device.domain !== 'datetime') return null;
  const read = readValue(device, values);
  if (!read) return null;
  const text = read.usable ? String(read.raw).trim() : '';
  const kind = typeof read.raw === 'string' ? calendarKind(text) : undefined;
  const writable = read.channel.write === true && read.channel.type === 'string' && kind !== undefined;
  return editableEntity('datetime', device, entityId, values, read, text || STATE_UNKNOWN, { ...kind }, writable);
}
