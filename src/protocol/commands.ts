import { ALLOWED_PRESET_MODES } from './climate';

export type ServiceCall =
  | { kind: 'turn_on'; entityId: string }
  | { kind: 'turn_off'; entityId: string }
  | { kind: 'toggle'; entityId: string }
  | {
      kind: 'set_light';
      entityId: string;
      state?: 'on' | 'off';
      brightnessPct?: number;
      rgb?: [number, number, number];
      kelvin?: number;
      /** Why a color_temp_kelvin that was sent is not in `kelvin` (Ruling 59: skipped, never refused). */
      skippedKelvin?: string;
    }
  | { kind: 'activate_scene'; alias: string }
  | { kind: 'set_temperature'; entityId: string; value?: number; low?: number; high?: number }
  | { kind: 'set_humidity'; entityId: string; value: number }
  | { kind: 'set_hvac_mode'; entityId: string; mode: string }
  | { kind: 'set_fan_mode'; entityId: string; mode: string }
  | { kind: 'set_preset_mode'; entityId: string; mode: string }
  | { kind: 'set_swing_mode'; entityId: string; mode: string }
  | { kind: 'set_swing_horizontal_mode'; entityId: string; on: boolean }
  | {
      kind:
        | 'open_cover'
        | 'close_cover'
        | 'stop_cover'
        | 'open_cover_tilt'
        | 'close_cover_tilt'
        | 'stop_cover_tilt'
        | 'toggle_cover'
        | 'toggle_cover_tilt';
      entityId: string;
    }
  | { kind: 'set_cover_position' | 'set_cover_tilt_position'; entityId: string; value: number }
  | { kind: 'media_previous' | 'media_play_pause' | 'media_next'; entityId: string }
  /** `value`: the slider's whole percent, 0..100 -- the wire's 0..1 volume_level times 100. */
  | { kind: 'media_set_volume'; entityId: string; value: number }
  /** `position`: seconds into the track, as the panel sends them. */
  | { kind: 'media_seek'; entityId: string; position: number };

export class CommandError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'CommandError';
  }
}

const MAX_SCENE_ALIAS_LENGTH = 128;
/**
 * Home Assistant entity ids are far shorter than this; the cap exists for the
 * same reason the scene alias has one. Every field crossing this boundary is
 * untrusted, so none of them may be unbounded.
 */
const MAX_ENTITY_ID_LENGTH = 255;
const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;

function parseObject(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CommandError('invalid_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CommandError('invalid_payload');
  }
  return parsed as Record<string, unknown>;
}

function requireEntityId(payload: Record<string, unknown>): string {
  const raw = payload.entity_id;
  if (typeof raw !== 'string') throw new CommandError('missing_entity_id');
  const entityId = raw.trim().toLowerCase();
  if (entityId.length > MAX_ENTITY_ID_LENGTH) throw new CommandError('entity_id_too_long');
  if (!ENTITY_ID_RE.test(entityId)) throw new CommandError('invalid_entity_id');
  return entityId;
}

function requireNumber(value: unknown, code: string): number {
  const numeric = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(numeric)) throw new CommandError(code);
  return numeric;
}

/**
 * A whole number as the firmware sends one, refused -- never clamped --
 * outside min..max: clamping another client's 150 wrote 100 with ok:true
 * (Task 8 round 1, M1b; rgb in round 2).
 */
function requireWhole(value: unknown, code: string, min: number, max: number): number {
  const whole = Math.round(requireNumber(value, code));
  if (whole < min || whole > max) throw new CommandError(code);
  // `|| 0`: -0.4 rounds to -0, which must land as a plain 0.
  return whole || 0;
}

/** A percentage: 0..100, as mqttPublishLightCommand and mqttPublishCoverCommand both cap it. */
function requirePercent(value: unknown, code: string): number {
  return requireWhole(value, code, 0, 100);
}

function requireMode(value: unknown, code: string): string {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!text) throw new CommandError(code);
  return text;
}

function requireOnOff(value: unknown, code: string): boolean {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'on') return true;
  if (text === 'off') return false;
  throw new CommandError(code);
}

function onOffCall(entityId: string, state: unknown): ServiceCall {
  const text = typeof state === 'string' ? state.trim().toLowerCase() : '';
  // The firmware sends "toggle" whenever the tile had no explicit target state.
  if (!text || text === 'toggle') return { kind: 'toggle', entityId };
  if (text === 'on') return { kind: 'turn_on', entityId };
  if (text === 'off') return { kind: 'turn_off', entityId };
  throw new CommandError('invalid_state');
}

export function parseSwitchCommand(raw: string): ServiceCall {
  const payload = parseObject(raw);
  return onOffCall(requireEntityId(payload), payload.state);
}

