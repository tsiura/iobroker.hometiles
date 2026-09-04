export type LocalIoType = 'relay' | 'temperature';

export interface LocalIoChannel {
  id: string;
  entityId: string;
  legacyEntityIds: string[];
  name: string;
  type: LocalIoType;
}

export interface Announcement {
  deviceId: string;
  baseTopic: string;
  haPrefix: string;
  deviceName: string;
  manufacturer: string;
  model: string;
  sensors: string[];
  binarySensors: string[];
  sceneMap: Record<string, string>;
  localIo: LocalIoChannel[];
}

export class AnnounceError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'AnnounceError';
  }
}

const MAX_LOCAL_IO_CHANNELS = 64;
const CHANNEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENTITY_ID_RE = /^(sensor|switch)\.[a-z0-9][a-z0-9_]{0,254}$/;

const TYPE_ALIASES: Record<string, LocalIoType> = {
  relay: 'relay',
  switch: 'relay',
  temperature: 'temperature',
  temperature_sensor: 'temperature',
  temp: 'temperature',
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && entry.length > 0) out[key] = entry;
  }
  return out;
}

export function normaliseLocalIo(raw: unknown): LocalIoChannel[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AnnounceError('invalid_local_io');
  if (raw.length > MAX_LOCAL_IO_CHANNELS) throw new AnnounceError('too_many_local_io_channels');

  const result: LocalIoChannel[] = [];
  const seenIds = new Set<string>();

  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AnnounceError(`invalid_local_io_item_${index}`);
    }
    const record = item as Record<string, unknown>;
    const type = TYPE_ALIASES[String(record.type ?? '').trim().toLowerCase()];
    const id = String(record.id ?? '').trim();
    const entityId = String(record.entity_id ?? '').trim().toLowerCase();

    if (!type || !CHANNEL_ID_RE.test(id) || !ENTITY_ID_RE.test(entityId)) {
      throw new AnnounceError(`invalid_local_io_item_${index}`);
    }
    if (seenIds.has(id)) throw new AnnounceError(`duplicate_local_io_id_${id}`);
    seenIds.add(id);

    result.push({
      id,
      entityId,
      legacyEntityIds: asStringArray(record.legacy_entity_ids).map((value) => value.toLowerCase()),
      name: String(record.name ?? '').trim() || id,
      type,
    });
  }

  return result;
}

export function parseAnnouncement(deviceId: string, raw: string): Announcement {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AnnounceError('invalid_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AnnounceError('invalid_payload');
  }
  const payload = parsed as Record<string, unknown>;

  const text = (key: string, fallback: string): string => {
    const value = payload[key];
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  };

  return {
    // The topic is authoritative: it is what the panel actually owns.
    deviceId,
    baseTopic: text('base_topic', 'hometiles'),
    haPrefix: text('ha_prefix', 'ha/statestream'),
    deviceName: text('device_name', ''),
    manufacturer: text('manufacturer', 'HomeTiles'),
    model: text('model', ''),
    sensors: asStringArray(payload.sensors),
    binarySensors: asStringArray(payload.binary_sensors),
    sceneMap: asStringRecord(payload.scene_map),
    localIo: normaliseLocalIo(payload.local_io),
  };
}
