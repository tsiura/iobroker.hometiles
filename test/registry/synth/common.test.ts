import { expect } from 'chai';
import { encodeChannelValue, toBoolState } from '../../../src/registry/synth/common';
import { synthClimate } from '../../../src/registry/synth/climate';
import type { ChannelCodec, DeviceInput, SourceValue } from '../../../src/registry/types';

/**
 * encodeChannelValue is the exact inverse of readEnum (synth/climate.ts) and
 * toBoolState (synth/common.ts): those decode a raw ioBroker value into an
 * HA-style display label; this turns a label back into the raw value a
 * write actually needs. Each test below states which decode behaviour it
 * mirrors, so the round trip is checked against real, already-tested decode
 * behaviour (pinned in test/registry/synth/climate.test.ts) rather than
 * reinvented here.
 */
describe('registry/synth/common: encodeChannelValue', () => {
  it('round-trips a numeric MODE with a states map (1 <-> "heat")', () => {
    // readEnum: raw=1 -> String(1)="1" -> states["1"]="heat" -> decodes "heat".
    const codec: ChannelCodec = { type: 'number', states: { '1': 'heat', '3': 'cool' } };
    const encoded = encodeChannelValue(codec, 'heat');
    expect(encoded).to.equal(1);
    expect(typeof encoded).to.equal('number');
  });

  it('round-trips a numeric MODE with no states map', () => {
    // readEnum: raw=3 (number, no states) -> String(3) -> decodes "3".
    const codec: ChannelCodec = { type: 'number' };
    const encoded = encodeChannelValue(codec, '3');
    expect(encoded).to.equal(3);
    expect(typeof encoded).to.equal('number');
  });

  // Ruling 33 (supersedes Ruling 24(a)'s passthrough): with no non-empty
  // states map, only a number- or boolean-typed channel says what a label
  // means. When a modes list is empty the firmware still offers the CURRENT
  // value as a lone option (climate_popup.cpp:458-460), lowercased, so a
  // passthrough wrote "auto" for "AUTO", the string "1" for 1 and "on" for
  // "true" -- with ok:true. Refusing loses nothing: that lone option is a
  // re-select of the current value.
  it('refuses a label for a channel that is not number- or boolean-typed and has no non-empty states map (Ruling 33)', () => {
    const codecs: Array<ChannelCodec | undefined> = [
      undefined,
      {},
      { type: 'string' },
      { type: 'mixed' },
      { type: 'string', states: {} },
    ];
    for (const codec of codecs) {
      for (const label of ['auto', '1', 'on']) {
        expect(encodeChannelValue(codec, label), `${JSON.stringify(codec)} "${label}"`).to.equal(undefined);
      }
    }
  });

  it('still reverses a string channel label through its states map, restoring the exact case', () => {
    const encoded = encodeChannelValue({ type: 'string', states: { AUTO: 'Auto', HEAT: 'Heat' } }, 'auto');
    expect(encoded).to.equal('AUTO');
    expect(typeof encoded).to.equal('string');
  });

  // Ruling 36: readEnum emits a raw number OUTSIDE its states map as its own
  // number-string ("50"), and that is exactly what the lone fallback option
  // sends back. Refusing it left a dead button; carrying it back is a no-op
  // write of the current value.
  it('carries a label outside the states map back as its own number, on a number channel only', () => {
    const codec: ChannelCodec = { type: 'number', states: { '0': 'AUS', '100': 'MAX' } };
    const encoded = encodeChannelValue(codec, '50');
    expect(encoded).to.equal(50);
    expect(typeof encoded).to.equal('number');
    for (const label of ['', '   ', 'NaN', 'Infinity', 'turbo']) {
      expect(encodeChannelValue(codec, label), label).to.equal(undefined);
    }
    expect(encodeChannelValue({ type: 'string', states: { AUTO: 'Auto' } }, 'eco')).to.equal(undefined);
  });

  it('round-trips the boolean swing toggle (true/false <-> the decoder\'s own "on"/"off")', () => {
    // toBoolState: raw=true -> 'on'; raw=false -> 'off'.
    const codec: ChannelCodec = { type: 'boolean' };
    const on = encodeChannelValue(codec, 'on');
    const off = encodeChannelValue(codec, 'off');
    expect(on).to.equal(true);
    expect(typeof on).to.equal('boolean');
    expect(off).to.equal(false);
    expect(typeof off).to.equal('boolean');
  });

  it('round-trips a numeric SPEED with a label map -- the case fix-round 1 made refuse, which must now work', () => {
    // readEnum: raw=1 -> states["1"]="high" -> decodes "high". Round 1's
    // numericModeValue rejected "high" outright (Number('high') is NaN);
    // this must now reverse it through the states map instead.
    const codec: ChannelCodec = { type: 'number', states: { '0': 'auto', '1': 'high', '2': 'low' } };
    const encoded = encodeChannelValue(codec, 'high');
    expect(encoded).to.equal(1);
    expect(typeof encoded).to.equal('number');
  });

  it('reverses a states label case-insensitively, matching the firmware lowercasing hvac_mode/fan_mode/swing_mode on ingest', () => {
    // docs/contract-climate-cover.md: the firmware trims+lowercases these
    // three fields in its own state cache, so whatever label we publish
    // (often the states map's own, uncontrolled case -- @iobroker/type-detector's
    // own defaultStates are upper-case, e.g. "HIGH") comes back from a real
    // panel already lower-cased. An exact-case-only reversal would silently
    // refuse every one of the type-detector's own default labels.
    const codec: ChannelCodec = { type: 'number', states: { '1': 'HIGH' } };
    const encoded = encodeChannelValue(codec, 'high');
    expect(encoded).to.equal(1);
    expect(typeof encoded).to.equal('number');
  });

  it('round-trips SPEED_LEVEL, a plain numeric percentage with no states map', () => {
    // synth/climate.ts: fanMode falls back to String(speedLevel) when SPEED
    // itself is not configured, e.g. raw=42 -> decodes "42".
    const codec: ChannelCodec = { type: 'number' };
    const encoded = encodeChannelValue(codec, '42');
    expect(encoded).to.equal(42);
    expect(typeof encoded).to.equal('number');
  });

  it('refuses an unknown label rather than guessing', () => {
    const codec: ChannelCodec = { type: 'number', states: { '0': 'auto', '1': 'high' } };
    expect(encodeChannelValue(codec, 'turbo')).to.equal(undefined);
  });

  it('refuses a blank numeric label rather than writing zero', () => {
    // Number('') is 0 and finite -- the exact trap this project has hit
    // before (fix-round 1's numericModeValue guarded the identical case).
    const codec: ChannelCodec = { type: 'number' };
    expect(encodeChannelValue(codec, '')).to.equal(undefined);
    expect(encodeChannelValue(codec, '   ')).to.equal(undefined);
  });

  it('refuses the literal label "NaN" rather than writing NaN', () => {
    const codec: ChannelCodec = { type: 'number' };
    expect(encodeChannelValue(codec, 'NaN')).to.equal(undefined);
  });

  it('refuses a boolean label the decoder never emits, e.g. "auto"', () => {
    // toBoolState only ever emits 'on'/'off' for a genuine boolean channel
    // ('unknown' means no boolean was recoverable at all) -- the encoder
    // must not guess that some other string means true or false.
    const codec: ChannelCodec = { type: 'boolean' };
    expect(encodeChannelValue(codec, 'auto')).to.equal(undefined);
  });

  // Fix-round 3, IMPORTANT A: ambiguous states-map matches must refuse, not
  // silently pick one.
  it('refuses a label that matches two different keys case-insensitively, rather than picking the first', () => {
    // {"1":"High","2":"HIGH"} with label "high": a device currently at raw 2
    // (decoded "HIGH") whose user re-selects their OWN current mode must not
    // get raw 1 written instead -- `.find` returning the first match did
    // exactly that, with ok:true.
    const codec: ChannelCodec = { type: 'number', states: { '1': 'High', '2': 'HIGH' } };
    expect(encodeChannelValue(codec, 'high')).to.equal(undefined);
  });

  it('refuses a label that matches two keys under exact-case duplicates too', () => {
    const codec: ChannelCodec = { type: 'number', states: { '1': 'heat', '5': 'heat' } };
    expect(encodeChannelValue(codec, 'heat')).to.equal(undefined);
  });

  // Fix-round 3, IMPORTANT B (REGRESSION): the decoder toBoolState never
  // reads a states map -- it always emits STATE_ON/STATE_OFF -- so the
  // encoder must not apply one either for a boolean-typed channel.
  it('ignores a states map entirely for a boolean-typed channel, matching toBoolState exactly', () => {
    for (const states of [{ true: 'ON', false: 'OFF' }, { true: 'An', false: 'Aus' }, { true: 'on', false: 'off' }]) {
      const codec: ChannelCodec = { type: 'boolean', states };
      expect(encodeChannelValue(codec, 'on'), JSON.stringify(states)).to.equal(true);
      expect(encodeChannelValue(codec, 'off'), JSON.stringify(states)).to.equal(false);
    }
  });

  // Fix-round 3, fold-in 1: readEnum treats {} exactly like no map at all
  // (no key of an empty object can ever match), so the encoder must too.
  it('treats an empty states map as no map at all', () => {
    const codec: ChannelCodec = { type: 'number', states: {} };
    expect(encodeChannelValue(codec, '3')).to.equal(3);
  });

  // Fix-round 3, fold-in 3: a non-string label must be skipped, not thrown
  // on. main.ts's detectDevices now validates common.states so a real
  // device should never produce one, but the encoder must not crash if a
  // states map built any other way ever does.
  it('skips a non-string label in a states map instead of throwing', () => {
    const malformed = { '1': 'heat', '2': 5 } as unknown as Record<string, string>;
    const codec: ChannelCodec = { type: 'number', states: malformed };
    expect(() => encodeChannelValue(codec, 'heat')).to.not.throw();
    expect(encodeChannelValue(codec, 'heat')).to.equal(1);
    // The non-string entry can never match anything, string or not: "5"
    // never resolves to its key 2. On a number channel it is simply a label
    // outside the map, carried back as its own number (Ruling 36).
    expect(() => encodeChannelValue(codec, '5')).to.not.throw();
    expect(encodeChannelValue(codec, '5')).to.equal(5);
  });

  // Fix-round 3, finding 6: feed REAL decoder output into the encoder,
  // rather than a hand-written label, so the round trip is checked against
  // the actual decode path, not a re-description of it.
  describe('round-trips real decoder output, not hand-written labels', () => {
    const NOW = 1_757_000_000_000;
    function numState(val: unknown): SourceValue {
      return { val, ack: true, q: 0, ts: NOW };
    }

    it('via synthClimate: a real numeric MODE with a states map', () => {
      const device: DeviceInput = {
        objectId: 'rt.0',
        name: 'RT',
        detectorType: 'airCondition',
        domain: 'climate',
        channels: { mode: { objectId: 'rt.0.mode', write: true, type: 'number', states: { '1': 'heat', '3': 'cool' } } },
      };
      const values = { 'rt.0.mode': numState(1) };
      const e = synthClimate(device, 'climate.rt', values);
      const decoded = e?.attributes.hvac_mode;
      expect(decoded, 'synthClimate must actually decode MODE via the real readEnum path').to.equal('heat');

      const encoded = encodeChannelValue(e?.channelMeta?.mode, decoded as string);
      expect(encoded).to.equal(1);
      expect(typeof encoded).to.equal('number');
    });

    it('via synthClimate: a numeric SPEED whose raw value is outside its states map (Ruling 36)', () => {
      const device: DeviceInput = {
        objectId: 'rt.0',
        name: 'RT',
        detectorType: 'airCondition',
        domain: 'climate',
        channels: {
          mode: { objectId: 'rt.0.mode', write: true, type: 'number' },
          speed: { objectId: 'rt.0.speed', write: true, type: 'number', states: { '0': 'AUTO', '1': 'HIGH' } },
        },
      };
      const e = synthClimate(device, 'climate.rt', { 'rt.0.speed': numState(4) });
      const decoded = e?.attributes.fan_mode;
      expect(decoded, 'readEnum emits the out-of-map raw value as its own number-string').to.equal('4');

      const encoded = encodeChannelValue(e?.channelMeta?.speed, decoded as string);
      expect(encoded).to.equal(4);
      expect(typeof encoded).to.equal('number');
    });

    it('via the real toBoolState: the boolean swing toggle', () => {
      const decodedOn = toBoolState(true);
      const decodedOff = toBoolState(false);
      expect(decodedOn).to.equal('on');
      expect(decodedOff).to.equal('off');

      expect(encodeChannelValue({ type: 'boolean' }, decodedOn)).to.equal(true);
      expect(encodeChannelValue({ type: 'boolean' }, decodedOff)).to.equal(false);
    });
  });
});
