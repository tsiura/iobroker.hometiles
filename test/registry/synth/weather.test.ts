import { expect } from 'chai';
import { discoverDevices } from '../../../src/registry/detector';
import { EntityRegistry } from '../../../src/registry/entity-registry';
import { synthesise } from '../../../src/registry/synth/index';
import { synthWeather } from '../../../src/registry/synth/weather';
import type { ChannelInput, DeviceInput, SourceValue, VirtualEntity } from '../../../src/registry/types';

const NOW = 1_758_600_000_000;
const val = (v: unknown, q = 0): SourceValue => ({ val: v, ack: true, q, ts: NOW });

type Spec = Omit<ChannelInput, 'objectId'> & { value?: SourceValue };

/** A detected weather device: channel name (as detector.ts names it) -> object metadata plus its value. */
function weather(specs: Record<string, Spec>, detectorType = 'weatherForecast'): { device: DeviceInput; values: Record<string, SourceValue> } {
  const channels: DeviceInput['channels'] = {};
  const values: Record<string, SourceValue> = {};
  for (const [name, { value, ...meta }] of Object.entries(specs)) {
    const objectId = `alias.0.Wetter.${name}`;
    channels[name] = { objectId, ...meta };
    if (value) values[objectId] = value;
  }
  return { device: { objectId: 'alias.0.Wetter', name: 'Wetter', detectorType, domain: 'weather', channels }, values };
}

function synth({ device, values }: ReturnType<typeof weather>): VirtualEntity | null {
  return synthWeather(device, 'weather.wetter', values);
}

function entity(source: ReturnType<typeof weather>): VirtualEntity {
  const result = synth(source);
  expect(result, 'an entity').to.not.equal(null);
  return result as VirtualEntity;
}

const suffix = (day: number): string => (day ? String(day) : '');

/** Day k's channels as the detector names them: TEMP_MIN for day 0, TEMP_MIN<k> after it. */
function day(k: number, over: Partial<Record<'temp_min' | 'temp_max' | 'icon' | 'date', Spec>> = {}): Record<string, Spec> {
  const specs: Record<string, Spec> = {
    temp_min: { role: `value.temperature.min.forecast.${k}`, type: 'number', unit: '°C', value: val(10 + k) },
    temp_max: { role: `value.temperature.max.forecast.${k}`, type: 'number', unit: '°C', value: val(20 + k) },
    icon: { role: `weather.icon.forecast.${k}`, type: 'string', value: val(`https://icons.example/${k}.png`) },
    date: { role: `date.forecast.${k}`, type: 'string', value: val(`2026-09-${23 + k}`) },
    ...over,
  };
  return Object.fromEntries(Object.entries(specs).map(([name, spec]) => [`${name}${suffix(k)}`, spec]));
}

const forecastWithDays = (...days: number[]) => weather(Object.assign({}, ...days.map((k) => day(k))));

const forecastOf = (source: ReturnType<typeof weather>): Array<Record<string, unknown>> =>
  entity(source).attributes.forecast as Array<Record<string, unknown>>;

