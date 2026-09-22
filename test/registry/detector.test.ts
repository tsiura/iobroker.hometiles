import { expect } from 'chai';
import { DETECTOR_TYPE_TO_DOMAIN, mapControlToDevice, type DetectedControl, type ObjectMeta } from '../../src/registry/detector';

const META: Record<string, ObjectMeta> = {
  'hue.0.decke.on': { name: 'On', role: 'switch', type: 'boolean', write: true },
  'hue.0.decke.level': { name: 'Level', role: 'level.dimmer', type: 'number', min: 0, max: 100, write: true },
  'hue.0.decke.ct': { name: 'CT', role: 'level.color.temperature', type: 'number', min: 2200, max: 6500, write: true },
  'zigbee.0.temp.value': { name: 'Temperature', role: 'value.temperature', type: 'number', unit: '°C' },
  'shelly.0.plug.on': { name: 'Kaffeemaschine', role: 'switch', type: 'boolean', write: true },
};

describe('registry/detector mapping', () => {
  it('maps the type-detector 6.x enum members onto the v0.1 domains', () => {
    expect(DETECTOR_TYPE_TO_DOMAIN.socket).to.equal('switch');
    expect(DETECTOR_TYPE_TO_DOMAIN.light).to.equal('light');
    expect(DETECTOR_TYPE_TO_DOMAIN.dimmer).to.equal('light');
    expect(DETECTOR_TYPE_TO_DOMAIN.rgb).to.equal('light');
    expect(DETECTOR_TYPE_TO_DOMAIN.rgbSingle).to.equal('light');
    expect(DETECTOR_TYPE_TO_DOMAIN.rgbwSingle).to.equal('light');
    expect(DETECTOR_TYPE_TO_DOMAIN.hue).to.equal('light');
    expect(DETECTOR_TYPE_TO_DOMAIN.ct).to.equal('light');
    expect(DETECTOR_TYPE_TO_DOMAIN.cie).to.equal('light');
    expect(DETECTOR_TYPE_TO_DOMAIN.temperature).to.equal('sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.humidity).to.equal('sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.illuminance).to.equal('sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.pressure).to.equal('sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.info).to.equal('sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.window).to.equal('binary_sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.windowTilt).to.equal('binary_sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.door).to.equal('binary_sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.contact).to.equal('binary_sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.motion).to.equal('binary_sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.fireAlarm).to.equal('binary_sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.floodAlarm).to.equal('binary_sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.coAlarm).to.equal('binary_sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.warning).to.equal('binary_sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.button).to.equal('scene');
  });

  it('does not map enum members that do not exist in type-detector 6.x', () => {
    expect(DETECTOR_TYPE_TO_DOMAIN.flood).to.equal(undefined);
    expect(DETECTOR_TYPE_TO_DOMAIN.occupancy).to.equal(undefined);
    expect(DETECTOR_TYPE_TO_DOMAIN.switch).to.equal(undefined);
    expect(DETECTOR_TYPE_TO_DOMAIN.brightness).to.equal(undefined);
  });

  it('does not map buttonSensor to any domain: PRESS and PRESS_LONG are both read-only', () => {
    // Verified against node_modules/@iobroker/type-detector/build/typePatterns.js:
    // buttonSensor's states are PRESS (read:true, write:false) and the optional
    // PRESS_LONG (read:true, write:false) — no writable channel exists. Mapping
    // it to scene would create a tile whose press writes nothing while the
    // dispatcher's own success/failure result cannot save it, because the
    // device never had a `set` channel to begin with. `button`, whose SET is
    // write:true, is the writable sibling and stays mapped.
    expect(DETECTOR_TYPE_TO_DOMAIN.buttonSensor).to.equal(undefined);
  });

  it('returns null for a detector type this adapter does not map, rather than guessing', () => {
    // 'occupancy' is not a real type-detector 6.x member either (see the test
    // above); the point is that mapControlToDevice bails out on the type
    // alone, before ever looking at whether states carries a usable channel.
    const control: DetectedControl = { type: 'occupancy', states: [{ id: 'x.0.set', name: 'SET', write: true }] };
    expect(mapControlToDevice('x.0', control, META)).to.equal(null);
  });

  it('lowercases channel names and carries the ioBroker metadata across', () => {
    const control: DetectedControl = {
      type: 'dimmer',
      states: [
        { id: 'hue.0.decke.on', name: 'ON_SET', write: true },
        { id: 'hue.0.decke.level', name: 'SET', write: true },
      ],
    };
    const device = mapControlToDevice('hue.0.decke', control, META);
    expect(device).to.not.equal(null);
    expect(device!.domain).to.equal('light');
    expect(device!.detectorType).to.equal('dimmer');
    expect(device!.channels.set!.objectId).to.equal('hue.0.decke.on');
    expect(device!.channels.dimmer!.objectId).to.equal('hue.0.decke.level');
    expect(device!.channels.dimmer!.min).to.equal(0);
    expect(device!.channels.dimmer!.max).to.equal(100);
  });

  it('renames a dimmer SET channel to dimmer and its ON_SET to set', () => {
    const control: DetectedControl = {
      type: 'dimmer',
      states: [
        { id: 'hue.0.decke.level', name: 'SET', write: true },
        { id: 'hue.0.decke.on', name: 'ON_ACTUAL' },
      ],
    };
    const device = mapControlToDevice('hue.0.decke', control, META);
    expect(Object.keys(device!.channels).sort()).to.deep.equal(['actual', 'dimmer']);
  });

  it('maps the bare ON channel of a colour or CT bulb onto set', () => {
    // hue, ct, cie, rgb, rgbSingle and rgbwSingle all carry power on ON(w),
    // not ON_SET. Without this the device has no writable power channel and a
    // tile press silently writes nothing while reporting success.
    for (const type of ['hue', 'ct', 'cie', 'rgb', 'rgbSingle', 'rgbwSingle']) {
      const control: DetectedControl = {
        type,
        states: [
          { id: 'hue.0.decke.on', name: 'ON', write: true },
          { id: 'hue.0.decke.on_actual', name: 'ON_ACTUAL' },
          { id: 'hue.0.decke.level', name: 'DIMMER', write: true },
        ],
      };
      const device = mapControlToDevice('hue.0.decke', control, META);
      expect(device, `${type} must map`).to.not.equal(null);
      expect(device!.channels.set?.objectId, `${type} needs a set channel`).to.equal('hue.0.decke.on');
      expect(device!.channels.actual?.objectId, `${type} actual`).to.equal('hue.0.decke.on_actual');
      expect(device!.channels.dimmer?.objectId, `${type} dimmer`).to.equal('hue.0.decke.level');
    }
  });

  it('keeps a dimmer SET as the level while ON_SET remains power', () => {
    const control: DetectedControl = {
      type: 'dimmer',
      states: [
        { id: 'hue.0.decke.level', name: 'SET', write: true },
        { id: 'hue.0.decke.on', name: 'ON_SET', write: true },
      ],
    };
    const device = mapControlToDevice('hue.0.decke', control, META);
    expect(device!.channels.dimmer!.objectId).to.equal('hue.0.decke.level');
    expect(device!.channels.set!.objectId).to.equal('hue.0.decke.on');
  });

  it('keeps a plain switch SET channel as set', () => {
    const control: DetectedControl = {
      type: 'socket',
      states: [{ id: 'shelly.0.plug.on', name: 'SET', write: true }],
    };
    const device = mapControlToDevice('shelly.0.plug', control, META);
    expect(device!.domain).to.equal('switch');
    expect(device!.channels.set!.objectId).to.equal('shelly.0.plug.on');
    expect(device!.name).to.equal('Kaffeemaschine');
  });

  it('drops indicator channels the panel has no use for', () => {
    const control: DetectedControl = {
      type: 'socket',
      states: [
        { id: 'shelly.0.plug.on', name: 'SET', write: true },
        { id: 'shelly.0.plug.unreach', name: 'UNREACH' },
        { id: 'shelly.0.plug.lowbat', name: 'LOWBAT' },
      ],
    };
    const device = mapControlToDevice('shelly.0.plug', control, META);
    expect(Object.keys(device!.channels)).to.deep.equal(['set']);
  });

  it('drops telemetry and effect channels from a power-metering bulb', () => {
    const control: DetectedControl = {
      type: 'ct',
      states: [
        { id: 'zig.0.b.on', name: 'ON', write: true },
        { id: 'zig.0.b.on_actual', name: 'ON_ACTUAL' },
        { id: 'zig.0.b.level', name: 'DIMMER', write: true },
        { id: 'zig.0.b.ct', name: 'TEMPERATURE', write: true },
        { id: 'zig.0.b.power', name: 'ELECTRIC_POWER' },
        { id: 'zig.0.b.voltage', name: 'VOLTAGE' },
        { id: 'zig.0.b.rssi', name: 'RSSI' },
        { id: 'zig.0.b.battery', name: 'BATTERY' },
        { id: 'zig.0.b.effect', name: 'EFFECT', write: true },
      ],
    };
    const device = mapControlToDevice('zig.0.b', control, {});
    expect(Object.keys(device!.channels).sort()).to.deep.equal([
      'actual',
      'dimmer',
      'set',
      'temperature',
    ]);
  });

  it('returns null when the control has no usable channel left after filtering', () => {
    const control: DetectedControl = { type: 'socket', states: [{ id: 'shelly.0.plug.unreach', name: 'UNREACH' }] };
    expect(mapControlToDevice('shelly.0.plug', control, META)).to.equal(null);
  });

  it('maps thermostat and airCondition to the climate domain', () => {
    expect(DETECTOR_TYPE_TO_DOMAIN.thermostat).to.equal('climate');
    expect(DETECTOR_TYPE_TO_DOMAIN.airCondition).to.equal('climate');
  });

  it("resolves airCondition's duplicate SWING channels by role, not by name", () => {
    // Verified directly against node_modules/@iobroker/type-detector/build/
    // typePatterns.js: airCondition's states array carries FanPatterns.swing
    // (defaultRole 'level.mode.swing', a numeric multi-position control) and
    // FanPatterns.swingBoolean (defaultRole 'switch.mode.swing', a plain
    // on/off toggle) back to back - two distinct state definitions that both
    // carry name SWING. Keying the channel map on name alone (as channelName
    // already does for every other channel) would let the second SWING
    // silently overwrite the first.
    const control: DetectedControl = {
      type: 'airCondition',
      states: [
        { id: 'ac.0.mode', name: 'MODE', write: true },
        { id: 'ac.0.swing_level', name: 'SWING', write: true, defaultRole: 'level.mode.swing' },
        { id: 'ac.0.swing_switch', name: 'SWING', write: true, defaultRole: 'switch.mode.swing' },
      ],
    };
    const device = mapControlToDevice('ac.0', control, {});
    expect(device).to.not.equal(null);
    expect(device!.channels.swing?.objectId).to.equal('ac.0.swing_level');
    expect(device!.channels.swing_toggle?.objectId).to.equal('ac.0.swing_switch');
  });

  it('falls back to the last object id segment when no name is known', () => {
    const control: DetectedControl = { type: 'temperature', states: [{ id: 'zigbee.0.unknown.value', name: 'ACTUAL' }] };
    const device = mapControlToDevice('zigbee.0.unknown', control, {});
    expect(device!.name).to.equal('unknown');
  });
});
