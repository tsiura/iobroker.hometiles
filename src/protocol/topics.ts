export const CONFIG_TOPIC_ROOT = 'tab5_lvgl/config';
export const ANNOUNCE_TOPIC_PATTERN = `${CONFIG_TOPIC_ROOT}/+/bridge`;

/** Panel settings mirrored in both directions, as cmnd/<leaf> and stat/<leaf>. */
export const PANEL_SETTING_LEAVES = [
  'display_brightness',
  'screensaver_brightness',
  'display_rotate',
  'display_sleep',
  'sleep_mains',
  'sleep_battery',
] as const;

export type PanelSettingLeaf = (typeof PANEL_SETTING_LEAVES)[number];

/**
 * The firmware's device id is 12 hex digits. It becomes panels.<deviceId>
 * object ids, which a "." would misparent (M-11): letters, digits, "_" and
 * "-", 64 at most, or no device.
 */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function deviceIdFromAnnounceTopic(topic: string): string | null {
  const parts = topic.split('/');
  if (parts.length !== 4) return null;
  if (`${parts[0]}/${parts[1]}` !== CONFIG_TOPIC_ROOT) return null;
  if (parts[3] !== 'bridge') return null;
  const deviceId = parts[2];
  return deviceId && DEVICE_ID_RE.test(deviceId) ? deviceId : null;
}

export function applyTopic(deviceId: string): string {
  return `${CONFIG_TOPIC_ROOT}/${deviceId}/bridge/apply`;
}

export function iconsTopic(deviceId: string): string {
  return `${CONFIG_TOPIC_ROOT}/${deviceId}/bridge/icons`;
}

export function bridgeRequestTopic(deviceId: string): string {
  return `${CONFIG_TOPIC_ROOT}/${deviceId}/bridge/request`;
}

/** The weather popup's request (network_manager.cpp:583-591). It has no response topic. */
export function weatherRequestTopic(deviceId: string): string {
  return `${CONFIG_TOPIC_ROOT}/${deviceId}/weather/request`;
}

/** A panel's history request and its answer (network_manager.cpp:589-590): config-plane, never under the base topic. */
export function historyRequestTopic(deviceId: string): string {
  return `${CONFIG_TOPIC_ROOT}/${deviceId}/history/request`;
}

export function historyResponseTopic(deviceId: string): string {
  return `${CONFIG_TOPIC_ROOT}/${deviceId}/history/response`;
}

/** A panel's energy request and its answer (network_manager.cpp:592-593): config-plane, never under the base topic. */
export function energyRequestTopic(deviceId: string): string {
  return `${CONFIG_TOPIC_ROOT}/${deviceId}/energy/request`;
}

export function energyResponseTopic(deviceId: string): string {
  return `${CONFIG_TOPIC_ROOT}/${deviceId}/energy/response`;
}

export function commandTopic(baseTopic: string, leaf: string): string {
  return `${baseTopic}/cmnd/${leaf}`;
}

export function stateTopic(baseTopic: string, leaf: string): string {
  return `${baseTopic}/stat/${leaf}`;
}

/** The panel's own telemetry (`mqttPublishHomeSnapshot`), e.g. `sensor/soc_pct`: read-only, never published by the adapter. */
export function sensorTopic(baseTopic: string, leaf: string): string {
  return `${baseTopic}/sensor/${leaf}`;
}

export function ioCommandTopic(baseTopic: string, channelId: string): string {
  return `${baseTopic}/cmnd/io/${channelId}`;
}

export function ioStateTopic(baseTopic: string, channelId: string): string {
  return `${baseTopic}/stat/io/${channelId}`;
}

/**
 * Builds the retained entity-state topic.
 *
 * The firmware's `buildHaStatestreamTopic` (src/network/mqtt_handlers.cpp)
 * trims the entity id and replaces EVERY '.' with '/', leaving case untouched.
 * This function lowercases and replaces only the FIRST '.'. The two are
 * equivalent for every id this adapter can produce: `entity-id.ts` emits
 * `<domain>.<slug>` where the slug is already lowercase and cannot contain a
 * dot, because slugify collapses every non-alphanumeric run to '_'. The
 * lowercasing is defensive, for an id that reaches here from an admin override.
 * Do not "align" this with the firmware by replacing every dot: a
 * multi-dot id is a bug upstream, and one slash-joined topic segment per dot
 * would silently address the wrong entity rather than fail loudly.
 */
export function entityStateTopic(haPrefix: string, entityId: string, leaf: 'state' | 'weather' | 'control' = 'state'): string {
  const dot = entityId.indexOf('.');
  if (dot <= 0 || dot === entityId.length - 1) {
    throw new Error(`invalid entity id: ${entityId}`);
  }
  const path = entityId.toLowerCase().replace('.', '/');
  return `${haPrefix}/${path}/${leaf}`;
}
