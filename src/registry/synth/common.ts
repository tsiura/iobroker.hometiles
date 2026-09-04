import type { ChannelInput, DeviceInput, SourceValue } from '../types';
import { STATE_OFF, STATE_ON, STATE_UNAVAILABLE, STATE_UNKNOWN } from '../types';

export type Values = Readonly<Record<string, SourceValue | null | undefined>>;

export interface ChannelRead {
  channel: ChannelInput;
  value: SourceValue | null;
}

/**
 * Reads one logical channel. Returns null when the channel is not configured at
 * all, which is a different condition from a configured channel with no value.
 */
export function readChannel(device: DeviceInput, name: string, values: Values): ChannelRead | null {
  const channel = device.channels[name];
  if (!channel) return null;
  return { channel, value: values[channel.objectId] ?? null };
}

/** A value is usable only when it exists, is non-null and its quality is good. */
export function isUsable(value: SourceValue | null | undefined): value is SourceValue {
  if (!value) return false;
  if (value.val === null || value.val === undefined) return false;
  return !value.q;
}

export function toBoolState(raw: unknown): string {
  if (typeof raw === 'boolean') return raw ? STATE_ON : STATE_OFF;
  if (typeof raw === 'number') return raw !== 0 ? STATE_ON : STATE_OFF;
  if (typeof raw === 'string') {
    const text = raw.trim().toLowerCase();
    if (['true', 'on', '1', 'open', 'yes'].includes(text)) return STATE_ON;
    if (['false', 'off', '0', 'closed', 'no'].includes(text)) return STATE_OFF;
    return STATE_UNKNOWN;
  }
  return STATE_UNKNOWN;
}

export function numberToState(raw: unknown): string {
  const numeric = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(numeric)) return STATE_UNKNOWN;
  return String(numeric);
}

export function baseEntity(
  device: DeviceInput,
  entityId: string,
  values: Values,
): { source: Record<string, string>; lastChanged: number; friendly: Record<string, unknown> } {
  const source: Record<string, string> = {};
  let lastChanged = 0;
  for (const [name, channel] of Object.entries(device.channels)) {
    source[name] = channel.objectId;
    const value = values[channel.objectId];
    if (value && value.ts > lastChanged) lastChanged = value.ts;
  }
  const friendly: Record<string, unknown> = { friendly_name: device.name || entityId };
  if (device.icon) friendly.icon = device.icon;
  return { source, lastChanged: lastChanged || Date.now(), friendly };
}

export const UNAVAILABLE = STATE_UNAVAILABLE;
export const UNKNOWN = STATE_UNKNOWN;
