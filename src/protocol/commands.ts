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
  | { kind: 'activate_scene'; alias: string };

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

export function parseCommand(leaf: 'light' | 'switch' | 'scene', raw: string): ServiceCall {
  switch (leaf) {
    case 'light':
      return parseLightCommand(raw);
    case 'switch':
      return parseSwitchCommand(raw);
    case 'scene':
      return parseSceneCommand(raw);
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
