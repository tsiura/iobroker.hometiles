import type { VirtualEntity } from '../registry/types';

/**
 * Climate is unlike every v0.1 domain: the firmware caches state by full
 * overwrite, never by merge (docs/contract-climate-cover.md, "The overwrite
 * problem") — a diffing publisher that only sends changed keys would let
 * stale attributes accumulate wrong. That does NOT mean every field must be
 * force-filled, though (review round 1 correction of this file's original
 * comment here): most climate fields have a real "unknown" struct default
 * gated behind a has_* presence flag (has_target_temperature,
 * has_target_range, has_current_temperature, has_current_humidity,
 * has_target_humidity — src/types/climate/state.h), and the panel gates real
 * UI on those flags (e.g. src/types/climate/renderer.cpp's
 * slot_is_interactive only makes the target-temperature slot interactive
 * when has_target_temperature is set; src/ui/popups/climate/climate_popup.cpp
 * only enters dual-range mode when has_target_range && !has_target_temperature).
 * Omitting a key is how you tell the firmware "no such value" — it is never
 * safe to substitute the firmware's own struct default in place of an
 * unknown value, because that default is not inert: it becomes a real,
 * interactive, commandable value the moment its presence flag is set.
 * min_temp/max_temp are the only two fields with no presence flag at all
 * (state.h) — sending or omitting them is equally safe wire-wise — but they
 * follow the same emit-only-what-is-known rule anyway, for one uniform rule
 * across every numeric field rather than a field-by-field exception list.
 */

/**
 * Non-climate attributes this module knows are safe to forward verbatim:
 * plain metadata the firmware's climate scanner never looks for under these
 * names, and always a defined, non-blank string in practice (see
 * synth/common.ts's baseEntity for friendly_name/icon, synth/climate.ts's
 * readBoolAttr for power/boost). This is an explicit allow-list, not an
 * exclude-list (review round 1, M5): the firmware's scanner also recognises
 * "state" (hvac_mode fallback), "unit_of_measurement" (temperature_unit
 * fallback), "humidity" (target_humidity fallback), "precision"
 * (target_temp_step fallback), "supported_features", the five *_modes
 * arrays, and a nested "attributes" object that triggers a second scan pass
 * (tile_renderer.cpp:2148,2178,2230,2259,2270) — an open-ended pass-through
 * would forward any of those unvalidated, including as a literal JSON null,
 * which is exactly the hazard the never-null rule below exists to close.
 * supported_features and four of the lists now have dedicated, validated
 * paths below (Task 5b); none of them is ever forwarded from here.
 */
const PASSTHROUGH_KEYS = ['friendly_name', 'icon', 'power', 'boost'] as const;

/**
 * The control lists synthClimate builds (Task 5b). The firmware draws a mode,
 * fan or swing option list ONLY from these arrays (tile_renderer.cpp:
 * 2190-2211); an absent array leaves its mask at 0, so the popup offers at
 * most the current value as a lone option (climate_popup.cpp:458-460).
 * preset_modes is deliberately absent: no synth reads a preset channel, so
 * there is never a list to send.
 */
const MODES_KEYS = ['hvac_modes', 'fan_modes', 'swing_modes', 'swing_horizontal_modes'] as const;

/**
 * `writable` roles to the ClimateSupportedFeature bit each authorises, read
 * from HomeTiles (read-only repo) src/ui/popups/climate/climate_popup.h:6-16.
 * Once a mask is present every control whose bit is clear is disabled
 * (renderer.cpp:74-97, climate_popup.cpp:280-324); with NO mask the firmware
 * assumes every feature (legacy_supported = true), which is what made a
 * read-only setpoint look tappable.
 *
 * The range needs BOTH bounds: the firmware has one bit for both handles and
 * always sends both bounds together, so with one side read-only the
 * dispatcher would write the other alone and report ok:true for a drag that
 * moved nothing. hvac_mode has no bit at all: climate_popup.cpp:310-311 shows
 * the mode control whenever it has an option, even the lone current-value
 * fallback, so only hvac_modes (and hvac_mode itself) shape it.
 * TURN_OFF (128) and TURN_ON (256) are declared but never read by the
 * firmware, and this adapter has no climate on/off command to back them.
 */
const FEATURE_BY_ROLES: ReadonlyArray<readonly [roles: readonly string[], bit: number]> = [
  [['setpoint'], 1 << 0], // CLIMATE_FEATURE_TARGET_TEMPERATURE
  [['target_temp_low', 'target_temp_high'], 1 << 1], // CLIMATE_FEATURE_TARGET_TEMPERATURE_RANGE
  [['target_humidity'], 1 << 2], // CLIMATE_FEATURE_TARGET_HUMIDITY
  [['fan_mode'], 1 << 3], // CLIMATE_FEATURE_FAN_MODE
  [['preset_mode'], 1 << 4], // CLIMATE_FEATURE_PRESET_MODE
  [['swing_mode'], 1 << 5], // CLIMATE_FEATURE_SWING_MODE
  [['swing_horizontal_mode'], 1 << 9], // CLIMATE_FEATURE_SWING_HORIZONTAL_MODE
];

function supportedFeatures(writable: Record<string, boolean> | undefined): number {
  let mask = 0;
  for (const [roles, bit] of FEATURE_BY_ROLES) {
    if (roles.every((role) => writable?.[role] === true)) mask |= bit;
  }
  return mask;
}

/**
 * Wire keys for plain climate string fields. The firmware's hand-rolled
 * scanner (tile_renderer.cpp's extract_json_string_field) can misparse a
 * JSON `null` here: finding no opening quote right after the colon, it keeps
 * scanning and grabs the *next* quoted token in the whole payload -- often
 * the following key's own name -- as if it were the value. Omitting the key
 * is always safe; sending null never is. preset_mode is deliberately not
 * here: it needs the extra allow-list check in buildClimatePayload below.
 */