describe('registry/synth/weather', () => {
  it('walks the day-indexed channels and stops at the first gap', () => {
    // no day 3; day 4 exists but is past the gap
    expect(forecastOf(forecastWithDays(0, 1, 2, 4))).to.have.lengthOf(3);
  });

  it('does not assume a fixed forecast depth', () => {
    expect(forecastOf(forecastWithDays(0))).to.have.lengthOf(1);
    expect(forecastOf(forecastWithDays(0, 1, 2, 3, 4, 5, 6))).to.have.lengthOf(7);
  });

  it('combines weatherCurrent and weatherForecast into one entity', () => {
    // The channels discovery gives one source: the current conditions'
    // ACTUAL and WEATHER beside the forecast's own (detector.ts).
    const e = entity(
      weather({
        actual: { role: 'value.temperature', type: 'number', unit: '°C', value: val(18.6) },
        weather: { role: 'weather.state', type: 'string', value: val('Leichter Regen') },
        ...day(0),
        ...day(1),
      }),
    );
    expect(e.attributes.temperature).to.be.a('number');
    expect(e.attributes.temperature).to.equal(18.6);
    expect(e.attributes.weather_state).to.equal('Leichter Regen');
    expect(e.attributes.forecast).to.be.an('array').with.lengthOf(2);
  });

  it('is what synthesise() returns for the weather domain', () => {
    const { device, values } = forecastWithDays(0, 1);
    expect(synthesise(device, 'weather.wetter', values)).to.deep.equal(synthWeather(device, 'weather.wetter', values));
  });

  describe('forecast days', () => {
    it("reads each day's high, low, icon and date under Home Assistant's forecast names", () => {
      expect(forecastOf(forecastWithDays(0, 1))).to.deep.equal([
        {
          date: '2026-09-23',
          weather_icon: 'https://icons.example/0.png',
          temperature: 20,
          temperature_unit: '°C',
          templow: 10,
          templow_unit: '°C',
        },
        {
          date: '2026-09-24',
          weather_icon: 'https://icons.example/1.png',
          temperature: 21,
          temperature_unit: '°C',
          templow: 11,
          templow_unit: '°C',
        },
      ]);
    });

    it('reads the text, precipitation and its chance of a day when the source publishes them', () => {
      const [first] = forecastOf(
        weather({
          ...day(0),
          state: { role: 'weather.state.forecast.0', type: 'string', value: val('Sonnig') },
          precipitation: { role: 'value.precipitation.forecast.0', type: 'number', unit: 'mm', value: val(0.4) },
          precipitation_chance: { role: 'value.precipitation.forecast.0', type: 'number', unit: '%', value: val(35) },
        }),
      );
      expect(first).to.include({
        weather_state: 'Sonnig',
        precipitation: 0.4,
        precipitation_unit: 'mm',
        precipitation_probability: 35,
        precipitation_probability_unit: '%',
      });
    });

    it('stops at a day whose channels hold no usable value, rather than padding an empty day', () => {
      const source = forecastWithDays(0, 1, 2);
      for (const name of ['temp_min1', 'temp_max1', 'icon1', 'date1']) delete source.values[source.device.channels[name]!.objectId];
      // Day 2 still has values, but a list with a hole in it would slide it
      // into day 1's place for a panel that fills undated days in order.
      expect(forecastOf(source)).to.have.lengthOf(1);
    });

    it('treats a blank, null or bad-quality reading as absent, never as zero', () => {
      const [first] = forecastOf(
        weather(day(0, { temp_min: { role: 'value.temperature.min.forecast.0', type: 'number', unit: '°C', value: val('  ') } })),
      );
      expect(first).to.not.have.any.keys('templow', 'templow_unit');
      const [second] = forecastOf(
        weather(day(0, { temp_min: { role: 'value.temperature.min.forecast.0', type: 'number', unit: '°C', value: val(null) } })),
      );
      expect(second).to.not.have.any.keys('templow', 'templow_unit');
      const [third] = forecastOf(
        weather(day(0, { temp_min: { role: 'value.temperature.min.forecast.0', type: 'number', unit: '°C', value: val(4, 0x42) } })),
      );
      expect(third).to.not.have.any.keys('templow', 'templow_unit');
    });

    it('a missing TEMP_MIN is not 0, and a real 0 stays 0', () => {
      const withoutMin = weather(day(0));
      delete withoutMin.device.channels.temp_min;
      const [missing] = forecastOf(withoutMin);
      expect(missing).to.include({ temperature: 20 }).and.not.have.any.keys('templow', 'templow_unit');

      const [zero] = forecastOf(
        weather(day(0, { temp_min: { role: 'value.temperature.min.forecast.0', type: 'number', unit: '°C', value: val(0) } })),
      );
      expect(zero).to.include({ templow: 0 });
    });

    it("keeps each day's date exactly as the source provides it", () => {
      // AccuWeather's ISO date with offset, Weather Underground's local day,
      // DasWetter's UTC instant, OpenWeatherMap's weekday name, a timestamp.
      const dates = ['2026-09-23T07:00:00+02:00', '2026-09-24', '2026-09-24T22:00:00.000Z', 'Donnerstag', 1_758_664_800_000];
      const forecast = forecastOf(
        weather(
          Object.assign(
            {},
            ...dates.map((date, k) =>
              day(k, { date: { role: `date.forecast.${k}`, type: typeof date === 'number' ? 'number' : 'string', value: val(date) } }),
            ),
          ),
        ),
      );
      expect(forecast.map((entry) => entry.date)).to.deep.equal(dates);
    });

    it("carries each value's declared unit and never assumes one", () => {
      const [fahrenheit] = forecastOf(
        weather(
          day(0, {
            temp_min: { role: 'value.temperature.min.forecast.0', type: 'number', unit: 'F', value: val(50) },
            temp_max: { role: 'value.temperature.max.forecast.0', type: 'number', unit: '°F', value: val(68) },
          }),
        ),
      );
      expect(fahrenheit).to.include({ templow: 50, templow_unit: 'F', temperature: 68, temperature_unit: '°F' });

      const unitless = weather(day(0));
      for (const channel of Object.values(unitless.device.channels)) delete channel.unit;
      const [first] = forecastOf(unitless);
      expect(first).to.include({ temperature: 20, templow: 10 }).and.not.have.any.keys('temperature_unit', 'templow_unit');
    });

    it('reads no `…0` channel: the day-0 slots are the unsuffixed ones', () => {
      // The detector's ICON%d also matches forecast.0, so it names a second
      // day-0 object ICON0: AccuWeather's current icon beside the day's own.
      const [first] = forecastOf(
        weather({ ...day(0), icon0: { role: 'weather.icon.forecast.0', type: 'string', value: val('https://icons.example/now.png') } }),
      );
      expect(first!.weather_icon).to.equal('https://icons.example/0.png');
    });

    it('is omitted, not empty, for a source that publishes no forecast', () => {
      const current = entity(
        weather(
          {
            actual: { role: 'value.temperature', type: 'number', unit: '°C', value: val(7.5) },
            icon: { role: 'weather.icon', type: 'string', value: val('rain') },
          },
          'weatherCurrent',
        ),
      );
      expect(current.attributes).to.not.have.property('forecast');
      expect(current.attributes).to.include({ temperature: 7.5, temperature_unit: '°C', weather_icon: 'rain' });
    });

    it('is empty while a forecast source has no value yet', () => {
      const { device } = forecastWithDays(0, 1);
      expect(synthWeather(device, 'weather.wetter', {})!.attributes.forecast).to.deep.equal([]);
    });
  });

  describe('current conditions', () => {
    it("takes the temperature from ACTUAL, else from the forecast's TEMP, with that channel's unit", () => {
      const both = entity(
        weather({
          actual: { role: 'value.temperature', type: 'number', unit: '°F', value: val(65) },
          temp: { role: 'value.temperature.forecast.0', type: 'number', unit: '°C', value: val(18) },
          ...day(0),
        }),
      );
      expect(both.attributes).to.include({ temperature: 65, temperature_unit: '°F' });
      const temp = entity(weather({ temp: { role: 'value.temperature.forecast.0', type: 'number', unit: '°C', value: val(18) }, ...day(0) }));
      expect(temp.attributes).to.include({ temperature: 18, temperature_unit: '°C' });
    });

    it('does not borrow the other channel when the chosen one has no value', () => {
      const e = entity(
        weather({
          actual: { role: 'value.temperature', type: 'number', unit: '°C' },
          temp: { role: 'value.temperature.forecast.0', type: 'number', unit: '°C', value: val(18) },
          ...day(0),
        }),
      );
      expect(e.attributes).to.not.have.any.keys('temperature', 'temperature_unit');
    });

    it("takes the text from the current conditions' WEATHER, else the forecast's day-0 STATE", () => {
      const both = entity(
        weather({
          weather: { role: 'weather.state', type: 'string', value: val('Bewölkt') },
          state: { role: 'weather.state.forecast.0', type: 'string', value: val('Regen am Nachmittag') },
          ...day(0),
        }),
      );
      expect(both.attributes.weather_state).to.equal('Bewölkt');
      const state = entity(weather({ state: { role: 'weather.state.forecast.0', type: 'string', value: val('Regen') }, ...day(0) }));
      expect(state.attributes.weather_state).to.equal('Regen');
      // One channel: WEATHER without a value is no text yet, never day 0's.
      const silent = entity(
        weather({
          weather: { role: 'weather.state', type: 'string', value: val('   ') },
          state: { role: 'weather.state.forecast.0', type: 'string', value: val('Regen') },
          ...day(0),
        }),
      );
      expect(silent.attributes).to.not.have.property('weather_state');
    });

    it('reads a value-role ACTUAL as a temperature only when its unit is one', () => {
      const celsius = entity(weather({ actual: { role: 'value', type: 'number', unit: '°C', value: val(12) } }, 'weatherCurrent'));
      expect(celsius.attributes.temperature).to.equal(12);
      // DasWetter's hourly channels: the detector binds ACTUAL to the weather
      // SYMBOL number (role value, no unit), or to a pressure in hPa.
      const symbol = weather(
        {
          actual: { role: 'value', type: 'number', value: val(3) },
          icon: { role: 'weather.icon', type: 'string', value: val('/daswetter.admin/icons/weather/gallery1/png/64x64/3.png') },
        },
        'weatherCurrent',
      );
      expect(synth(symbol), 'no temperature and no forecast is no weather').to.equal(null);
      const pressure = weather({ actual: { role: 'value', type: 'number', unit: 'hPa', value: val(1013) } }, 'weatherCurrent');
      expect(synth(pressure)).to.equal(null);
      const withForecast = entity(weather({ actual: { role: 'value', type: 'number', value: val(3) }, ...day(0) }));
      expect(withForecast.attributes).to.not.have.property('temperature');
    });

    it('returns null for a device with neither a temperature nor a forecast: only a domain override brings one here', () => {
      expect(synth(weather({ set: { role: 'switch', type: 'boolean', write: true, value: val(true) } }, 'socket'))).to.equal(null);
    });
  });

  describe('entity', () => {
    it('is unknown with anything usable and unavailable with nothing', () => {
      const live = entity(forecastWithDays(0));
      expect(live).to.include({ domain: 'weather', state: 'unknown', available: true });
      const { device } = forecastWithDays(0);
      const silent = synthWeather(device, 'weather.wetter', {})!;
      expect(silent).to.include({ state: 'unavailable', available: false });
      expect(silent.attributes).to.deep.equal({ friendly_name: 'Wetter', forecast: [] });
      // A forecast is reason enough: a day's high and low, nothing current.
      const lows = weather({ ...day(0), ...day(1) });
      for (const name of ['icon', 'date', 'icon1', 'date1']) delete lows.device.channels[name];
      expect(entity(lows)).to.include({ state: 'unknown', available: true });
    });

    it('is read-only: it records no writable role', () => {
      expect(entity(forecastWithDays(0, 1))).to.not.have.property('writable');
    });

    it('carries channelMeta, with each channel unit, from the real synth (Ruling 23)', () => {
      const e = entity(forecastWithDays(0, 1));
      expect(e.channelMeta?.temp_max1).to.include({ type: 'number', unit: '°C', current: 21 });
      expect(Object.keys(e.channelMeta ?? {})).to.have.members(Object.keys(e.source));
    });

    it('never publishes null or undefined for any value', () => {
      const e = entity(
        weather({
          actual: { role: 'value.temperature', type: 'number', unit: '°C', value: val(null) },
          weather: { role: 'weather.state', type: 'string', value: val(null) },
          ...day(0, { date: { role: 'date.forecast.0', type: 'string', value: val(null) } }),
        }),
      );
      const values = (node: unknown): unknown[] =>
        node && typeof node === 'object' ? Object.values(node).flatMap((child) => [child, ...values(child)]) : [];
      expect(values(e.attributes).filter((v) => v === null || v === undefined)).to.deep.equal([]);
    });
  });
});

