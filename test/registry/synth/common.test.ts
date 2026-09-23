import { expect } from 'chai';
import { encodeChannelValue, fromPercent, toBoolState, toPercent, withinDeclaredRange } from '../../../src/registry/synth/common';
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
    // readEnum: raw=3 (number, no states) -> String(3) -> decodes "3". With
    // no map no list is published, so the decoded current value is the only
    // name the panel can send back (Task 8 round 1, M1a).
    const codec: ChannelCodec = { type: 'number', current: 3 };
    const encoded = encodeChannelValue(codec, '3', '3');
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

  // Ruling 36, narrowed by Ruling 41 (Task 8): readEnum emits a raw number
  // OUTSIDE its states map as its own number-string ("50"), and that is
  // exactly what the lone fallback option sends back -- a re-select of the
  // CURRENT value, which writes the current value. Any other out-of-map
  // number is refused again: the cmnd topic is a trust boundary, and Ruling
  // 36 alone let any MQTT client write any finite number into a mapped channel.
  it('carries a label outside the states map back only when it re-selects the current value (Rulings 36/41)', () => {
    const codec: ChannelCodec = { type: 'number', states: { '0': 'AUS', '100': 'MAX' }, current: 50 };
    const encoded = encodeChannelValue(codec, '50', '50');
    expect(encoded).to.equal(50);
    expect(typeof encoded).to.equal('number');
    // Not the current value, or no current value known: refused.
    expect(encodeChannelValue(codec, '60', '50')).to.equal(undefined);
    expect(encodeChannelValue({ type: 'number', states: { '0': 'AUS', '100': 'MAX' } }, '50')).to.equal(undefined);
    for (const label of ['', '   ', 'NaN', 'Infinity', 'turbo']) {
      expect(encodeChannelValue(codec, label, '50'), label).to.equal(undefined);
    }
    expect(encodeChannelValue({ type: 'string', states: { AUTO: 'Auto' } }, 'eco')).to.equal(undefined);
  });

  // Ruling 41: re-selecting the current value writes the current value. The
  // codec carries the channel's current raw value (baseEntity); the caller
  // passes the role's current DECODED value -- what the panel shows.
  describe('re-selecting the current value (Ruling 41)', () => {
    it('writes a current value outside the map before any map reversal: {B1:"Boost"} at "BOOST"', () => {
      // The reversal alone resolves "boost" to the OTHER entry, B1.
      expect(encodeChannelValue({ type: 'string', states: { B1: 'Boost' }, current: 'BOOST' }, 'boost', 'BOOST')).to.equal('BOOST');
      // Selecting the entry itself, or with no current value known, still reverses.
      expect(encodeChannelValue({ type: 'string', states: { B1: 'Boost' } }, 'boost')).to.equal('B1');
    });

    it('writes whichever raw value the re-selected label was decoded from: {3:"5"} at 5, or at 3', () => {
      expect(encodeChannelValue({ type: 'number', states: { '3': '5' }, current: 5 }, '5', '5')).to.equal(5);
      expect(encodeChannelValue({ type: 'number', states: { '3': '5' }, current: 3 }, '5', '5')).to.equal(3);
    });

    it('refuses any other number into a mapped number channel: 7 into a SPEED mapped 0..3', () => {
      const codec: ChannelCodec = { type: 'number', states: { '0': 'AUTO', '1': 'LOW', '2': 'MEDIUM', '3': 'HIGH' }, current: 1 };
      expect(encodeChannelValue(codec, '7', 'LOW')).to.equal(undefined);
      expect(encodeChannelValue(codec, 'high', 'LOW')).to.equal(3);
      expect(encodeChannelValue(codec, 'low', 'LOW')).to.equal(1);
    });

    it('coerces the current value to the channel type, and refuses one that cannot be', () => {
      expect(encodeChannelValue({ type: 'number', states: { '0': 'AUS' }, current: '50' }, '50', '50')).to.equal(50);
      expect(encodeChannelValue({ type: 'string', states: { A: 'Auto' }, current: 7 }, '7', '7')).to.equal('7');
      expect(encodeChannelValue({ type: 'number', states: { '0': 'AUS' }, current: 'abc' }, 'abc', 'abc')).to.equal(undefined);
    });

    it('leaves a current value the map decoded to the map, unambiguous only', () => {
      // {1:"High",2:"HIGH"} at 2 shows "HIGH": the map produced it, so the
      // map reverses it, and two matching keys are still refused.
      expect(encodeChannelValue({ type: 'number', states: { '1': 'High', '2': 'HIGH' }, current: 2 }, 'high', 'HIGH')).to.equal(
        undefined,
      );
    });

    it('re-selects a SPEED_LEVEL whose decoder never consulted its map, so the dead-button fix holds', () => {
      // synthClimate reads SPEED_LEVEL with readNumber, not readEnum: at 100
      // the panel shows "100", although the map labels 100 "MAX".
      expect(encodeChannelValue({ type: 'number', states: { '0': 'AUS', '100': 'MAX' }, current: 100 }, '100', '100')).to.equal(100);
    });

    // Task 8 round 1, M1a (reverses what this test pinned in Task 8): with no
    // map there is no list to publish, so the panel can only ever send the
    // current value back. Anything else came from another MQTT client:
    // "100000" into a SPEED_LEVEL declared 0..100, "42" into an unmapped MODE.
    it('lets an unmapped number channel take only its current value', () => {
      expect(encodeChannelValue({ type: 'number', current: 42 }, '42', '42')).to.equal(42);
      expect(encodeChannelValue({ type: 'number', current: 42 }, '43', '42')).to.equal(undefined);
      expect(encodeChannelValue({ type: 'number', current: 50, min: 0, max: 100 }, '100000', '50')).to.equal(undefined);
      // With no current value known there is nothing it could re-select.
      expect(encodeChannelValue({ type: 'number' }, '42')).to.equal(undefined);
      expect(encodeChannelValue({ type: 'number', current: 42 }, '42')).to.equal(undefined);
    });
  });

  // Ruling 49: the panel speaks percent for cover position/tilt and light
  // brightness; a channel speaks its declared min..max. One linear map, both
  // directions.
  describe('percent scaling (Ruling 49)', () => {
    const range = (min?: number, max?: number): ChannelCodec => ({ type: 'number', min, max });

    it('is the identity for a 0..100 channel and for one that declares no range', () => {
      for (const codec of [range(0, 100), range(), undefined]) {
        for (const value of [0, 1, 33.3, 50, 99.5, 100]) {
          expect(toPercent(value, codec), `${JSON.stringify(codec)} ${value}`).to.equal(value);
          expect(fromPercent(value, codec), `${JSON.stringify(codec)} ${value}`).to.equal(value);
        }
      }
    });

    // Ruling 55 (round 2) corrects round 1's "never invent a bound" for a
    // percentage: 0..100 is the panel's own scale, the only sensible floor and
    // ceiling, so a missing min is 0 and a missing max is 100. Equal or
    // inverted bounds cannot be scaled at all, so the control is withheld.
    it('takes a missing min as 0 and a missing max as 100, and cannot scale equal or inverted bounds (Ruling 55)', () => {
      expect(fromPercent(50, range(undefined, 255))).to.equal(128);
      expect(toPercent(255, range(undefined, 255))).to.equal(100);
      expect(fromPercent(50, range(10))).to.equal(55);
      expect(toPercent(55, range(10))).to.equal(50);
      // A non-finite bound is no bound.
      expect(fromPercent(50, range(Number.NaN, 255))).to.equal(128);
      expect(fromPercent(50, range(0, Number.POSITIVE_INFINITY))).to.equal(50);
      for (const codec of [range(40, 40), range(255, 0), range(150)]) {
        expect(toPercent(200, codec), JSON.stringify(codec)).to.equal(undefined);
        expect(fromPercent(50, codec), JSON.stringify(codec)).to.equal(undefined);
      }
    });

    it('lands exactly on the declared endpoints at 0% and 100% (N2)', () => {
      // 0.1 + 100 * 0.2 / 100 is 0.30000000000000004: above max, so 100% was refused.
      expect(fromPercent(100, range(0.1, 0.3))).to.equal(0.3);
      expect(fromPercent(0, range(0.1, 0.3))).to.equal(0.1);
      expect(withinDeclaredRange(fromPercent(100, range(0.1, 0.3))!, range(0.1, 0.3))).to.equal(true);
    });

    it('scales a 0..255 channel both ways: published exactly, written as the nearest whole number', () => {
      // toPercent is exact: the light's HA brightness needs the fraction, and
      // the cover synth rounds what it publishes (round 2, N1).
      expect(toPercent(200, range(0, 255))).to.equal((200 * 100) / 255);
      expect(toPercent(0, range(0, 255))).to.equal(0);
      expect(toPercent(255, range(0, 255))).to.equal(100);
      // Write: 50% is 127.5; a whole-number range of at least 100 steps keeps
      // an integral device integral, and every percent still lands on its own
      // step.
      expect(fromPercent(50, range(0, 255))).to.equal(128);
      expect(fromPercent(1, range(0, 255))).to.equal(3);
      expect(fromPercent(0, range(0, 255))).to.equal(0);
      expect(fromPercent(100, range(0, 255))).to.equal(255);
      expect(fromPercent(50, range(0, 254))).to.equal(127);
      const steps = new Set(Array.from({ length: 101 }, (_, percent) => fromPercent(percent, range(0, 255))));
      expect(steps.size, 'no two percentages collapse onto one raw value').to.equal(101);
    });

    it('keeps the exact value for a fractional or narrow range, and shifts an offset range', () => {
      expect(fromPercent(50, range(0, 1))).to.equal(0.5);
      expect(toPercent(0.25, range(0, 1))).to.equal(25);
      expect(fromPercent(55, range(0, 10))).to.equal(5.5);
      expect(fromPercent(50, range(10, 30))).to.equal(20);
      expect(toPercent(20, range(10, 30))).to.equal(50);
    });

    it('checks each bound an absolute channel declares, and ignores an equal or inverted pair (Ruling 55)', () => {
      expect(withinDeclaredRange(30, range(5, 30))).to.equal(true);
      expect(withinDeclaredRange(30.5, range(5, 30))).to.equal(false);
      expect(withinDeclaredRange(4.9, range(5, 30))).to.equal(false);
      expect(withinDeclaredRange(1e9, range(5))).to.equal(true);
      expect(withinDeclaredRange(4, range(5))).to.equal(false);
      expect(withinDeclaredRange(-1e9, range(undefined, 30))).to.equal(true);
      expect(withinDeclaredRange(31, range(undefined, 30))).to.equal(false);
      expect(withinDeclaredRange(1e9, range())).to.equal(true);
      expect(withinDeclaredRange(1e9, undefined)).to.equal(true);
      // Round 1 took an equal or inverted pair literally (one value, or none).
      // Ruling 55: for an absolute value -- a setpoint, a humidity, a colour
      // temperature -- such a pair means nothing, so it is ignored.
      expect(withinDeclaredRange(41, range(40, 40))).to.equal(true);
      expect(withinDeclaredRange(50, range(255, 0))).to.equal(true);
    });
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
    // itself is not configured, e.g. raw=42 -> decodes "42" -- the current
    // value, and with no map the only one the panel can send (M1a).
    const codec: ChannelCodec = { type: 'number', current: 42 };
    const encoded = encodeChannelValue(codec, '42', '42');
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
    // Exactly as an unmapped channel since M1a: its current value, and nothing else.
    const codec: ChannelCodec = { type: 'number', states: {}, current: 3 };
    expect(encodeChannelValue(codec, '3', '3')).to.equal(3);
    expect(encodeChannelValue(codec, '4', '3')).to.equal(undefined);
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
    // never resolves to its key 2. It is simply a label outside the map, and
    // not the current value, so it is refused (Ruling 41 narrowed Ruling 36's
    // number fallback to the current value).
    expect(() => encodeChannelValue(codec, '5')).to.not.throw();
    expect(encodeChannelValue(codec, '5')).to.equal(undefined);
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

      // Ruling 41: this is a re-select of the current value, so the encoder
      // is told what the panel shows (the dispatcher passes the attribute).
      const encoded = encodeChannelValue(e?.channelMeta?.speed, decoded as string, e?.attributes.fan_mode);
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
