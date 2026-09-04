import { expect } from 'chai';
import { synthLight } from '../../../src/registry/synth/light';
import { synthScene } from '../../../src/registry/synth/scene';
import { synthesise } from '../../../src/registry/synth/index';
import type { DeviceInput, SourceValue } from '../../../src/registry/types';

const NOW = 1_757_000_000_000;
const value = (val: unknown, q = 0): SourceValue => ({ val, ack: true, q, ts: NOW });

const onOff: DeviceInput = {
  objectId: 'hue.0.decke',
  name: 'Decke',
  detectorType: 'light',
  domain: 'light',
  channels: { set: { objectId: 'hue.0.decke.on', type: 'boolean', write: true } },
};

const dimmer: DeviceInput = {
  objectId: 'hue.0.dim',
  name: 'Esstisch',
  detectorType: 'dimmer',
  domain: 'light',
  channels: {
    set: { objectId: 'hue.0.dim.on', type: 'boolean', write: true },
    dimmer: { objectId: 'hue.0.dim.level', type: 'number', min: 0, max: 100, write: true },
  },
};

const rgbct: DeviceInput = {
  objectId: 'hue.0.rgb',
  name: 'Sofa',
  detectorType: 'rgb',
  domain: 'light',
  channels: {
    set: { objectId: 'hue.0.rgb.on', type: 'boolean', write: true },
    dimmer: { objectId: 'hue.0.rgb.level', type: 'number', min: 0, max: 100, write: true },
    red: { objectId: 'hue.0.rgb.r', type: 'number', min: 0, max: 255, write: true },
    green: { objectId: 'hue.0.rgb.g', type: 'number', min: 0, max: 255, write: true },
    blue: { objectId: 'hue.0.rgb.b', type: 'number', min: 0, max: 255, write: true },
    temperature: { objectId: 'hue.0.rgb.ct', type: 'number', min: 2000, max: 6500, write: true },
  },
};