// ---- The real type-detector on real weather adapters' trees ----
//
// Each tree is rebuilt from the adapter's own object-creation code (npm
// packages as published): ids, roles, types and units exactly as the adapter
// writes them, including the states that compete for a weather slot.

type IoObject = { _id: string; type: 'device' | 'channel' | 'state'; common: Record<string, unknown>; native: Record<string, unknown> };
type IoObjects = Record<string, IoObject>;

const ioDevice = (id: string, name: string, common: Record<string, unknown> = {}): IoObject => ({
  _id: id,
  type: 'device',
  common: { name, ...common },
  native: {},
});
const ioChannel = (id: string, name: string, common: Record<string, unknown> = {}): IoObject => ({
  _id: id,
  type: 'channel',
  common: { name, ...common },
  native: {},
});
const ioState = (id: string, role: string, type: string, unit?: string): IoObject => ({
  _id: id,
  type: 'state',
  common: { name: id.split('.').pop(), role, type, read: true, write: false, ...(unit === undefined ? {} : { unit }) },
  native: {},
});
const ioObjects = (list: IoObject[]): IoObjects => Object.fromEntries(list.map((obj) => [obj._id, obj]));

/** [key, role, type, unit] rows, as the adapters' own object tables list them. */
type Row = [key: string, role: string, type: string, unit?: string];
const rows = (prefix: string, table: Row[], roleSuffix = ''): IoObject[] =>
  table.map(([key, role, type, unit]) => ioState(`${prefix}.${key}`, role + roleSuffix, type, unit));

