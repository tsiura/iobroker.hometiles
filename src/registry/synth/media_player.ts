import type { ChannelInput, DeviceInput, VirtualEntity } from '../types';
import { STATE_OFF, STATE_ON, STATE_UNAVAILABLE, STATE_UNKNOWN } from '../types';
import {
  baseEntity,
  isUsable,
  percentScale,
  readBool,
  readChannel,
  readNumber,
  readPercent,
  toBoolState,
  type Values,
} from './common';

/**
 * Home Assistant's state names by the words ioBroker uses: a string STATE's
 * value or a states-map label. ioBroker's role list documents media.state as
 * 'play'/'stop'/'pause', as 0 pause / 1 play / 2 stop, or as true playing /
 * false pause; HA calls a stopped player idle. The panel gives playing,
 * paused, idle, standby and off their own label and shows "no playback" for
 * anything else, unknown and unavailable included (tile_renderer.cpp:
 * 2904-2914); only "playing" shows the pause button and advances the seek bar
 * (:2954-2967, media_popup.cpp:289-296).
 */
const STATE_NAMES: ReadonlyMap<string, string> = new Map([
  ['play', 'playing'],
  ['playing', 'playing'],
  ['pause', 'paused'],
  ['paused', 'paused'],
  ['stop', 'idle'],
  ['stopped', 'idle'],
  ['idle', 'idle'],
  ['buffering', 'buffering'],
  ['standby', 'standby'],
  ['on', 'on'],
  ['off', 'off'],
]);

const NUMERIC_STATES = ['paused', 'playing', 'idle'];

/** STATE's channel as the decoder reads it: a ChannelInput here, a ChannelCodec in the dispatcher. */
type StateCodec = Pick<ChannelInput, 'type' | 'states'>;

/**
 * A boolean is read as documented, true playing and false pause. A
 * states-map label or a string is read by name; a number whose label names no
 * state (a localised "Wiedergabe") falls back to the numeric convention.
 */
function mediaState(raw: unknown, channel: StateCodec): string | undefined {
  if (typeof raw === 'boolean' || channel.type === 'boolean') {
    const on = toBoolState(raw);
    return on === STATE_ON ? 'playing' : on === STATE_OFF ? 'paused' : undefined;
  }
  const named = STATE_NAMES.get(String(channel.states?.[String(raw)] ?? raw).trim().toLowerCase());
  return named ?? (typeof raw === 'number' ? NUMERIC_STATES[raw] : undefined);
}

/**
 * The raw value a writable STATE takes to read as `target` (Task 10's
 * play_pause): mediaState's exact inverse, by construction. Each value the
 * channel holds -- true/false, its states map's keys, or a number's 0/1/2 --
 * is decoded, and exactly one must read as `target`. None, or several, is
 * undefined: never a guess.
 */
export function mediaStateValue(channel: StateCodec | undefined, target: string): unknown {
  if (!channel) return undefined;
  const keys = Object.keys(channel.states ?? {});
  const held: unknown[] =
    channel.type === 'boolean'
      ? [true, false]
      : keys.length
        ? keys.map((key) => (channel.type === 'number' ? Number(key) : key))
        : channel.type === 'number'
          ? [0, 1, 2]
          : [];
  const matches = held.filter((raw) => mediaState(raw, channel) === target);
  return matches.length === 1 ? matches[0] : undefined;
}

