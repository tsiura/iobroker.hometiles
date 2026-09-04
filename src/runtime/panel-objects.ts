import type { LocalIoChannel } from '../protocol/announce';
import { ioCommandTopic } from '../protocol/topics';
import type { Logger } from './mqtt-client';
import type { PanelSession } from './panel-session';

export interface ObjectStore {
  setObject(id: string, obj: unknown): Promise<void>;
  deleteObject(id: string, recursive: boolean): Promise<void>;
  setState(id: string, value: unknown, ack: boolean): Promise<void>;
}

export interface PanelSettingDef {
  leaf: string;
  /**
   * How the firmware parses this leaf, verified in mqtt_handlers.cpp:
   *  - percent : integer, with a legacy 121..255 encoding on the stat topic
   *  - bool    : parseBoolPayload, echoed as ON / OFF
   *  - duration: parseSleepPayload, echoed as a label
   */
  kind: 'percent' | 'bool' | 'duration';
  role: string;
  name: string;
  min?: number;
  max?: number;
  unit?: string;
  states?: string[];
}

/**
 * The labels `parseSleepPayload` matches exactly. It ALSO accepts free-form
 * durations (`30s`, `15min`, a bare number of seconds in 1..3600) and the
 * disable words below, so these are the convenient values rather than the only
 * legal ones. `sleepLabelFromConfig` echoes one of these back on the stat topic.
 */
const SLEEP_LABELS = ['5 s', '15 s', '30 s', '60 s', '5 min', '15 min', '30 min', '60 min'];
/** Any of these disables the timeout. The firmware lower-cases before matching. */
const SLEEP_DISABLE = 'never';

export const PANEL_SETTING_DEFS: readonly PanelSettingDef[] = [
  { leaf: 'display_brightness', kind: 'percent', role: 'level.dimmer', name: 'Display brightness', min: 1, max: 100, unit: '%' },
  { leaf: 'screensaver_brightness', kind: 'percent', role: 'level.dimmer', name: 'Screensaver brightness', min: 1, max: 100, unit: '%' },
  // Boolean, not an angle: parseBoolPayload feeds setRotationFlipped(). The
  // panel echoes ON/OFF. Writing "2" here fails the parse and is silently
  // ignored by the firmware.
  { leaf: 'display_rotate', kind: 'bool', role: 'switch', name: 'Display rotated 180 degrees' },
  // Boolean, and it is NOT a timeout: it puts the panel to sleep or wakes it.
  // The stat topic reports powerManager.isInSleep().
  { leaf: 'display_sleep', kind: 'bool', role: 'switch', name: 'Display asleep' },
  { leaf: 'sleep_mains', kind: 'duration', role: 'text', name: 'Sleep timeout on mains', states: [...SLEEP_LABELS, SLEEP_DISABLE] },
  { leaf: 'sleep_battery', kind: 'duration', role: 'text', name: 'Sleep timeout on battery', states: [...SLEEP_LABELS, SLEEP_DISABLE] },
];

const LEGACY_BRIGHTNESS_MIN = 121;
const LEGACY_BRIGHTNESS_MAX = 255;

/**
 * Number('') and Number('   ') are both 0, and 0 is finite, so a bare
 * Number()+isFinite guard silently turns a blank payload into a confident zero.
 * That is the same defect class already fixed in the synthesis helpers: here it
 * would write 0 % brightness, or 0 °C for a temperature channel that reported
 * nothing. Blank means unknown, so it yields undefined and the caller decides.
 */
/** Mirrors the firmware's parseBoolPayload exactly, including its vocabulary. */
function parseBoolPayload(raw: string): boolean | undefined {
  const text = raw.trim().toLowerCase();
  if (['1', 'on', 'true', 'yes'].includes(text)) return true;
  if (['0', 'off', 'false', 'no'].includes(text)) return false;
  return undefined;
}

function parseFiniteNumber(raw: string): number | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : undefined;
}

/** The firmware's older protocol encoded 1..100 percent as 121..255. */
function decodeBrightness(raw: number): number {
  if (raw <= 100) return Math.round(raw);
  const clamped = Math.min(LEGACY_BRIGHTNESS_MAX, Math.max(LEGACY_BRIGHTNESS_MIN, raw));
  return Math.round(1 + ((clamped - LEGACY_BRIGHTNESS_MIN) * 99) / (LEGACY_BRIGHTNESS_MAX - LEGACY_BRIGHTNESS_MIN));
}

function stateObject(name: string, common: Record<string, unknown>): Record<string, unknown> {
  return { type: 'state', common: { name, read: true, ...common }, native: {} };
}

export function ioStateDef(channel: LocalIoChannel): Record<string, unknown> {
  if (channel.type === 'relay') {
    return stateObject(channel.name, { type: 'boolean', role: 'switch', write: true, def: false });
  }
  return stateObject(channel.name, { type: 'number', role: 'value.temperature', write: false, unit: '°C' });
}