// ioBroker.accuweather 2.3.0: lib/currentCondObject.json, lib/summaryObject.json,
// lib/DailyObject.json, lib/nextHourObject.json, placed by build/lib/nexthour-obj.js
// (Daily/Hourly roles get `.forecast.<n>`; dayPart becomes Day and Night).
const ACCU = 'accuweather.0';
const ACCU_CURRENT: Row[] = [
  ['LocalObservationDateTime', 'date', 'string'],
  ['WeatherIcon', 'value', 'number'],
  ['WeatherIconURL', 'media.url', 'string'],
  ['WeatherIconURLS', 'weather.icon', 'string'],
  ['WeatherText', 'weather.state', 'string'],
  ['HasPrecipitation', 'value', 'boolean'],
  ['PrecipitationType', 'value', 'string'],
  ['Temperature', 'value.temperature', 'number', '°C'],
  ['RealFeelTemperature', 'value.temperature.feelslike', 'number', '°C'],
  ['RealFeelTemperatureShade', 'value.temperature', 'number', '°C'],
  ['DewPoint', 'value', 'number', '°C'],
  ['WindSpeed', 'value.speed.wind', 'number', 'km/h'],
  ['WindDirection', 'value.direction.wind', 'number', '°'],
  ['WindDirectionText', 'value.direction.wind', 'string'],
  ['WindGust', 'value', 'number', 'km/h'],
  ['RelativeHumidity', 'value.humidity', 'number', '%'],
  ['CloudCover', 'value', 'number', '%'],
  ['UVIndex', 'value', 'number'],
  ['UVIndexText', 'value', 'string'],
  ['Pressure', 'value.pressure', 'number', 'mb'],
  ['PressureTendency', 'value', 'string'],
  ['LandscapeLink', 'text.url', 'string'],
  ['PortraitLink', 'text.url', 'string'],
];
const ACCU_SUMMARY: Row[] = [
  ['CurrentDateTime', 'date.forecast.0', 'string'],
  ['WeatherIcon', 'weather.icon.name.forecast.0', 'string'],
  ['WeatherIconURL', 'weather.icon.forecast.0', 'string'],
  ['WeatherText', 'weather.state.forecast.0', 'string'],
  ['Temperature', 'value.temperature.forecast.0', 'number', '°C'],
  ['HoursOfSun', 'value.HoursOfSun', 'number'],
  ['RealFeelTemperature', 'value.temperature.feelslike.forecast.0', 'number', '°C'],
  ['WindSpeed', 'value.speed.wind.forecast.0', 'number', 'km/h'],
  ['WindDirection', 'value.direction.wind.forecast.0', 'number', '°'],
  ['WindDirectionStr', 'weather.direction.wind.forecast.0', 'string', ''],
  ['RelativeHumidity', 'value.humidity.forecast.0', 'number', '%'],
  ['Pressure', 'value.pressure', 'number', 'mmHg'],
  ['DayOfWeek', 'dayofweek.forecast.0', 'string', ''],
  ['Sunrise', 'time.sunrise', 'string', ''],
  ['Sunset', 'time.sunset', 'string', ''],
];
const ACCU_SUMMARY_DAY = (d: number): Row[] => [
  [`DateTime_d${d}`, `date.forecast.${d - 1}`, 'string'],
  [`WeatherIcon_d${d}`, `weather.icon.name.forecast.${d - 1}`, 'string'],
  [`WeatherIconURL_d${d}`, `weather.icon.forecast.${d - 1}`, 'string'],
  [`WeatherText_d${d}`, `weather.state.forecast.${d - 1}`, 'string'],
  [`TempMin_d${d}`, `value.temperature.min.forecast.${d - 1}`, 'number', '°C'],
  [`TempMax_d${d}`, `value.temperature.max.forecast.${d - 1}`, 'number', '°C'],
  [`WindSpeed_d${d}`, `value.speed.wind.forecast.${d - 1}`, 'number', 'km/h'],
  [`WindDirection_d${d}`, `value.direction.wind.forecast.${d - 1}`, 'number', '°'],
  [`WindDirectionStr_d${d}`, `weather.direction.wind.forecast.${d - 1}`, 'string', ''],
  [`DayOfWeek_d${d}`, `dayofweek.forecast.${d - 1}`, 'string', ''],
  [`PrecipitationProbability_d${d}`, `value.precipitation.forecast.${d - 1}`, 'number', '%'],
  [`TotalLiquidVolume_d${d}`, `value.precipitation.forecast.${d - 1}`, 'number', 'mm'],
];
const ACCU_DAILY: Row[] = [
  ['Date', 'date', 'string'],
  ['Sunrise', 'date.sunrise', 'string'],
  ['Sunset', 'date.sunset', 'string'],
  ['HoursOfSun', 'value', 'number'],
  ['Temperature.Minimum', 'value.temperature.min', 'number', '°C'],
  ['Temperature.Maximum', 'value.temperature.max', 'number', '°C'],
  ['RealFeelTemperature.Minimum', 'value.temperature.feelslike.min', 'number', '°C'],
  ['RealFeelTemperature.Maximum', 'value.temperature.feelslike.max', 'number', '°C'],
];
const ACCU_DAYPART: Row[] = [
  ['Icon', 'value', 'number'],
  ['IconURL', 'media.url', 'string'],
  ['IconURLS', 'weather.icon', 'string'],
  ['IconPhrase', 'weather.state', 'string'],
  ['HasPrecipitation', 'value', 'boolean'],
  ['ShortPhrase', 'weather.state.description', 'string'],
  ['LongPhrase', 'value', 'string'],
  ['PrecipitationProbability', 'value.precipitation', 'number', '%'],
  ['ThunderstormProbability', 'value', 'number', '%'],
  ['RainProbability', 'value', 'number', '%'],
  ['SnowProbability', 'value', 'number', '%'],
  ['IceProbability', 'value', 'number', '%'],
  ['WindSpeed', 'value.speed.wind', 'number', 'km/h'],
  ['WindDirection', 'value.direction.wind', 'string', '°'],
  ['WindGust', 'value', 'number', 'km/h'],
  ['RainVolume', 'value', 'number', 'mm'],
  ['SnowVolume', 'value', 'number', 'mm'],
  ['IceVolume', 'value', 'number', 'mm'],
  ['TotalLiquidVolume', 'value.precipitation', 'number', 'mm'],
];
const ACCU_HOUR: Row[] = [
  ['DateTime', 'date', 'string'],
  ['WeatherIcon', 'value', 'number'],
  ['CloudCover', 'value', 'number'],
  ['WeatherIconURL', 'media.url', 'string'],
  ['WeatherIconURLS', 'weather.icon', 'string'],
  ['IconPhrase', 'weather.state', 'string'],
  ['HasPrecipitation', 'value', 'boolean'],
  ['Temperature', 'value.temperature', 'number', '°C'],
  ['RealFeelTemperature', 'value.temperature.feelslike', 'number', '°C'],
  ['DewPoint', 'value', 'number', '°C'],
  ['WindSpeed', 'value.speed.wind', 'number', 'km/h'],
  ['WindDirection', 'value.direction.wind', 'string', '°'],
  ['WindGust', 'value', 'number', 'km/h'],
  ['RelativeHumidity', 'value.humidity', 'number', '%'],
  ['UVIndex', 'value', 'number'],
  ['UVIndexText', 'value', 'string'],
  ['PrecipitationProbability', 'value.precipitation', 'number', '%'],
  ['RainProbability', 'value', 'number', '%'],
  ['SnowProbability', 'value', 'number', '%'],
  ['IceProbability', 'value', 'number', '%'],
  ['RainVolume', 'value', 'number', 'mm'],
  ['SnowVolume', 'value', 'number', 'mm'],
  ['IceVolume', 'value', 'number', 'mm'],
  ['TotalLiquidVolume', 'value.precipitation', 'number', 'mm'],
];
const ACCU_ICON = (n: number): string => `http://vortex.accuweather.com/adc2010/images/slate/icons/${String(n).padStart(2, '0')}.svg`;
const ACCUWEATHER = ioObjects([
  ioChannel(`${ACCU}.Current`, 'Current Conditions'),
  ...rows(`${ACCU}.Current`, ACCU_CURRENT),
  ioChannel(`${ACCU}.Summary`, 'Weather Summary'),
  ...rows(`${ACCU}.Summary`, ACCU_SUMMARY),
  ...[1, 2, 3, 4, 5].flatMap((d) => rows(`${ACCU}.Summary`, ACCU_SUMMARY_DAY(d))),
  ...[1, 2, 3, 4, 5].flatMap((d) => [
    ioChannel(`${ACCU}.Daily.Day${d}`, `Day ${d} Forecast`),
    ...rows(`${ACCU}.Daily.Day${d}`, ACCU_DAILY, `.forecast.${d - 1}`),
    ...rows(`${ACCU}.Daily.Day${d}.Day`, ACCU_DAYPART, `.forecast.${d - 1}`),
    ...rows(`${ACCU}.Daily.Day${d}.Night`, ACCU_DAYPART, `.forecast.${d - 1}`),
  ]),
  ...[0, 1].flatMap((h) => [ioChannel(`${ACCU}.Hourly.h${h}`, `Hour ${h} Forecast`), ...rows(`${ACCU}.Hourly.h${h}`, ACCU_HOUR, `.forecast.${h}`)]),
]);
const ACCUWEATHER_VALUES: Record<string, SourceValue> = {
  [`${ACCU}.Current.Temperature`]: val(17.3),
  [`${ACCU}.Current.RealFeelTemperatureShade`]: val(15.1),
  [`${ACCU}.Current.WeatherText`]: val('Partly sunny'),
  [`${ACCU}.Current.WeatherIconURLS`]: val(ACCU_ICON(3)),
  [`${ACCU}.Summary.Temperature`]: val(17.3),
  [`${ACCU}.Summary.CurrentDateTime`]: val('2026-09-23T10:45:00+02:00'),
  [`${ACCU}.Summary.WeatherIconURL`]: val(ACCU_ICON(3)),
  [`${ACCU}.Summary.WeatherText`]: val('Partly sunny'),
  ...Object.fromEntries(
    [1, 2, 3, 4, 5].flatMap((d) => [
      [`${ACCU}.Summary.DateTime_d${d}`, val(`2026-09-${22 + d}T07:00:00+02:00`)],
      [`${ACCU}.Summary.WeatherIconURL_d${d}`, val(ACCU_ICON(d))],
      [`${ACCU}.Summary.WeatherText_d${d}`, val(`Day ${d} text`)],
      [`${ACCU}.Summary.TempMin_d${d}`, val(8 + d)],
      [`${ACCU}.Summary.TempMax_d${d}`, val(18 + d)],
      [`${ACCU}.Summary.PrecipitationProbability_d${d}`, val(10 * d)],
      [`${ACCU}.Summary.TotalLiquidVolume_d${d}`, val(d / 10)],
    ]),
  ),
  [`${ACCU}.Daily.Day1.Date`]: val('2026-09-23T07:00:00+02:00'),
  [`${ACCU}.Daily.Day1.Temperature.Minimum`]: val(9),
  [`${ACCU}.Daily.Day1.Temperature.Maximum`]: val(19),
  [`${ACCU}.Daily.Day1.Day.IconURLS`]: val(ACCU_ICON(2)),
  [`${ACCU}.Daily.Day1.Night.IconURLS`]: val(ACCU_ICON(34)),
};

