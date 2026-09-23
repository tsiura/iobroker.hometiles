import { expect } from 'chai';
import { buildMediaPayload } from '../../src/protocol/media';
import type { VirtualEntity } from '../../src/registry/types';

/*
 * Firmware facts these tests pin (HomeTiles, read-only, commit 5d25167):
 * - update_media_tile_state parses EVERY field afresh from each message and
 *   has no acceptance check (tile_renderer.cpp:4244-4299): a key left out
 *   means "no value", except the two below.
 * - is_volume_muted left out keeps the previous mute display (:4328).
 * - artwork left out (all three keys) keeps the previous cover; "" or null
 *   clears it (:4349-4351, :4393-4407; artwork_payload.h:8-22).
 * - a cover is only ever downloaded from an absolute http:// or https:// URL
 *   (:3638); anything else can never be shown.
 * - the flat scanner finds the FIRST quoted token equal to a key, key or
 *   value alike (json_scan.h:41-46).
 */

function entity(attributes: Record<string, unknown> = {}, state = 'playing'): VirtualEntity {
  return {
    entityId: 'media_player.wohnzimmer',
    domain: 'media_player',
    source: {},
    state,
    attributes,
    available: true,
    lastChanged: 1_757_000_000_000,
  };
}

const payload = (attributes?: Record<string, unknown>, state?: string): Record<string, unknown> =>
  JSON.parse(buildMediaPayload(entity(attributes, state))) as Record<string, unknown>;

const COVER = 'http://192.168.1.10:9000/music/current/cover.jpg?player=00:04:20:12:34:56';

describe('protocol/media', () => {
  it('forwards exactly the keys the firmware media parser reads, and nothing else', () => {
    expect(
      payload({
        friendly_name: 'Wohnzimmer',
        icon: 'mdi:speaker',
        supported_features: 255,
        available: false,
        source: 'Line-In',
        entity_picture_data: '/9j/4AAQSkZJRgABAQ',
        media_image_url: 'http://elsewhere/cover.jpg',
        media_title: 'Hotel California',
        media_artist: 'Eagles',
        media_album_name: 'Hotel California',
        entity_picture: COVER,
        volume_level: 0.25,
        is_volume_muted: false,
        media_position: 42,
        media_duration: 391,
      }),
    ).to.deep.equal({
      state: 'playing',
      volume_level: 0.25,
      is_volume_muted: false,
      media_position: 42,
      media_duration: 391,
      entity_picture: COVER,
      media_title: 'Hotel California',
      media_artist: 'Eagles',
      media_album_name: 'Hotel California',
    });
  });

  it("always carries the entity's own state, unavailable included", () => {
    expect(payload({}, 'unavailable').state).to.equal('unavailable');
    expect(payload({ state: 'playing' }, 'idle').state).to.equal('idle');
  });

  describe('artwork: left out means "keep the old cover", so "no cover" must be said', () => {
    it('sends an empty entity_picture when the entity has no cover, clearing the previous one', () => {
      expect(payload({})).to.have.property('entity_picture', '');
    });

    it('forwards an absolute http or https URL, trimmed', () => {
      expect(payload({ entity_picture: ` ${COVER} ` }).entity_picture).to.equal(COVER);
      expect(payload({ entity_picture: 'https://i.scdn.co/image/ab67616d0000b273' }).entity_picture).to.equal(
        'https://i.scdn.co/image/ab67616d0000b273',
      );
    });

    it('clears the cover for a value the panel can never download', () => {
      for (const unusable of [
        '/state/sonos.0.root.192_168_1_55.cover_png',
        'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ',
        'HTTP://192.168.1.10/cover.jpg',
        'ftp://nas/cover.jpg',
        '   ',
        42,
        null,
      ]) {
        expect(payload({ entity_picture: unusable }).entity_picture, String(unusable)).to.equal('');
      }
    });

    it('never sends inline pixels or the media_image_url fallback: the artwork is URL-only', () => {
      const p = payload({ entity_picture: COVER, entity_picture_data: 'iVBORw0KGgo', media_image_url: COVER });
      expect(p).to.not.have.property('entity_picture_data');
      expect(p).to.not.have.property('media_image_url');
    });
  });

  it('forwards volume_level only as a finite number, keeping a real zero', () => {
    expect(payload({ volume_level: 0 }).volume_level).to.equal(0);
    for (const bad of ['0.3', Number.NaN, Number.POSITIVE_INFINITY, null, true]) {
      expect(payload({ volume_level: bad }), String(bad)).to.not.have.property('volume_level');
    }
  });

  it('forwards is_volume_muted only as a boolean, never a guessed false', () => {
    expect(payload({ is_volume_muted: true }).is_volume_muted).to.equal(true);
    expect(payload({ is_volume_muted: false }).is_volume_muted).to.equal(false);
    for (const bad of [undefined, null, 'true', 1]) {
      expect(payload({ is_volume_muted: bad }), String(bad)).to.not.have.property('is_volume_muted');
    }
  });

  it('forwards position and duration only as a pair with a positive duration: the seek bar needs both', () => {
    expect(payload({ media_position: 0, media_duration: 180 })).to.include({ media_position: 0, media_duration: 180 });
    for (const [position, duration] of [
      [42, 0],
      [42, undefined],
      [undefined, 180],
      [42, -5],
      ['42', 180],
    ]) {
      const p = payload({ media_position: position, media_duration: duration });
      expect(p, `${String(position)}/${String(duration)}`).to.not.have.any.keys('media_position', 'media_duration');
    }
  });

  it('forwards title, artist and album trimmed, and leaves out a blank or non-text one', () => {
    const p = payload({ media_title: '  Ruhe  ', media_artist: '   ', media_album_name: 7 });
    expect(p.media_title).to.equal('Ruhe');
    expect(p).to.not.have.any.keys('media_artist', 'media_album_name');
  });

  it('puts every key the panel scans before the free text, so a title cannot impersonate a key', () => {
    // A title, artist or album equal to a key name is found by the flat
    // scanner if it comes first; ahead of the text, the real key always wins.
    const raw = buildMediaPayload(
      entity({
        media_title: 'state',
        media_artist: 'entity_picture',
        media_album_name: 'volume_level',
        volume_level: 0.3,
        is_volume_muted: true,
        media_position: 1,
        media_duration: 2,
      }),
    );
    for (const key of Object.keys(JSON.parse(raw) as object)) {
      expect(raw.indexOf(`"${key}"`), key).to.equal(raw.indexOf(`"${key}":`));
    }
  });
});
