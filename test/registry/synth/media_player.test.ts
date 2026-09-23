import { expect } from 'chai';
import { synthesise } from '../../../src/registry/synth/index';
import { synthMediaPlayer } from '../../../src/registry/synth/media_player';
import type { ChannelInput, DeviceInput, SourceValue, VirtualEntity } from '../../../src/registry/types';

const NOW = 1_757_000_000_000;
const val = (v: unknown, q = 0): SourceValue => ({ val: v, ack: true, q, ts: NOW });

type Spec = Omit<ChannelInput, 'objectId'> & { value?: SourceValue };

/** A detected media player: channel name (as detector.ts lowercases it) -> object metadata plus its value. */
function player(specs: Record<string, Spec>): { device: DeviceInput; values: Record<string, SourceValue> } {
  const channels: DeviceInput['channels'] = {};
  const values: Record<string, SourceValue> = {};
  for (const [name, { value, ...meta }] of Object.entries(specs)) {
    const objectId = `sonos.0.root.192_168_1_55.${name}`;
    channels[name] = { objectId, ...meta };
    if (value) values[objectId] = value;
  }
  return {
    device: { objectId: 'sonos.0.root.192_168_1_55', name: 'Wohnzimmer', detectorType: 'media', domain: 'media_player', channels },
    values,
  };
}

function synth(specs: Record<string, Spec>): VirtualEntity | null {
  const { device, values } = player(specs);
  return synthMediaPlayer(device, 'media_player.wohnzimmer', values);
}

function entity(specs: Record<string, Spec>): VirtualEntity {
  const result = synth(specs);
  expect(result, 'an entity').to.not.equal(null);
  return result as VirtualEntity;
}

const playing: Spec = { type: 'boolean', write: true, value: val(true) };
const stateOf = (spec: Spec): string => entity({ state: spec }).state;