export function parseLightCommand(raw: string): ServiceCall {
  const payload = parseObject(raw);
  const entityId = requireEntityId(payload);

  const hasBrightness = payload.brightness_pct !== undefined;
  const hasRgb = payload.rgb_color !== undefined;
  const hasKelvin = payload.color_temp_kelvin !== undefined;

  // Without any channel argument this is an ordinary on, off or toggle.
  if (!hasBrightness && !hasRgb && !hasKelvin) {
    return onOffCall(entityId, payload.state);
  }

  const call: Extract<ServiceCall, { kind: 'set_light' }> = { kind: 'set_light', entityId };

  if (typeof payload.state === 'string') {
    const text = payload.state.trim().toLowerCase();
    if (text === 'on' || text === 'off') call.state = text;
    else if (text.length) throw new CommandError('invalid_state');
  }

  if (hasBrightness) {
    call.brightnessPct = requirePercent(payload.brightness_pct, 'invalid_brightness');
  }

  if (hasRgb) {
    const rgb = payload.rgb_color;
    if (!Array.isArray(rgb) || rgb.length !== 3) throw new CommandError('invalid_rgb');
    // The firmware sends uint8 components, so one outside 0..255 came from
    // another client.
    const [r, g, b] = rgb.map((component) => requireWhole(component, 'invalid_rgb', 0, 255));
    call.rgb = [r as number, g as number, b as number];
  }

  if (hasKelvin) {
    // Ruling 59: a colour temperature never refuses the call. The power
    // button of a light with CT but no colour always sends one together with
    // "on" (light_popup.cpp:1616-1618, 1021-1038), so a CT the light cannot
    // take must not stop it switching on. An unusable one is skipped here;
    // the dispatcher skips one outside the light's own range, both out loud.
    // The value itself is not echoed: it came from the wire.
    const kelvin = payload.color_temp_kelvin;
    if (typeof kelvin === 'number' && Number.isFinite(kelvin) && kelvin > 0) call.kelvin = Math.round(kelvin);
    else call.skippedKelvin = 'color_temp_kelvin is not a positive number';
  }

  return call;
}

/** The scene topic carries plain text, not JSON. See mqttPublishScene. */
export function parseSceneCommand(raw: string): ServiceCall {
  const alias = raw.trim().toLowerCase();
  if (!alias) throw new CommandError('empty_scene');
  if (alias.length > MAX_SCENE_ALIAS_LENGTH) throw new CommandError('scene_alias_too_long');
  return { kind: 'activate_scene', alias };
}

/**
 * All seven climate commands share one MQTT topic and are discriminated by a
 * "command" field inside the JSON payload itself (docs/contract-climate-cover.md
 * "Outbound commands and service names") -- unlike light/switch/scene, where
 * the topic leaf alone says what the payload means.
 */
export function parseClimateCommand(raw: string): ServiceCall {
  const payload = parseObject(raw);
  const entityId = requireEntityId(payload);
  const command = typeof payload.command === 'string' ? payload.command : '';

  switch (command) {
    case 'set_temperature': {
      const hasValue = payload.temperature !== undefined;
      const hasLow = payload.target_temp_low !== undefined;
      const hasHigh = payload.target_temp_high !== undefined;
      // The firmware only ever sends the single "temperature" key or the
      // complete "target_temp_low"+"target_temp_high" pair together
      // (mqttPublishClimateTemperature's two branches), never one bound
      // alone. Guessing the missing bound would silently move a setpoint the
      // user never touched.
      if (hasLow !== hasHigh) throw new CommandError('incomplete_temperature_range');
      if (!hasValue && !hasLow) throw new CommandError('missing_temperature');

      const call: Extract<ServiceCall, { kind: 'set_temperature' }> = { kind: 'set_temperature', entityId };
      if (hasValue) call.value = requireNumber(payload.temperature, 'invalid_temperature');
      if (hasLow) {
        call.low = requireNumber(payload.target_temp_low, 'invalid_temperature_range');
        call.high = requireNumber(payload.target_temp_high, 'invalid_temperature_range');
      }
      return call;
    }
    case 'set_humidity':
      return { kind: 'set_humidity', entityId, value: requireNumber(payload.humidity, 'invalid_humidity') };
    case 'set_hvac_mode':
      return { kind: 'set_hvac_mode', entityId, mode: requireMode(payload.hvac_mode, 'invalid_hvac_mode') };
    case 'set_fan_mode':
      return { kind: 'set_fan_mode', entityId, mode: requireMode(payload.fan_mode, 'invalid_fan_mode') };
    case 'set_preset_mode': {
      const mode = requireMode(payload.preset_mode, 'invalid_preset_mode');
      // Only the firmware's fixed 8 survive; anything else is silently
      // discarded on the other end (climate_preset_id), so forwarding it
      // would report success for a command that does nothing.
      if (!ALLOWED_PRESET_MODES.has(mode)) throw new CommandError('invalid_preset_mode');
      return { kind: 'set_preset_mode', entityId, mode };
    }
    case 'set_swing_mode':
      return { kind: 'set_swing_mode', entityId, mode: requireMode(payload.swing_mode, 'invalid_swing_mode') };
    case 'set_swing_horizontal_mode':
      return {
        kind: 'set_swing_horizontal_mode',
        entityId,
        // The only ioBroker channel this role ever maps to (synth/climate.ts's
        // SWING_TOGGLE) is a boolean, so "on"/"off" are the only values with
        // anywhere real to go.
        on: requireOnOff(payload.swing_horizontal_mode, 'invalid_swing_horizontal_mode'),
      };
    default:
      throw new CommandError('unsupported_climate_command');
  }
}

