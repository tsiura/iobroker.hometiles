import { expect } from 'chai';
import { synthCover } from '../../../src/registry/synth/cover';
import { synthesise } from '../../../src/registry/synth/index';
import type { ChannelInput, DeviceInput, SourceValue } from '../../../src/registry/types';

const NOW = 1_757_000_000_000;

function numState(val: unknown, q = 0): SourceValue {
  return { val, ack: true, q, ts: NOW };
}

/**
 * Builds a blind DeviceInput plus its values map from a detector-style
 * channel name -> value record, e.g. { SET: numState(40) }. Channel names
 * are lowercased the same way detector.ts's channelName default branch
 * does, so these fixtures read exactly like a real detected blind.
 *
 * Defaults detectorType to 'blind' -- the Types enum VALUE a real blinds
 * device carries at runtime, not the pattern key 'blinds' (docs/
 * contract-iobroker-types.md's "pattern keys are not Types values" trap,
 * verified directly against node_modules/@iobroker/type-detector/build/
 * types.js: Types.blind = "blind"; there is no Types.blinds at all).
 */
function deviceWith(
  channelValues: Record<string, SourceValue>,
  detectorType = 'blind',
): { device: DeviceInput; values: Record<string, SourceValue> } {
  const channels: DeviceInput['channels'] = {};
  const values: Record<string, SourceValue> = {};
  for (const [rawName, value] of Object.entries(channelValues)) {
    const name = rawName.toLowerCase();
    const objectId = `cover.0.${name}`;
    channels[name] = { objectId, write: true };
    values[objectId] = value;
  }
  return {
    device: { objectId: 'cover.0', name: 'Cover', detectorType, domain: 'cover', channels },
    values,
  };
}

function synth(channelValues: Record<string, SourceValue>, detectorType?: string) {
  const { device, values } = deviceWith(channelValues, detectorType);
  return synthCover(device, 'cover.test', values);
}

/**
 * blindButtons: STOP/OPEN/CLOSE are all required; type-detector 6.0.1's
 * pattern for it has no position-shaped state at all (verified against
 * typePatterns.js -- no SET, no ACTUAL).
 */
function blindButtonsDevice(): { device: DeviceInput; values: Record<string, SourceValue> } {
  const device: DeviceInput = {
    objectId: 'cover.0',
    name: 'Blind Buttons',
    detectorType: 'blindButtons',
    domain: 'cover',
    channels: {
      stop: { objectId: 'cover.0.stop', write: true },
      open: { objectId: 'cover.0.open', write: true },
      close: { objectId: 'cover.0.close', write: true },
    },
  };
  return { device, values: {} };
}

/**
 * gate: SET is required but, verified against typePatterns.js, is
 * `type: StateType.Boolean` (role switch(.gate)?) -- a plain open/close
 * toggle, never a percentage the way blind's SET (role level.blind,
 * StateType.Number) is.
 */
function gateDevice(setValue?: SourceValue): { device: DeviceInput; values: Record<string, SourceValue> } {
  const device: DeviceInput = {
    objectId: 'gate.0',
    name: 'Gate',
    detectorType: 'gate',
    domain: 'cover',
    channels: { set: { objectId: 'gate.0.set', write: true } },
  };
  const values: Record<string, SourceValue> = {};
  if (setValue) values['gate.0.set'] = setValue;
  return { device, values };
}

