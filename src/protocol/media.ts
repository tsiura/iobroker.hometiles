import type { VirtualEntity } from '../registry/types';

/**
 * The media_player state payload (docs/contract-media-weather.md, "media_player").
 * Firmware facts, from HomeTiles (read-only) src/tiles/runtime/tile_renderer.cpp:
 *
 * - No acceptance check: every JSON payload is parsed, and every field afresh
 *   from each message (update_media_tile_state, :4244-4299). A key left out
 *   means "no value": no title, volume slider disabled, seek bar hidden.
 * - Two exceptions. A left-out is_volume_muted keeps the previous mute display
 *   (:4328). Left-out artwork keeps the previous cover, and only an explicit
 *   "" (or null) clears it (:4349-4351, :4393-4407). So "no cover" must be
 *   said, never implied, or the last track's cover stays up.
 * - A cover is downloaded only from an absolute http:// or https:// URL
 *   (:3638). Anything else (an ioBroker web path such as sonos's /state/...,
 *   a data: URI) could never be shown, so it is sent as "no cover".
 * - No `available` key and no friendly_name are read for media, and there is
 *   no supported_features: the volume slider is enabled by volume_level alone
 *   and the seek bar shown by media_position+media_duration alone
 *   (media_popup.cpp:261-265, :483, :300-310, :501-502). The synth sets those
 *   attributes only when the command behind them can land
 *   (synth/media_player.ts).
 *
 * state_fast: the firmware routes <entity>/state_fast exactly like
 * <entity>/state (mqtt_handlers.cpp:1330-1338, :1454-1483). The Bridge uses it
 * to send the cover URL ahead of the inline pixels (entity_picture_data) the
 * full state carries (tile_renderer.cpp:4072-4073). This adapter sends no
 * pixels, so this one URL-only payload already is that variant, and it goes to
 * `state`, the topic every firmware subscribes to. A payload holding the URL
 * alone would blank title, subtitle, volume and seek bar, since each message is
 * parsed afresh.
 */

const TEXT_KEYS = ['media_title', 'media_artist', 'media_album_name'] as const;

/**
 * Every key the panel looks up in a media payload, fallbacks included
 * (tile_renderer.cpp:4283-4298, :4396-4399), and the one the entity cache
 * searches for (tab_tiles_unified.cpp:402-403, :435-436).
 */
const PANEL_KEYS: ReadonlySet<string> = new Set([
  'state',
  'media_title',
  'media_artist',
  'media_album_name',
  'app_name',
  'source',
  'media_channel',
  'volume_level',
  'volume',
  'media_position',
  'media_duration',
  'is_volume_muted',
  'muted',
  'entity_picture',
  'entity_picture_data',
  'media_image_url',
]);

/**
 * A string as a JSON token no lookup can take for a key (Ruling 65(2)). Every
 * lookup searches the whole payload for the quoted name, value or key alike,
 * and reads past the NEXT colon (strstr, tile_renderer.cpp:820-823;
 * json_scan.h:41-55). So a title "volume" ahead of an artist "50" read as
 * volume 50 for a player whose volume is read-only, and a title
 * "entity_picture_data" had the artist decoded as cover pixels. A quote inside
 * a string is therefore written \u0022, which makes every quote in the payload
 * a token's delimiter: a lookup can match only a whole token equal to the
 * name, and a string equal to a name has its first letter escaped. The panel
 * decodes \uXXXX (tile_renderer.cpp:998-1089) and shows the text unchanged.
 * Nothing is sent as null: the string lookup takes the next quoted token as
 * the value of a null (strchr(colon, '"'), :825).
 */
function text(value: string): string {
  const inner = JSON.stringify(value)
    .slice(1, -1)
    .replace(/\\(u[0-9a-fA-F]{4}|.)/g, (escape, code: string) => (code === '"' ? '\\u0022' : escape));
  const first = `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`;
  return PANEL_KEYS.has(value) ? `"${first}${inner.slice(1)}"` : `"${inner}"`;
}

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function coverUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.trim() : '';
  return url.startsWith('http://') || url.startsWith('https://') ? url : '';
}

export function buildMediaPayload(entity: VirtualEntity): string {
  const attrs = entity.attributes;
  const fields = [`"state":${text(entity.state)}`];

  const volume = finite(attrs.volume_level);
  if (volume !== undefined) fields.push(`"volume_level":${volume}`);
  if (typeof attrs.is_volume_muted === 'boolean') fields.push(`"is_volume_muted":${attrs.is_volume_muted}`);

  const position = finite(attrs.media_position);
  const duration = finite(attrs.media_duration);
  if (position !== undefined && duration !== undefined && duration > 0) {
    fields.push(`"media_position":${position}`, `"media_duration":${duration}`);
  }

  fields.push(`"entity_picture":${text(coverUrl(attrs.entity_picture))}`);

  for (const key of TEXT_KEYS) {
    const value = attrs[key];
    if (typeof value === 'string' && value.trim()) fields.push(`"${key}":${text(value.trim())}`);
  }
  return `{${fields.join(',')}}`;
}