// ioBroker.openweathermap 2.0.0: io-package.json instanceObjects, then
// build/main.js processTasks: day1..day5 states are day0's objects copied
// WITHOUT a channel object, their role's trailing digit replaced by the day;
// periodN copies get `.undefined` (task.day is unset for them).
const OWM = 'openweathermap.0.forecast';
const OWM_CURRENT: Row[] = [
  ['date', 'date', 'number'],
  ['day', 'date', 'string'],
  ['day_short', 'date', 'string'],
  ['icon', 'weather.icon', 'string'],
  ['state', 'weather.state', 'string'],
  ['title', 'weather.title', 'string'],
  ['temperature', 'value.temperature', 'number', '°C'],
  ['temperatureFeel', 'value.temperature.feel', 'number', '°C'],
  ['temperatureMin', 'value.temperature.min', 'number', '°C'],
  ['temperatureMax', 'value.temperature.max', 'number', '°C'],
  ['clouds', 'value.clouds', 'number', '%'],
  ['windDirection', 'value.direction.wind', 'number', '°'],
  ['windDirectionText', 'value.direction.wind', 'string', ''],
  ['windSpeed', 'value.speed.wind', 'number', 'm/s'],
  ['windGust', 'value.gust.wind', 'number', 'm/s'],
  ['pressure', 'value.pressure', 'number', 'hPa'],
  ['humidity', 'value.humidity', 'number', '%'],
  ['visibility', 'value.distance.visibility', 'number', 'm'],
  ['sunrise', 'date.sunrise', 'number'],
  ['sunset', 'date.sunset', 'number'],
  ['precipitation', 'weather.precipitation', 'number', 'mm'],
  ['precipitationRain', 'weather.precipitation.rain', 'number', 'mm'],
  ['precipitationSnow', 'weather.precipitation.snow', 'number', 'mm'],
];
const OWM_DAY: Row[] = [
  ['date', 'date.forecast.0', 'number'],
  ['day', 'date.forecast.0', 'string'],
  ['day_short', 'date.forecast.0', 'string'],
  ['icon', 'weather.icon.forecast.0', 'string'],
  ['state', 'weather.state.forecast.0', 'string'],
  ['title', 'weather.title.forecast.0', 'string'],
  ['temperatureFeel', 'value.temperature.feel.forecast.0', 'number', '°C'],
  ['temperatureMin', 'value.temperature.min.forecast.0', 'number', '°C'],
  ['temperatureMax', 'value.temperature.max.forecast.0', 'number', '°C'],
  ['clouds', 'value.clouds.forecast.0', 'number', '%'],
  ['precipitation', 'weather.precipitation.forecast.0', 'number', 'mm'],
  ['precipitationRain', 'weather.precipitation.rain.forecast.0', 'number', 'mm'],
  ['precipitationSnow', 'weather.precipitation.snow.forecast.0', 'number', 'mm'],
  ['windDirection', 'value.direction.wind.forecast.0', 'number', '°'],
  ['windDirectionText', 'value.direction.wind.forecast.0', 'string', ''],
  ['windSpeed', 'value.speed.wind.forecast.0', 'number', 'm/s'],
  ['pressure', 'value.pressure.forecast.0', 'number', 'hPa'],
  ['humidity', 'value.humidity.forecast.0', 'number', '%'],
  ['visibility', 'value.distance.visibility', 'number', 'm'],
];
const owmDay = (prefix: string, day: string): IoObject[] =>
  OWM_DAY.map(([key, role, type, unit]) => ioState(`${prefix}.${key}`, role.replace(/\.\d+$/, `.${day}`), type, unit));
const WEEKDAYS = ['Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag', 'Montag'];
const OPENWEATHERMAP = ioObjects([
  ioDevice(OWM, 'Actual weather or forecast', { role: 'weather' }),
  ioChannel(`${OWM}.current`, 'Actual weather for today', { role: 'weather.current' }),
  ...rows(`${OWM}.current`, OWM_CURRENT),
  ioChannel(`${OWM}.day0`, 'Actual weather or forecast', { role: 'weather.forecast' }),
  ...[0, 1, 2, 3, 4, 5].flatMap((d) => owmDay(`${OWM}.day${d}`, String(d))),
  ...[0, 1].flatMap((p) => owmDay(`${OWM}.period${p}`, 'undefined')),
]);
const OPENWEATHERMAP_VALUES: Record<string, SourceValue> = {
  [`${OWM}.current.temperature`]: val(18.6),
  [`${OWM}.current.state`]: val('Leichter Regen'),
  [`${OWM}.current.icon`]: val('https://openweathermap.org/img/w/10d.png'),
  ...Object.fromEntries(
    [0, 1, 2, 3, 4, 5].flatMap((d) => [
      [`${OWM}.day${d}.temperatureMin`, val(9 + d)],
      [`${OWM}.day${d}.temperatureMax`, val(19 + d)],
      [`${OWM}.day${d}.icon`, val(`https://openweathermap.org/img/w/0${d + 1}d.png`)],
      [`${OWM}.day${d}.state`, val(`Tag ${d}`)],
      [`${OWM}.day${d}.day`, val(WEEKDAYS[d])],
      [`${OWM}.day${d}.day_short`, val(WEEKDAYS[d]!.slice(0, 2))],
      [`${OWM}.day${d}.date`, val(1_758_621_600_000 + d * 86_400_000)],
    ]),
  ),
};