describe('registry/synth/cover', () => {
  it('synthesises a blindButtons device with no position channel', () => {
    // blindButtons has no SET; a position-shaped assumption drops the device
    const { device, values } = blindButtonsDevice();
    const e = synthCover(device, 'cover.test', values);
    expect(e).to.not.equal(null);
    expect(e.attributes.current_position).to.equal(undefined);
    expect(e.writable?.open).to.not.equal(undefined);
  });

  it('does not report position 0 for a device that has no position channel', () => {
    // 0 is a legitimate closed position; absent must stay absent
    const { device, values } = blindButtonsDevice();
    const e = synthCover(device, 'cover.test', values);
    expect('current_position' in e.attributes).to.equal(false);
  });

  it('keeps tilt independent of position', () => {
    const e = synth({ SET: numState(40), TILT_SET: numState(90) });
    expect(e.attributes.current_position).to.equal(40);
    expect(e.attributes.current_tilt_position).to.equal(90);
  });

  it('reports position 0 as a real, present value -- not absent', () => {
    const e = synth({ SET: numState(0) });
    expect('current_position' in e.attributes).to.equal(true);
    expect(e.attributes.current_position).to.equal(0);
  });

  it('omits current_position for a blank SET reading instead of reporting zero', () => {
    // Number('') is 0 and finite: a blank reading must resolve to "unknown",
    // never to a confident zero-percent (fully closed) position.
    const e = synth({ SET: numState('') });
    expect(e.attributes.current_position).to.equal(undefined);
    // The channel is still configured and writable, even though its current
    // value is unusable -- a future dispatcher must still be able to write.
    expect(e.writable?.position).to.equal(true);
  });

  it('prefers ACTUAL over SET for the reported position, same precedence as switch/light', () => {
    const e = synth({ SET: numState(40), ACTUAL: numState(55) });
    expect(e.attributes.current_position).to.equal(55);
  });

  it('falls back to SET when ACTUAL is not configured', () => {
    const e = synth({ SET: numState(40) });
    expect(e.attributes.current_position).to.equal(40);
    expect(e.writable?.position).to.equal(true);
  });

  it('derives open/closed state from the resolved position', () => {
    expect(synth({ SET: numState(0) }).state).to.equal('closed');
    expect(synth({ SET: numState(40) }).state).to.equal('open');
  });

  it("does not treat gate's boolean SET as a position", () => {
    // Verified against type-detector 6.0.1 typePatterns.js: gate's SET has
    // role switch(.gate)? and type Boolean, unlike blind's level.blind/
    // Number -- a position-shaped assumption here would grant SET_POSITION
    // on a channel that only ever accepts true/false.
    const { device, values } = gateDevice(numState(true));
    const e = synthCover(device, 'gate.test', values);
    expect(e.attributes.current_position).to.equal(undefined);
    expect(e.writable?.position).to.equal(undefined);
  });

  it("derives gate's open/closed state from its boolean SET when nothing else is available", () => {
    const openGate = gateDevice(numState(true));
    const closedGate = gateDevice(numState(false));
    expect(synthCover(openGate.device, 'gate.open', openGate.values).state).to.equal('open');
    expect(synthCover(closedGate.device, 'gate.closed', closedGate.values).state).to.equal('closed');
  });

  it('grants open/close writability from a gate device exposing only its required SET', () => {
    // gate has no separate OPEN/CLOSE channels at all (verified against
    // typePatterns.js) -- its one boolean SET must back both, or a detected
    // gate renders as a cover tile with nothing on it that can ever be
    // pressed.
    const { device, values } = gateDevice();
    const e = synthCover(device, 'gate.test', values);
    expect(e.writable?.open).to.equal(true);
    expect(e.writable?.close).to.equal(true);
    expect(e.writable?.position).to.equal(undefined);
  });

  it("uses gate's dedicated OPENED/CLOSED contacts when they resolve the state", () => {
    const device: DeviceInput = {
      objectId: 'gate.0',
      name: 'Gate',
      detectorType: 'gate',
      domain: 'cover',
      channels: {
        set: { objectId: 'gate.0.set', write: true },
        opened: { objectId: 'gate.0.opened' },
        closed: { objectId: 'gate.0.closed' },
      },
    };
    const values = { 'gate.0.opened': numState(false), 'gate.0.closed': numState(true) };
    const e = synthCover(device, 'gate.test', values);
    expect(e.state).to.equal('closed');
  });

  it('marks the tilt channel writable independently of the main position', () => {
    const e = synth({ TILT_SET: numState(50) });
    expect(e.writable?.tilt_position).to.equal(true);
    expect(e.writable?.position).to.equal(undefined);
  });

  it('marks open/close/stop writable from a blindButtons device', () => {
    const { device, values } = blindButtonsDevice();
    const e = synthCover(device, 'cover.test', values);
    expect(e.writable?.open).to.equal(true);
    expect(e.writable?.close).to.equal(true);
    expect(e.writable?.stop).to.equal(true);
  });

  it('reports unavailable for a freshly-detected blindButtons device with no reading yet', () => {
    const { device, values } = blindButtonsDevice();
    const e = synthCover(device, 'cover.test', values);
    expect(e.available).to.equal(false);
    expect(e.state).to.equal('unavailable');
  });

  it('reports unknown, not unavailable, when tilt is known but open/closed cannot be derived', () => {
    const e = synth({ TILT_SET: numState(50) });
    expect(e.available).to.equal(true);
    expect(e.state).to.equal('unknown');
  });

  it('carries channel type/states metadata for the dispatcher to encode commands with', () => {
    // Real-synth proof (not a hand-built VirtualEntity): channelMeta must
    // reach the entity synthCover actually returns, or a command encoder
    // downstream would silently have nothing to decode against -- exactly
    // the climate defect (fix-round 2) that shipped inert once already
    // because its own test used a hand-built entity instead of the real
    // synth function.
    const { device, values } = deviceWith({});
    device.channels.set = { objectId: 'cover.0.set', write: true, type: 'number' };
    values['cover.0.set'] = numState(40);
    const e = synthCover(device, 'cover.test', values);
    // Task 8: `write` (Ruling 38) and the current raw value (Ruling 41) ride
    // along; round 1 adds the declared range (Ruling 49), round 3 the unit
    // (Ruling 59), none of either here.
    expect(e.channelMeta?.set).to.deep.equal({
      type: 'number',
      states: undefined,
      write: true,
      current: 40,
      min: undefined,
      max: undefined,
      step: undefined,
      unit: undefined,
    });
  });

  it("carries gate's boolean SET type through channelMeta, distinct from blind's number", () => {
    const { device, values } = gateDevice(numState(true));
    device.channels.set = { objectId: 'gate.0.set', write: true, type: 'boolean' };
    const e = synthCover(device, 'gate.test', values);
    expect(e.channelMeta?.set).to.deep.equal({
      type: 'boolean',
      states: undefined,
      write: true,
      current: true,
      min: undefined,
      max: undefined,
      step: undefined,
      unit: undefined,
    });
  });

  it('dispatches to synthCover through synthesise', () => {
    const { device, values } = deviceWith({ SET: numState(40) });
    expect(synthesise(device, 'cover.x', values)?.domain).to.equal('cover');
  });

  // --- Fix round 1 -----------------------------------------------------

  it('keeps a numeric ACTUAL as current_position for a gate too, while its toggle SET grants no position write (Ruling 27)', () => {
    // Home Assistant reports current_position independently of whether
    // SET_POSITION is offered -- a gate can have real position telemetry
    // (its optional ACTUAL, verified Number-typed against typePatterns.js)
    // even though its required SET can only open/close, not set an exact
    // percentage. Dropping ACTUAL here would discard real, non-fabricated
    // data; task 7 is what prevents the position slider from appearing,
    // by deriving supported_features from `writable` rather than from
    // current_position's mere presence.
    const device: DeviceInput = {
      objectId: 'gate.0',
      name: 'Gate',
      detectorType: 'gate',
      domain: 'cover',
      channels: {
        set: { objectId: 'gate.0.set', write: true },
        actual: { objectId: 'gate.0.actual' },
      },
    };
    const values = { 'gate.0.actual': numState(62) };
    const e = synthCover(device, 'gate.test', values);
    expect(e.attributes.current_position).to.equal(62);
    // No position WRITE path exists: writable.position must stay unset.
    expect(e.writable?.position).to.equal(undefined);
    // Its boolean SET still backs open/close.
    expect(e.writable?.open).to.equal(true);
    expect(e.writable?.close).to.equal(true);
  });

  it('treats a boolean SET as a toggle even when forced into cover from a non-gate detectorType (Ruling 28)', () => {
    // overrides.ts forces `domain` without touching channels or
    // detectorType (overrides.ts:25-30 spreads ...device unchanged) -- a
    // socket's SET is boolean in practice, so the type-based decision must
    // resolve 'toggle' here from that recorded type alone, with a
    // detectorType that is neither 'gate' nor 'blind'.
    const device: DeviceInput = {
      objectId: 'socket.0',
      name: 'Forced socket',
      detectorType: 'socket',
      domain: 'cover',
      channels: { set: { objectId: 'socket.0.set', write: true, type: 'boolean' } },
    };
    const e = synthCover(device, 'cover.forced', {});
    expect(e.writable?.position).to.equal(undefined);
    expect(e.writable?.open).to.equal(true);
    expect(e.writable?.close).to.equal(true);
  });

  it('does not fabricate a state from a numeric SET holding NaN (Ruling 28)', () => {
    // toBoolState treats a NaN number as truthy (NaN !== 0), which
    // previously let a numeric SET's garbage value fall into the
    // boolean-toggle state path and report a spurious 'open'. A
    // numeric-kind SET must never reach that path at all.
    const e = synth({ SET: numState(NaN) });
    expect(e.attributes.current_position).to.equal(undefined);
    expect(e.state).to.equal('unavailable');
  });

  it('never treats an explicitly numeric SET as a toggle, even under a gate detectorType', () => {
    // Isolates the type-based rule from the detectorType fallback: real
    // metadata (type: 'number') must win even where the pattern-shape
    // fallback would otherwise say 'toggle' for detectorType 'gate'.
    const device: DeviceInput = {
      objectId: 'weird.0',
      name: 'Weird',
      detectorType: 'gate',
      domain: 'cover',
      channels: { set: { objectId: 'weird.0.set', write: true, type: 'number' } },
    };
    const e = synthCover(device, 'cover.weird', { 'weird.0.set': numState(NaN) });
    expect(e.attributes.current_position).to.equal(undefined);
    expect(e.writable?.position).to.equal(true);
    expect(e.state).to.equal('unavailable');
  });

  it("uses gate's OPENED contact alone when CLOSED does not resolve the state", () => {
    // The existing "dedicated OPENED/CLOSED contacts" test only ever
    // exercises the closed === true branch; a swapped or dead
    // `opened === true` branch would not be caught without this one, since
    // CLOSED here resolves to a definite `false`, not merely absent.
    const device: DeviceInput = {
      objectId: 'gate.0',
      name: 'Gate',
      detectorType: 'gate',
      domain: 'cover',
      channels: {
        set: { objectId: 'gate.0.set', write: true },
        opened: { objectId: 'gate.0.opened' },
        closed: { objectId: 'gate.0.closed' },
      },
    };
    const values = { 'gate.0.opened': numState(true), 'gate.0.closed': numState(false) };
    const e = synthCover(device, 'gate.test', values);
    expect(e.state).to.equal('open');
  });

  // --- Task 8 ----------------------------------------------------------

  it('grants a string- or mixed-typed SET neither a position nor open/close, whatever the detectorType (Ruling 32)', () => {
    // Such a SET used to fall to the detectorType fallback: a position on a
    // blind, a toggle on a gate. Task 7 derives supported_features from
    // `writable`, so that advertised a slider (or open/close buttons) that
    // would write a number (or a boolean) into a string channel.
    for (const type of ['string', 'mixed'] as const) {
      for (const detectorType of ['blind', 'gate']) {
        const device: DeviceInput = {
          objectId: 'odd.0',
          name: 'Odd',
          detectorType,
          domain: 'cover',
          channels: {
            set: { objectId: 'odd.0.set', write: true, type },
            stop: { objectId: 'odd.0.stop', write: true, type: 'boolean' },
          },
        };
        const e = synthCover(device, 'cover.odd', { 'odd.0.set': numState('true') });
        expect(e.writable, `${type} SET, ${detectorType}`).to.deep.equal({ stop: true });
        // Nor read back as a toggle: a gate's fallback turned "true" into 'open'.
        expect(e.state, `${type} SET, ${detectorType}`).to.equal('unavailable');
      }
    }
  });

  it("records an untyped SET's decided kind as its channelMeta type, so the dispatcher writes what the synth advertised", () => {
    // gate's pattern guarantees a boolean SET, blind's a number (Ruling 28's
    // fallback). The dispatcher tells the two apart by this type alone.
    const gate = gateDevice();
    expect(synthCover(gate.device, 'gate.test', gate.values).channelMeta?.set?.type).to.equal('boolean');
    const blind = deviceWith({ SET: numState(40) });
    expect(synthCover(blind.device, 'cover.test', blind.values).channelMeta?.set?.type).to.equal('number');
  });

  it('carries each channel\'s write flag and current value into channelMeta, write undefined included (Rulings 38/41)', () => {
    const device: DeviceInput = {
      objectId: 'cover.0',
      name: 'Cover',
      detectorType: 'blind',
      domain: 'cover',
      channels: {
        set: { objectId: 'cover.0.set', type: 'number', write: false },
        stop: { objectId: 'cover.0.stop', type: 'boolean' },
      },
    };
    // A bad-quality reading is not a current value, exactly as the decoders treat it.
    const e = synthCover(device, 'cover.test', { 'cover.0.set': numState(30), 'cover.0.stop': numState(false, 1) });
    expect(e.channelMeta?.set).to.include({ write: false, current: 30 });
    expect(e.channelMeta?.stop?.write).to.equal(undefined);
    expect(e.channelMeta?.stop?.current).to.equal(undefined);
  });

  // --- Task 8 round 1 (Ruling 49) --------------------------------------

  it('publishes a 0..255 position and tilt as the percentage the panel reads, each in its own range', () => {
    // The panel's current_position is a percentage: raw 200 of 255 is ~78%,
    // not 200 (which the firmware would clamp to fully open).
    const device: DeviceInput = {
      objectId: 'cover.0',
      name: 'Cover',
      detectorType: 'blind',
      domain: 'cover',
      channels: {
        set: { objectId: 'cover.0.set', type: 'number', write: true, min: 0, max: 255 },
        actual: { objectId: 'cover.0.actual', type: 'number', min: 0, max: 1000 },
        tilt_set: { objectId: 'cover.0.tilt_set', type: 'number', write: true, min: 0, max: 255 },
      },
    };
    const fromSet = synthCover(device, 'cover.test', { 'cover.0.set': numState(200), 'cover.0.tilt_set': numState(51) });
    // 78.43...%, published as the nearest whole percent (round 2, N1: the
    // firmware would truncate the fraction).
    expect(fromSet.attributes.current_position).to.equal(78);
    expect(fromSet.attributes.current_tilt_position).to.equal(20);
    expect(fromSet.channelMeta?.set).to.include({ min: 0, max: 255 });
    // ACTUAL wins, and is read in ITS own range, not SET's.
    const fromActual = synthCover(device, 'cover.test', { 'cover.0.set': numState(200), 'cover.0.actual': numState(250) });
    expect(fromActual.attributes.current_position).to.equal(25);
  });

  it('derives closed from the bottom of the declared range, whatever its raw value', () => {
    const device: DeviceInput = {
      objectId: 'cover.0',
      name: 'Cover',
      detectorType: 'blind',
      domain: 'cover',
      channels: { set: { objectId: 'cover.0.set', type: 'number', write: true, min: 10, max: 30 } },
    };
    expect(synthCover(device, 'cover.test', { 'cover.0.set': numState(10) }).state).to.equal('closed');
    expect(synthCover(device, 'cover.test', { 'cover.0.set': numState(11) }).state).to.equal('open');
  });

  it('publishes the whole percent the panel keeps, on a 0..100 channel and one that declares no range too', () => {
    // Round 1 published 40.5 and 33.3 as read; the firmware's read_int
    // TRUNCATES a fraction (item.as<int>(), cover/renderer.cpp:57), so they
    // showed as 40 and 33. Round 2 (N1) rounds before publishing.
    const { device, values } = deviceWith({ SET: numState(40.5), TILT_SET: numState(33.3) });
    device.channels.set = { ...device.channels.set!, min: 0, max: 100 };
    const e = synthCover(device, 'cover.test', values);
    expect(e.attributes.current_position).to.equal(41);
    expect(e.attributes.current_tilt_position).to.equal(33);
  });

  // --- Task 8 round 2 ----------------------------------------------------

  it('derives the state from the same whole percent it publishes, so the panel never disables Close on an open cover (N1)', () => {
    // cover_popup.cpp:446-462 disables Close at position 0 and when the state
    // is "closed". Raw 1 of 255 is 0.39%: published as 0 (truncated before,
    // rounded now) while the state said "open", Close was disabled on a cover
    // the panel called open. Position and state now come from one number.
    const blind = (raw: number) =>
      synthCover(
        {
          objectId: 'cover.0',
          name: 'Cover',
          detectorType: 'blind',
          domain: 'cover',
          channels: { set: { objectId: 'cover.0.set', type: 'number', write: true, min: 0, max: 255 } },
        },
        'cover.test',
        { 'cover.0.set': numState(raw) },
      );
    expect(blind(1).attributes.current_position).to.equal(0);
    expect(blind(1).state).to.equal('closed');
    expect(blind(2).attributes.current_position).to.equal(1);
    expect(blind(2).state).to.equal('open');
    expect(blind(254).attributes.current_position).to.equal(100);
    expect(blind(254).state).to.equal('open');
  });

  it('clamps a reading outside its declared range to 0..100 before the state is derived from it (Ruling 59.4)', () => {
    // 1..100 at raw 0 is -1%: published as -1 with the state "open", which the
    // firmware clamped to 0 and so disabled Close on a cover it called open.
    const blind = (min: number, max: number, raw: number) =>
      synthCover(
        {
          objectId: 'cover.0',
          name: 'Cover',
          detectorType: 'blind',
          domain: 'cover',
          channels: { set: { objectId: 'cover.0.set', type: 'number', write: true, min, max } },
        },
        'cover.test',
        { 'cover.0.set': numState(raw) },
      );
    for (const [min, max, raw, position, state] of [
      [1, 100, 0, 0, 'closed'],
      [0, 255, -2, 0, 'closed'],
      [0, 255, 300, 100, 'open'],
    ] as const) {
      const e = blind(min, max, raw);
      expect(e.attributes.current_position, `${min}..${max} at ${raw}`).to.equal(position);
      expect(e.state, `${min}..${max} at ${raw}`).to.equal(state);
    }
  });

  describe('bounds a percentage cannot scale over (Ruling 55)', () => {
    const cover = (set: Partial<ChannelInput>, tilt: Partial<ChannelInput>, raw: number) =>
      synthCover(
        {
          objectId: 'cover.0',
          name: 'Cover',
          detectorType: 'blind',
          domain: 'cover',
          channels: {
            set: { objectId: 'cover.0.set', type: 'number', write: true, ...set },
            tilt_set: { objectId: 'cover.0.tilt_set', type: 'number', write: true, ...tilt },
          },
        },
        'cover.test',
        { 'cover.0.set': numState(raw), 'cover.0.tilt_set': numState(raw) },
      );

    it('scales a max-only 255 from a floor of 0, and a min-only 10 to a ceiling of 100', () => {
      const maxOnly = cover({ max: 255 }, { max: 255 }, 128);
      expect(maxOnly.attributes).to.include({ current_position: 50, current_tilt_position: 50 });
      expect(maxOnly.writable).to.include({ position: true, tilt_position: true });
      expect(cover({ min: 10 }, { min: 10 }, 55).attributes).to.include({ current_position: 50 });
    });

    it('withholds position and tilt, and publishes no reading for them, when the bounds are equal or inverted', () => {
      for (const bounds of [{ min: 40, max: 40 }, { min: 255, max: 0 }, { min: 150 }]) {
        const e = cover(bounds, bounds, 40);
        expect(e.writable, JSON.stringify(bounds)).to.include({ position: false, tilt_position: false });
        expect(e.attributes, JSON.stringify(bounds)).to.not.have.any.keys('current_position', 'current_tilt_position');
      }
    });
  });
});
