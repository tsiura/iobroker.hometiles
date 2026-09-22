import { expect } from 'chai';
import { buildCoverPayload } from '../../src/protocol/cover';
import type { VirtualEntity } from '../../src/registry/types';

/**
 * CoverFeature bit values, verified directly against the firmware
 * (src/types/cover/state.h:7-14 in the HomeTiles repo, and cross-checked
 * against docs/contract-climate-cover.md's own table):
 * OPEN=1, CLOSE=2, SET_POSITION=4, STOP=8, OPEN_TILT=16, CLOSE_TILT=32,
 * STOP_TILT=64, SET_TILT_POSITION=128.
 */
const OPEN = 1;
const CLOSE = 2;
const SET_POSITION = 4;
const STOP = 8;
const OPEN_TILT = 16;
const CLOSE_TILT = 32;
const STOP_TILT = 64;
const SET_TILT_POSITION = 128;

function entity(over: Partial<VirtualEntity> = {}): VirtualEntity {
  return {
    entityId: 'cover.x',
    domain: 'cover',
    source: {},
    state: 'open',
    attributes: {},
    available: true,
    lastChanged: 1_757_000_000_000,
    ...over,
  };
}

function entityWith(attributes: Record<string, unknown>, writable: Record<string, boolean> = {}): VirtualEntity {
  return entity({ attributes, writable });
}