// ioBroker.weatherunderground 3.7.0: main.js checkWeatherVariables, metric.
const WU = 'weatherunderground.0.forecast';
const WU_CURRENT: Row[] = [
  ['displayLocationFull', 'location', 'string'],
  ['observationTime', 'date', 'string'],
  ['observationTimeRFC822', 'state', 'string'],
  ['weather', 'weather.state', 'string'],
  ['temp', 'value.temperature', 'number', '°C'],
  ['dewPoint', 'value.temperature.dewpoint', 'number', '°C'],
  ['windChill', 'value.temperature.windchill', 'number', '°C'],
  ['feelsLike', 'value.temperature.feelslike', 'number', '°C'],
  ['visibility', 'value.distance.visibility', 'number', 'km'],
  ['relativeHumidity', 'value.humidity', 'number', '%'],
  ['windDegrees', 'value.direction.wind', 'number', '°'],
  ['windDirection', 'value.direction.wind', 'string'],
  ['wind', 'value.speed.wind', 'number', 'km/h'],
  ['windGust', 'value.speed.wind.gust', 'number', 'km/h'],
  ['pressure', 'value.pressure', 'number', 'mbar'],
  ['UV', 'value.uv', 'number'],
  ['precipitationHour', 'value.precipitation.hour', 'number', 'mm'],
  ['precipitationDay', 'value.precipitation.today', 'number', 'mm'],
  ['iconURL', 'weather.icon', 'number'],
  ['forecastURL', 'weather.chart.url.forecast', 'string'],
  ['historyURL', 'weather.chart.url', 'string'],
];
const WU_DAY = (p: number): Row[] => [
  ['date', `date.forecast.${p}`, 'string'],
  ['tempMax', `value.temperature.max.forecast.${p}`, 'number', '°C'],
  ['tempMin', `value.temperature.min.forecast.${p}`, 'number', '°C'],
  ['precipitationAllDay', `value.precipitation.today.forecast.${p}`, 'number', 'mm'],
  ['precipitationDay', `value.precipitation.day.forecast.${p}`, 'number', 'mm'],
  ['cloudCover', `value.cloudcover.day.forecast.${p}`, 'number', '%'],
  ['precipitationNight', `value.precipitation.night.forecast.${p}`, 'number', 'mm'],
  ['snowAllDay', `value.snow.forecast.${p}`, 'number', 'cm'],
  ['windSpeedMax', `value.speed.max.wind.forecast.${p}`, 'number', 'km/h'],
  ['windSpeed', `value.speed.wind.forecast.${p}`, 'number', 'km/h'],
  ['icon', `weather.icon.name.forecast.${p}`, 'number'],
  ['state', `weather.state.forecast.${p}`, 'string'],
  ['iconURL', `weather.icon.forecast.${p}`, 'string'],
  ['precipitationChance', `value.precipitation.forecast.${p}`, 'number', '%'],
  ['windDirectionMax', `weather.direction.max.wind.forecast.${p}`, 'string'],
  ['windDegreesMax', `value.direction.max.wind.forecast.${p}`, 'number', '°'],
  ['windDirection', `weather.direction.wind.forecast.${p}`, 'string'],
  ['windDegrees', `value.direction.wind.forecast.${p}`, 'number', '°'],
  ['humidity', `value.humidity.forecast.${p}`, 'number', '%'],
  ['humidityMax', `value.humidity.max.forecast.${p}`, 'number', '%'],
  ['humidityMin', `value.humidity.min.forecast.${p}`, 'number', '%'],
];
const WEATHERUNDERGROUND = ioObjects([
  ioDevice(WU, 'Forecast for next 4 days days and current conditions', { role: 'forecast' }),
  ioChannel(`${WU}.current`, 'Current conditions', { role: 'weather' }),
  ...rows(`${WU}.current`, WU_CURRENT),
  ...[0, 1, 2, 3, 4, 5].flatMap((p) => [ioChannel(`${WU}.${p}d`, `in ${p}days`, { role: 'forecast' }), ...rows(`${WU}.${p}d`, WU_DAY(p))]),
]);
const WEATHERUNDERGROUND_VALUES: Record<string, SourceValue> = {
  [`${WU}.current.temp`]: val(16.2),
  [`${WU}.current.weather`]: val('Mostly Cloudy'),
  [`${WU}.current.iconURL`]: val('https://icons.wxug.com/i/c/k/mostlycloudy.gif'),
  ...Object.fromEntries(
    [0, 1, 2, 3, 4, 5].flatMap((p) => [
      [`${WU}.${p}d.date`, val(`2026-09-${23 + p}`)],
      [`${WU}.${p}d.tempMin`, val(7 + p)],
      [`${WU}.${p}d.tempMax`, val(17 + p)],
      [`${WU}.${p}d.iconURL`, val(`https://icons.wxug.com/i/c/k/${p}.gif`)],
      [`${WU}.${p}d.precipitationChance`, val(5 * p)],
    ]),
  ),
};

// ioBroker.daswetter 4.5.10 (Meteored): build/lib/meteored.js CreateObjects /
// CreateObjectsHourly. Every ForecastDaily day uses the day-0 roles.
const DW = 'daswetter.0.location_1';
const DW_DAY: Row[] = [
  ['date_full', 'date', 'string'],
  ['date', 'date', 'string'],
  ['NameOfDay', 'dayofweek', 'string'],
  ['start', 'date', 'number'],
  ['symbol', 'value', 'number'],
  ['symbol_URL', 'weather.icon', 'string'],
  ['symbol_description', 'weather.state.forecast.0', 'string'],
  ['Temperature_Min', 'value.temperature.min.forecast.0', 'number', '°C'],
  ['Temperature_Max', 'value.temperature.max.forecast.0', 'number', '°C'],
  ['Wind_Speed', 'value.speed.wind.forecast.0', 'number', 'km/h'],
  ['Wind_Speed_Beauforts', 'value.speed.wind.forecast.0', 'number'],
  ['Wind_Gust', 'value.speed.wind.gust', 'number', 'km/h'],
  ['Wind_Direction', 'weather.direction.wind.forecast.0', 'string'],
  ['Wind_symbol_URL', 'weather.icon.wind', 'string'],
  ['Rain', 'value.precipitation', 'number', 'mm'],
  ['Rain_Probability', 'value.precipitation.chance', 'number', '%'],
  ['Humidity', 'value.humidity', 'number', '%'],
  ['Pressure', 'value.pressure.forecast.0', 'number', 'hPa'],
  ['Snowline', 'value', 'number', 'm'],
  ['UV_index_max', 'value.uv', 'number'],
  ['Sun_in', 'date.sunrise', 'string'],
  ['Sun_mid', 'date', 'string'],
  ['Sun_out', 'date.sunset', 'string'],
  ['Moon_in', 'date', 'string'],
  ['Moon_out', 'date', 'string'],
  ['Sun_in_full', 'date.sunrise', 'number'],
  ['Sun_mid_full', 'date', 'number'],
  ['Sun_out_full', 'date.sunset', 'number'],
  ['Moon_in_full', 'date', 'number'],
  ['Moon_out_full', 'date', 'number'],
  ['Moon_symbol', 'value', 'number'],
  ['Moon_symbol_URL', 'text', 'string'],
  ['Moon_illumination', 'value', 'number', '%'],
];
const DW_HOUR: Row[] = [
  ['end', 'date', 'number'],
  ['time', 'date', 'string'],
  ['symbol', 'value', 'number'],
  ['symbol_URL', 'weather.icon', 'string'],
  ['symbol_description', 'text', 'string'],
  ['night', 'state', 'boolean'],
  ['temperature', 'value.temperature.max.forecast.0', 'number', '°C'],
  ['temperature_feels_like', 'value.temperature.feelslike', 'number', '°C'],
  ['wind_speed', 'value.speed.wind.forecast.0', 'number', 'km/h'],
  ['wind_speed_Beauforts', 'value.speed.wind.forecast.0', 'number'],
  ['wind_gust', 'value.speed.wind.gust', 'number', 'km/h'],
  ['wind_direction', 'weather.direction.wind.forecast.0', 'string'],
  ['Wind_symbol_URL', 'weather.icon.wind', 'string'],
  ['rain', 'value.precipitation', 'number', 'mm'],
  ['rain_probability', 'value.precipitation.chance', 'number', '%'],
  ['humidity', 'value.humidity', 'number', '%'],
  ['pressure', 'value', 'number', 'hPa'],
  ['snowline', 'value.snowline', 'number', 'm'],
  ['uv_index_max', 'value.uv', 'number'],
  ['clouds', 'value.clouds', 'number', '%'],
];
const DW_HOURS = [...Array.from({ length: 24 }, (_, h) => `Hour_${h + 1}`), 'Current'];
const DASWETTER = ioObjects([
  ioChannel(DW, 'location'),
  ioState(`${DW}.Location`, 'location', 'string'),
  ioState(`${DW}.URL`, 'weather.chart.url.forecast', 'string'),
  ioState(`${DW}.LastDownloadTime`, 'date', 'string'),
  ioChannel(`${DW}.ForecastDaily`, 'ForecastDaily'),
  ...[1, 2, 3, 4, 5].flatMap((d) => [
    ioChannel(`${DW}.ForecastDaily.Day_${d}`, `ForecastDaily Day_${d}`),
    ...rows(`${DW}.ForecastDaily.Day_${d}`, d === 1 ? [...DW_DAY, ['sunshineduration', 'value', 'number', 'hours']] : DW_DAY),
  ]),
  ioChannel(`${DW}.ForecastHourly`, 'ForecastHourly'),
  ioState(`${DW}.ForecastHourly.date_full`, 'date', 'string'),
  ioState(`${DW}.ForecastHourly.date`, 'date', 'string'),
  ...DW_HOURS.flatMap((h) => [ioChannel(`${DW}.ForecastHourly.${h}`, `ForecastDaily ${h}`), ...rows(`${DW}.ForecastHourly.${h}`, DW_HOUR)]),
]);
const DW_ICON = (n: number): string => `/daswetter.admin/icons/weather/gallery1/png/64x64/${n}.png`;
const DASWETTER_VALUES: Record<string, SourceValue> = {
  ...Object.fromEntries(
    [1, 2, 3, 4, 5].flatMap((d) => [
      // toISOString(): local midnight in UTC, the day BEFORE in UTC+ zones.
      [`${DW}.ForecastDaily.Day_${d}.date_full`, val(`2026-09-${21 + d}T22:00:00.000Z`)],
      [`${DW}.ForecastDaily.Day_${d}.symbol_URL`, val(DW_ICON(d))],
      [`${DW}.ForecastDaily.Day_${d}.symbol_description`, val(`Tag ${d}`)],
      [`${DW}.ForecastDaily.Day_${d}.Temperature_Min`, val(6 + d)],
      [`${DW}.ForecastDaily.Day_${d}.Temperature_Max`, val(16 + d)],
      [`${DW}.ForecastDaily.Day_${d}.Rain`, val(d / 2)],
    ]),
  ),
  ...Object.fromEntries(
    DW_HOURS.flatMap((h, i) => [
      [`${DW}.ForecastHourly.${h}.symbol`, val(i % 7)],
      [`${DW}.ForecastHourly.${h}.symbol_URL`, val(DW_ICON(i % 7))],
      [`${DW}.ForecastHourly.${h}.temperature`, val(12 + (i % 5))],
      [`${DW}.ForecastHourly.${h}.pressure`, val(1013)],
    ]),
  ),
};

