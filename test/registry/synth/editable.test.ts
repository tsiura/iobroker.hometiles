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
    // invented to rescue one, and a partial or inconsistent set is none. An
    // absent step is derived (Ruling 81, below); a declared invalid one is not.
    for (const [label, bounds] of [
      ['no min', { max: 100, step: 1 }],
      ['no max', { min: 0, step: 1 }],
      ['min above max', { min: 30, max: 5, step: 1 }],
      ['min equal to max', { min: 5, max: 5, step: 1 }],
      // A zero range derives no step: Home Assistant's loop runs only for a
      // range other than 0, and without that guard it never ends (T81-1).
      ['min equal to max and no step', { min: 5, max: 5 }],
      ['a zero step', { min: 0, max: 10, step: 0 }],
      ['a negative step', { min: 0, max: 10, step: -1 }],
      // objectMeta's reading of a common.step that is present but no number.
      ['a declared step that is no number', { min: 0, max: 10, step: Number.NaN }],
      ['an infinite bound', { min: 0, max: Number.POSITIVE_INFINITY, step: 1 }],
      ['a range whose width overflows', { min: -1.7e308, max: 1.7e308, step: 1 }],
      ['a range whose width overflows and no step', { min: -1.7e308, max: 1.7e308 }],
    ] as const) {
      it(`publishes no bound and is read-only with ${label}`, () => {
        const e = synthNumber(sliderWith(bounds), 'number.test', holding(3));
        for (const key of ['min', 'max', 'step']) expect(e?.attributes, key).to.not.have.property(key);
        expect(e?.writable).to.deep.equal({ value: false });
        expect(e?.state, 'still displayed').to.equal('3');
      });
    }

    // Ruling 81: an absent common.step is Home Assistant's own
    // (NumberEntity._calculate_step): 1, divided by 10 while the range is at
    // most the step -- by repeated division, the value the Bridge relays.
    const divided = (times: number): number => {
      let step = 1;
      for (let i = 0; i < times; i++) step /= 10;
      return step;
    };
    for (const [bounds, step] of [
      [{ min: 0, max: 100 }, 1],
      [{ min: 20, max: 60 }, 1],
      [{ min: 0, max: 1000 }, 1],
      [{ min: 0, max: 1.5 }, 1],
      // A range of exactly 1 is at most 1.
      [{ min: 0, max: 1 }, 0.1],
      [{ min: -0.5, max: 0.5 }, 0.1],
      [{ min: 0, max: 0.05 }, 0.01],
      // 0.0000010000000000000002, never 10 ** -6.
      [{ min: 0, max: 0.000005 }, divided(6)],
    ] as const) {
      it(`derives the step ${step} for ${bounds.min}..${bounds.max} without common.step (Ruling 81)`, () => {
        const e = synthNumber(sliderWith(bounds), 'number.test', holding(bounds.min));
        expect(e?.attributes).to.include({ min: bounds.min, max: bounds.max, step });
        expect(e?.writable).to.deep.equal({ value: true });
        // One source of truth (T81-4): the published step. channelMeta keeps
        // the object's own, which is none.
        expect(e?.channelMeta?.set?.step).to.equal(undefined);
      });
    }

    it('keeps a declared step over the derived one', () => {
      expect(synthNumber(sliderWith({ min: 0, max: 100, step: 5 }), 'number.test', holding(10))?.attributes).to.include({ step: 5 });
    });

    // Ruling 82: a percent value is 0..100 where the object declares no bound,
    // each bound on its own (Home Assistant's DEFAULT_MIN_VALUE and
    // DEFAULT_MAX_VALUE; percentScale, Ruling 55).
    for (const [bounds, range] of [
      [{}, { min: 0, max: 100, step: 1 }],
      [{ min: 10 }, { min: 10, max: 100, step: 1 }],
      [{ max: 50 }, { min: 0, max: 50, step: 1 }],
      [{ min: -20, max: 20 }, { min: -20, max: 20, step: 1 }],
      [{ max: 1 }, { min: 0, max: 1, step: 0.1 }],
    ] as const) {
      it(`gives a percent level declaring ${JSON.stringify(bounds)} the range ${range.min}..${range.max} (Ruling 82)`, () => {
        const e = synthNumber(sliderWith({ unit: '%', ...bounds }), 'number.test', holding(1));
        expect(e?.attributes).to.include({ ...range, unit_of_measurement: '%' });
        expect(e?.writable).to.deep.equal({ value: true });
      });
    }

    it('defaults a bound for the unit % only, and never past the other bound (Ruling 82)', () => {
      // A forced temperature must not get an invented 0..100 (T82-3).
      const celsius = synthNumber(sliderWith({ unit: '°C', max: 30 }), 'number.test', holding(21));
      expect(celsius?.attributes).to.not.have.any.keys('min', 'max', 'step');
      expect(celsius?.writable).to.deep.equal({ value: false });
      // 100 as min leaves 100..100: no range.
      const empty = synthNumber(sliderWith({ unit: '%', min: 100 }), 'number.test', holding(100));
      expect(empty?.attributes).to.not.have.any.keys('min', 'max', 'step');
      expect(empty?.writable).to.deep.equal({ value: false });
    });

    it('is read-only on a channel declared read-only, or one that holds no number', () => {
      const range = { min: 0, max: 10, step: 1 };
      expect(synthNumber(sliderWith({ ...range, write: false }), 'number.test', holding(3))?.writable).to.deep.equal({ value: false });
      expect(synthNumber(sliderWith({ ...range, type: 'string' }), 'number.test', holding('3'))?.writable).to.deep.equal({ value: false });
    });

    it('is writable on a channel that declares no write flag, as ioBroker defaults it (Ruling 89)', () => {
      // Only write false is read-only, as for the dispatcher (Ruling 38).
      const e = synthNumber(sliderWith({ min: 0, max: 10, step: 1, write: undefined }), 'number.test', holding(3));
      expect(e?.writable).to.deep.equal({ value: true });
    });

    it('shows a usable number as text, unknown without a value, and unavailable only for bad quality (Ruling 88)', () => {
      const slider = sliderWith({ min: 0, max: 10, step: 1 });
      expect(synthNumber(slider, 'number.test', holding(0))).to.include({ state: '0', available: true });
      // No value yet, or a null one: still editable, the panel drafting from
      // min (value_control.cpp:416-417), as Home Assistant keeps an unknown
      // number available.
      for (const values of [holding(null), {}]) {
        const e = synthNumber(slider, 'number.test', values);
        expect(e).to.include({ state: 'unknown', available: true });
        expect(e?.writable).to.deep.equal({ value: true });
      }
      // ioBroker's quality says the value cannot be trusted, whatever it is.
      expect(synthNumber(slider, 'number.test', { [ID]: value(4, 0x44) })).to.include({ state: 'unavailable', available: false });
      expect(synthNumber(slider, 'number.test', { [ID]: value(null, 0x42) })).to.include({ state: 'unavailable', available: false });
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

    it('is writable on a channel that declares no write flag (Ruling 89)', () => {
      const e = synthSelect(selectWithStates(MODES, { type: 'number', write: undefined }), 'select.test', holding(2));
      expect(e?.writable).to.deep.equal({ value: true });
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

    it('shows a raw value outside the map as its own text, and unknown for a blank one', () => {
      const device = selectWithStates(MODES, { type: 'number' });
      expect(synthSelect(device, 'select.test', holding(7))).to.include({ state: '7', available: true });
      expect(synthSelect(selectWithStates({ a: 'A' }), 'select.test', holding('  '))).to.include({ state: 'unknown', available: true });
    });

    it('is unknown and still selectable without a value, and unavailable only for bad quality (Ruling 88)', () => {
      const device = selectWithStates(MODES, { type: 'number' });
      for (const values of [holding(null), {}]) {
        const e = synthSelect(device, 'select.test', values);
        expect(e).to.include({ state: 'unknown', available: true });
        expect(e?.writable).to.deep.equal({ value: true });
      }
      expect(synthSelect(device, 'select.test', { [ID]: value(1, 0x44) })).to.include({ state: 'unavailable', available: false });
    });

    it('never takes an Object.prototype member for a label (M3)', () => {
      // readEnum looked a raw value up in the states map by plain indexing:
      // "constructor" found Object itself, a function no payload can carry.
      const device = selectWithStates({ eco: 'Eco', comfort: 'Komfort' });
      for (const raw of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
        expect(synthSelect(device, 'select.test', holding(raw))?.state, raw).to.equal(raw);
      }
    });

    it('drops the whole list for a NUL, where the panel cuts an option short (M4)', () => {
      // value_control.cpp:96 copies each option as a C string.
      for (const states of [{ 1: 'A\u0000B', 2: 'C' }, { 1: 'A\u0000B', 2: 'A\u0000C' }]) {
        const e = synthSelect(selectWithStates(states, { type: 'number' }), 'select.test', {});
        expect(e?.attributes.options, JSON.stringify(states)).to.equal(undefined);
        expect(e?.writable).to.deep.equal({ value: false });
      }
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

    // M1: the panel's own ranges as well (value_editor_model.h:46-49, the leap
    // rule of :17-20). A value in the grammar but outside them could not seed
    // the panel's editor (value_control.cpp:858-859).
    for (const [text, hasDate, hasTime] of [
      ['23:59:59', false, true],
      ['00:00', false, true],
      ['2024-02-29', true, false],
      ['2000-02-29', true, false],
      ['0001-01-01', true, false],
      ['9999-12-31', true, false],
      ['2026-12-31 23:59:59', true, true],
    ] as const) {
      it(`keeps "${text}", a boundary inside the panel's ranges (M1)`, () => {
        const e = synthDatetime(datetimeWith(), 'datetime.test', holding(text));
        expect(e?.attributes).to.include({ has_date: hasDate, has_time: hasTime });
        expect(e?.writable).to.deep.equal({ value: true });
      });
    }

    it("gives no kind to a value in the grammar but outside the panel's ranges, and keeps it read-only (M1)", () => {
      for (const text of [
        '24:00',
        '23:60',
        '07:30:60',
        '2026-02-29',
        '1900-02-29',
        '2026-02-30',
        '2026-04-31',
        '2026-13-01',
        '0000-01-01',
        '2026-00-10',
        '2026-09-00',
        '2026-09-23T24:00',
        '2026-09-23 23:59:60',
      ]) {
        const e = synthDatetime(datetimeWith(), 'datetime.test', holding(text));
        expect(e, text).to.include({ state: text, available: true });
        expect(e?.attributes, text).to.not.have.any.keys('has_date', 'has_time');
        expect(e?.writable, text).to.deep.equal({ value: false });
      }
    });

    it('shows any other text as it is, read-only and with no kind', () => {
      // ISO text with a zone and a localised date stay read-only (Ruling 84).
      for (const raw of ['23.09.2026', '2026-09-23T05:30:00.000Z', 'morgen', '07:30 Uhr']) {
        const e = synthDatetime(datetimeWith(), 'datetime.test', holding(raw));
        expect(e, raw).to.include({ state: raw, available: true });
        expect(e?.attributes, raw).to.not.have.any.keys('has_date', 'has_time');
        expect(e?.writable, raw).to.deep.equal({ value: false });
      }
    });

    it('is read-only on a channel declared read-only, or one that is no string, even when the value parses', () => {
      for (const common of [{ write: false }, { type: 'mixed' as const }]) {
        const e = synthDatetime(datetimeWith(common), 'datetime.test', holding('07:30'));
        expect(e?.attributes, JSON.stringify(common)).to.include({ has_date: false, has_time: true });
        expect(e?.writable, JSON.stringify(common)).to.deep.equal({ value: false });
      }
    });

    it('is writable on a channel that declares no write flag (Ruling 89)', () => {
      expect(synthDatetime(datetimeWith({ write: undefined }), 'datetime.test', holding('07:30'))?.writable).to.deep.equal({ value: true });
      const epoch = datetimeWith({ role: 'value.time', type: 'number', write: undefined });
      expect(synthDatetime(epoch, 'datetime.test', holding(null))?.writable).to.deep.equal({ value: true });
    });

    it('is unknown without a value, and unavailable only for bad quality (Ruling 88)', () => {
      for (const values of [holding(null), {}, holding('')]) {
        const e = synthDatetime(datetimeWith(), 'datetime.test', values);
        expect(e).to.include({ state: 'unknown', available: true });
        // A text's kind is its value's shape: none can be told from no value.
        expect(e?.attributes).to.not.have.any.keys('has_date', 'has_time');
        expect(e?.writable).to.deep.equal({ value: false });
      }
      expect(synthDatetime(datetimeWith(), 'datetime.test', { [ID]: value('07:30', 0x44) })).to.include({
        state: 'unavailable',
        available: false,
      });
    });

    describe('epoch milliseconds, in the host zone (Ruling 84)', () => {
      // Pinned: the conversion is the host's local time (T84-6).
      let zone: string | undefined;
      before(() => {
        zone = process.env.TZ;
        process.env.TZ = 'Europe/Berlin';
      });
      after(() => {
        if (zone === undefined) delete process.env.TZ;
        else process.env.TZ = zone;
      });
      const epochWith = (common: Partial<ChannelInput> = {}): DeviceInput => datetimeWith({ role: 'value.time', type: 'number', ...common });
      const BOTH = { has_date: true, has_time: true };

      it('shows epoch milliseconds as the local date and time, editable, in the shape the panel sends back', () => {
        const e = synthDatetime(epochWith(), 'datetime.test', holding(1_758_600_000_000));
        expect(e).to.include({ state: '2025-09-23 06:00:00', available: true });
        expect(e?.attributes).to.include(BOTH);
        expect(e?.writable).to.deep.equal({ value: true });
        // Milliseconds below a second are dropped, never rounded up (T84-7).
        expect(synthDatetime(epochWith(), 'datetime.test', holding(1_758_600_000_999.9))?.state).to.equal('2025-09-23 06:00:00');
      });

      it('draws the line at 1e11 ms: below it a number is no date, shown as it is and read-only', () => {
        const below = synthDatetime(epochWith(), 'datetime.test', holding(99_999_999_999));
        expect(below).to.include({ state: '99999999999', available: true });
        expect(below?.writable).to.deep.equal({ value: false });
        const at = synthDatetime(epochWith(), 'datetime.test', holding(100_000_000_000));
        expect(at).to.include({ state: '1973-03-03 10:46:40' });
        expect(at?.writable).to.deep.equal({ value: true });
      });

      it("and at the host zone's last second of the year 9999, and at the largest Date (T84-2)", () => {
        expect(synthDatetime(epochWith(), 'datetime.test', holding(253_402_297_199_999))).to.include({ state: '9999-12-31 23:59:59' });
        for (const raw of [253_402_297_200_000, 8.64e15 + 1, Number.POSITIVE_INFINITY]) {
          const e = synthDatetime(epochWith(), 'datetime.test', holding(raw));
          expect(e?.state, String(raw)).to.equal(String(raw));
          expect(e?.writable, String(raw)).to.deep.equal({ value: false });
        }
      });

      it('follows daylight saving time: the gap is never shown, the repeated hour shows twice', () => {
        const at = (ms: number): string | undefined => synthDatetime(epochWith(), 'datetime.test', holding(ms))?.state;
        expect(at(Date.UTC(2026, 2, 29, 0, 59, 59))).to.equal('2026-03-29 01:59:59');
        expect(at(Date.UTC(2026, 2, 29, 1, 0, 0))).to.equal('2026-03-29 03:00:00');
        expect(at(Date.UTC(2026, 9, 25, 0, 30, 0))).to.equal('2026-10-25 02:30:00');
        expect(at(Date.UTC(2026, 9, 25, 1, 30, 0))).to.equal('2026-10-25 02:30:00');
      });

      it('keeps its kind without a value or with bad quality, so the tile never changes layout (T84-3)', () => {
        const unknown = synthDatetime(epochWith(), 'datetime.test', holding(null));
        expect(unknown).to.include({ state: 'unknown', available: true });
        expect(unknown?.attributes).to.include(BOTH);
        // The first date may be set (Ruling 88).
        expect(unknown?.writable).to.deep.equal({ value: true });
        const bad = synthDatetime(epochWith(), 'datetime.test', { [ID]: value(1_758_600_000_000, 0x44) });
        expect(bad).to.include({ state: 'unavailable', available: false });
        expect(bad?.attributes).to.include(BOTH);
      });

      it('is read-only on a read-only channel, and for a date that arrives as text on a number channel', () => {
        expect(synthDatetime(epochWith({ write: false }), 'datetime.test', holding(1_758_600_000_000))?.writable).to.deep.equal({ value: false });
        const text = synthDatetime(epochWith(), 'datetime.test', holding('1758600000000'));
        expect(text).to.include({ state: '1758600000000' });
        expect(text?.writable).to.deep.equal({ value: false });
      });
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
