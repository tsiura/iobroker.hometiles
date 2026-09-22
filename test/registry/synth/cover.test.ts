import { expect } from 'chai';
import { synthCover } from '../../../src/registry/synth/cover';
import { synthesise } from '../../../src/registry/synth/index';
import type { DeviceInput, SourceValue } from '../../../src/registry/types';

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
    expect(e.channelMeta?.set).to.deep.equal({ type: 'number', states: undefined });
  });

  it("carries gate's boolean SET type through channelMeta, distinct from blind's number", () => {
    const { device, values } = gateDevice(numState(true));
    device.channels.set = { objectId: 'gate.0.set', write: true, type: 'boolean' };
    const e = synthCover(device, 'gate.test', values);
    expect(e.channelMeta?.set).to.deep.equal({ type: 'boolean', states: undefined });
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
});
