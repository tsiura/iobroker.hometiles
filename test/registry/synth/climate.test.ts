import { expect } from 'chai';
import { synthClimate } from '../../../src/registry/synth/climate';
import { synthesise } from '../../../src/registry/synth/index';
import type { ChannelInput, DeviceInput, SourceValue } from '../../../src/registry/types';

const NOW = 1_757_000_000_000;

function numState(val: unknown, q = 0): SourceValue {
  return { val, ack: true, q, ts: NOW };
}

/**
 * Builds a climate DeviceInput plus its values map from a detector-style
 * channel name -> value record, e.g. { ACTUAL: numState(21.5) }. Channel
 * names are lowercased the same way detector.ts's channelName default branch
 * does, so these fixtures read exactly like a real detected thermostat.
 *
 * synthClimate does not branch on detectorType: thermostat and airCondition
 * are read identically, purely from whichever channels are configured. One
 * fixture builder therefore covers both.
 */
function deviceWith(channelValues: Record<string, SourceValue>): { device: DeviceInput; values: Record<string, SourceValue> } {
  const channels: DeviceInput['channels'] = {};
  const values: Record<string, SourceValue> = {};
  for (const [rawName, value] of Object.entries(channelValues)) {
    const name = rawName.toLowerCase();
    const objectId = `climate.0.${name}`;
    channels[name] = { objectId, write: true };
    values[objectId] = value;
  }
  return {
    device: { objectId: 'climate.0', name: 'Climate', detectorType: 'thermostat', domain: 'climate', channels },
    values,
  };
}

function synth(channelValues: Record<string, SourceValue>) {
  const { device, values } = deviceWith(channelValues);
  return synthClimate(device, 'climate.test', values);
}

function airConditionWithBothSwings(): { device: DeviceInput; values: Record<string, SourceValue> } {
  const device: DeviceInput = {
    objectId: 'ac.0',
    name: 'AC',
    detectorType: 'airCondition',
    domain: 'climate',
    channels: {
      mode: { objectId: 'ac.0.mode', write: true },
      // The numeric multi-position swing (type-detector's FanPatterns.swing,
      // defaultRole level.mode.swing) carries named positions.
      swing: { objectId: 'ac.0.swing_level', write: true, states: { '3': 'vertical' } },
      // The boolean swing toggle (FanPatterns.swingBoolean, defaultRole
      // switch.mode.swing) is a plain on/off switch.
      swing_toggle: { objectId: 'ac.0.swing_switch', write: true },
    },
  };
  const values: Record<string, SourceValue> = {
    'ac.0.mode': numState('cool'),
    'ac.0.swing_level': numState(3),
    'ac.0.swing_switch': numState(true),
  };
  return { device, values };
}