interface Run {
  device: DeviceInput;
  entity: VirtualEntity | null;
}

const runAll = (all: IoObjects, values: Record<string, SourceValue>): Run[] =>
  discoverDevices(all, 'hometiles.0').devices.map((device) => ({ device, entity: synthesise(device, `${device.domain}.under_test`, values) }));
const weathers = (runs: Run[]): Run[] => runs.filter((run) => run.entity?.domain === 'weather');
const weatherIds = (runs: Run[]): string[] => weathers(runs).map((run) => run.device.objectId);
const forecast = (run: Run | undefined): Array<Record<string, unknown>> => run?.entity?.attributes.forecast as Array<Record<string, unknown>>;
const only = (runs: Run[], objectId: string): Run => {
  const found = runs.find((run) => run.device.objectId === objectId);
  if (!found) throw new Error(`nothing detected at ${objectId}; got ${runs.map((run) => run.device.objectId).join(', ')}`);
  return found;
};

/** Discovery's own invariants hold with weather in the tree: stable ids, and no identifying state behind two entities. */
function expectStableDiscovery(all: IoObjects): void {
  const ids = (objects: IoObjects): Record<string, string> =>
    new EntityRegistry({ onEntityChanged: () => undefined, onMembershipChanged: () => undefined }, 0).rebuild(
      discoverDevices(objects, 'hometiles.0').devices,
      {},
    ).entityIds;
  expect(ids(Object.fromEntries(Object.entries(all).reverse())), 'reversing the object order').to.deep.equal(ids(all));
  const { devices, anchors } = discoverDevices(all, 'hometiles.0');
  // A restart reads the anchors the first run recorded, the merged-away
  // current conditions' root among them: the same devices come back.
  const restart = discoverDevices(all, 'hometiles.0', anchors);
  expect(restart.devices, 'a restart with the recorded anchors').to.deep.equal(devices);
  expect(restart.anchors).to.deep.equal(anchors);
  const owners = new Map<string, string>();
  for (const detected of devices) {
    const anchor = anchors[detected.objectId] ?? detected.objectId;
    expect(Object.values(detected.channels).map((ch) => ch.objectId), `${detected.objectId} is backed by its anchor`).to.include(anchor);
    expect(owners.get(anchor) ?? detected.objectId, `${anchor} backs two entities`).to.equal(detected.objectId);
    owners.set(anchor, detected.objectId);
  }
}

