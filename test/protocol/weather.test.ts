import { expect } from 'chai';
import { buildWeatherPayload } from '../../src/protocol/weather';
import { STATE_UNAVAILABLE, STATE_UNKNOWN, type VirtualEntity } from '../../src/registry/types';

/** A weather entity as synth/weather.ts builds one: provider text and icon, raw day dates, declared units. */
function weather(attributes: Record<string, unknown>, state = STATE_UNKNOWN): VirtualEntity {
  return {
    entityId: 'weather.home',
    domain: 'weather',
    source: {},
    state,
    attributes: { friendly_name: 'Zuhause', ...attributes },
    available: state !== STATE_UNAVAILABLE,
    lastChanged: 0,
  };
}

type Json = Record<string, unknown> & { forecast?: Array<Record<string, unknown>> };
const publish = (attributes: Record<string, unknown>): string => buildWeatherPayload(weather(attributes));
const parse = (attributes: Record<string, unknown>): Json => JSON.parse(publish(attributes)) as Json;
const conditionOf = (weather_state: unknown, weather_icon?: unknown): unknown => parse({ weather_state, weather_icon }).condition;

/*
 * What the panel reads, by its own rule: every lookup takes the FIRST
 * `"key"` in the whole payload -- a forecast entry's key included -- then the
 * value after the next colon (json_scan.h:34-60, tile_renderer.cpp:802-816).
 * JSON.parse cannot see this: it would find the right key wherever it sits.
 */
function after(payload: string, key: string): string | undefined {
  const at = payload.indexOf(`"${key}"`);
  return at < 0 ? undefined : payload.slice(payload.indexOf(':', at) + 1).trimStart();
}
/** The tile's string reader: the next quoted run after that colon, '' being no value (tile_renderer.cpp:802-816). */
function panelText(payload: string, key: string): string | undefined {
  const rest = after(payload, key);
  if (rest === undefined) return undefined;
  const open = rest.indexOf('"');
  return rest.slice(open + 1, rest.indexOf('"', open + 1)).trim() || undefined;
}
/** A bare number, else a numeric string (tile_renderer.cpp:924-936, json_scan.h:128-137). */
function panelNumber(payload: string, key: string): number | undefined {
  const rest = after(payload, key);
  if (rest === undefined) return undefined;
  const value = rest.startsWith('"') ? Number.parseFloat((panelText(payload, key) ?? '').replace(',', '.')) : Number.parseFloat(rest);
  return Number.isNaN(value) ? undefined : value;
}
/** The tile reads `state` before `condition` (tile_renderer.cpp:2552-2554), the popup `condition` first (weather_popup.cpp:1040-1060). */
const tileCondition = (payload: string): string | undefined => panelText(payload, 'state') ?? panelText(payload, 'condition');
const popupCondition = (payload: string): string | undefined =>
  panelText(payload, 'condition') ?? panelText(payload, 'c') ?? panelText(payload, 'state');

