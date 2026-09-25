import type { ChannelInput, DeviceInput, VirtualEntity } from '../types';
import { STATE_UNAVAILABLE, STATE_UNKNOWN } from '../types';
import { baseEntity, isUsable, readChannel, readNumber, type Values } from './common';

/**
 * A value-role reading is a temperature only by its unit: DasWetter's hourly
 * channels give weatherCurrent's ACTUAL (/^value(\.temperature)?$/) the weather
 * SYMBOL number, or a pressure in hPa. AccuWeather's imperial unit is a bare "F".
 */
const TEMPERATURE_UNIT = /^(°?[cfk]|℃|℉)$/i;

function isTemperature(channel: ChannelInput | undefined): boolean {
  return !!channel && (/^value\.temperature(\.|$)/.test(channel.role ?? '') || TEMPERATURE_UNIT.test(channel.unit?.trim() ?? ''));
}

/** A text (trimmed; blank is none) or a finite number, of the type the source holds it in. */
function readRaw(device: DeviceInput, name: string | undefined, values: Values): string | number | undefined {
  const read = name === undefined ? null : readChannel(device, name, values);
  const raw = read && isUsable(read.value) ? read.value.val : undefined;
  if (typeof raw === 'string') return raw.trim() || undefined;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/** A reading under `key`, with its channel's declared unit as `<key>_unit`: a unit is never assumed. */
function putNumber(target: Record<string, unknown>, key: string, device: DeviceInput, name: string, values: Values): void {
  const value = readNumber(device, name, values);
  if (value === undefined) return;
  target[key] = value;
  const unit = device.channels[name]?.unit?.trim();
  if (unit) target[`${key}_unit`] = unit;
}

const DAY_TEXTS = [
  ['date', 'date'],
  ['state', 'weather_state'],
  ['icon', 'weather_icon'],
] as const;

const DAY_NUMBERS = [
  ['temp_max', 'temperature'],
  ['temp_min', 'templow'],
  ['precipitation', 'precipitation'],
  ['precipitation_chance', 'precipitation_probability'],
] as const;

/**
 * Day 0 is the unsuffixed channels (TEMP_MIN), day k the detector's `%d`
 * family (TEMP_MIN<k>). As many days as the source publishes: the walk stops
 * at the first day holding no usable value -- a list with a hole would slide
 * the next day into its place on a panel that fills undated days in order.
 */
function forecastDays(device: DeviceInput, values: Values): Array<Record<string, unknown>> {
  const days: Array<Record<string, unknown>> = [];
  for (let day = 0; ; day++) {
    const suffix = day ? String(day) : '';
    const entry: Record<string, unknown> = {};
    for (const [channel, key] of DAY_TEXTS) {
      const value = readRaw(device, channel + suffix, values);
      if (value !== undefined) entry[key] = value;
    }
    for (const [channel, key] of DAY_NUMBERS) putNumber(entry, key, device, channel + suffix, values);
    if (!Object.keys(entry).length) return days;
    days.push(entry);
  }
}

/**
 * What weather is read from: a temperature (ACTUAL, else the forecast's TEMP)
 * or a forecast (TEMP_MIN/TEMP_MAX). Undefined when there is neither --
 * nothing on the device is weather: an hour's symbol read as ACTUAL, or a
 * domain override. synthWeather's null test, and lacks' (synth/index.ts,
 * Ruling 139).
 */
export function weatherReadings(device: DeviceInput): { temperature: string | undefined; hasForecast: boolean } | undefined {
  const temperature = ['actual', 'temp'].find((name) => isTemperature(device.channels[name]));
  const hasForecast = !!(device.channels.temp_min ?? device.channels.temp_max);
  return temperature || hasForecast ? { temperature, hasForecast } : undefined;
}

/**
 * weatherCurrent (ACTUAL, WEATHER and its ICON as `current_icon`) and
 * weatherForecast (TEMP and the day channels), as detector.ts keeps them --
 * one source's two detections already combined into one device there.
 * Read-only: there is no weather command, so no role is writable.
 *
 * Current conditions: the temperature from ACTUAL, else from the forecast's
 * TEMP, the text from WEATHER, else the forecast's day-0 STATE, and the icon
 * from `current_icon`, else day 0's ICON -- one channel each, never the other
 * one's value when the chosen has none.
 * `forecast` exists only for a source with a forecast (its TEMP_MIN/TEMP_MAX),
 * so current conditions alone never read as a day.
 *
 * Values stay as the source gives them, for the payload (Task 12) to convert:
 * every number carries its channel's declared unit as `<key>_unit`, a date is
 * the adapter's own text or timestamp, and `weather_state`/`weather_icon` are
 * its text and icon -- no Home Assistant condition, so the state is unknown.
 */
export function synthWeather(device: DeviceInput, entityId: string, values: Values): VirtualEntity | null {
  const readings = weatherReadings(device);
  if (!readings) return null;
  const { temperature, hasForecast } = readings;

  const { source, channelMeta, lastChanged, friendly } = baseEntity(device, entityId, values);
  const attributes: Record<string, unknown> = { ...friendly };
  const baselineKeys = Object.keys(attributes).length;

  if (temperature) putNumber(attributes, 'temperature', device, temperature, values);
  const text = readRaw(device, ['weather', 'state'].find((name) => device.channels[name]), values);
  if (text !== undefined) attributes.weather_state = text;
  const icon = readRaw(device, ['current_icon', 'icon'].find((name) => device.channels[name]), values);
  if (icon !== undefined) attributes.weather_icon = icon;

  const forecast = hasForecast ? forecastDays(device, values) : undefined;
  const available = Object.keys(attributes).length > baselineKeys || !!forecast?.length;
  if (forecast) attributes.forecast = forecast;

  return {
    entityId,
    domain: 'weather',
    source,
    state: available ? STATE_UNKNOWN : STATE_UNAVAILABLE,
    attributes,
    available,
    lastChanged,
    channelMeta,
  };
}
