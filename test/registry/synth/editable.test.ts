import { expect } from 'chai';
import { encodeChannelValue } from '../../../src/registry/synth/common';
import { synthDatetime, synthNumber, synthSelect, valueChannel } from '../../../src/registry/synth/editable';
import { synthesise } from '../../../src/registry/synth/index';
import type { ChannelInput, DeviceInput, Domain, SourceValue } from '../../../src/registry/types';

const NOW = 1_758_000_000_000;
const ID = 'alias.0.Test.SET';

const value = (val: unknown, q = 0): SourceValue => ({ val, ack: true, q, ts: NOW });
const holding = (val: unknown): Record<string, SourceValue> => ({ [ID]: value(val) });

/**
 * A device as discovery and the admin's override hand it to a synth: a
 * slider's one channel is `set` (detector.ts's channelName), the catch-all
 * info's is `actual`.
 */
function deviceWith(domain: Domain, channel: Partial<ChannelInput>, name: 'set' | 'actual' = 'set'): DeviceInput {
  return {
    objectId: 'alias.0.Test',
    name: 'Test',
    detectorType: name === 'set' ? 'slider' : 'info',
    domain,
    channels: { [name]: { objectId: ID, ...channel } },
  };
}

const sliderWith = (common: Partial<ChannelInput>): DeviceInput =>
  deviceWith('number', { role: 'level', type: 'number', write: true, ...common });

/** A writable string state with a states map, as a user forces an info reading into select. */
const selectWithStates = (states: Record<string, string>, common: Partial<ChannelInput> = {}): DeviceInput =>
  deviceWith('select', { role: 'state', type: 'string', write: true, states, ...common }, 'actual');

const datetimeWith = (common: Partial<ChannelInput> = {}): DeviceInput =>
  deviceWith('datetime', { role: 'state', type: 'string', write: true, ...common }, 'actual');