describe('weather with the real type-detector (Task 11)', () => {
  describe('OpenWeatherMap', () => {
    it('is ONE entity: the current conditions and all six forecast days under the forecast device', () => {
      const runs = runAll(OPENWEATHERMAP, OPENWEATHERMAP_VALUES);
      // The day0 channel holds the only forecast the detector ties to one
      // channel; the device root sees days 1..5 and the current temperature
      // as the same forecast again, and the current channel is its current
      // conditions. Neither may become an entity of its own.
      expect(weatherIds(runs)).to.deep.equal([`${OWM}.day0`]);
      const owm = only(runs, `${OWM}.day0`);
      expect(owm.entity!.attributes).to.include({
        friendly_name: 'Actual weather or forecast',
        temperature: 18.6,
        temperature_unit: '°C',
        weather_state: 'Leichter Regen',
        weather_icon: 'https://openweathermap.org/img/w/01d.png',
      });
      expect(forecast(owm)).to.have.lengthOf(6);
    });

    it("keeps the adapter's dates as they are: weekday names, since its real date is a number the pattern's DATE (a string) cannot bind", () => {
      const owm = only(runAll(OPENWEATHERMAP, OPENWEATHERMAP_VALUES), `${OWM}.day0`);
      // Day 0's DATE is the detector's pick among day0.day/day0.day_short;
      // days 1..5 come from the device root's DATE%d, day<k>.day first.
      expect(forecast(owm).map((entry) => entry.date)).to.deep.equal(['Mi', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag', 'Montag']);
      expect(forecast(owm)[5]).to.include({ temperature: 24, temperature_unit: '°C', templow: 14, templow_unit: '°C' });
    });

    it('keeps discovery stable', () => expectStableDiscovery(OPENWEATHERMAP));
  });

  describe('Weather Underground', () => {
    it('is ONE entity with six days, dated YYYY-MM-DD, and the current conditions', () => {
      const runs = runAll(WEATHERUNDERGROUND, WEATHERUNDERGROUND_VALUES);
      expect(weatherIds(runs)).to.deep.equal([`${WU}.0d`]);
      const wu = only(runs, `${WU}.0d`);
      expect(wu.entity!.attributes).to.include({ temperature: 16.2, temperature_unit: '°C', weather_state: 'Mostly Cloudy' });
      expect(forecast(wu).map((entry) => entry.date)).to.deep.equal([
        '2026-09-23',
        '2026-09-24',
        '2026-09-25',
        '2026-09-26',
        '2026-09-27',
        '2026-09-28',
      ]);
      expect(forecast(wu)[2]).to.include({ templow: 9, temperature: 19, precipitation_probability: 10, weather_icon: 'https://icons.wxug.com/i/c/k/2.gif' });
    });

    it('keeps discovery stable', () => expectStableDiscovery(WEATHERUNDERGROUND));
  });

  describe('AccuWeather', () => {
    it("publishes the Summary's five days, its day 0 from the _d1 states, not the current ones competing for the same roles", () => {
      const summary = only(runAll(ACCUWEATHER, ACCUWEATHER_VALUES), `${ACCU}.Summary`);
      expect(summary.entity!.attributes).to.include({ temperature: 17.3, temperature_unit: '°C', weather_state: 'Day 1 text' });
      expect(forecast(summary)).to.have.lengthOf(5);
      expect(forecast(summary)[0]).to.deep.equal({
        date: '2026-09-23T07:00:00+02:00',
        weather_state: 'Day 1 text',
        weather_icon: ACCU_ICON(1),
        temperature: 19,
        temperature_unit: '°C',
        templow: 9,
        templow_unit: '°C',
        precipitation: 0.1,
        precipitation_unit: 'mm',
        precipitation_probability: 10,
        precipitation_probability_unit: '%',
      });
      expect(forecast(summary)[4]).to.include({ date: '2026-09-27T07:00:00+02:00', temperature: 23, templow: 13 });
      // The current-conditions states the detector names ICON0/DATE0/STATE0
      // are no channel: nothing reads them, so nothing subscribes them.
      const competing = [`${ACCU}.Summary.WeatherIconURL`, `${ACCU}.Summary.CurrentDateTime`, `${ACCU}.Summary.WeatherText`];
      expect(Object.values(summary.device.channels).filter((ch) => competing.includes(ch.objectId))).to.deep.equal([]);
    });

    it('keeps its Current channel as current conditions of its own: no object ties it to the Summary', () => {
      const runs = runAll(ACCUWEATHER, ACCUWEATHER_VALUES);
      expect(weatherIds(runs)).to.deep.equal([`${ACCU}.Daily.Day1`, `${ACCU}.Current`, `${ACCU}.Summary`]);
      const current = only(runs, `${ACCU}.Current`);
      // Temperature, not RealFeelTemperatureShade, which shares its role.
      expect(current.entity!.attributes).to.include({ temperature: 17.3, weather_state: 'Partly sunny', weather_icon: ACCU_ICON(3) });
      expect(current.entity!.attributes).to.not.have.property('forecast');
    });

    it("reads Daily.Day1 as the one day its roles describe; Day2..5 and the hours are no weather at all", () => {
      const daily = only(runAll(ACCUWEATHER, ACCUWEATHER_VALUES), `${ACCU}.Daily.Day1`);
      expect(forecast(daily)).to.deep.equal([
        {
          date: '2026-09-23T07:00:00+02:00',
          // The detector's pick between the Day and Night parts' icons.
          weather_icon: ACCU_ICON(34),
          temperature: 19,
          temperature_unit: '°C',
          templow: 9,
          templow_unit: '°C',
        },
      ]);
      expect(daily.entity!.attributes).to.not.have.property('temperature');
    });

    it('keeps discovery stable', () => expectStableDiscovery(ACCUWEATHER));
  });

  describe('DasWetter', () => {
    it('publishes each ForecastDaily day channel as the one day it describes', () => {
      const runs = runAll(DASWETTER, DASWETTER_VALUES);
      expect(weatherIds(runs)).to.deep.equal([1, 2, 3, 4, 5].map((d) => `${DW}.ForecastDaily.Day_${d}`));
      expect(forecast(only(runs, `${DW}.ForecastDaily.Day_2`))).to.deep.equal([
        {
          date: '2026-09-23T22:00:00.000Z',
          weather_state: 'Tag 2',
          weather_icon: DW_ICON(2),
          temperature: 18,
          temperature_unit: '°C',
          templow: 8,
          templow_unit: '°C',
          precipitation: 1,
          precipitation_unit: 'mm',
        },
      ]);
    });

    it('publishes no hour as current weather: the detector binds its ACTUAL to the weather symbol number', () => {
      const runs = runAll(DASWETTER, DASWETTER_VALUES);
      const hours = runs.filter((run) => run.device.objectId.startsWith(`${DW}.ForecastHourly.`) && run.device.detectorType === 'weatherCurrent');
      expect(hours.map((run) => run.device.channels.actual?.objectId)).to.include(`${DW}.ForecastHourly.Hour_1.symbol`);
      expect(hours).to.have.lengthOf(25);
      expect(hours.filter((run) => run.entity !== null)).to.deep.equal([]);
    });

    it("publishes nothing mixing an hour's icon and temperature with a day's low: the location's forecast is no source of its own", () => {
      const runs = runAll(DASWETTER, DASWETTER_VALUES);
      expect(runs.filter((run) => run.device.detectorType === 'weatherForecast').map((run) => run.device.objectId)).to.not.include(DW);
    });

    it('keeps discovery stable', () => expectStableDiscovery(DASWETTER));
  });

  it('the real synth carries channelMeta with each unit (Ruling 23)', () => {
    const owm = only(runAll(OPENWEATHERMAP, OPENWEATHERMAP_VALUES), `${OWM}.day0`).entity!;
    expect(owm.channelMeta?.temp_max5).to.include({ type: 'number', unit: '°C', current: 24, write: false });
    expect(owm.channelMeta?.actual).to.include({ unit: '°C', current: 18.6 });
    expect(owm.writable).to.equal(undefined);
  });

  it('subscribes only the states the weather synth reads', () => {
    const registry = new EntityRegistry({ onEntityChanged: () => undefined, onMembershipChanged: () => undefined }, 0);
    const { subscribe } = registry.rebuild(discoverDevices(OPENWEATHERMAP, 'hometiles.0').devices, {});
    // Six days of high, low, icon, text and date, plus the current
    // temperature and text; no wind, pressure, humidity, sun or charts.
    expect(subscribe.filter((id) => /\.(windSpeed|pressure|humidity|sunrise|clouds|visibility)$/.test(id))).to.deep.equal([]);
    expect(subscribe).to.include.members([`${OWM}.current.temperature`, `${OWM}.current.state`, `${OWM}.day5.temperatureMax`]);
  });
});
