import type { VirtualEntity } from '../registry/types';
import { usableNumber, usableString } from './climate';

/**
 * The weather state payload (docs/contract-media-weather.md, "weather"), sent
 * retained on <haPrefix>/weather/<object_id>/weather. Firmware readers, from
 * HomeTiles (read-only): update_weather_tile_state (tile_renderer.cpp:2530-2734)
 * and the popup's apply_weather_header and parse_weather_base_data
 * (weather_popup.cpp:2493-2696). Reference sender: the Bridge's
 * _build_weather_payload (HomeTiles-Bridge __init__.py:3847).
 *
 * - Every lookup takes the FIRST `"key"` anywhere in the payload, a forecast
 *   entry's included (json_scan.h:34-60, tile_renderer.cpp:802-816). So the
 *   current conditions come first, and while a forecast follows, a current
 *   value the source lacks goes out as "", which every reader takes as no
 *   value (tile_renderer.cpp:814-815, :924-936; weather_popup.cpp:480-491): a
 *   key left out would be read from the first forecast day, its high shown as
 *   the current temperature.
 * - Never null: the tile's string reader takes the next quoted token as the
 *   value of a null (tile_renderer.cpp:807-813).
 * - Only one of Home Assistant's 15 conditions gets an icon and a translated
 *   label (weather_popup.cpp:1004-1024, i18n.cpp:1728-1749); other text is
 *   shown as it is. The tile reads `state` first and the popup `condition`
 *   first (tile_renderer.cpp:2552-2554, weather_popup.cpp:1040-1060), so both
 *   carry it.
 * - No `icon`: the panel derives exactly the Bridge's icons from the condition
 *   (_WEATHER_ICON_MAP, __init__.py:4819-4835), and a forecast entry's `icon`
 *   would be read as the current one.
 * - Units as the source declares them, flat: a `units` object's "temperature"
 *   would be the payload's first.
 * - A day's date goes out as date_local, the host's local YYYY-MM-DD (the
 *   Bridge's, __init__.py:3865-3868), only when every day has one: an undated
 *   day takes the first free slot in arrival order (tile_renderer.cpp:2709-2721),
 *   which misorders a mixed set.
 * - No aggregation (Ruling 72): a day's high and low are the provider's own
 *   daily TEMP_MAX and TEMP_MIN; ioBroker's weather patterns carry no hours.
 */

const CONDITIONS: ReadonlySet<string> = new Set([
  'clear-night',
  'cloudy',
  'exceptional',
  'fog',
  'hail',
  'lightning',
  'lightning-rainy',
  'partlycloudy',
  'pouring',
  'rainy',
  'snowy',
  'snowy-rainy',
  'sunny',
  'windy',
  'windy-variant',
]);

/**
 * OpenWeatherMap's icon codes, from its "Icon list"
 * (https://openweathermap.org/api/weather-conditions); ioBroker.openweathermap
 * 2.0.0 publishes https://openweathermap.org/img/w/<code>.png (build/main.js:192).
 * The trailing d or n is day or night.
 */
const OWM_ICON = /(?:^|\/)(\d\d)([dn])(?:@\dx)?(?:\.png)?$/;
const OWM_CONDITIONS: Readonly<Record<string, string>> = {
  '01': 'sunny', // clear sky; 01n is clear-night
  '02': 'partlycloudy', // few clouds
  '03': 'partlycloudy', // scattered clouds
  '04': 'cloudy', // broken clouds
  '09': 'rainy', // shower rain
  '10': 'rainy', // rain
  '11': 'lightning-rainy', // thunderstorm
  '13': 'snowy', // snow
  '50': 'fog', // mist
};

const THUNDER = '(gewitter|thunder|\\bt-?storm|lightning)';
const RAIN = '(regen|rain|schauer|shower|drizzle|niesel)';

/**
 * German and English words in the provider's text, the most specific first:
 * DasWetter's texts (build/i18n/de.json) pair a precipitation with a sky, as in
 * "Leichter Regen bei teilweise bewölktem Himmel".
 */
const KEYWORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/hagel|graupel|hail/, 'hail'],
  [new RegExp(`^(?=.*${THUNDER})(?=.*${RAIN})`), 'lightning-rainy'],
  [new RegExp(THUNDER), 'lightning'],
  [/^(?=.*(schnee|snow))(?=.*(regen|rain|drizzle|niesel))|sleet|wintry mix/, 'snowy-rainy'],
  [/schnee|snow|flurr|blizzard/, 'snowy'],
  [/(stark|heftig|kräftig)e[nr]? regen|starkregen|wolkenbruch|platzregen|heavy (intensity )?(rain|shower)|downpour|pouring|torrential/, 'pouring'],
  [new RegExp(RAIN), 'rainy'],
  [/nebel|dunst|fog|mist|haze|smoke/, 'fog'],
  [/wind(?!still)|sturm|stürm|storm|böig|breez|gust/, 'windy'],
  [/teilweise|teils|leicht bewölk|mäßig bewölk|aufgelockert|wolkig|hohe wolken|ein paar wolken|partly|few clouds|scattered clouds|high clouds|intermittent/, 'partlycloudy'],
  [/bewölk|bedeckt|trüb|wolke(?!nlos)|cloud|overcast|dreary/, 'cloudy'],
  [/^(?=.*(klar|clear))(?=.*(nacht|night))|moon|mondlicht|mondschein/, 'clear-night'],
  [/sonn|sun|klar|clear|heiter|fair|wolkenlos/, 'sunny'],
];

/** Home Assistant's condition for a provider's text and icon, else the text as it is. */
function condition(text: unknown, icon: unknown): string | undefined {
  const [, code = '', time] = OWM_ICON.exec(usableString(icon) ?? '') ?? [];
  const coded = code === '01' && time === 'n' ? 'clear-night' : OWM_CONDITIONS[code];
  if (coded) return coded;
  const shown = usableString(text);
  if (shown === undefined) return undefined;
  const key = shown.toLowerCase();
  if (CONDITIONS.has(key)) return key;
  return KEYWORDS.find(([words]) => words.test(key))?.[1] ?? shown;
}

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A date and a time with its zone, Z or an offset: one instant (Ruling 74). */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const two = (value: number): string => String(value).padStart(2, '0');

/**
 * A day's date as the host's local YYYY-MM-DD, when it has one beyond doubt: a
 * plain date is already local (Weather Underground), an instant is converted
 * (DasWetter's UTC midnight, AccuWeather's offset). A weekday name
 * (OpenWeatherMap), a number or a time with no zone is none.
 */
function localDate(date: unknown): string | undefined {
  const text = usableString(date) ?? '';
  if (PLAIN_DATE.test(text)) return text;
  const instant = INSTANT.test(text) ? new Date(text) : undefined;
  if (!instant || Number.isNaN(instant.getTime())) return undefined;
  return `${instant.getFullYear()}-${two(instant.getMonth() + 1)}-${two(instant.getDate())}`;
}

/** The unit the first day declaring one declares, under any of `keys`. */
function dayUnit(days: ReadonlyArray<Record<string, unknown>>, ...keys: string[]): string | undefined {
  for (const day of days) {
    for (const key of keys) {
      const unit = usableString(day[key]);
      if (unit !== undefined) return unit;
    }
  }
  return undefined;
}

export function buildWeatherPayload(entity: VirtualEntity): string {
  const attrs = entity.attributes;
  const days = Array.isArray(attrs.forecast) ? (attrs.forecast as Array<Record<string, unknown>>) : [];
  const dates = days.map((day) => localDate(day.date));
  const dated = dates.every((date) => date !== undefined);
  const forecast = days.map((day, index) => ({
    date_local: dated ? dates[index] : undefined,
    condition: condition(day.weather_state, day.weather_icon),
    temperature: usableNumber(day.temperature),
    templow: usableNumber(day.templow),
    precipitation: usableNumber(day.precipitation),
    precipitation_probability: usableNumber(day.precipitation_probability),
  }));
  // "" is "none" only where a forecast could be misread in its place.
  const none = forecast.length ? '' : undefined;
  const now = condition(attrs.weather_state, attrs.weather_icon) ?? none;
  return JSON.stringify({
    state: now,
    condition: now,
    temperature: usableNumber(attrs.temperature) ?? none,
    temperature_unit: usableString(attrs.temperature_unit) ?? dayUnit(days, 'temperature_unit', 'templow_unit'),
    precipitation_unit: dayUnit(days, 'precipitation_unit'),
    name: usableString(attrs.friendly_name),
    forecast: forecast.length ? forecast : undefined,
  });
}