const CLIMATE_STRING_KEYS = [
  'hvac_mode',
  'hvac_action',
  'fan_mode',
  'swing_mode',
  'swing_horizontal_mode',
  'temperature_unit',
] as const;

/**
 * The firmware's preset name table (tile_renderer.cpp's climate_preset_id)
 * only recognises these 8 HA-core names. Anything else maps to its "no
 * preset" sentinel and the original name is lost, not passed through -- so a
 * custom integration preset must be dropped here rather than sent and
 * silently discarded on the other end.
 */
export const ALLOWED_PRESET_MODES: ReadonlySet<string> = new Set([
  'none',
  'eco',
  'away',
  'boost',
  'comfort',
  'home',
  'sleep',
  'activity',
]);

/**
 * Number('') and Number('   ') are both 0 and finite, so a blank reading
 * must resolve to "no value", never a confident zero-degree setpoint or
 * zero-percent humidity -- this is how the bug got in last time. Mirrors
 * synth/climate.ts's readNumber and synth/common.ts's numberToState, which
 * guard the identical trap on the ioBroker-reading side.
 */
export function usableNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return undefined;
    const numeric = Number(text);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  return undefined;
}

/** A blank or whitespace-only string is "no value", same reasoning as usableNumber. */
function usableString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text : undefined;
}

/**
 * Builds the complete climate MQTT state payload for one entity. Unlike the
 * generic JSON path in state-payload.ts, this never diffs against a previous
 * publish and never forwards entity.state directly -- see the inline notes
 * for why each rule exists. Pure formatting: no ioBroker or MQTT imports
 * (enforced by eslint for src/protocol/**).
 */
export function buildClimatePayload(entity: VirtualEntity): string {
  const attrs = entity.attributes;
  const body: Record<string, unknown> = {};

  // Explicit allow-list forward (see PASSTHROUGH_KEYS above for why this is
  // not a generic "forward everything else" loop). entity.state is
  // deliberately never forwarded under a "state" key here: the firmware
  // treats "state" as a fallback name for hvac_mode, and entity.state is
  // "unknown"/"unavailable" exactly when hvac_mode is unset (see
  // synth/climate.ts) -- forwarding it would smuggle a placeholder into the
  // one string field rule 2 exists to guard.
  for (const key of PASSTHROUGH_KEYS) {
    const value = attrs[key];
    if (typeof value === 'string' && value.length > 0) body[key] = value;
  }

  body.available = entity.available;

  // temperature/min_temp/max_temp: emit the real value when known, omit
  // otherwise. Never substitute the firmware's own struct default in place
  // of an unknown reading -- see the file-level comment above for why that
  // is actively harmful for temperature (has_target_temperature gates a
  // real, interactive, commandable UI slot), even though it is merely
  // redundant-but-harmless for min_temp/max_temp specifically.
  const targetTemperature = usableNumber(attrs.target_temperature);
  if (targetTemperature !== undefined) body.temperature = targetTemperature;

  const minTemp = usableNumber(attrs.min_temp);
  if (minTemp !== undefined) body.min_temp = minTemp;

  const maxTemp = usableNumber(attrs.max_temp);
  if (maxTemp !== undefined) body.max_temp = maxTemp;

  // target_temp_low/target_temp_high share ONE presence flag in the
  // firmware: sending only one makes it treat both as fresh and silently
  // revert the other to its default. Emit both, verbatim, ONLY when both are
  // known; fabricating the missing side would itself become a real,
  // interactive, commandable range bound the moment has_target_range is set
  // (renderer.cpp's slot_is_interactive, climate_popup.cpp's range mode).
  const low = usableNumber(attrs.target_temp_low);
  const high = usableNumber(attrs.target_temp_high);
  if (low !== undefined && high !== undefined) {
    body.target_temp_low = low;
    body.target_temp_high = high;
  }

  // Optional live readouts: a real "unknown" state already exists for these
  // (has_current_temperature/has_current_humidity/has_target_humidity all
  // default false), so omitting is the correct way to say "no reading".
  const currentTemperature = usableNumber(attrs.current_temperature);
  if (currentTemperature !== undefined) body.current_temperature = currentTemperature;

  const currentHumidity = usableNumber(attrs.current_humidity);
  if (currentHumidity !== undefined) body.current_humidity = currentHumidity;

  const targetHumidity = usableNumber(attrs.target_humidity);
  if (targetHumidity !== undefined) body.target_humidity = targetHumidity;

  // String fields: omit rather than null (see CLIMATE_STRING_KEYS above).
  for (const key of CLIMATE_STRING_KEYS) {
    const value = usableString(attrs[key]);
    if (value !== undefined) body[key] = value;
  }

  // preset_mode: only 8 hardcoded HA-core names survive the firmware's name
  // table, so don't send a name it will silently discard.
  const preset = usableString(attrs.preset_mode)?.toLowerCase();
  if (preset !== undefined && ALLOWED_PRESET_MODES.has(preset)) body.preset_mode = preset;

  // Control lists: only real, non-blank names, and only when one survives --
  // omission, never an empty or null-bearing array (see MODES_KEYS above).
  for (const key of MODES_KEYS) {
    const value = attrs[key];
    if (!Array.isArray(value)) continue;
    const names = value.map(usableString).filter((name): name is string => name !== undefined);
    if (names.length) body[key] = names;
  }

  // Always explicit, computed from what can actually be commanded, never
  // forwarded from an attribute (see FEATURE_BY_ROLES above).
  body.supported_features = supportedFeatures(entity.writable);

  return JSON.stringify(body);
}