describe('protocol/cover', () => {
  // --- Central requirement: supported_features is ALWAYS explicit --------
  // renderer.cpp:124-137 is an if/else: an explicit supported_features is
  // used exactly as given (clamped 0-255) with NO inference layered on top;
  // only its absence triggers OPEN|CLOSE|STOP + position/tilt inference from
  // current_position/current_tilt_position presence. Omitting the key here
  // would silently hand control back to that inference.

  it('emits an explicit supported_features rather than relying on firmware inference', () => {
    const p = JSON.parse(buildCoverPayload(entityWith({}, { open: true, close: true, stop: true, position: true })));
    expect(p.supported_features).to.be.a('number');
  });

  it('emits a zero mask, not an absent key, for a device with no writable roles', () => {
    const p = JSON.parse(buildCoverPayload(entityWith({})));
    expect(p).to.have.property('supported_features');
    expect(p.supported_features).to.equal(0);
  });

  it('emits a zero mask when writable is entirely absent from the entity', () => {
    const p = JSON.parse(buildCoverPayload(entity({ writable: undefined })));
    expect(p.supported_features).to.equal(0);
  });

  it('does not grant SET_POSITION for a gate reporting current_position without a writable position (Ruling 27)', () => {
    // A gate's boolean SET can only open/close; its numeric ACTUAL is real
    // telemetry synthCover deliberately keeps as current_position (Task 6).
    // Advertising SET_POSITION here would draw a slider the gate can never
    // obey -- this is the whole point of task 7.
    const p = JSON.parse(buildCoverPayload(entityWith({ current_position: 62 }, { open: true, close: true })));
    expect(p.current_position).to.equal(62);
    expect(p.supported_features & SET_POSITION).to.equal(0);
    expect(p.supported_features & OPEN).to.equal(OPEN);
    expect(p.supported_features & CLOSE).to.equal(CLOSE);
  });

  it('grants SET_POSITION for a blind with a writable numeric SET', () => {
    const p = JSON.parse(
      buildCoverPayload(
        entityWith({ current_position: 40 }, { position: true, open: true, close: true, stop: true }),
      ),
    );
    expect(p.supported_features & SET_POSITION).to.equal(SET_POSITION);
  });

  it('grants the four tilt bits for a tilt-writable device', () => {
    const p = JSON.parse(
      buildCoverPayload(
        entityWith(
          { current_tilt_position: 50 },
          { tilt_position: true, tilt_open: true, tilt_close: true, tilt_stop: true },
        ),
      ),
    );
    expect(p.supported_features & OPEN_TILT).to.equal(OPEN_TILT);
    expect(p.supported_features & CLOSE_TILT).to.equal(CLOSE_TILT);
    expect(p.supported_features & STOP_TILT).to.equal(STOP_TILT);
    expect(p.supported_features & SET_TILT_POSITION).to.equal(SET_TILT_POSITION);
  });

  it('computes every bit from writable, matching the full firmware CoverFeature enum when everything is writable', () => {
    const p = JSON.parse(
      buildCoverPayload(
        entityWith(
          {},
          {
            open: true,
            close: true,
            position: true,
            stop: true,
            tilt_open: true,
            tilt_close: true,
            tilt_stop: true,
            tilt_position: true,
          },
        ),
      ),
    );
    expect(p.supported_features).to.equal(255);
  });

  it('does not grant a bit for a role explicitly marked non-writable', () => {
    const p = JSON.parse(buildCoverPayload(entityWith({}, { open: true, close: true, stop: false, position: false })));
    expect(p.supported_features & STOP).to.equal(0);
    expect(p.supported_features & SET_POSITION).to.equal(0);
  });

  // --- position / tilt: 0 is real, blank/NaN/null is absent ---------------

  it('omits current_position for a device with no position channel', () => {
    // Presence alone grants SET_POSITION by inference on the firmware side,
    // so a device that never reported a position must never see the key.
    const p = JSON.parse(buildCoverPayload(entityWith({})));
    expect(p).to.not.have.property('current_position');
  });

  it('omits current_tilt_position for a device with no tilt channel', () => {
    const p = JSON.parse(buildCoverPayload(entityWith({})));
    expect(p).to.not.have.property('current_tilt_position');
  });

  it('emits position 0 as a real value, distinct from absent', () => {
    const p = JSON.parse(buildCoverPayload(entityWith({ current_position: 0 })));
    expect('current_position' in p).to.equal(true);
    expect(p.current_position).to.equal(0);
  });

  it('emits tilt 0 as a real value, distinct from absent', () => {
    const p = JSON.parse(buildCoverPayload(entityWith({ current_tilt_position: 0 })));
    expect('current_tilt_position' in p).to.equal(true);
    expect(p.current_tilt_position).to.equal(0);
  });

  it('treats a blank or non-finite position/tilt reading as absent, never zero', () => {
    // Number('') is 0 and finite -- the exact trap climate.ts's usableNumber
    // already guards; cover must guard it identically.
    const p = JSON.parse(
      buildCoverPayload(entityWith({ current_position: '', current_tilt_position: Number.NaN })),
    );
    expect(p).to.not.have.property('current_position');
    expect(p).to.not.have.property('current_tilt_position');
  });

  it('treats an explicit null position/tilt the same as absent', () => {
    // ArduinoJson treats null like an absent key on the firmware side too
    // (docs/contract-climate-cover.md); omission is used for consistency.
    const p = JSON.parse(buildCoverPayload(entityWith({ current_position: null, current_tilt_position: null })));
    expect(p).to.not.have.property('current_position');
    expect(p).to.not.have.property('current_tilt_position');
  });

  it('keeps position and tilt independent of one another', () => {
    const p = JSON.parse(buildCoverPayload(entityWith({ current_position: 40, current_tilt_position: 90 })));
    expect(p.current_position).to.equal(40);
    expect(p.current_tilt_position).to.equal(90);
  });

  // --- state / available: always known for cover, always emitted ---------

  it('always emits state and available', () => {
    const p = JSON.parse(buildCoverPayload(entity({ state: 'closed', available: true })));
    expect(p.state).to.equal('closed');
    expect(p.available).to.equal(true);
  });

  it('emits available false and the unavailable state together', () => {
    const p = JSON.parse(buildCoverPayload(entity({ state: 'unavailable', available: false })));
    expect(p.state).to.equal('unavailable');
    expect(p.available).to.equal(false);
  });

  it('passes through the exact contract state strings unchanged', () => {
    for (const state of ['open', 'closed', 'opening', 'closing']) {
      const p = JSON.parse(buildCoverPayload(entity({ state })));
      expect(p.state).to.equal(state);
    }
  });

  // --- allow-listed passthrough only, never a generic attribute loop ------

  it('forwards only friendly_name and icon from attributes', () => {
    const p = JSON.parse(buildCoverPayload(entityWith({ friendly_name: 'Kitchen blind', icon: 'mdi:blinds' })));
    expect(p.friendly_name).to.equal('Kitchen blind');
    expect(p.icon).to.equal('mdi:blinds');
  });

  it('does not forward an attribute outside the validated allow-list, even a spoofed supported_features', () => {
    // supported_features must be computed from `writable`, never forwarded
    // from an arbitrary attribute -- a generic pass-through would let a
    // stray attribute silently override the computed mask.
    const p = JSON.parse(
      buildCoverPayload(
        entityWith({
          device_class: 'shutter',
          assumed_state: true,
          made_up_key: 'x',
          supported_features: 999,
        }),
      ),
    );
    expect(p).to.not.have.property('device_class');
    expect(p).to.not.have.property('assumed_state');
    expect(p).to.not.have.property('made_up_key');
    expect(p.supported_features).to.equal(0);
  });

  it('omits an empty friendly_name/icon instead of sending it blank', () => {
    // Matches climate.ts's own PASSTHROUGH_KEYS guard exactly (length > 0,
    // not trimmed): both fields are structurally non-blank in practice
    // (synth/common.ts's baseEntity: `device.name || entityId`, and icon is
    // only ever added `if (device.icon)`), so this only needs to guard the
    // one shape the allow-list check itself performs.
    const p = JSON.parse(buildCoverPayload(entityWith({ friendly_name: '', icon: '' })));
    expect(p).to.not.have.property('friendly_name');
    expect(p).to.not.have.property('icon');
  });
});
