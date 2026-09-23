import { expect } from 'chai';
import { buildMediaPayload } from '../../src/protocol/media';
import { synthMediaPlayer } from '../../src/registry/synth/media_player';
import type { ChannelInput, DeviceInput, SourceValue, VirtualEntity } from '../../src/registry/types';

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
 * - every lookup finds the FIRST quoted token equal to the key, key or value
 *   alike (strstr at :820-821, json_scan.h:41-46), then reads past the NEXT
 *   colon -- the port at the end of this file proves what the panel takes.
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

  describe('no text value ever acts as a key the panel reads (Ruling 65(2)), proved against a port of its scanner', () => {
    // Every key update_media_tile_state looks up, fallbacks included
    // (tile_renderer.cpp:4283-4298, :4396-4399, artwork_payload.h:10-12).
    const PANEL_KEYS = [
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
    ];

    type Spec = Omit<ChannelInput, 'objectId'> & { value?: unknown };
    function synthesised(specs: Record<string, Spec>): VirtualEntity {
      const channels: DeviceInput['channels'] = {};
      const values: Record<string, SourceValue> = {};
      for (const [name, { value, ...meta }] of Object.entries(specs)) {
        channels[name] = { objectId: `p.${name}`, ...meta };
        if (value !== undefined) values[`p.${name}`] = { val: value, ack: true, q: 0, ts: 1 };
      }
      const device: DeviceInput = { objectId: 'p', name: 'P', detectorType: 'media', domain: 'media_player', channels };
      return synthMediaPlayer(device, 'media_player.p', values) as VirtualEntity;
    }
    const texts = (title: string, artist: string, album: string): Record<string, Spec> => ({
      title: { type: 'string', value: title },
      artist: { type: 'string', value: artist },
      album: { type: 'string', value: album },
    });
    const PLAYING: Record<string, Spec> = { state: { type: 'boolean', write: true, value: true } };
    const READ_ONLY_VOLUME: Record<string, Spec> = { volume: { type: 'number', min: 0, max: 100, write: false, value: 30 } };
    const FULL: Record<string, Spec> = {
      volume: { type: 'number', min: 0, max: 100, write: true, value: 30 },
      mute: { type: 'boolean', write: true, value: false },
      seek: { type: 'number', min: 0, max: 100, write: true },
      duration: { type: 'number', value: 200 },
      elapsed: { type: 'number', value: 10 },
      cover: { type: 'string', value: 'http://nas/"volume' },
    };

    /** What the panel should take from the entity's payload: exactly the entity, and no cover data. */
    function expected(e: VirtualEntity): Record<string, unknown> {
      const a = e.attributes;
      const url = typeof a.entity_picture === 'string' && /^https?:\/\//.test(a.entity_picture) ? a.entity_picture : '';
      return {
        state: e.state,
        title: a.media_title,
        artist: a.media_artist,
        album: a.media_album_name,
        app: undefined,
        source: undefined,
        channel: undefined,
        volume: a.volume_level,
        muted: a.is_volume_muted,
        position: a.media_position,
        duration: a.media_duration,
        cover: { url, data: undefined },
      };
    }

    it("the reviewer's probes: a text named like a key the payload leaves out is not read as that key", () => {
      const probes: Array<[string, Record<string, Spec>]> = [
        ['read-only volume, title "volume", artist "50"', { ...PLAYING, ...READ_ONLY_VOLUME, ...texts('volume', '50', 'Album') }],
        ['no mute, title "muted", artist "true"', { ...PLAYING, ...texts('muted', 'true', 'Album') }],
        ['title "entity_picture_data", artist "Eagles"', { ...PLAYING, ...texts('entity_picture_data', 'Eagles', 'Album') }],
      ];
      for (const [label, specs] of probes) {
        const e = synthesised(specs);
        expect(panelReads(buildMediaPayload(e)), label).to.deep.equal(expected(e));
      }
    });

    it('holds for every key the panel reads, sent or left out, as a bare text or after a quote', () => {
      for (const key of PANEL_KEYS) {
        for (const [extraLabel, extra] of [
          ['bare', {}],
          ['full', FULL],
        ] as const) {
          for (const [title, artist] of [
            [key, 'true'],
            [`a"${key}`, '1'],
            [`"${key}`, 'false'],
            ['Title', key],
          ]) {
            const e = synthesised({ ...PLAYING, ...extra, ...texts(title as string, artist as string, '50') });
            expect(panelReads(buildMediaPayload(e)), `${extraLabel}: ${title} / ${artist}`).to.deep.equal(expected(e));
          }
        }
      }
    });
  });
});

/*
 * A port of the firmware's media reads, line for line, to prove what the
 * panel takes from a payload -- update_media_tile_state's order
 * (tile_renderer.cpp:4282-4299, :4393-4401) over
 * extract_json_{string,number,bool}_field_cstr (:818-908), valueOffset and
 * stringSpan (json_scan.h:33-87) behind media_artwork::has_fields and
 * read_string (artwork_payload.h:8-22), and decode_basic_json_escapes
 * (:998-1089). Arduino's String::trim strips C whitespace only.
 */
