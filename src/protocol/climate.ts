import type { VirtualEntity } from '../registry/types';

/**
 * Climate is unlike every v0.1 domain: the firmware caches state by full
 * overwrite, never by merge (docs/contract-climate-cover.md, "The overwrite
 * problem"). A key this module omits does not mean "unchanged" to the
 * firmware -- it snaps straight back to one of the hardcoded struct defaults
 * below. These three have no "unknown" representation in the firmware at
 * all (no has_* flag), so leaving one out is never neutral. Values match
 * src/types/climate/state.h as cited in the contract doc.
 */
const DEFAULT_TEMPERATURE = 20.0;
const DEFAULT_MIN_TEMP = 7.0;
const DEFAULT_MAX_TEMP = 35.0;
const DEFAULT_TARGET_TEMP_LOW = 18.0;
const DEFAULT_TARGET_TEMP_HIGH = 24.0;

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
const ALLOWED_PRESET_MODES = new Set(['none', 'eco', 'away', 'boost', 'comfort', 'home', 'sleep', 'activity']);

/**
 * Keys this module reads out of entity.attributes under a name that differs
 * from (or needs extra handling beyond) a plain passthrough, so the generic
 * forwarding loop below must not also copy them verbatim under their
 * internal name.
 */
const HANDLED_KEYS = new Set<string>([
  'target_temperature',
  'min_temp',
  'max_temp',
  'target_temp_low',
  'target_temp_high',
  'current_temperature',
  'current_humidity',
  'target_humidity',
  'preset_mode',
  ...CLIMATE_STRING_KEYS,
]);

/**
 * Number('') and Number('   ') are both 0 and finite, so a blank reading
 * must resolve to "no value", never a confident zero-degree setpoint or
 * zero-percent humidity -- this is how the bug got in last time. Mirrors
 * synth/climate.ts's readNumber and synth/common.ts's numberToState, which
 * guard the identical trap on the ioBroker-reading side.
 */
function usableNumber(value: unknown): number | undefined {
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

  // Everything the entity carries outside the climate schema (friendly_name,
  // icon, power, boost, ...) forwards unchanged, same as the generic JSON
  // domains in state-payload.ts. entity.state is deliberately NOT forwarded
  // under a "state" key here: the firmware treats "state" as a fallback
  // name for hvac_mode, and entity.state is "unknown"/"unavailable" exactly
  // when hvac_mode is unset (see synth/climate.ts) -- forwarding it would
  // smuggle a placeholder into the one string field rule 2 exists to guard.
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || HANDLED_KEYS.has(key)) continue;
    body[key] = value;
  }

  body.available = entity.available;

  // temperature/min_temp/max_temp have no "unknown" state in the firmware,
  // so they are always given a concrete number: the real reading when known,
  // the firmware's own default otherwise (the same number it would apply on
  // its own if the key were missing -- sending it explicitly just makes that
  // deliberate instead of accidental). Wire key is "temperature", matching
  // tile_renderer.cpp's parser, not the internal target_temperature name.
  body.temperature = usableNumber(attrs.target_temperature) ?? DEFAULT_TEMPERATURE;
  body.min_temp = usableNumber(attrs.min_temp) ?? DEFAULT_MIN_TEMP;
  body.max_temp = usableNumber(attrs.max_temp) ?? DEFAULT_MAX_TEMP;

  // target_temp_low/target_temp_high share ONE presence flag in the
  // firmware: sending only one makes it treat both as fresh and silently
  // revert the other to its default. Emit both (falling back per side) when
  // either is known, or neither when this entity has no dual setpoint at all.
  const low = usableNumber(attrs.target_temp_low);
  const high = usableNumber(attrs.target_temp_high);
  if (low !== undefined || high !== undefined) {
    body.target_temp_low = low ?? DEFAULT_TARGET_TEMP_LOW;
    body.target_temp_high = high ?? DEFAULT_TARGET_TEMP_HIGH;
  }

  // Optional live readouts: these DO have a real "unknown" state in the
  // firmware (has_current_temperature/has_current_humidity/
  // has_target_humidity default false), so omitting is the correct way to
  // say "no reading available", not a bug to work around.
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

  return JSON.stringify(body);
}