describe('registry/synth light and scene', () => {
  it('advertises only onoff for a light with no dimmer channel', () => {
    const e = synthLight(onOff, 'light.decke', { 'hue.0.decke.on': value(true) });
    expect(e.state).to.equal('on');
    expect(e.attributes.supported_color_modes).to.deep.equal(['onoff']);
    expect(e.attributes.brightness).to.equal(undefined);
  });

  it('never advertises colour for a dimmer that has no colour channel', () => {
    const e = synthLight(dimmer, 'light.esstisch', {
      'hue.0.dim.on': value(true),
      'hue.0.dim.level': value(60),
    });
    expect(e.attributes.supported_color_modes).to.deep.equal(['brightness']);
    expect(e.attributes.color_mode).to.equal('brightness');
  });

  it('scales an ioBroker 0..100 dimmer onto the Home Assistant 0..255 range', () => {
    const e = synthLight(dimmer, 'light.esstisch', {
      'hue.0.dim.on': value(true),
      'hue.0.dim.level': value(100),
    });
    expect(e.attributes.brightness).to.equal(255);
    const half = synthLight(dimmer, 'light.esstisch', {
      'hue.0.dim.on': value(true),
      'hue.0.dim.level': value(50),
    });
    expect(half.attributes.brightness).to.equal(128);
  });

  it('treats a dimmer at zero as off without inventing an unavailable state', () => {
    const e = synthLight(dimmer, 'light.esstisch', {
      'hue.0.dim.on': value(false),
      'hue.0.dim.level': value(0),
    });
    expect(e.state).to.equal('off');
    expect(e.available).to.equal(true);
  });

  it('derives on from a non-zero dimmer when the device has no dedicated on channel', () => {
    const dimmerOnly: DeviceInput = {
      ...dimmer,
      channels: { dimmer: { objectId: 'hue.0.dim.level', type: 'number', min: 0, max: 100, write: true } },
    };
    const e = synthLight(dimmerOnly, 'light.esstisch', { 'hue.0.dim.level': value(30) });
    expect(e.state).to.equal('on');
    expect(e.attributes.brightness).to.equal(77);
  });

  it('reads the level from BRIGHTNESS when the device has no DIMMER channel', () => {
    // hue, ct, cie, rgb, rgbSingle and rgbwSingle carry their level on DIMMER
    // *or* BRIGHTNESS depending on which detector pattern matched.
    const brightnessOnly: DeviceInput = {
      objectId: 'zig.0.ct',
      name: 'Decke CT',
      detectorType: 'ct',
      domain: 'light',
      channels: {
        set: { objectId: 'zig.0.ct.on', type: 'boolean', write: true },
        brightness: { objectId: 'zig.0.ct.level', type: 'number', min: 0, max: 100, write: true },
      },
    };
    const e = synthLight(brightnessOnly, 'light.ct', {
      'zig.0.ct.on': value(true),
      'zig.0.ct.level': value(60),
    });
    expect(e.attributes.brightness).to.equal(153);
    expect(e.attributes.brightness_pct).to.equal(60);
    expect(e.attributes.supported_color_modes).to.deep.equal(['brightness']);
  });

  it('reports rgb and colour temperature modes when both channel groups exist', () => {
    const e = synthLight(rgbct, 'light.sofa', {
      'hue.0.rgb.on': value(true),
      'hue.0.rgb.level': value(80),
      'hue.0.rgb.r': value(255),
      'hue.0.rgb.g': value(180),
      'hue.0.rgb.b': value(90),
      'hue.0.rgb.ct': value(3000),
    });
    expect(e.attributes.supported_color_modes).to.deep.equal(['color_temp', 'rgb']);
    expect(e.attributes.rgb_color).to.deep.equal([255, 180, 90]);
    expect(e.attributes.color_temp_kelvin).to.equal(3000);
    expect(e.attributes.min_color_temp_kelvin).to.equal(2000);
    expect(e.attributes.max_color_temp_kelvin).to.equal(6500);
  });

  it('does not advertise colour for a single-channel rgb device it cannot write', () => {
    // rgbSingle/rgbwSingle/cie carry colour on one combined channel that the
    // dispatcher has no encoder for. Offering the control would be a dead UI.
    const single: DeviceInput = {
      objectId: 'zigbee.0.strip',
      name: 'Strip',
      detectorType: 'rgbSingle',
      domain: 'light',
      channels: {
        set: { objectId: 'zigbee.0.strip.on', type: 'boolean', write: true },
        dimmer: { objectId: 'zigbee.0.strip.level', type: 'number', min: 0, max: 100, write: true },
        rgb: { objectId: 'zigbee.0.strip.rgb', type: 'string', write: true },
      },
    };
    const e = synthLight(single, 'light.strip', {
      'zigbee.0.strip.on': value(true),
      'zigbee.0.strip.level': value(40),
    });
    expect(e.attributes.supported_color_modes).to.deep.equal(['brightness']);
    expect(e.attributes.rgb_color).to.equal(undefined);
  });

  it('prefers an ACTUAL power channel over an unconfirmed SET, matching the switch synthesiser', () => {
    // readChannel returns a non-null wrapper for a CONFIGURED channel even
    // when its value is null, so a naive `readChannel(set) ?? readChannel(actual)`
    // never falls through and this would previously render unavailable.
    const withActual: DeviceInput = {
      ...onOff,
      channels: {
        set: { objectId: 'hue.0.decke.on', type: 'boolean', write: true },
        actual: { objectId: 'hue.0.decke.on_actual', type: 'boolean' },
      },
    };
    const e = synthLight(withActual, 'light.decke', {
      'hue.0.decke.on': value(null),
      'hue.0.decke.on_actual': value(true),
    });
    expect(e.available).to.equal(true);
    expect(e.state).to.equal('on');
  });

  it('marks a light unavailable rather than off when every channel is missing', () => {
    const e = synthLight(dimmer, 'light.esstisch', {});
    expect(e.state).to.equal('unavailable');
    expect(e.available).to.equal(false);
  });

  it('omits brightness rather than publishing zero when the dimmer value is unusable', () => {
    const e = synthLight(dimmer, 'light.esstisch', {
      'hue.0.dim.on': value(true),
      'hue.0.dim.level': value(null),
    });
    expect(e.state).to.equal('on');
    expect(e.attributes.brightness).to.equal(undefined);
  });

  it('omits brightness for a blank dimmer reading instead of reporting zero percent', () => {
    // Number('') is 0, so a naive coercion would render a lamp at 0% rather
    // than admitting the level is unknown.
    const e = synthLight(dimmer, 'light.esstisch', {
      'hue.0.dim.on': value(true),
      'hue.0.dim.level': value('   '),
    });
    expect(e.state).to.equal('on');
    expect(e.attributes.brightness).to.equal(undefined);
    expect(e.attributes.brightness_pct).to.equal(undefined);
  });

  it('renders a scene as a stateless entity that is always available', () => {
    const scene: DeviceInput = {
      objectId: 'scene.0.gute_nacht',
      name: 'Gute Nacht',
      detectorType: 'button',
      domain: 'scene',
      channels: { set: { objectId: 'scene.0.gute_nacht', type: 'boolean', write: true } },
    };
    const e = synthScene(scene, 'scene.gute_nacht', {});
    expect(e.state).to.equal('unknown');
    expect(e.available).to.equal(true);
    expect(e.attributes.friendly_name).to.equal('Gute Nacht');
  });

  it('dispatches to the right synthesiser by domain', () => {
    expect(synthesise(onOff, 'light.decke', { 'hue.0.decke.on': value(true) }).domain).to.equal('light');
    expect(synthesise({ ...onOff, domain: 'switch' }, 'switch.decke', { 'hue.0.decke.on': value(true) }).domain).to.equal('switch');
  });
});