const ctrim = (text: string): string => text.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, '');

/** strstr for the quoted key, then strchr for the next ':' after it. */
function colonAfter(src: string, key: string): number {
  const idx = src.indexOf(`"${key}"`);
  return idx < 0 ? -1 : src.indexOf(':', idx + key.length + 2);
}

function cstrString(src: string, key: string): string | undefined {
  const colon = colonAfter(src, key);
  if (colon < 0) return undefined;
  const q1 = src.indexOf('"', colon); // strchr(colon, '"'): the next quote, whatever lies between
  if (q1 < 0) return undefined;
  let q2 = q1 + 1;
  let escaped = false;
  while (q2 < src.length) {
    const c = src.charAt(q2);
    if (c === '"' && !escaped) break;
    escaped = c === '\\' && !escaped;
    if (c !== '\\') escaped = false;
    q2++;
  }
  if (src.charAt(q2) !== '"') return undefined;
  const out = ctrim(src.slice(q1 + 1, q2));
  return out.length ? out : undefined;
}

/** strtof's accepted syntax, after the leading whitespace it skips itself. */
const STRTOF = /^[ \t\n\v\f\r]*[+-]?(?:inf(?:inity)?|nan|0x(?:[0-9a-f]+\.?[0-9a-f]*|\.[0-9a-f]+)(?:p[+-]?\d+)?|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/i;

function cstrNumber(src: string, key: string): number | undefined {
  const colon = colonAfter(src, key);
  if (colon < 0) return undefined;
  let start = colon + 1;
  while (/[ \t\r\n]/.test(src.charAt(start))) start++;
  const quoted = src.charAt(start) === '"';
  if (quoted) start++;
  const match = STRTOF.exec(src.slice(start));
  if (!match) return undefined;
  if (quoted && src.charAt(start + match[0].length) !== '"') return undefined;
  return Number(ctrim(match[0]));
}

function cstrBool(src: string, key: string): boolean | undefined {
  const colon = colonAfter(src, key);
  if (colon < 0) return undefined;
  let start = colon + 1;
  while (/[ \t\r\n]/.test(src.charAt(start))) start++;
  const rest = src.slice(start);
  if (rest.startsWith('true') || rest.startsWith('"true')) return true;
  if (rest.startsWith('false') || rest.startsWith('"false')) return false;
  return undefined;
}

function valueOffset(json: string, key: string): number {
  const found = json.indexOf(`"${key}"`);
  if (found < 0) return -1;
  const colon = json.indexOf(':', found);
  if (colon < 0) return -1;
  let pos = colon + 1;
  while (json.charAt(pos) === ' ' || json.charAt(pos) === '\t') pos++;
  return pos < json.length ? pos : -1;
}

/** media_artwork::read_string: stringSpan, trimmed; undefined when stringSpan fails. */
function readString(json: string, key: string): string | undefined {
  const pos = valueOffset(json, key);
  if (pos < 0 || json.charAt(pos) !== '"') return undefined;
  let escaped = false;
  for (let i = pos + 1; i < json.length; i++) {
    const c = json.charAt(i);
    if (escaped) escaped = false;
    else if (c === '\\') escaped = true;
    else if (c === '"') return ctrim(json.slice(pos + 1, i));
  }
  return undefined;
}

function decodeEscapes(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c !== '\\' || i + 1 >= text.length) {
      out += c;
      continue;
    }
    const hex = /^u([0-9a-fA-F]{4})/.exec(text.slice(i + 1));
    if (hex) {
      out += String.fromCharCode(Number.parseInt(hex[1] as string, 16));
      i += 5;
      continue;
    }
    const esc = text.charAt(i + 1);
    out += ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[esc] ?? esc;
    i++;
  }
  return out;
}

function panelReads(payload: string): Record<string, unknown> {
  const text = (key: string): string | undefined => {
    const raw = cstrString(payload, key);
    return raw === undefined ? undefined : decodeEscapes(raw);
  };
  const hasArtwork = ['entity_picture_data', 'entity_picture', 'media_image_url'].some((key) => valueOffset(payload, key) >= 0);
  const url = readString(payload, 'entity_picture') ?? readString(payload, 'media_image_url') ?? '';
  const data = readString(payload, 'entity_picture_data');
  return {
    state: text('state'),
    title: text('media_title'),
    artist: text('media_artist'),
    album: text('media_album_name'),
    app: text('app_name'),
    source: text('source'),
    channel: text('media_channel'),
    volume: cstrNumber(payload, 'volume_level') ?? cstrNumber(payload, 'volume'),
    muted: cstrBool(payload, 'is_volume_muted') ?? cstrBool(payload, 'muted'),
    position: cstrNumber(payload, 'media_position'),
    duration: cstrNumber(payload, 'media_duration'),
    cover: hasArtwork ? { url: decodeEscapes(url), data: data === undefined || data === '' ? undefined : decodeEscapes(data) } : undefined,
  };
}
