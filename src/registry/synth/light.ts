import type { DeviceInput, VirtualEntity } from '../types';
import { STATE_OFF, STATE_ON } from '../types';
import { baseEntity, isUsable, readChannel, toBoolState, UNAVAILABLE, type Values } from './common';

/** ioBroker dimmers are 0..100 percent; Home Assistant brightness is 0..255. */
function percentToHaBrightness(percent: number): number {
  const clamped = Math.min(100, Math.max(0, percent));
  return Math.round((clamped * 255) / 100);
}

function readNumber(device: DeviceInput, name: string, values: Values): number | undefined {
  const read = readChannel(device, name, values);
  if (!read || !isUsable(read.value)) return undefined;
  const raw = read.value.val;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  // The same trap numberToState guards against: Number('') is 0, so a blank
  // dimmer reading would become brightness 0 and render the lamp as off at 0%.
  // Blank means the level is unknown, so the attribute is omitted entirely.
  const text = String(raw).trim();
  if (!text) return undefined;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function synthLight(device: DeviceInput, entityId: string, values: Values): VirtualEntity {
  // channelMeta carries each channel's write flag: the dispatcher refuses a
  // read-only one (Ruling 38).
  const { source, channelMeta, lastChanged, friendly } = baseEntity(device, entityId, values);
  const attributes: Record<string, unknown> = { ...friendly };

  // Colour modes come only from channels that exist. Never from a current value.
  const hasDimmer = Boolean(device.channels.dimmer || device.channels.brightness);
  // Colour is advertised ONLY when the three component channels exist, because
  // those are the only ones the dispatcher can write. rgbSingle, rgbwSingle and
  // cie carry colour on a single combined channel (rgb / rgbw / cie) that the
  // v0.1 command path has no encoder for; advertising them would put a colour
  // picker on the panel whose writes silently do nothing. Such a bulb still
  // works for on/off, brightness and colour temperature.
  const hasRgb = Boolean(device.channels.red && device.channels.green && device.channels.blue);
  const hasCt = Boolean(device.channels.temperature);

  const modes: string[] = [];
  if (hasCt) modes.push('color_temp');
  if (hasRgb) modes.push('rgb');
  if (!modes.length) modes.push(hasDimmer ? 'brightness' : 'onoff');
  attributes.supported_color_modes = modes;

  // readChannel returns a non-null wrapper for any CONFIGURED channel even
  // when its value is null, so `readChannel(set) ?? readChannel(actual)`
  // never falls through: a device with both channels always keeps the SET
  // wrapper, even when SET has never been confirmed. Matches the pattern
  // switch.ts already gets right: prefer real feedback over an unconfirmed
  // command, and only fall back when the preferred channel is not usable.
  const actualRead = readChannel(device, 'actual', values);
  const setChannelRead = readChannel(device, 'set', values);
  const setRead = actualRead && isUsable(actualRead.value) ? actualRead : setChannelRead;
  // rgb, rgbSingle, rgbwSingle, hue, ct and cie carry their level on DIMMER
  // *or* BRIGHTNESS, depending on which detector pattern matched (see
  // hasDimmer above, and dispatcher.ts's matching write-side fallback). Both
  // are ioBroker 0..100 percent, so the same scaling applies to either.
  const dimmerPercent = readNumber(device, 'dimmer', values) ?? readNumber(device, 'brightness', values);
  const anyUsable = Boolean(setRead && isUsable(setRead.value)) || dimmerPercent !== undefined;

  if (!anyUsable) {
    return { entityId, domain: 'light', source, state: UNAVAILABLE, attributes, available: false, lastChanged, channelMeta };
  }

  let state: string;
  if (setRead && isUsable(setRead.value)) {
    state = toBoolState(setRead.value.val);
  } else {
    // No on/off channel at all: a non-zero dimmer is the only evidence of "on".
    state = (dimmerPercent ?? 0) > 0 ? STATE_ON : STATE_OFF;
  }

  if (dimmerPercent !== undefined) {
    attributes.brightness = percentToHaBrightness(dimmerPercent);
    attributes.brightness_pct = Math.round(Math.min(100, Math.max(0, dimmerPercent)));
  }

  const red = readNumber(device, 'red', values);
  const green = readNumber(device, 'green', values);
  const blue = readNumber(device, 'blue', values);
  if (red !== undefined && green !== undefined && blue !== undefined) {
    attributes.rgb_color = [Math.round(red), Math.round(green), Math.round(blue)];
  }

  const kelvin = readNumber(device, 'temperature', values);
  if (kelvin !== undefined) attributes.color_temp_kelvin = Math.round(kelvin);
  const ctChannel = device.channels.temperature;
  if (ctChannel?.min !== undefined) attributes.min_color_temp_kelvin = ctChannel.min;
  if (ctChannel?.max !== undefined) attributes.max_color_temp_kelvin = ctChannel.max;

  // color_mode reports the mode currently in effect, chosen from advertised modes.
  if (hasRgb && attributes.rgb_color) attributes.color_mode = 'rgb';
  else if (hasCt && attributes.color_temp_kelvin !== undefined) attributes.color_mode = 'color_temp';
  else attributes.color_mode = modes[0];

  return { entityId, domain: 'light', source, state, attributes, available: true, lastChanged, channelMeta };
}