describe('registry/synth/editable (Task 13)', () => {
  describe('valueChannel', () => {
    it('is SET when there is one, else the reading, else none', () => {
      expect(valueChannel({ set: 'a', actual: 'b' })).to.equal('set');
      expect(valueChannel({ actual: 'b' })).to.equal('actual');
      expect(valueChannel({ dimmer: 'c' })).to.equal(undefined);
    });
  });

  describe('synthNumber', () => {
    it('derives number bounds from the ioBroker object common min/max', () => {
      const e = synthNumber(sliderWith({ min: 5, max: 30, step: 0.5, unit: '°C' }), 'number.test', holding(21.5));
      expect(e?.attributes).to.include({ min: 5, max: 30, step: 0.5 });
      expect(e?.attributes.unit_of_measurement).to.equal('°C');
      expect(e).to.include({ domain: 'number', state: '21.5', available: true });
      expect(e?.writable).to.deep.equal({ value: true });
    });

    // contract-editable.md §3 (value_control.cpp:82-86): the panel edits a
    // number only with a finite min, max and step, min < max, step > 0 and a
    // finite max - min; anything else leaves the tile read-only. No bound is
    // invented to rescue one, and a partial or inconsistent set is none.
    for (const [label, bounds] of [
      ['no step (ioBroker declares none on most states)', { min: 0, max: 100 }],
      ['no min', { max: 100, step: 1 }],
      ['no max', { min: 0, step: 1 }],
      ['min above max', { min: 30, max: 5, step: 1 }],
      ['min equal to max', { min: 5, max: 5, step: 1 }],
      ['a zero step', { min: 0, max: 10, step: 0 }],
      ['a negative step', { min: 0, max: 10, step: -1 }],
      ['an infinite bound', { min: 0, max: Number.POSITIVE_INFINITY, step: 1 }],
      ['a range whose width overflows', { min: -1.7e308, max: 1.7e308, step: 1 }],
    ] as const) {
      it(`publishes no bound and is read-only with ${label}`, () => {
        const e = synthNumber(sliderWith(bounds), 'number.test', holding(3));
        for (const key of ['min', 'max', 'step']) expect(e?.attributes, key).to.not.have.property(key);
        expect(e?.writable).to.deep.equal({ value: false });
        expect(e?.state, 'still displayed').to.equal('3');
      });
    }

    it('is read-only on a read-only channel, or one that holds no number', () => {
      const range = { min: 0, max: 10, step: 1 };
      expect(synthNumber(sliderWith({ ...range, write: false }), 'number.test', holding(3))?.writable).to.deep.equal({ value: false });
      expect(synthNumber(sliderWith({ ...range, write: undefined }), 'number.test', holding(3))?.writable).to.deep.equal({ value: false });
      expect(synthNumber(sliderWith({ ...range, type: 'string' }), 'number.test', holding('3'))?.writable).to.deep.equal({ value: false });
    });

    it('shows a usable number as text; unavailable without a value, unknown for one that is no number', () => {
      const slider = sliderWith({ min: 0, max: 10, step: 1 });
      expect(synthNumber(slider, 'number.test', holding(0))).to.include({ state: '0', available: true });
      expect(synthNumber(slider, 'number.test', holding(null))).to.include({ state: 'unavailable', available: false });
      expect(synthNumber(slider, 'number.test', { [ID]: value(4, 0x44) })).to.include({ state: 'unavailable', available: false });
      expect(synthNumber(slider, 'number.test', {})).to.include({ state: 'unavailable', available: false });
      // Blank is never a confident zero.
      expect(synthNumber(slider, 'number.test', holding(' '))).to.include({ state: 'unknown', available: true });
    });

    it('shows and writes SET, never a reading beside it', () => {
      // A device a user forces into number keeps every channel it had: a
      // thermostat's setpoint is the number, its room temperature is not.
      const device: DeviceInput = {
        ...sliderWith({ min: 5, max: 30, step: 0.5 }),
        channels: {
          set: { objectId: ID, type: 'number', write: true, min: 5, max: 30, step: 0.5 },
          actual: { objectId: 'alias.0.Test.ACTUAL', type: 'number', write: false },
        },
      };
      const e = synthNumber(device, 'number.test', { [ID]: value(21), 'alias.0.Test.ACTUAL': value(19.5) });
      expect(e?.state).to.equal('21');
      expect(e?.writable).to.deep.equal({ value: true });
    });

    it('uses a forced reading as its value when there is no SET', () => {
      const device = deviceWith('number', { type: 'number', write: true, min: 0, max: 10, step: 1 }, 'actual');
      const e = synthNumber(device, 'number.test', holding(7));
      expect(e).to.include({ state: '7', available: true });
      expect(e?.writable).to.deep.equal({ value: true });
    });

    it('is no entity at all without a SET or a reading', () => {
      const device: DeviceInput = { ...sliderWith({}), channels: { dimmer: { objectId: ID, type: 'number', write: true } } };
      expect(synthNumber(device, 'number.test', holding(1))).to.equal(null);
    });

    it('carries channelMeta, the declared step included, from the real synth (Ruling 23)', () => {
      const e = synthNumber(sliderWith({ min: 5, max: 30, step: 0.5, unit: '°C' }), 'number.test', holding(21.5));
      expect(e?.source).to.deep.equal({ set: ID });
      expect(e?.channelMeta?.set).to.include({ type: 'number', write: true, min: 5, max: 30, step: 0.5, unit: '°C', current: 21.5 });
    });
  });

  describe('synthSelect', () => {
    const MODES = { 0: 'Aus', 1: 'Eco', 2: 'Komfort' };

    it("lists the states map's labels as options, in order, and shows the current value's label", () => {
      const e = synthSelect(selectWithStates(MODES, { type: 'number' }), 'select.test', holding(1));
      expect(e?.attributes.options).to.deep.equal(['Aus', 'Eco', 'Komfort']);
      expect(e).to.include({ domain: 'select', state: 'Eco', available: true });
      expect(e?.writable).to.deep.equal({ value: true });
    });

    it('drops the whole option list when one option is invalid', () => {
      // no partial acceptance: an invalid option makes the tile read-only
      const e = synthSelect(selectWithStates({ a: 'Alpha', b: 'Bad\nName' }), 'select.test', holding('a'));
      expect(e?.attributes.options).to.equal(undefined);
      expect(e?.writable).to.deep.equal({ value: false });
      // Still displayed: only the capability goes.
      expect(e?.state).to.equal('Alpha');
    });

    it('drops the whole list for a carriage return as well (the panel joins its options with a newline)', () => {
      expect(synthSelect(selectWithStates({ a: 'Alpha', b: 'Bad\rName' }), 'select.test', {})?.attributes.options).to.equal(undefined);
    });

    it('rejects an option list with a duplicate label', () => {
      expect(synthSelect(selectWithStates({ a: 'Same', b: 'Same' }), 'select.test', {})?.attributes.options).to.equal(undefined);
    });

    it('rejects labels that only case or surrounding space tell apart: the value command could not tell them apart either', () => {
      // encodeChannelValue, which reverses the option the panel sends back,
      // matches trimmed and case-insensitively (Ruling 22's shared encoder).
      for (const states of [{ 1: 'High', 2: 'HIGH' }, { 1: 'Eco', 2: ' eco' }]) {
        const e = synthSelect(selectWithStates(states, { type: 'number' }), 'select.test', {});
        expect(e?.attributes.options, JSON.stringify(states)).to.equal(undefined);
        expect(e?.writable).to.deep.equal({ value: false });
      }
    });

    it('rejects an empty label and one over 255 UTF-8 bytes, but keeps one of exactly 255 bytes', () => {
      // contract-editable.md §6/§8 (value_control.cpp:97): 1 to 255 BYTES.
      const bytes255 = `${'ä'.repeat(127)}a`;
      const bytes256 = 'ä'.repeat(128);
      expect(Buffer.byteLength(bytes255, 'utf8')).to.equal(255);
      expect(Buffer.byteLength(bytes256, 'utf8')).to.equal(256);
      expect(synthSelect(selectWithStates({ a: bytes255, b: 'B' }), 'select.test', {})?.attributes.options).to.deep.equal([bytes255, 'B']);
      expect(synthSelect(selectWithStates({ a: bytes256, b: 'B' }), 'select.test', {})?.attributes.options).to.equal(undefined);
      expect(synthSelect(selectWithStates({ a: '', b: 'B' }), 'select.test', {})?.attributes.options).to.equal(undefined);
    });

    it('keeps 64 options and drops a 65th', () => {
      // contract-editable.md §6/§8 (value_control.cpp:92): 1 to 64 options.
      const labels = (count: number): Record<string, string> =>
        Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), `Stufe ${i}`]));
      expect(synthSelect(selectWithStates(labels(64), { type: 'number' }), 'select.test', {})?.attributes.options).to.have.length(64);
      expect(synthSelect(selectWithStates(labels(65), { type: 'number' }), 'select.test', {})?.attributes.options).to.equal(undefined);
    });

    it('publishes no options without a states map, and is read-only', () => {
      const e = synthSelect(selectWithStates({}, { states: undefined }), 'select.test', holding('eco'));
      expect(e?.attributes).to.not.have.property('options');
      expect(e).to.include({ state: 'eco', available: true });
      expect(e?.writable).to.deep.equal({ value: false });
    });

    it('publishes no options for a channel with no single native type to write', () => {
      // encodeChannelValue never reverses a label on a boolean channel, and a
      // mixed or untyped one has no single type to write (as climate's
      // enumModes).
      for (const type of ['boolean', 'mixed', undefined] as const) {
        const e = synthSelect(selectWithStates({ false: 'Aus', true: 'An' }, { type }), 'select.test', {});
        expect(e?.attributes.options, String(type)).to.equal(undefined);
        expect(e?.writable, String(type)).to.deep.equal({ value: false });
      }
    });

    it('drops the list when a key would not read back as its own option', () => {
      // A number channel stores 1.5 for the key "1.50", and readEnum then finds
      // no label for it: the panel would wait on its confirmation in vain.
      expect(synthSelect(selectWithStates({ '1.50': 'X', 2: 'Y' }, { type: 'number' }), 'select.test', {})?.attributes.options).to.equal(undefined);
      // Nor can a number channel hold "abc" at all.
      expect(synthSelect(selectWithStates({ abc: 'X', 2: 'Y' }, { type: 'number' }), 'select.test', {})?.attributes.options).to.equal(undefined);
    });

    it('keeps the list on a read-only channel, but is not writable', () => {
      const e = synthSelect(selectWithStates(MODES, { type: 'number', write: false }), 'select.test', holding(2));
      expect(e?.attributes.options).to.deep.equal(['Aus', 'Eco', 'Komfort']);
      expect(e?.writable).to.deep.equal({ value: false });
    });

    it('maps every option losslessly back to the raw value that then shows as that option (Task 15)', () => {
      // What cmnd/value must do with the option string the panel sends: the
      // shared encoder over the entity's own channelMeta. The panel confirms a
      // select only when the state then equals the option EXACTLY
      // (value_control.cpp:329).
      for (const [states, type] of [
        [MODES, 'number'],
        [{ eco: 'Eco', comfort: 'Komfort', 'boost, silent': 'Boost, leise' }, 'string'],
      ] as const) {
        const device = selectWithStates(states, { type });
        const e = synthSelect(device, 'select.test', {})!;
        const codec = e.channelMeta?.[valueChannel(e.source)!];
        for (const option of e.attributes.options as string[]) {
          const raw = encodeChannelValue(codec, option);
          expect(raw, option).to.not.equal(undefined);
          expect(typeof raw, option).to.equal(type);
          expect(synthSelect(device, 'select.test', holding(raw))?.state, option).to.equal(option);
        }
      }
    });

    it("shows a raw value outside the map as its own text, nothing without one, and unknown for a blank one", () => {
      const device = selectWithStates(MODES, { type: 'number' });
      expect(synthSelect(device, 'select.test', holding(7))).to.include({ state: '7', available: true });
      expect(synthSelect(device, 'select.test', {})).to.include({ state: 'unavailable', available: false });
      expect(synthSelect(selectWithStates({ a: 'A' }), 'select.test', holding('  '))).to.include({ state: 'unknown', available: true });
    });

    it('carries channelMeta, the states map included, from the real synth (Ruling 23)', () => {
      const e = synthSelect(selectWithStates(MODES, { type: 'number' }), 'select.test', holding(1));
      expect(e?.source).to.deep.equal({ actual: ID });
      expect(e?.channelMeta?.actual).to.include({ type: 'number', write: true, current: 1 });
      expect(e?.channelMeta?.actual?.states).to.deep.equal({ 0: 'Aus', 1: 'Eco', 2: 'Komfort' });
    });
  });

  describe('synthDatetime', () => {
    /** Devices exactly as detection alone produces them: a catch-all reading, a slider. */
    const detected: DeviceInput[] = [
      { ...datetimeWith({ role: 'date' }), domain: 'sensor' },
      { ...datetimeWith({ role: 'state' }), domain: 'sensor' },
      { ...sliderWith({ min: 0, max: 10, step: 1 }) },
    ];
    const anyDetectedDevice = (): DeviceInput => detected[0]!;

    it('never infers a datetime entity from detection alone', () => {
      expect(synthDatetime(anyDetectedDevice(), 'datetime.test', holding('2026-09-23'))).to.equal(null);
      for (const device of detected) {
        expect(synthDatetime(device, 'datetime.test', holding('2026-09-23 07:30:00')), device.domain).to.equal(null);
      }
    });

    // contract-editable.md §3 (value_editor_model.h:28-52): date is Y-M-D,
    // time H:M or H:M:S, datetime a date, one ' ' or 'T', then a time.
    for (const [text, hasDate, hasTime] of [
      ['2026-09-23', true, false],
      ['07:30', false, true],
      ['07:30:15', false, true],
      ['7:05', false, true],
      ['2026-09-23 07:30:00', true, true],
      ['2026-9-3T07:30', true, true],
    ] as const) {
      it(`recognises "${text}" as ${hasDate ? 'a date' : ''}${hasDate && hasTime ? ' and ' : ''}${hasTime ? 'a time' : ''}`, () => {
        const e = synthDatetime(datetimeWith(), 'datetime.test', holding(text));
        expect(e).to.include({ domain: 'datetime', state: text, available: true });
        expect(e?.attributes).to.include({ has_date: hasDate, has_time: hasTime });
        expect(e?.writable).to.deep.equal({ value: true });
      });
    }

    it('shows any other shape as its raw text, read-only and with no kind', () => {
      for (const raw of ['23.09.2026', '2026-09-23T05:30:00.000Z', 'morgen', '07:30 Uhr']) {
        const e = synthDatetime(datetimeWith(), 'datetime.test', holding(raw));
        expect(e, raw).to.include({ state: raw, available: true });
        expect(e?.attributes, raw).to.not.have.any.keys('has_date', 'has_time');
        expect(e?.writable, raw).to.deep.equal({ value: false });
      }
      // An epoch timestamp: its unit (ms or s) and zone are not the object's
      // to tell, so it is shown as it is and never written.
      const epoch = synthDatetime(datetimeWith({ type: 'number' }), 'datetime.test', holding(1_758_600_000_000));
      expect(epoch).to.include({ state: '1758600000000', available: true });
      expect(epoch?.attributes).to.not.have.any.keys('has_date', 'has_time');
      expect(epoch?.writable).to.deep.equal({ value: false });
    });

    it('is read-only on a read-only channel, or one that is no string, even when the value parses', () => {
      for (const common of [{ write: false }, { write: undefined }, { type: 'mixed' as const }]) {
        const e = synthDatetime(datetimeWith(common), 'datetime.test', holding('07:30'));
        expect(e?.attributes, JSON.stringify(common)).to.include({ has_date: false, has_time: true });
        expect(e?.writable, JSON.stringify(common)).to.deep.equal({ value: false });
      }
    });

    it('is unavailable without a value, and unknown for a blank one', () => {
      expect(synthDatetime(datetimeWith(), 'datetime.test', {})).to.include({ state: 'unavailable', available: false });
      expect(synthDatetime(datetimeWith(), 'datetime.test', holding(''))).to.include({ state: 'unknown', available: true });
    });

    it('carries channelMeta from the real synth (Ruling 23)', () => {
      const e = synthDatetime(datetimeWith(), 'datetime.test', holding('07:30'));
      expect(e?.source).to.deep.equal({ actual: ID });
      expect(e?.channelMeta?.actual).to.include({ type: 'string', write: true, current: '07:30' });
    });
  });

  it('synthesise dispatches number, select and datetime to their synths', () => {
    expect(synthesise(sliderWith({ min: 0, max: 10, step: 1 }), 'number.test', holding(4))).to.include({ domain: 'number', state: '4' });
    expect(synthesise(selectWithStates({ a: 'A' }), 'select.test', holding('a'))).to.include({ domain: 'select', state: 'A' });
    expect(synthesise(datetimeWith(), 'datetime.test', holding('07:30'))).to.include({ domain: 'datetime', state: '07:30' });
  });
});