/**
 * All ten cover commands share one topic, cmnd/cover, discriminated by a
 * "command" field -- exactly the firmware's fixed allow-list
 * (mqttPublishCoverCommand, mqtt_handlers.cpp:2268-2271; see
 * docs/contract-climate-cover.md, Cover "Outbound commands"). The firmware's
 * own publisher clamps a position to 0..100 (:2290-2291), so one outside it
 * came from another client and is refused (requirePercent).
 */
export function parseCoverCommand(raw: string): ServiceCall {
  const payload = parseObject(raw);
  const entityId = requireEntityId(payload);
  const command = typeof payload.command === 'string' ? payload.command : '';

  switch (command) {
    case 'set_cover_position':
      return { kind: 'set_cover_position', entityId, value: requirePercent(payload.position, 'invalid_position') };
    case 'set_cover_tilt_position':
      return {
        kind: 'set_cover_tilt_position',
        entityId,
        value: requirePercent(payload.tilt_position, 'invalid_tilt_position'),
      };
    case 'open_cover':
    case 'close_cover':
    case 'stop_cover':
    case 'open_cover_tilt':
    case 'close_cover_tilt':
    case 'stop_cover_tilt':
    // Uncalled: no UI in this firmware sends it (allow-list only, :2271).
    case 'toggle_cover_tilt':
      return { kind: command, entityId };
    case 'toggle':
      // Uncalled too (allow-list only, :2270). HA's cover.toggle: open or
      // close by the current state -- not switch/light's toggle, so it gets
      // its own kind, which also keeps this topic from reaching a switch.
      return { kind: 'toggle_cover', entityId };
    default:
      throw new CommandError('unsupported_cover_command');
  }
}

/**
 * All media commands share one topic, cmnd/media, discriminated by a
 * "command" field (docs/contract-media-weather.md, media_player "Outbound
 * commands"). These are exactly what the panel's controls send: the three
 * transport buttons (media_popup.cpp:774-794, types/media/renderer.cpp:
 * 478-498), the volume slider and the mute icon -- both volume_set
 * (media_popup.cpp:490, :529) -- and the seek bar (:513). No control sends a
 * stop, and mqttPublishMediaMute has no caller, so volume_mute is refused like
 * any other command. The firmware clamps a volume to 0..1 and a seek to >= 0
 * before sending (mqtt_handlers.cpp:2044, :2072-2073); one outside came from
 * another client and is refused.
 */
export function parseMediaCommand(raw: string): ServiceCall {
  const payload = parseObject(raw);
  const entityId = requireEntityId(payload);
  const command = typeof payload.command === 'string' ? payload.command : '';

  switch (command) {
    case 'previous':
      return { kind: 'media_previous', entityId };
    case 'play_pause':
      return { kind: 'media_play_pause', entityId };
    case 'next':
      return { kind: 'media_next', entityId };
    case 'volume_set': {
      // A whole slider percent / 100, printed %.3f: times 100 and rounded,
      // it is that percent again.
      const level = requireNumber(payload.volume_level, 'invalid_volume_level');
      return { kind: 'media_set_volume', entityId, value: requireWhole(level * 100, 'invalid_volume_level', 0, 100) };
    }
    case 'media_seek': {
      const position = requireNumber(payload.seek_position, 'invalid_seek_position');
      if (position < 0) throw new CommandError('invalid_seek_position');
      return { kind: 'media_seek', entityId, position };
    }
    default:
      throw new CommandError('unsupported_media_command');
  }
}

export function parseCommand(leaf: 'light' | 'switch' | 'scene' | 'climate' | 'cover' | 'media', raw: string): ServiceCall {
  switch (leaf) {
    case 'light':
      return parseLightCommand(raw);
    case 'switch':
      return parseSwitchCommand(raw);
    case 'scene':
      return parseSceneCommand(raw);
    case 'climate':
      return parseClimateCommand(raw);
    case 'cover':
      return parseCoverCommand(raw);
    case 'media':
      return parseMediaCommand(raw);
    default: {
      // The union makes this unreachable at compile time, and the `never`
      // binding keeps that guarantee if a leaf is added. The throw covers the
      // runtime: this function is typed to return a ServiceCall, so a caller
      // reaching it with a wider string must fail loudly rather than receive
      // undefined from a non-optional return type.
      const unreachable: never = leaf;
      throw new CommandError(`unsupported_command_leaf_${String(unreachable)}`);
    }
  }
}
