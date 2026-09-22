import { expect } from 'chai';
import { synthClimate } from '../../../src/registry/synth/climate';
import { synthesise } from '../../../src/registry/synth/index';
import type { DeviceInput, SourceValue } from '../../../src/registry/types';

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
    // thermostat has NO required channels, so this is reachable, not theoretical
    expect(synth({})).to.equal(null);
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
    const e = synth({ SPEED_LEVEL: numState(45) });
    expect(e?.attributes.fan_mode).to.equal('45');
    expect(e?.writable?.fan_mode).to.equal(true);
  });

  it('reads POWER and BOOST as on/off and records them writable', () => {
    const e = synth({ POWER: numState(true), BOOST: numState(false) });
    expect(e?.attributes.power).to.equal('on');
    expect(e?.attributes.boost).to.equal('off');
    expect(e?.writable?.power).to.equal(true);
    expect(e?.writable?.boost).to.equal(true);
  });

  it('dispatches to synthClimate through synthesise, including its null result', () => {
    const { device, values } = deviceWith({ ACTUAL: numState(21.5) });
    expect(synthesise(device, 'climate.x', values)?.domain).to.equal('climate');
    const { device: empty, values: emptyValues } = deviceWith({});
    expect(synthesise(empty, 'climate.y', emptyValues)).to.equal(null);
  });
});
