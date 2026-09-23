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

/** Free text last: the flat scanner takes the first quoted token equal to a key, value or not (json_scan.h:41-46). */
const TEXT_KEYS = ['media_title', 'media_artist', 'media_album_name'] as const;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function coverUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.trim() : '';
  return url.startsWith('http://') || url.startsWith('https://') ? url : '';
}

export function buildMediaPayload(entity: VirtualEntity): string {
  const attrs = entity.attributes;
  const body: Record<string, unknown> = { state: entity.state };

  const volume = finite(attrs.volume_level);
  if (volume !== undefined) body.volume_level = volume;
  if (typeof attrs.is_volume_muted === 'boolean') body.is_volume_muted = attrs.is_volume_muted;

  const position = finite(attrs.media_position);
  const duration = finite(attrs.media_duration);
  if (position !== undefined && duration !== undefined && duration > 0) {
    body.media_position = position;
    body.media_duration = duration;
  }

  body.entity_picture = coverUrl(attrs.entity_picture);

  for (const key of TEXT_KEYS) {
    const text = attrs[key];
    if (typeof text === 'string' && text.trim()) body[key] = text.trim();
  }
  return JSON.stringify(body);
}
