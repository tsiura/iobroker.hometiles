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
  | { kind: 'set_cover_position' | 'set_cover_tilt_position'; entityId: string; value: number };

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

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
    call.brightnessPct = clamp(requireNumber(payload.brightness_pct, 'invalid_brightness'), 0, 100);
  }

  if (hasRgb) {
    const rgb = payload.rgb_color;
    if (!Array.isArray(rgb) || rgb.length !== 3) throw new CommandError('invalid_rgb');
    const [r, g, b] = rgb.map((component) => clamp(requireNumber(component, 'invalid_rgb'), 0, 255));
    call.rgb = [r as number, g as number, b as number];
  }

  if (hasKelvin) {
    call.kelvin = clamp(requireNumber(payload.color_temp_kelvin, 'invalid_kelvin'), 1000, 15000);
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
 * docs/contract-climate-cover.md, Cover "Outbound commands"). Positions are
 * clamped to 0..100 as the firmware's own publisher does (:2290-2291).
 */
export function parseCoverCommand(raw: string): ServiceCall {
  const payload = parseObject(raw);
  const entityId = requireEntityId(payload);
  const command = typeof payload.command === 'string' ? payload.command : '';

  switch (command) {
    case 'set_cover_position':
      return {
        kind: 'set_cover_position',
        entityId,
        value: clamp(requireNumber(payload.position, 'invalid_position'), 0, 100),
      };
    case 'set_cover_tilt_position':
      return {
        kind: 'set_cover_tilt_position',
        entityId,
        value: clamp(requireNumber(payload.tilt_position, 'invalid_tilt_position'), 0, 100),
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

export function parseCommand(leaf: 'light' | 'switch' | 'scene' | 'climate' | 'cover', raw: string): ServiceCall {
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
