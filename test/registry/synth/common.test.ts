import { expect } from 'chai';
import { encodeChannelValue } from '../../../src/registry/synth/common';
import type { ChannelCodec } from '../../../src/registry/types';

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

  it('passes a string-typed MODE label straight through', () => {
    // readEnum: raw="cool" (string, no states) -> trimmed -> decodes "cool".
    const codec: ChannelCodec = { type: 'string' };
    const encoded = encodeChannelValue(codec, 'cool');
    expect(encoded).to.equal('cool');
    expect(typeof encoded).to.equal('string');
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

  it('passes a label through unchanged when the channel carries no type/states metadata at all', () => {
    // The safe default for a channel the registry never captured metadata
    // for: write back exactly what arrived, same as every climate command
    // already did before this field existed.
    expect(encodeChannelValue(undefined, 'cool')).to.equal('cool');
  });

  it('treats a mixed-type channel the same as a plain string: pass through', () => {
    const codec: ChannelCodec = { type: 'mixed' };
    expect(encodeChannelValue(codec, 'cool')).to.equal('cool');
  });
});