export function panelObjectDefs(session: PanelSession): Array<{ id: string; obj: Record<string, unknown> }> {
  const root = `panels.${session.deviceId}`;
  const defs: Array<{ id: string; obj: Record<string, unknown> }> = [
    { id: root, obj: { type: 'device', common: { name: session.deviceName || session.deviceId }, native: { deviceId: session.deviceId } } },
    { id: `${root}.info`, obj: { type: 'channel', common: { name: 'Information' }, native: {} } },
    { id: `${root}.info.connected`, obj: stateObject('Panel connected', { type: 'boolean', role: 'indicator.reachable', write: false, def: false }) },
    { id: `${root}.info.ip`, obj: stateObject('IP address', { type: 'string', role: 'info.ip', write: false }) },
    { id: `${root}.info.baseTopic`, obj: stateObject('Base topic', { type: 'string', role: 'text', write: false }) },
    { id: `${root}.info.model`, obj: stateObject('Model', { type: 'string', role: 'text', write: false }) },
    { id: `${root}.control`, obj: { type: 'channel', common: { name: 'Control' }, native: {} } },
  ];

  for (const def of PANEL_SETTING_DEFS) {
    const stateType = def.kind === 'percent' ? 'number' : def.kind === 'bool' ? 'boolean' : 'string';
    const common: Record<string, unknown> = { type: stateType, role: def.role, write: true };
    if (def.min !== undefined) common.min = def.min;
    if (def.max !== undefined) common.max = def.max;
    if (def.unit) common.unit = def.unit;
    if (def.states) common.states = Object.fromEntries(def.states.map((value) => [value, value]));
    defs.push({ id: `${root}.control.${def.leaf}`, obj: stateObject(def.name, common) });
  }

  defs.push({ id: `${root}.control.pair`, obj: stateObject('Send broker credentials', { type: 'boolean', role: 'button', write: true }) });
  defs.push({ id: `${root}.control.refresh`, obj: stateObject('Force configuration push', { type: 'boolean', role: 'button', write: true }) });

  if (session.localIo.length) {
    defs.push({ id: `${root}.io`, obj: { type: 'channel', common: { name: 'Local Hardware I/O' }, native: {} } });
    for (const channel of session.localIo) {
      defs.push({ id: `${root}.io.${channel.id}`, obj: ioStateDef(channel) });
    }
  }

  return defs;
}

export class PanelObjects {
  constructor(
    private readonly store: ObjectStore,
    private readonly log: Logger,
  ) {}

  async sync(session: PanelSession): Promise<void> {
    for (const def of panelObjectDefs(session)) {
      await this.store.setObject(def.id, def.obj);
    }
    const root = `panels.${session.deviceId}`;
    await this.store.setState(`${root}.info.baseTopic`, session.baseTopic, true);
    await this.store.setState(`${root}.info.model`, session.model, true);
  }

  async remove(deviceId: string): Promise<void> {
    await this.store.deleteObject(`panels.${deviceId}`, true);
  }

  async applyPanelStat(session: PanelSession, leaf: string, payload: string): Promise<void> {
    const def = PANEL_SETTING_DEFS.find((candidate) => candidate.leaf === leaf);
    if (!def) return;
    const id = `panels.${session.deviceId}.control.${def.leaf}`;

    if (def.kind === 'bool') {
      // The panel echoes ON / OFF on these two.
      const flag = parseBoolPayload(payload);
      if (flag === undefined) return;
      await this.store.setState(id, flag, true);
      return;
    }

    if (def.kind === 'duration') {
      const text = payload.trim();
      if (!text) return;
      await this.store.setState(id, text, true);
      return;
    }

    const numeric = parseFiniteNumber(payload);
    if (numeric === undefined) return;
    await this.store.setState(id, decodeBrightness(numeric), true);
  }

  async applyIoStat(session: PanelSession, channelId: string, payload: string): Promise<void> {
    const channel = session.localIo.find((candidate) => candidate.id === channelId);
    if (!channel) return;
    const id = `panels.${session.deviceId}.io.${channel.id}`;
    const text = payload.trim();

    if (channel.type === 'relay') {
      await this.store.setState(id, text.toUpperCase() === 'ON', true);
      return;
    }

    // An unavailable sensor must stay null. Zero is a plausible temperature, so
    // a blank or non-numeric payload must never be coerced into one.
    const numeric = parseFiniteNumber(text);
    await this.store.setState(id, numeric ?? null, true);
  }

  handleControlWrite(session: PanelSession, path: string, value: unknown): void {
    if (path.startsWith('io.')) {
      const channelId = path.slice(3);
      const channel = session.localIo.find((candidate) => candidate.id === channelId);
      if (!channel || channel.type !== 'relay') {
        this.log.warn(`[Panel ${session.deviceId}] Ignored write to non-commandable channel ${path}`);
        return;
      }
      session.publishRaw(ioCommandTopic(session.baseTopic, channel.id), value ? 'ON' : 'OFF');
      return;
    }

    const leaf = path.startsWith('control.') ? path.slice('control.'.length) : '';
    const def = PANEL_SETTING_DEFS.find((candidate) => candidate.leaf === leaf);
    if (!def) return;

    if (def.kind === 'bool') {
      // parseBoolPayload accepts ON / OFF among others; publish the form the
      // panel itself echoes so a round trip is byte-identical.
      const flag = typeof value === 'boolean' ? value : parseBoolPayload(String(value ?? ''));
      if (flag === undefined) return;
      session.publishPanelCommand(def.leaf, flag ? 'ON' : 'OFF');
      return;
    }

    if (def.kind === 'duration') {
      // parseSleepPayload takes a label, a free-form duration, or a disable
      // word. Pass the text through and let the firmware do the validating —
      // it accepts more forms than any list here could usefully enumerate.
      const text = String(value ?? '').trim();
      if (!text) return;
      session.publishPanelCommand(def.leaf, text);
      return;
    }

    // The already-a-number branch still needs the finite check: NaN and Infinity
    // are numbers. Without it NaN publishes the literal string "NaN" and
    // Infinity silently clamps to the maximum, both of which accept garbage as
    // though it were a deliberate setting.
    const raw = typeof value === 'number' ? value : parseFiniteNumber(String(value ?? ''));
    if (raw === undefined || !Number.isFinite(raw)) return;
    const numeric = raw;
    const min = def.min ?? Number.NEGATIVE_INFINITY;
    const max = def.max ?? Number.POSITIVE_INFINITY;
    session.publishPanelCommand(def.leaf, String(Math.round(Math.min(max, Math.max(min, numeric)))));
  }
}