describe('registry/synth/media_player', () => {
  it('synthesises a player that exposes only STATE', () => {
    const e = entity({ state: playing });
    expect(e.domain).to.equal('media_player');
    expect(e.state).to.equal('playing');
    expect(e.available).to.equal(true);
    expect(e.attributes).to.deep.equal({ friendly_name: 'Wohnzimmer' });
  });

  it('is what synthesise() returns for the media_player domain', () => {
    const { device, values } = player({ state: playing });
    expect(synthesise(device, 'media_player.wohnzimmer', values)).to.deep.equal(
      synthMediaPlayer(device, 'media_player.wohnzimmer', values),
    );
  });

  it('returns null without STATE, the one channel mediaPlayer requires: only a domain override brings such a device here', () => {
    expect(synth({ set: { type: 'boolean', write: true, value: val(true) } })).to.equal(null);
  });

  describe('state', () => {
    it('decodes a boolean STATE as ioBroker documents media.state: true playing, false pause', () => {
      expect(stateOf({ type: 'boolean', value: val(true) })).to.equal('playing');
      expect(stateOf({ type: 'boolean', value: val(false) })).to.equal('paused');
      expect(stateOf({ type: 'boolean', value: val('true') })).to.equal('playing');
    });

    it('decodes a numeric STATE by the ioBroker convention: 0 pause, 1 play, 2 stop', () => {
      expect([0, 1, 2].map((n) => stateOf({ type: 'number', value: val(n) }))).to.deep.equal(['paused', 'playing', 'idle']);
    });

    it("decodes through the channel's own states map first", () => {
      const states = { 0: 'STOP', 1: 'PLAY', 2: 'PAUSE' };
      expect([0, 1, 2].map((n) => stateOf({ type: 'number', states, value: val(n) }))).to.deep.equal(['idle', 'playing', 'paused']);
    });

    it('falls back to the convention for a map label that names no state', () => {
      const states = { 0: 'Pause', 1: 'Wiedergabe', 2: 'Stopp' };
      expect([0, 1, 2].map((n) => stateOf({ type: 'number', states, value: val(n) }))).to.deep.equal(['paused', 'playing', 'idle']);
    });

    it('decodes a string STATE by name', () => {
      const names = ['PLAY', ' pause ', 'stop', 'buffering', 'off', 'standby'];
      expect(names.map((name) => stateOf({ type: 'string', value: val(name) }))).to.deep.equal([
        'playing',
        'paused',
        'idle',
        'buffering',
        'off',
        'standby',
      ]);
    });

    it('is unknown, not unavailable, for a STATE value it cannot decode', () => {
      for (const raw of [7, 'banana']) {
        const e = entity({ state: { value: val(raw) } });
        expect([e.state, e.available], String(raw)).to.deep.equal(['unknown', true]);
      }
    });

    it('is unavailable when nothing usable is known', () => {
      for (const value of [undefined, val(null), val(true, 0x42)]) {
        const e = entity({ state: { type: 'boolean', value } });
        expect([e.state, e.available], JSON.stringify(value)).to.deep.equal(['unavailable', false]);
      }
    });

    it('is unknown, and available, when STATE is unusable but the player reports other things', () => {
      const e = entity({ state: { type: 'boolean', value: val(null) }, title: { type: 'string', value: val('Ruhe') } });
      expect([e.state, e.available]).to.deep.equal(['unknown', true]);
    });
  });

  describe('text and artwork', () => {
    it('maps TITLE, ARTIST and ALBUM, trimmed, and leaves out a blank one', () => {
      const e = entity({
        state: playing,
        title: { type: 'string', value: val(' Hotel California ') },
        artist: { type: 'string', value: val('Eagles') },
        album: { type: 'string', value: val('   ') },
      });
      expect(e.attributes).to.include({ media_title: 'Hotel California', media_artist: 'Eagles' });
      expect(e.attributes).to.not.have.property('media_album_name');
    });

    it('keeps the cover as the device reports it, and leaves a blank one out', () => {
      const cover = '/state/sonos.0.root.192_168_1_55.cover_png';
      expect(entity({ state: playing, cover: { type: 'string', value: val(cover) } }).attributes.entity_picture).to.equal(cover);
      expect(entity({ state: playing, cover: { type: 'string', value: val(' ') } }).attributes).to.not.have.property('entity_picture');
    });
  });

  describe('volume: volume_level enables the popup slider, so only a settable volume is published', () => {
    const level = (volume: Spec, extra: Record<string, Spec> = {}): unknown =>
      entity({ state: playing, volume, ...extra }).attributes.volume_level;

    it("publishes a writable VOLUME as 0..1 of the channel's own declared range", () => {
      expect(level({ type: 'number', min: 0, max: 100, write: true, value: val(30) })).to.equal(0.3);
      expect(level({ type: 'number', min: 0, max: 1, write: true, value: val(0.25) })).to.equal(0.25);
      expect(level({ type: 'number', min: -80, max: 18, write: true, value: val(-31) })).to.equal(0.5);
      expect(level({ type: 'number', write: true, value: val(45) })).to.equal(0.45);
      expect(entity({ state: playing, volume: { type: 'number', write: true, value: val(45) } }).writable).to.deep.equal({ volume: true, state: true });
    });

    it('prefers VOLUME_ACTUAL feedback over the last VOLUME command, each in its own range', () => {
      const actual: Spec = { type: 'number', min: 0, max: 50, write: false, value: val(10) };
      expect(level({ type: 'number', min: 0, max: 100, write: true, value: val(40) }, { volume_actual: actual })).to.equal(0.2);
    });

    it('keeps a real zero and clamps a reading outside the range', () => {
      expect(level({ type: 'number', min: 0, max: 100, write: true, value: val(0) })).to.equal(0);
      expect(level({ type: 'number', min: 0, max: 100, write: true, value: val(120) })).to.equal(1);
    });

    it('never turns a missing or blank volume into 0', () => {
      expect(level({ type: 'number', write: true })).to.equal(undefined);
      expect(level({ type: 'number', write: true, value: val('') })).to.equal(undefined);
    });

    it('publishes no volume it cannot set: read-only, VOLUME_ACTUAL alone, or bounds that cannot be scaled', () => {
      const readOnly = entity({ state: playing, volume: { type: 'number', write: false, value: val(30) } });
      expect([readOnly.attributes.volume_level, readOnly.writable]).to.deep.equal([undefined, { volume: false, state: true }]);

      const actualOnly = entity({ state: playing, volume_actual: { type: 'number', write: false, value: val(30) } });
      expect([actualOnly.attributes.volume_level, actualOnly.writable]).to.deep.equal([undefined, { state: true }]);

      const inverted = entity({ state: playing, volume: { type: 'number', min: 100, max: 0, write: true, value: val(30) } });
      expect([inverted.attributes.volume_level, inverted.writable]).to.deep.equal([undefined, { volume: false, state: true }]);
    });
  });

  it('maps MUTE to is_volume_muted, and leaves it out when unknown rather than guessing false', () => {
    const muted = (value?: SourceValue): unknown =>
      entity({ state: playing, mute: { type: 'boolean', write: true, value } }).attributes.is_volume_muted;
    expect([muted(val(true)), muted(val(false)), muted()]).to.deep.equal([true, false, undefined]);
  });

  describe('position: media_position+media_duration show a draggable seek bar, so only a seekable player publishes them', () => {
    const seek: Spec = { type: 'number', min: 0, max: 100, unit: '%', write: true };
    const duration = (seconds?: unknown, unit = 'sec'): Spec => ({ type: 'number', unit, write: false, value: val(seconds) });
    const elapsed = (seconds?: unknown, unit = 'sec'): Spec => ({ type: 'number', unit, write: false, value: val(seconds) });

    it('publishes both when a writable SEEK can act on them', () => {
      const e = entity({ state: playing, seek, duration: duration(391), elapsed: elapsed(42) });
      expect(e.attributes).to.include({ media_position: 42, media_duration: 391 });
      expect(e.writable).to.deep.equal({ seek: true, state: true });
    });

    it('withholds both without a writable SEEK', () => {
      const none = entity({ state: playing, duration: duration(391), elapsed: elapsed(42) });
      expect(none.attributes).to.not.have.any.keys('media_position', 'media_duration');
      const readOnly = entity({ state: playing, seek: { ...seek, write: false }, duration: duration(391), elapsed: elapsed(42) });
      expect(readOnly.attributes).to.not.have.any.keys('media_position', 'media_duration');
      expect(readOnly.writable).to.deep.equal({ seek: false, state: true });
    });

    it('withholds both unless both are known and the duration is positive', () => {
      for (const [d, p] of [
        [0, 42],
        [undefined, 42],
        [391, undefined],
        [391, ''],
      ]) {
        const e = entity({ state: playing, seek, duration: duration(d), elapsed: elapsed(p) });
        expect(e.attributes, `${String(d)}/${String(p)}`).to.not.have.any.keys('media_position', 'media_duration');
      }
    });

    it('reads a duration and position declared in milliseconds as seconds', () => {
      const e = entity({ state: playing, seek, duration: duration(391000, 'ms'), elapsed: elapsed(42000, 'ms') });
      expect(e.attributes).to.include({ media_position: 42, media_duration: 391 });
    });

    it('takes SEEK as the percentage media.seek is only when it declares no unit or % (Ruling 67)', () => {
      // A SEEK in a time unit would receive a percentage as if it were time,
      // and is not converted: no seek bar, and nothing to command.
      for (const [unit, max] of [
        ['s', 100],
        ['sec', 3600],
        ['seconds', 3600],
        ['ms', 3_600_000],
      ] as const) {
        const e = entity({ state: playing, seek: { ...seek, unit, max }, duration: duration(180), elapsed: elapsed(90) });
        expect(e.attributes, unit).to.not.have.any.keys('media_position', 'media_duration');
        expect(e.writable, unit).to.deep.equal({ seek: false, state: true });
      }
      for (const unit of [undefined, '', ' % ']) {
        const e = entity({ state: playing, seek: { ...seek, unit }, duration: duration(180), elapsed: elapsed(90) });
        expect(e.attributes, `unit ${JSON.stringify(unit)}`).to.include({ media_position: 90, media_duration: 180 });
      }
    });
  });

  it("carries every channel's codec in channelMeta, so a command can be scaled into the channel's range", () => {
    const e = entity({ state: playing, volume: { type: 'number', min: 0, max: 100, unit: '%', write: true, value: val(30) } });
    expect(e.channelMeta?.volume).to.deep.equal({
      type: 'number',
      states: undefined,
      write: true,
      current: 30,
      min: 0,
      max: 100,
      step: undefined,
      unit: '%',
    });
    expect(e.channelMeta?.state).to.include({ type: 'boolean', write: true, current: true });
  });

  it("records whether each transport button, STATE and MUTE takes a write, by the object's own flag (Task 10)", () => {
    // The panel always draws previous, play/pause and next
    // (media_popup.cpp:774-794), so no payload key can hide one that cannot
    // act: the dispatcher refuses by these instead.
    const button = (write?: boolean): Spec => ({ type: 'boolean', ...(write === undefined ? {} : { write }) });
    const e = entity({
      state: { type: 'number', write: false, value: val(1) },
      play: button(true),
      pause: button(false),
      next: button(),
      prev: button(true),
      stop: button(true),
      mute: { type: 'boolean', write: true, value: val(false) },
    });
    // Only an explicit true writes; STOP has no panel control and no role.
    expect(e.writable).to.deep.equal({ state: false, play: true, pause: false, next: false, prev: true, mute: true });
    expect(entity({ state: playing }).writable, 'no role for a channel the player lacks').to.deep.equal({ state: true });
  });
});
