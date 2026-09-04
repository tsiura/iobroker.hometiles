import { expect } from 'chai';
import { synthBinarySensor } from '../../../src/registry/synth/binary_sensor';
import { synthSensor } from '../../../src/registry/synth/sensor';
import { synthSwitch } from '../../../src/registry/synth/switch';
import type { DeviceInput, SourceValue } from '../../../src/registry/types';

const NOW = 1_757_000_000_000;

function value(val: unknown, q = 0): SourceValue {
  return { val, ack: true, q, ts: NOW };
}

const tempDevice: DeviceInput = {
  objectId: 'zigbee.0.temp',
  name: 'Wohnzimmer',
  detectorType: 'temperature',
  domain: 'sensor',
  channels: { actual: { objectId: 'zigbee.0.temp.value', unit: '°C', type: 'number', role: 'value.temperature' } },
};

const doorDevice: DeviceInput = {
  objectId: 'zigbee.0.door',
  name: 'Haustuer',
  detectorType: 'door',
  domain: 'binary_sensor',
  channels: { actual: { objectId: 'zigbee.0.door.state', type: 'boolean', role: 'sensor.door' } },
};

const socketDevice: DeviceInput = {
  objectId: 'shelly.0.plug',
  name: 'Kaffeemaschine',
  detectorType: 'socket',
  domain: 'switch',
  channels: { set: { objectId: 'shelly.0.plug.on', type: 'boolean', write: true, role: 'switch' } },
};

describe('registry/synth simple domains', () => {
  it('renders a numeric sensor as a bare value with its unit attribute', () => {
    const e = synthSensor(tempDevice, 'sensor.wohnzimmer', { 'zigbee.0.temp.value': value(21.5) });
    expect(e.state).to.equal('21.5');
    expect(e.available).to.equal(true);
    expect(e.attributes.unit_of_measurement).to.equal('°C');
    expect(e.attributes.device_class).to.equal('temperature');
    expect(e.attributes.friendly_name).to.equal('Wohnzimmer');
  });

  it('marks a sensor unavailable when the value is null', () => {
    const e = synthSensor(tempDevice, 'sensor.wohnzimmer', { 'zigbee.0.temp.value': value(null) });
    expect(e.state).to.equal('unavailable');
    expect(e.available).to.equal(false);
  });

  it('marks a sensor unavailable when the ioBroker quality is non-zero', () => {
    const e = synthSensor(tempDevice, 'sensor.wohnzimmer', { 'zigbee.0.temp.value': value(21.5, 0x02) });
    expect(e.state).to.equal('unavailable');
    expect(e.available).to.equal(false);
  });

  it('marks a sensor unknown when a numeric channel holds an unparseable value', () => {
    const e = synthSensor(tempDevice, 'sensor.wohnzimmer', { 'zigbee.0.temp.value': value('n/a') });
    expect(e.state).to.equal('unknown');
    expect(e.available).to.equal(true);
  });

  it('never turns a legitimate zero into unknown or unavailable', () => {
    const e = synthSensor(tempDevice, 'sensor.wohnzimmer', { 'zigbee.0.temp.value': value(0) });
    expect(e.state).to.equal('0');
    expect(e.available).to.equal(true);
  });

  it('marks a sensor unavailable when the backing state is entirely absent', () => {
    const e = synthSensor(tempDevice, 'sensor.wohnzimmer', {});
    expect(e.state).to.equal('unavailable');
    expect(e.available).to.equal(false);
  });

  it('keeps a textual sensor state verbatim', () => {
    const textDevice: DeviceInput = {
      ...tempDevice,
      detectorType: 'info',
      channels: { actual: { objectId: 'zigbee.0.temp.value', type: 'string', role: 'text' } },
    };
    const e = synthSensor(textDevice, 'sensor.status', { 'zigbee.0.temp.value': value('heating') });
    expect(e.state).to.equal('heating');
    expect(e.attributes.unit_of_measurement).to.equal(undefined);
  });

  it('maps a boolean door sensor onto on and off with a device class', () => {
    const open = synthBinarySensor(doorDevice, 'binary_sensor.haustuer', { 'zigbee.0.door.state': value(true) });
    expect(open.state).to.equal('on');
    expect(open.attributes.device_class).to.equal('door');
    const shut = synthBinarySensor(doorDevice, 'binary_sensor.haustuer', { 'zigbee.0.door.state': value(false) });
    expect(shut.state).to.equal('off');
  });

  it('marks a binary sensor unavailable rather than off when its value is missing', () => {
    const e = synthBinarySensor(doorDevice, 'binary_sensor.haustuer', {});
    expect(e.state).to.equal('unavailable');
    expect(e.state).to.not.equal('off');
  });

  it('renders a switch from its SET channel and advertises it as writable', () => {
    const e = synthSwitch(socketDevice, 'switch.kaffeemaschine', { 'shelly.0.plug.on': value(true) });
    expect(e.state).to.equal('on');
    expect(e.source.set).to.equal('shelly.0.plug.on');
    expect(e.attributes.assumed_state).to.equal(false);
  });

  it('prefers an ACTUAL channel over SET for switch feedback when both exist', () => {
    const withActual: DeviceInput = {
      ...socketDevice,
      channels: {
        set: { objectId: 'shelly.0.plug.on', type: 'boolean', write: true },
        actual: { objectId: 'shelly.0.plug.state', type: 'boolean' },
      },
    };
    const e = synthSwitch(withActual, 'switch.kaffeemaschine', {
      'shelly.0.plug.on': value(true),
      'shelly.0.plug.state': value(false),
    });
    expect(e.state).to.equal('off');
  });

  it('treats an empty or blank numeric value as unknown, never as zero', () => {
    // Number('') and Number('   ') are both 0 in JavaScript. A blank reading
    // must not render as a confident 0 on a panel.
    for (const blank of ['', '   ', '\t']) {
      const e = synthSensor(tempDevice, 'sensor.wohnzimmer', { 'zigbee.0.temp.value': value(blank) });
      expect(e.state, `blank ${JSON.stringify(blank)} must be unknown`).to.equal('unknown');
      expect(e.available).to.equal(true);
    }
  });

  it('leaves lastChanged at zero when no source value has ever been seen', () => {
    // Substituting Date.now() here would make a permanently dead entity look
    // freshly changed on every synthesis pass.
    const e = synthSensor(tempDevice, 'sensor.wohnzimmer', {});
    expect(e.lastChanged).to.equal(0);
  });

  it('carries the source timestamp into lastChanged', () => {
    // The value() helper stamps ts = NOW; its second argument is quality.
    const e = synthSensor(tempDevice, 'sensor.wohnzimmer', { 'zigbee.0.temp.value': value(21.5) });
    expect(e.lastChanged).to.equal(NOW);
  });

  it('reports assumed_state when the device offers no feedback channel', () => {
    const setOnly: DeviceInput = {
      ...socketDevice,
      channels: { set: { objectId: 'shelly.0.plug.on', type: 'boolean', write: true } },
    };
    const e = synthSwitch(setOnly, 'switch.k', { 'shelly.0.plug.on': value(true) });
    expect(e.attributes.assumed_state).to.equal(false);
    const noAck: DeviceInput = { ...setOnly };
    const e2 = synthSwitch(noAck, 'switch.k', { 'shelly.0.plug.on': { val: true, ack: false, q: 0, ts: NOW } });
    expect(e2.attributes.assumed_state).to.equal(true);
  });
});