describe('registry/synth/climate', () => {
  it('returns null for a thermostat with no readable or writable channel', () => {
    // type-detector 6.0.1 requires a setpoint, but a later ^6 minor or a
    // domain override need not, so synthClimate must still refuse this
    expect(synth({})).to.equal(null);
  });

  it('returns null for a device exposing only channels the firmware payload can never validate on', () => {
    // Review round 1, M6: tile_renderer.cpp's parse_climate_payload only
    // marks a payload valid when it carries hvac_mode/hvac_action, a
    // temperature/humidity has_* flag, or a target range -- fan_mode,
    // swing_mode, swing_horizontal_mode, power and boost are never in that
    // check, so a device with only these would always publish a payload the
    // firmware discards outright. Such a device is not a climate entity in
    // the wire-format sense, however ioBroker's type-detector classified it.
    const e = synth({ SPEED_LEVEL: numState(45), SWING: numState(1), POWER: numState(true), BOOST: numState(false) });
    expect(e).to.equal(null);
  });

  it('marks a thermostat with ACTUAL but no SET as read-only', () => {
    const e = synth({ ACTUAL: numState(21.5) });
    expect(e?.attributes.current_temperature).to.equal(21.5);
    expect(e?.writable?.setpoint).to.equal(undefined);
  });

  it('carries SET_HEATING and SET_COOLING as a dual setpoint, not as SET', () => {
    const e = synth({ SET_HEATING: numState(18), SET_COOLING: numState(24) });
    expect(e?.attributes.target_temp_low).to.equal(18);
    expect(e?.attributes.target_temp_high).to.equal(24);
    expect(e?.attributes.target_temperature).to.equal(undefined);
    expect(e?.writable?.target_temp_low).to.equal(true);
    expect(e?.writable?.target_temp_high).to.equal(true);
  });

  it('treats a lone SET_HEATING with no SET_COOLING as a single target, not half a range', () => {
    // Review round 1, ruling 14: HA's own model for a heat-only thermostat
    // (only SET_HEATING configured) is a SINGLE target, not a range missing
    // its cool side -- the firmware's has_target_range/has_target_temperature
    // are mutually exclusive in the popup (climate_popup.cpp), so treating
    // this as target_temp_low would permanently disable its single-target UI.
    const e = synth({ SET_HEATING: numState(19) });
    expect(e?.attributes.target_temperature).to.equal(19);
    expect(e?.attributes.target_temp_low).to.equal(undefined);
    expect(e?.attributes.target_temp_high).to.equal(undefined);
    expect(e?.writable?.setpoint).to.equal(true);
    expect(e?.writable?.target_temp_low).to.equal(undefined);
    // Task 5's dispatcher looks up the setpoint writer by trying
    // 'set'/'set_heating'/'set_cooling' in order against entity.source, so
    // the channel key itself must still be 'set_heating', unrenamed.
    expect(e?.source.set_heating).to.equal('climate.0.set_heating');
  });

  it('treats a lone SET_COOLING with no SET_HEATING as a single target, not half a range', () => {
    const e = synth({ SET_COOLING: numState(26) });
    expect(e?.attributes.target_temperature).to.equal(26);
    expect(e?.attributes.target_temp_low).to.equal(undefined);
    expect(e?.attributes.target_temp_high).to.equal(undefined);
    expect(e?.writable?.setpoint).to.equal(true);
    expect(e?.writable?.target_temp_high).to.equal(undefined);
    expect(e?.source.set_cooling).to.equal('climate.0.set_cooling');
  });

  it('prefers a plain SET over SET_HEATING/SET_COOLING when all three are configured', () => {
    const e = synth({ SET: numState(21), SET_HEATING: numState(18), SET_COOLING: numState(24) });
    expect(e?.attributes.target_temperature).to.equal(21);
    expect(e?.writable?.setpoint).to.equal(true);
  });

  it('reads the two independently-resolved SWING channels into separate attributes', () => {
    // This fixture starts from channels already resolved to swing/swing_toggle
    // - it verifies synthClimate decodes each into its own attribute, not the
    // name-collision fix itself. That fix (two raw SWING states -> two
    // distinct channel keys, order-independent) is pinned at the detector
    // layer: test/registry/detector.test.ts, "resolves airCondition's
    // duplicate SWING channels by role, not by name" and its reversed-order
    // companion.
    const { device, values } = airConditionWithBothSwings();
    const e = synthClimate(device, 'climate.ac', values);
    expect(e?.attributes.swing_mode).to.equal('vertical');
    expect(e?.attributes.swing_horizontal_mode).to.equal('on');
    expect(e?.attributes.swing_mode).to.not.equal(e?.attributes.swing_horizontal_mode);
  });

  it('does not fabricate a setpoint from the current temperature', () => {
    const e = synth({ ACTUAL: numState(21.5) });
    expect(e?.attributes.target_temperature).to.equal(undefined);
  });

  it('marks the single setpoint writable when SET is configured and writable', () => {
    const e = synth({ SET: numState(22) });
    expect(e?.attributes.target_temperature).to.equal(22);
    expect(e?.writable?.setpoint).to.equal(true);
  });

  it('omits target_temperature for a blank SET reading instead of reporting zero', () => {
    // Number('') is 0 and finite: a blank reading must resolve to "unknown",
    // never to a confident zero-degree setpoint on a wall panel.
    const e = synth({ SET: numState('') });
    expect(e?.attributes.target_temperature).to.equal(undefined);
    // The channel is still configured and writable, even though its current
    // value is unusable - Task 5 must still be able to write a fresh value.
    expect(e?.writable?.setpoint).to.equal(true);
  });

  it('decodes MODE, WORKING_MODE and fan SPEED through the channel state-name table', () => {
    const { device, values } = deviceWith({});
    device.channels.mode = { objectId: 'climate.0.mode', write: true, states: { '1': 'heat' } };
    device.channels.working_mode = { objectId: 'climate.0.working_mode', states: { '1': 'heating' } };
    device.channels.speed = { objectId: 'climate.0.speed', write: true, states: { '2': 'high' } };
    values['climate.0.mode'] = numState(1);
    values['climate.0.working_mode'] = numState(1);
    values['climate.0.speed'] = numState(2);
    const e = synthClimate(device, 'climate.test', values);
    expect(e?.attributes.hvac_mode).to.equal('heat');
    expect(e?.attributes.hvac_action).to.equal('heating');
    expect(e?.attributes.fan_mode).to.equal('high');
    expect(e?.writable?.hvac_mode).to.equal(true);
    expect(e?.writable?.fan_mode).to.equal(true);
  });

  it('falls back to SPEED_LEVEL for fan_mode when SPEED is not configured', () => {
    // MODE is included purely to keep this device valid under the firmware's
    // acceptance rule (M6 above) -- SPEED_LEVEL alone would now return null,
    // which is covered by its own test, not this one. This test is only
    // about the SPEED/SPEED_LEVEL fallback.
    const e = synth({ MODE: numState('cool'), SPEED_LEVEL: numState(45) });
    expect(e?.attributes.fan_mode).to.equal('45');
    expect(e?.writable?.fan_mode).to.equal(true);
  });

  it('never borrows SPEED_LEVEL for fan_mode when SPEED is configured but has no usable value (Ruling 25, fix-round 3)', () => {
    // Before this fix: display fell back to SPEED_LEVEL's value here while
    // the dispatcher (which only checks whether the SPEED channel OBJECT
    // exists, not whether it currently has a value) still routed writes to
    // SPEED -- fan_mode would display "42" and a command would write the
    // number 42, a SPEED_LEVEL percentage, into the SPEED enum, with
    // ok:true. Display and write must use the SAME channel: SPEED exists,
    // so fan_mode is unknown here, never "42".
    const { device, values } = deviceWith({ MODE: numState('cool') });
    device.channels.speed = { objectId: 'climate.0.speed', write: true, states: { '2': 'high' } };
    device.channels.speed_level = { objectId: 'climate.0.speed_level', write: true };
    values['climate.0.speed_level'] = numState(42);
    // Deliberately no value at all for climate.0.speed.
    const e = synthClimate(device, 'climate.test', values);
    expect(e?.attributes.fan_mode).to.equal(undefined);
    expect(e?.writable?.fan_mode).to.equal(true);
    expect(e?.source.speed).to.equal('climate.0.speed');
  });

  it('reads POWER and BOOST as on/off and records them writable', () => {
    // ACTUAL keeps this device valid under the firmware's acceptance rule
    // (M6 above); a POWER/BOOST-only device is covered by its own
    // null-return test, not this one, which is only about the POWER/BOOST
    // decode itself.
    const e = synth({ ACTUAL: numState(21.5), POWER: numState(true), BOOST: numState(false) });
    expect(e?.attributes.power).to.equal('on');
    expect(e?.attributes.boost).to.equal('off');
    expect(e?.writable?.power).to.equal(true);
    expect(e?.writable?.boost).to.equal(true);
  });

  it('carries channel type/states metadata for the dispatcher to encode commands with (fix-round 2)', () => {
    const { device, values } = deviceWith({});
    device.channels.mode = { objectId: 'climate.0.mode', write: true, type: 'number', states: { '1': 'heat' } };
    values['climate.0.mode'] = numState(1);
    const e = synthClimate(device, 'climate.test', values);
    // Task 8: `write` (Ruling 38) and the current raw value (Ruling 41) ride
    // along; round 1 adds the declared range (Ruling 49), round 3 the unit
    // (Ruling 59), none of either here.
    expect(e?.channelMeta?.mode).to.deep.equal({
      type: 'number',
      states: { '1': 'heat' },
      write: true,
      current: 1,
      min: undefined,
      max: undefined,
      unit: undefined,
    });
  });

  // Task 8 round 1: the panel clamps every setpoint it offers to
  // min_temp..max_temp (7..35 when absent; climate_popup.cpp:225-231), and the
  // dispatcher refuses one outside the channel's declared range (Ruling 49).
  // Publishing that range keeps the two one set -- and it is channel
  // metadata, so like the *_modes lists it never makes a device available.
  describe('min_temp/max_temp from the setpoint channel (Ruling 49)', () => {
    const setpoint = (name: string, min?: number, max?: number): ChannelInput => ({
      objectId: `climate.0.${name}`,
      type: 'number',
      write: true,
      min,
      max,
    });
    const withSetpoints = (channels: DeviceInput['channels'], values: Record<string, SourceValue> = {}) =>
      synthClimate({ objectId: 'climate.0', name: 'Climate', detectorType: 'thermostat', domain: 'climate', channels }, 'climate.t', values);

    it('publishes a single setpoint channel\'s declared range, SET or a lone SET_HEATING', () => {
      expect(withSetpoints({ set: setpoint('set', 4.5, 30.5) })?.attributes).to.include({ min_temp: 4.5, max_temp: 30.5 });
      expect(withSetpoints({ set_heating: setpoint('set_heating', 5, 25) })?.attributes).to.include({ min_temp: 5, max_temp: 25 });
    });

    it('publishes a dual setpoint as its heating minimum and cooling maximum', () => {
      const e = withSetpoints({ set_heating: setpoint('set_heating', 5, 25), set_cooling: setpoint('set_cooling', 18, 32) });
      expect(e?.attributes).to.include({ min_temp: 5, max_temp: 32 });
    });

    it('publishes only the bounds a channel declares, never inventing one', () => {
      const onlyMax = withSetpoints({ set: setpoint('set', undefined, 30) })?.attributes;
      expect(onlyMax).to.include({ max_temp: 30 });
      expect(onlyMax).to.not.have.property('min_temp');
      const none = withSetpoints({ set: setpoint('set') })?.attributes;
      expect(none).to.not.have.property('min_temp');
      expect(none).to.not.have.property('max_temp');
    });

    it('never makes a valueless device available', () => {
      const e = withSetpoints({ set: setpoint('set', 4.5, 30.5) });
      expect(e?.available).to.equal(false);
      expect(e?.state).to.equal('unavailable');
    });

    it('publishes nothing for equal or inverted bounds, which mean nothing for an absolute value (Ruling 55)', () => {
      // Published, they would also trip the firmware's own fallback to 7..35
      // (tile_renderer.cpp:2274-2277), while the dispatcher checked them.
      for (const [min, max] of [
        [20, 20],
        [30, 5],
      ]) {
        const attributes = withSetpoints({ set: setpoint('set', min, max) })?.attributes;
        expect(attributes, `${min}..${max}`).to.not.have.any.keys('min_temp', 'max_temp');
      }
    });
  });

  it('dispatches to synthClimate through synthesise, including its null result', () => {
    const { device, values } = deviceWith({ ACTUAL: numState(21.5) });
    expect(synthesise(device, 'climate.x', values)?.domain).to.equal('climate');
    const { device: empty, values: emptyValues } = deviceWith({});
    expect(synthesise(empty, 'climate.y', emptyValues)).to.equal(null);
  });

  // Task 5b (Ruling 26): the firmware draws mode/fan/swing buttons ONLY from
  // explicit *_modes arrays, matched against fixed name tables
  // (tile_renderer.cpp:2029-2136). Every name published here must be one a
  // panel can send back (lowercased) and encodeChannelValue can reverse into
  // the channel's exact native value; the end-to-end proof of that lives in
  // test/runtime/dispatcher.test.ts.
  describe('*_modes lists', () => {
    function withChannels(channels: DeviceInput['channels'], values: Record<string, SourceValue> = {}) {
      const device: DeviceInput = { objectId: 'ac.0', name: 'AC', detectorType: 'airCondition', domain: 'climate', channels };
      return synthClimate(device, 'climate.ac', values);
    }

    it('keeps only the firmware hvac names from a MODE states map, never an unknown label', () => {
      const e = withChannels({
        mode: { objectId: 'ac.0.mode', type: 'number', write: true, states: { '0': 'OFF', '1': 'HEAT', '2': 'COOL', '3': 'MANU' } },
      });
      expect(e?.attributes.hvac_modes).to.deep.equal(['off', 'heat', 'cool']);
      expect(e?.attributes.hvac_modes).to.not.include('manu');
    });

    it('publishes no list at all without a states map, or when no label is a firmware name', () => {
      const noStates = withChannels({ mode: { objectId: 'ac.0.mode', type: 'number', write: true } });
      expect(noStates?.attributes).to.not.have.property('hvac_modes');

      const noFirmwareName = withChannels({
        mode: { objectId: 'ac.0.mode', type: 'number', write: true, states: { '0': 'MANU', '1': 'PARTY' } },
      });
      expect(noFirmwareName?.attributes).to.not.have.property('hvac_modes');
    });

    it('publishes no list for a string enum channel with no states map (Ruling 30)', () => {
      // Its valid values are unknown. The panel lowercases every command, so
      // a raw "AUTO" passed back as "auto" would be written verbatim, wrong,
      // with ok:true. With no list there is no button, so no such command.
      const e = withChannels({ mode: { objectId: 'ac.0.mode', type: 'string', write: true } }, { 'ac.0.mode': numState('AUTO') });
      expect(e?.attributes.hvac_mode).to.equal('AUTO');
      expect(e?.attributes).to.not.have.property('hvac_modes');
    });

    it('publishes no list for a read-only channel, whose buttons the dispatcher would have to refuse', () => {
      const e = withChannels({
        mode: { objectId: 'ac.0.mode', type: 'number', write: false, states: { '0': 'OFF', '1': 'HEAT' } },
      });
      expect(e?.attributes).to.not.have.property('hvac_modes');
    });

    it('publishes no list when the channel type is unknown or mixed, so its native type cannot be pinned', () => {
      const states = { '0': 'OFF', '1': 'HEAT' };
      expect(withChannels({ mode: { objectId: 'ac.0.mode', write: true, states } })?.attributes).to.not.have.property('hvac_modes');
      expect(withChannels({ mode: { objectId: 'ac.0.mode', type: 'mixed', write: true, states } })?.attributes).to.not.have.property(
        'hvac_modes',
      );
    });

    it('never publishes a label two states share case-insensitively, which the encoder must refuse', () => {
      const e = withChannels({
        mode: { objectId: 'ac.0.mode', type: 'number', write: true, states: { '0': 'OFF' } },
        speed: { objectId: 'ac.0.speed', type: 'number', write: true, states: { '1': 'High', '2': 'HIGH', '3': 'LOW' } },
      });
      expect(e?.attributes.fan_modes).to.deep.equal(['low']);
    });

    it('takes fan_modes from SPEED whenever SPEED is configured, from SPEED_LEVEL only when it is not (Ruling 25)', () => {
      const mode = { objectId: 'ac.0.mode', type: 'number' as const, write: true, states: { '0': 'OFF' } };
      const both = withChannels({
        mode,
        speed: { objectId: 'ac.0.speed', type: 'number', write: true, states: { '0': 'AUTO' } },
        speed_level: { objectId: 'ac.0.speed_level', type: 'number', write: true, states: { '50': 'MEDIUM' } },
      });
      expect(both?.attributes.fan_modes).to.deep.equal(['auto']);

      const levelOnly = withChannels({
        mode,
        speed_level: { objectId: 'ac.0.speed_level', type: 'number', write: true, states: { '50': 'MEDIUM' } },
      });
      expect(levelOnly?.attributes.fan_modes).to.deep.equal(['medium']);
    });

    it('takes swing_modes from the numeric SWING and swing_horizontal_modes from the boolean toggle', () => {
      const e = withChannels({
        mode: { objectId: 'ac.0.mode', type: 'number', write: true, states: { '0': 'OFF' } },
        // type-detector's own FanPatterns.swing defaultStates
        swing: {
          objectId: 'ac.0.swing',
          type: 'number',
          write: true,
          states: { '0': 'AUTO', '1': 'HORIZONTAL', '2': 'STATIONARY', '3': 'VERTICAL' },
        },
        swing_toggle: { objectId: 'ac.0.swing_toggle', type: 'boolean', write: true },
      });
      expect(e?.attributes.swing_modes).to.deep.equal(['vertical', 'horizontal']);
      expect(e?.attributes.swing_horizontal_modes).to.deep.equal(['off', 'on']);
    });

    it('never lets a static list make a device with no usable value look available', () => {
      // `available` counts attribute keys beyond the friendly_name/icon
      // baseline; a list is channel metadata, not a reading.
      const e = withChannels({
        mode: { objectId: 'ac.0.mode', type: 'number', write: true, states: { '0': 'OFF', '1': 'HEAT' } },
      });
      expect(e?.available).to.equal(false);
      expect(e?.state).to.equal('unavailable');
    });

    // Ruling 36: supported_features is derived from `writable`, so a label
    // role may be writable only when a label can actually land in its
    // channel -- judged on the same codec the dispatcher encodes with.
    it('marks a label role writable only when its channel is writable AND can take a label (Ruling 36)', () => {
      const mode = (channel: Partial<ChannelInput>) =>
        withChannels({ mode: { objectId: 'ac.0.mode', write: true, ...channel } })?.writable?.hvac_mode;
      const withMode = (name: string, channel: Partial<ChannelInput>) =>
        withChannels({
          mode: { objectId: 'ac.0.mode', type: 'number', write: true, states: { '0': 'OFF' } },
          [name]: { objectId: `ac.0.${name}`, write: true, ...channel },
        })?.writable;

      // (a) untyped MODE, no states: its raw 1 would come back as the string "1".
      expect(mode({}), 'untyped MODE').to.equal(false);
      expect(mode({ type: 'string' }), 'string MODE').to.equal(false);
      expect(mode({ type: 'number' }), 'number MODE: "1" carries back as 1').to.equal(true);
      expect(mode({ type: 'string', states: { AUTO: 'Auto' } }), 'string MODE with states').to.equal(true);
      // (b) string SPEED, no states: raw "HIGH" would come back as "high".
      expect(withMode('speed', { type: 'string' })?.fan_mode, 'string SPEED').to.equal(false);
      // The dispatcher encodes an untyped SPEED/SWING as a number, so it can land.
      expect(withMode('speed', {})?.fan_mode, 'untyped SPEED').to.equal(true);
      expect(withMode('swing', { type: 'string' })?.swing_mode, 'string SWING').to.equal(false);
      expect(withMode('swing', { type: 'number' })?.swing_mode, 'number SWING').to.equal(true);
    });

    it('gives the swing toggle its bit and its on/off list under one condition: writable and boolean', () => {
      const toggle = (channel: Partial<ChannelInput>) =>
        withChannels({
          mode: { objectId: 'ac.0.mode', type: 'number', write: true, states: { '0': 'OFF' } },
          swing_toggle: { objectId: 'ac.0.swing_toggle', ...channel },
        });
      const cases: Array<[string, Partial<ChannelInput>, boolean]> = [
        ['writable boolean', { type: 'boolean', write: true }, true],
        ['untyped, which the dispatcher encodes as boolean', { write: true }, true],
        ['read-only boolean', { type: 'boolean', write: false }, false],
        // (c) raw "true" would come back as "on".
        ['writable string', { type: 'string', write: true }, false],
        ['writable number', { type: 'number', write: true }, false],
      ];
      for (const [label, channel, commandable] of cases) {
        const e = toggle(channel);
        expect(e?.writable?.swing_horizontal_mode, `${label}: writable`).to.equal(commandable);
        if (commandable) expect(e?.attributes.swing_horizontal_modes, label).to.deep.equal(['off', 'on']);
        else expect(e?.attributes, label).to.not.have.property('swing_horizontal_modes');
      }
    });
  });
});