function readText(device: DeviceInput, name: string, values: Values): string | undefined {
  const read = readChannel(device, name, values);
  const raw = read && isUsable(read.value) ? read.value.val : undefined;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/** media.duration and media.elapsed are seconds (their pattern's defaultUnit 'sec'); a channel declaring ms is converted. */
function readSeconds(device: DeviceInput, name: string, values: Values): number | undefined {
  const raw = readNumber(device, name, values);
  return raw !== undefined && device.channels[name]?.unit?.trim().toLowerCase() === 'ms' ? raw / 1000 : raw;
}

const TEXT_ATTRIBUTES = [
  ['title', 'media_title'],
  ['artist', 'media_artist'],
  ['album', 'media_album_name'],
  // The cover as the device reports it; protocol/media.ts sends the panel
  // only what it can download.
  ['cover', 'entity_picture'],
] as const;

/**
 * mediaPlayer (@iobroker/type-detector 6.0.1) requires only STATE. The panel
 * has no acceptance check for a media payload (tile_renderer.cpp:4244-4263
 * drops only an empty or repeated one) and no supported_features, but two
 * readings ARE controls: volume_level enables the volume slider
 * (media_popup.cpp:261-265, :483) and media_position+media_duration show a
 * draggable seek bar (:300-310, :501-502). So each is published only when the
 * command behind it can land -- `writable.volume` and `writable.seek`, from
 * the channel's own write flag and scalable bounds, and for SEEK a percentage
 * unit -- and a read-only volume or position is left out rather than shown as
 * a control that does nothing.
 * The transport buttons (previous, play_pause, next) are always drawn; no
 * payload key shapes them.
 */
export function synthMediaPlayer(device: DeviceInput, entityId: string, values: Values): VirtualEntity | null {
  // Only a domain override brings a device here without STATE, and nothing
  // on it is a media player's (a socket's power switch, say).
  const stateChannel = device.channels.state;
  if (!stateChannel) return null;

  const { source, channelMeta, lastChanged, friendly } = baseEntity(device, entityId, values);
  const attributes: Record<string, unknown> = { ...friendly };
  const baselineKeys = Object.keys(attributes).length;
  const writable: Record<string, boolean> = {};

  for (const [channel, key] of TEXT_ATTRIBUTES) {
    const text = readText(device, channel, values);
    if (text !== undefined) attributes[key] = text;
  }

  const muted = readBool(device, 'mute', values);
  if (muted !== undefined) attributes.is_volume_muted = muted;

  // Where play_pause, previous, next and the mute icon land
  // (runtime/dispatcher.ts). The panel draws the three transport buttons
  // whatever the player has (media_popup.cpp:774-794,
  // types/media/renderer.cpp:478-498), so none can be withheld like the volume
  // and seek below: a command with no writable channel is refused, out loud.
  // play_pause presses PLAY or PAUSE, else writes STATE.
  for (const name of ['state', 'play', 'pause', 'next', 'prev', 'mute']) {
    const channel = device.channels[name];
    if (channel) writable[name] = channel.write === true;
  }

  // VOLUME_ACTUAL is feedback and wins over the last command written to
  // VOLUME, each read in its own range (Ruling 49) as the 0..1 the panel takes.
  const volume = device.channels.volume;
  if (volume) writable.volume = volume.write === true && percentScale(volume) !== undefined;
  if (writable.volume) {
    const percent = readPercent(device, 'volume_actual', values) ?? readPercent(device, 'volume', values);
    if (percent !== undefined) attributes.volume_level = percent / 100;
  }

  // SEEK is a percentage (ioBroker's media.seek), so a seek to a position
  // needs the duration; the panel shows the bar only with both, and a
  // positive duration. Ruling 67: only a SEEK declaring no unit or % is that
  // percentage. The SEEK pattern has no defaultUnit, and one declared in a
  // time unit would take a percentage as time; it is not converted either
  // (unit strings vary, and a wrong guess at ms is 1000 times off), so it
  // gets no seek bar and nothing lands on it.
  const seek = device.channels.seek;
  if (seek) {
    const unit = seek.unit?.trim();
    writable.seek = seek.write === true && percentScale(seek) !== undefined && (!unit || unit === '%');
  }
  if (writable.seek) {
    const duration = readSeconds(device, 'duration', values);
    const position = readSeconds(device, 'elapsed', values);
    if (duration !== undefined && duration > 0 && position !== undefined) {
      attributes.media_position = position;
      attributes.media_duration = duration;
    }
  }

  const read = readChannel(device, 'state', values);
  const raw = read && isUsable(read.value) ? read.value.val : undefined;
  const state = raw === undefined ? undefined : mediaState(raw, stateChannel);
  // A STATE value that names no state still says the player is reporting.
  const available = raw !== undefined || Object.keys(attributes).length > baselineKeys;

  return {
    entityId,
    domain: 'media_player',
    source,
    state: state ?? (available ? STATE_UNKNOWN : STATE_UNAVAILABLE),
    attributes,
    available,
    lastChanged,
    writable,
    channelMeta,
  };
}