/** Runs `read` with the host in `zone`, restoring the zone after. Node re-reads process.env.TZ on assignment. */
function inZone<T>(zone: string, read: () => T): T {
  const saved = process.env.TZ;
  process.env.TZ = zone;
  try {
    return read();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

const datesOf = (...dates: unknown[]): unknown[] =>
  (parse({ forecast: dates.map((date) => ({ date, temperature: 20 })) }).forecast ?? []).map((day) => day.date_local);

// ioBroker.daswetter 4.5.10 build/i18n/de.json: every text the adapter
// publishes, its English key beside its German value, by the condition each is.
const DASWETTER_TEXTS: Record<string, Array<[string, string]>> = {
  sunny: [
    ['Clear', 'Klar'],
    ['Clear sky', 'Klarer Himmel'],
  ],
  partlycloudy: [
    ['High clouds', 'Hohe Wolken'],
    ['Scattered clouds', 'Aufgelockerte Bewölkung'],
    ['Partly cloudy', 'Teilweise bewölkt'],
  ],
  cloudy: [['Overcast', 'Bedeckt']],
  fog: [
    ['Dust haze', 'Staubdunst'],
    ['Dust haze with clear sky', 'Staubdunst bei klarem Himmel'],
    ['Mist', 'Nebel'],
    ['Fog', 'Dichter Nebel'],
  ],
  lightning: [
    ['Dry thunderstorm', 'Trockengewitter'],
    ['Dry thunderstorm with partly cloudy sky', 'Trockengewitter bei teilweise bewölktem Himmel'],
    ['Dry thunderstorm with cloudy sky', 'Trockengewitter bei bewölktem Himmel'],
    ['Thunderstorm', 'Gewitter'],
    ['Thunderstorm with partly cloudy sky', 'Gewitter bei teilweise bewölktem Himmel'],
    ['Thunderstorm with cloudy sky', 'Gewitter bei bewölktem Himmel'],
  ],
  rainy: [
    ['Light rain', 'Leichter Regen'],
    ['Light rain with partly cloudy sky', 'Leichter Regen bei teilweise bewölktem Himmel'],
    ['Light rain with cloudy sky', 'Leichter Regen bei bewölktem Himmel'],
    ['Moderate rain', 'Mäßiger Regen'],
    ['Moderate rain with partly cloudy sky', 'Mäßiger Regen bei teilweise bewölktem Himmel'],
    ['Moderate rain with cloudy sky', 'Mäßiger Regen bei bewölktem Himmel'],
    ['Dust rain', 'Staubregen'],
    ['Dust rain with partly cloudy sky', 'Staubregen bei teilweise bewölktem Himmel'],
    ['Dust rain with cloudy sky', 'Staubregen bei bewölktem Himmel'],
    ['Freezing rain', 'Gefrierender Regen'],
    ['Freezing rain with partly cloudy sky', 'Gefrierender Regen bei teilweise bewölktem Himmel'],
    ['Freezing rain with cloudy sky', 'Gefrierender Regen bei bewölktem Himmel'],
  ],
  'snowy-rainy': [
    ['Rain and snow', 'Regen und Schnee'],
    ['Rain and snow with partly cloud sky', 'Regen und Schnee bei teilweise bewölktem Himmel'],
    ['Rain and snow with cloudy sky', 'Regen und Schnee bei bewölktem Himmel'],
    ['Dust rain and snow', 'Staubregen und Schnee'],
    ['Dust rain and snow with partly cloudy sky', 'Staubregen und Schnee bei teilweise bewölktem Himmel'],
    ['Dust rain and snow with cloudy sky', 'Staubregen und Schnee bei bewölktem Himmel'],
    ['Heavy Rain and snow', 'Starker Regen und Schnee'],
    ['Heavy Rain and snow with partly cloudy sky', 'Starker Regen und Schnee bei teilweise bewölktem Himmel'],
    ['Heavy Rain and snow with cloudy sky', 'Starker Regen und Schnee bei bewölktem Himmel'],
  ],
  snowy: [
    ['Snow', 'Schnee'],
    ['Snow with partly cloudy sky', 'Schnee bei teilweise bewölktem Himmel'],
    ['Snow with cloudy sky', 'Schnee bei bewölktem Himmel'],
    ['Dust snow', 'Staubschnee'],
    ['Dust snow with partly cloudy sky', 'Staubschnee bei teilweise bewölktem Himmel'],
    ['Dust snow with cloudy sky', 'Staubschnee bei bewölktem Himmel'],
    ['Heavy snow', 'Starker Schneefall'],
    ['Heavy snow with partly cloudy sky', 'Starker Schneefall bei teilweise bewölktem Himmel'],
    ['Heavy snow with cloudy sky', 'Starker Schneefall bei bewölktem Himmel'],
    ['Blizzard', 'Schneesturm'],
  ],
  pouring: [
    ['Heavy rain', 'Starker Regen'],
    ['Heavy rain with partly cloudy sky', 'Starker Regen bei teilweise bewölktem Himmel'],
    ['Heavy rain with cloudy sky', 'Starker Regen bei bewölktem Himmel'],
  ],
  hail: [
    ['Hail', 'Hagel'],
    ['Hail with partly cloudy sky', 'Hagel bei teilweise bewölktem Himmel'],
    ['Hail with cloudy sky', 'Hagel bei bewölktem Himmel'],
    ['Thunderstorm with hail', 'Gewitter mit Hagel'],
    ['Thunderstorm with hail and partly cloudy sky', 'Gewitter mit Hagel bei teilweise bewölktem Himmel'],
    ['Thunderstorm with hail and cloudy sky', 'Gewitter mit Hagel bei bewölktem Himmel'],
  ],
  windy: [['Duststorm', 'Staubsturm']],
};

describe('protocol/weather', () => {
  describe('current conditions', () => {
    it('puts the condition in both state and condition, ahead of the forecast: the tile reads state first, the popup condition first', () => {
      const payload = publish({
        weather_state: 'Leichter Regen',
        temperature: 18.6,
        temperature_unit: '°C',
        forecast: [{ weather_state: 'Sonnig', temperature: 24, templow: 11 }],
      });
      expect(JSON.parse(payload)).to.include({ state: 'rainy', condition: 'rainy', temperature: 18.6 });
      expect(tileCondition(payload), 'tile').to.equal('rainy');
      expect(popupCondition(payload), 'popup').to.equal('rainy');
      expect(panelNumber(payload, 'temperature')).to.equal(18.6);
    });

    it('says a missing current value with "" while a forecast follows: a key left out is read from the first forecast day', () => {
      // DasWetter's day entities and AccuWeather's Daily.Day1 have no current
      // temperature, and forecast[0] carries `temperature` and `condition`.
      const payload = publish({ forecast: [{ weather_state: 'Sonnig', temperature: 24, templow: 11 }] });
      expect(JSON.parse(payload)).to.include({ state: '', condition: '', temperature: '' });
      expect(panelNumber(payload, 'temperature'), 'not day 0 high').to.equal(undefined);
      expect(tileCondition(payload), 'tile').to.equal(undefined);
      expect(popupCondition(payload), 'popup').to.equal(undefined);
      // The forecast day itself is untouched.
      expect(JSON.parse(payload).forecast).to.deep.equal([{ condition: 'sunny', temperature: 24, templow: 11 }]);
    });

    it('leaves a missing value out when no forecast follows: nothing could be misread', () => {
      expect(parse({})).to.deep.equal({ name: 'Zuhause' });
      expect(parse({ temperature: 7.5, temperature_unit: '°C' })).to.deep.equal({ temperature: 7.5, temperature_unit: '°C', name: 'Zuhause' });
    });

    it('publishes an unavailable entity as its name alone: the panel shows "--", never 0', () => {
      const payload = buildWeatherPayload(weather({}, STATE_UNAVAILABLE));
      expect(JSON.parse(payload)).to.deep.equal({ name: 'Zuhause' });
      expect(panelNumber(payload, 'temperature')).to.equal(undefined);
    });

    it('keeps a real 0 degrees', () => {
      expect(parse({ temperature: 0, forecast: [{ temperature: 0, templow: -4 }] })).to.deep.include({ temperature: 0, forecast: [{ temperature: 0, templow: -4 }] });
    });

    it('names the entity like the Bridge does: its friendly name, trimmed (Bridge __init__.py:4933-4935)', () => {
      expect(parse({ friendly_name: '  Garten  ' }).name).to.equal('Garten');
    });

    it('never sends null, and never an icon: the panel derives the Bridge\'s own icon from the condition', () => {
      const payload = publish({
        weather_state: 'Leichter Regen',
        weather_icon: 'https://openweathermap.org/img/w/10d.png',
        forecast: [
          { date: 'Mittwoch', weather_state: 'Tag 0', weather_icon: 'https://openweathermap.org/img/w/01d.png' },
          { weather_icon: '/daswetter.admin/icons/weather/gallery1/png/64x64/3.png' },
        ],
      });
      expect(payload).to.not.match(/null/);
      expect(payload).to.not.match(/"icon"|"i"/);
      expect(payload).to.not.include('openweathermap.org');
      expect(payload).to.not.include('daswetter');
    });
  });

  describe('forecast', () => {
    it("takes day 0's high and low from the provider's own day-0 max and min; a missing one stays missing (Ruling 72)", () => {
      // Not filled from the current reading: 18.6 is no day's high.
      const days = parse({
        temperature: 18.6,
        forecast: [
          { templow: 9, precipitation: 0.4, precipitation_probability: 30 },
          { temperature: 21, templow: 10 },
        ],
      }).forecast;
      expect(days).to.deep.equal([
        { templow: 9, precipitation: 0.4, precipitation_probability: 30 },
        { temperature: 21, templow: 10 },
      ]);
    });

    it('keeps an entry holding nothing the panel reads, so no later day slides into its slot', () => {
      const days = parse({ forecast: [{ weather_icon: 'https://example.com/a.png' }, { temperature: 21 }] }).forecast;
      expect(days).to.deep.equal([{}, { temperature: 21 }]);
    });

    it('is left out when the source has no day yet', () => {
      expect(parse({ temperature: 5, forecast: [] })).to.not.have.property('forecast');
      expect(parse({ temperature: 5, forecast: [] })).to.not.have.property('state');
    });
  });

  describe('units: as declared, never assumed or converted (Ruling 5)', () => {
    it('takes the temperature unit from the current reading, even beside a forecast labelled otherwise', () => {
      // ioBroker.openweathermap in imperial labels its forecast °C.
      expect(parse({ temperature: 64.4, temperature_unit: '°F', forecast: [{ temperature: 70, temperature_unit: '°C' }] }).temperature_unit).to.equal('°F');
      // AccuWeather's imperial unit is a bare F.
      expect(parse({ temperature: 64.4, temperature_unit: 'F' }).temperature_unit).to.equal('F');
    });

    it('else from the first forecast day that declares one, its high or its low', () => {
      const forecast = [{ weather_state: 'Klar' }, { templow: 5, templow_unit: '°C' }, { temperature: 9, temperature_unit: 'K' }];
      expect(parse({ forecast }).temperature_unit).to.equal('°C');
    });

    it('takes the precipitation unit from the first forecast day that declares one', () => {
      const forecast = [{ precipitation_probability: 20, precipitation_probability_unit: '%' }, { precipitation: 1.2, precipitation_unit: 'in' }];
      const json = parse({ forecast });
      expect(json.precipitation_unit).to.equal('in');
      expect(json.forecast).to.deep.equal([{ precipitation_probability: 20 }, { precipitation: 1.2 }]);
    });

    it('sends no unit that is not declared: the firmware defaults are not the source\'s', () => {
      const json = parse({ temperature: 12, forecast: [{ temperature: 14, precipitation: 2 }] });
      expect(json).to.not.have.property('temperature_unit');
      expect(json).to.not.have.property('precipitation_unit');
      expect(json).to.not.have.property('units');
    });

    it('sends the units flat, never in a `units` object whose "temperature" would be the first one in the payload', () => {
      const payload = publish({ temperature_unit: '°C', forecast: [{ temperature: 14, precipitation: 2, precipitation_unit: 'mm' }] });
      expect(payload).to.not.include('"units"');
      expect(panelText(payload, 'temperature_unit')).to.equal('°C');
      expect(panelText(payload, 'precipitation_unit')).to.equal('mm');
    });
  });

  describe('condition: one of Home Assistant\'s 15, else the provider text (Ruling 73)', () => {
    it("maps OpenWeatherMap's documented icon codes, 01n being clear-night", () => {
      // https://openweathermap.org/api/weather-conditions, "Icon list", as
      // ioBroker.openweathermap 2.0.0 publishes them (build/main.js:192).
      const url = (code: string): string => `https://openweathermap.org/img/w/${code}.png`;
      expect(conditionOf(undefined, url('01d'))).to.equal('sunny');
      expect(conditionOf(undefined, url('01n'))).to.equal('clear-night');
      expect(conditionOf(undefined, url('02d'))).to.equal('partlycloudy');
      expect(conditionOf(undefined, 'https://openweathermap.org/img/wn/03n@2x.png')).to.equal('partlycloudy');
      expect(conditionOf(undefined, url('04n'))).to.equal('cloudy');
      expect(conditionOf(undefined, url('09d'))).to.equal('rainy');
      expect(conditionOf(undefined, url('10n'))).to.equal('rainy');
      expect(conditionOf(undefined, url('11d'))).to.equal('lightning-rainy');
      expect(conditionOf(undefined, '13d')).to.equal('snowy');
      expect(conditionOf(undefined, url('50n'))).to.equal('fog');
    });

    it('prefers the icon code to the text, and reads the text when the icon is no code', () => {
      expect(conditionOf('Klarer Himmel', 'https://openweathermap.org/img/w/10d.png')).to.equal('rainy');
      expect(conditionOf('Klarer Himmel', 'https://openweathermap.org/img/w/05d.png'), 'no such code').to.equal('sunny');
      expect(conditionOf('Bedeckt', '/daswetter.admin/icons/weather/gallery1/png/64x64/10.png'), 'no day/night: no code').to.equal('cloudy');
      expect(conditionOf(undefined, 'http://vortex.accuweather.com/adc2010/images/slate/icons/03.svg')).to.equal(undefined);
    });

    for (const [condition, pairs] of Object.entries(DASWETTER_TEXTS)) {
      it(`maps every DasWetter text that is ${condition}, in English and German`, () => {
        for (const [english, german] of pairs) {
          expect(conditionOf(english), english).to.equal(condition);
          expect(conditionOf(german), german).to.equal(condition);
        }
      });
    }

    it('maps the other adapters\' usual phrases', () => {
      expect(conditionOf('Mostly Cloudy')).to.equal('cloudy');
      expect(conditionOf('Partly sunny')).to.equal('partlycloudy');
      expect(conditionOf('Hazy sunshine')).to.equal('sunny');
      expect(conditionOf('Mostly cloudy w/ showers')).to.equal('rainy');
      expect(conditionOf('Partly sunny w/ t-storms')).to.equal('lightning');
      expect(conditionOf('Gewitterschauer')).to.equal('lightning-rainy');
      expect(conditionOf('Schneeschauer')).to.equal('snowy');
      expect(conditionOf('Sleet')).to.equal('snowy-rainy');
      expect(conditionOf('Windy')).to.equal('windy');
      expect(conditionOf('Überwiegend sonnig')).to.equal('sunny');
      expect(conditionOf('Heiter bis wolkig')).to.equal('partlycloudy');
      expect(conditionOf('Wolkenlos')).to.equal('sunny');
      expect(conditionOf('Klare Nacht')).to.equal('clear-night');
    });

    it('keeps a canonical condition as it is, in lower case', () => {
      expect(conditionOf('partlycloudy')).to.equal('partlycloudy');
      expect(conditionOf('Windy-Variant')).to.equal('windy-variant');
      expect(conditionOf('clear-night')).to.equal('clear-night');
    });

    it('sends text it cannot map unchanged, so the panel shows it with no icon', () => {
      expect(conditionOf('Heiß')).to.equal('Heiß');
      expect(conditionOf('Tag 3')).to.equal('Tag 3');
      expect(parse({ forecast: [{ weather_state: 'Ice', temperature: 1 }] }).forecast).to.deep.equal([{ condition: 'Ice', temperature: 1 }]);
    });

    it('reads no condition from a number', () => {
      expect(conditionOf(3)).to.equal(undefined);
    });
  });

  describe('dates: date_local in the host zone, for every day or for none (Ruling 74)', () => {
    it('converts an instant to the local date in a UTC+ zone: DasWetter sends local midnight in UTC, the day before', () => {
      inZone('Europe/Berlin', () => {
        expect(datesOf('2026-09-21T22:00:00.000Z', '2026-09-22T22:00:00.000Z')).to.deep.equal(['2026-09-22', '2026-09-23']);
        expect(datesOf('2026-09-23T07:00:00+02:00')).to.deep.equal(['2026-09-23']);
      });
    });

    it('converts an instant to the local date in a UTC- zone, where it can be the day before its UTC date', () => {
      inZone('America/New_York', () => {
        expect(datesOf('2026-09-24T02:00:00Z', '2026-09-24T01:00:00+02:00')).to.deep.equal(['2026-09-23', '2026-09-23']);
        expect(datesOf('2026-09-24T12:00:00-04:00')).to.deep.equal(['2026-09-24']);
      });
    });

    it('keeps a plain YYYY-MM-DD, which is already local, in every zone', () => {
      for (const zone of ['Europe/Berlin', 'America/New_York', 'Pacific/Kiritimati']) {
        inZone(zone, () => expect(datesOf('2026-09-23', '2026-09-24'), zone).to.deep.equal(['2026-09-23', '2026-09-24']));
      }
    });

    it('sends no date for a weekday name, a timestamp number, or a time with no zone', () => {
      expect(datesOf('Mittwoch', 'Donnerstag')).to.deep.equal([undefined, undefined]);
      expect(datesOf(1_758_621_600_000)).to.deep.equal([undefined]);
      expect(datesOf('2026-09-23T07:00:00')).to.deep.equal([undefined]);
    });

    it('sends no date at all when one day has none: the panel would misorder a mixed set', () => {
      inZone('Europe/Berlin', () => {
        expect(datesOf('2026-09-23', undefined, '2026-09-25')).to.deep.equal([undefined, undefined, undefined]);
        expect(datesOf('2026-09-23', 'Freitag')).to.deep.equal([undefined, undefined]);
      });
    });
  });
});
