import { expect } from 'chai';
import {
  DETECTOR_TYPE_TO_DOMAIN,
  mapControlToDevice,
  validStates,
  type DetectedControl,
  type ObjectMeta,
} from '../../src/registry/detector';
import { synthClimate } from '../../src/registry/synth/climate';
import { encodeChannelValue } from '../../src/registry/synth/common';

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

  it('maps blind, blindButtons and gate to the cover domain', () => {
    // The pattern is keyed 'blinds' but its Types value -- what
    // DetectedControl.type actually carries at runtime -- is 'blind'
    // (docs/contract-iobroker-types.md's "pattern keys are not Types
    // values" trap; verified directly against node_modules/@iobroker/
    // type-detector/build/types.js: Types["blind"] = "blind", and there is
    // no Types["blinds"] at all). blindButtons and gate already agree with
    // their own pattern keys.
    expect(DETECTOR_TYPE_TO_DOMAIN.blind).to.equal('cover');
    expect(DETECTOR_TYPE_TO_DOMAIN.blindButtons).to.equal('cover');
    expect(DETECTOR_TYPE_TO_DOMAIN.gate).to.equal('cover');
    // The plural pattern key must NOT be used as a map key, or every real
    // blind silently fails to detect: mapControlToDevice sees `domain` come
    // back undefined and returns null, with no error anywhere (the exact
    // "silent 'no such pattern'" trap the contract doc warns about).
    expect(DETECTOR_TYPE_TO_DOMAIN.blinds).to.equal(undefined);
  });

  it('maps a real blind control (Types value "blind") to the cover domain end to end', () => {
    const control: DetectedControl = {
      type: 'blind',
      states: [
        { id: 'shelly.0.blind.level', name: 'SET', write: true },
        { id: 'shelly.0.blind.direction', name: 'DIRECTION' },
      ],
    };
    const device = mapControlToDevice('shelly.0.blind', control, {});
    expect(device).to.not.equal(null);
    expect(device!.domain).to.equal('cover');
    expect(device!.channels.set!.objectId).to.equal('shelly.0.blind.level');
  });

  it('drops DIRECTION and DIRECTION_ENUM from a detected blind: no cover role reads either', () => {
    // Both are optional on blind/blindButtons/gate (typePatterns.js:
    // SharedPatterns.direction, SharedPatterns.direction_enum, always
    // listed as a pair) and neither has an HA Cover attribute behind it --
    // keeping either would only add a foreign-state subscription and an
    // entity recompute on every direction change, the exact churn
    // IGNORED_CHANNELS exists to stop.
    const control: DetectedControl = {
      type: 'blind',
      states: [
        { id: 'shelly.0.blind.level', name: 'SET', write: true },
        { id: 'shelly.0.blind.direction', name: 'DIRECTION' },
        { id: 'shelly.0.blind.direction_enum', name: 'DIRECTION_ENUM' },
      ],
    };
    const device = mapControlToDevice('shelly.0.blind', control, {});
    expect(Object.keys(device!.channels)).to.deep.equal(['set']);
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

  it('resolves the duplicate SWING channels by role regardless of which one arrives first', () => {
    // The test above happens to use the same ordering typePatterns.js does
    // (numeric level.mode.swing, then boolean switch.mode.swing). That alone
    // cannot catch a regression to position-based dispatch (first SWING wins
    // `swing`, second wins `swing_toggle`, defaultRole ignored) — a fixture
    // with the order reversed is required to prove it is genuinely
    // role-keyed, not order-keyed.
    const control: DetectedControl = {
      type: 'airCondition',
      states: [
        { id: 'ac.0.mode', name: 'MODE', write: true },
        { id: 'ac.0.swing_switch', name: 'SWING', write: true, defaultRole: 'switch.mode.swing' },
        { id: 'ac.0.swing_level', name: 'SWING', write: true, defaultRole: 'level.mode.swing' },
      ],
    };
    const device = mapControlToDevice('ac.0', control, {});
    expect(device).to.not.equal(null);
    expect(device!.channels.swing?.objectId).to.equal('ac.0.swing_level');
    expect(device!.channels.swing_toggle?.objectId).to.equal('ac.0.swing_switch');
  });

  it("drops a thermostat's VALVE, WINDOW and PARTY channels: no v0.2 role reads them", () => {
    // VALVE is a live analog percentage on a real device — exactly the
    // ELECTRIC_POWER-style recompute churn IGNORED_CHANNELS exists to stop
    // (see the mechanism-level regression test in entity-registry.test.ts).
    const control: DetectedControl = {
      type: 'thermostat',
      states: [
        { id: 'thermo.0.actual', name: 'ACTUAL' },
        { id: 'thermo.0.valve', name: 'VALVE' },
        { id: 'thermo.0.window', name: 'WINDOW' },
        { id: 'thermo.0.party', name: 'PARTY', write: true },
      ],
    };
    const device = mapControlToDevice('thermo.0', control, {});
    expect(Object.keys(device!.channels)).to.deep.equal(['actual']);
  });

  it('falls back to the last object id segment when no name is known', () => {
    const control: DetectedControl = { type: 'temperature', states: [{ id: 'zigbee.0.unknown.value', name: 'ACTUAL' }] };
    const device = mapControlToDevice('zigbee.0.unknown', control, {});
    expect(device!.name).to.equal('unknown');
  });
});

describe('registry/detector: validStates', () => {
  // Fix-round 3, finding 3: main.ts's detectDevices used to cast
  // common.states without validation. A non-object, or an object with a
  // non-string label, must never reach ChannelInput.states, where
  // encodeChannelValue's states-map reversal calls .toLowerCase() on every
  // label -- an unvalidated bad shape threw a TypeError several layers away,
  // in panel-session's generic command catch, logged as an opaque
  // "candidate.toLowerCase is not a function".
  it('passes a well-formed states map through unchanged', () => {
    expect(validStates({ '1': 'heat', '3': 'cool' })).to.deep.equal({ '1': 'heat', '3': 'cool' });
  });

  it('drops a non-string label instead of letting it through', () => {
    expect(validStates({ '1': 'heat', '2': 5 })).to.deep.equal({ '1': 'heat' });
  });

  it('returns undefined for a states map that is entirely non-string labels', () => {
    expect(validStates({ '1': 5, '2': true })).to.equal(undefined);
  });

  it('returns undefined for undefined, null, or a non-string primitive', () => {
    expect(validStates(undefined)).to.equal(undefined);
    expect(validStates(null)).to.equal(undefined);
    expect(validStates(42)).to.equal(undefined);
  });

  it('returns undefined for an empty object, matching "no states configured"', () => {
    expect(validStates({})).to.equal(undefined);
  });

  // Fix-round 4 (Ruling 30): ioBroker documents THREE forms of common.states
  // (@iobroker/types objects.d.ts) -- an object, an array and a deprecated
  // "val1:text1;val2:text2" string. Round 3 accepted only the object, so an
  // array-form device silently lost its mode labels and its control.
  describe('the array form', () => {
    it('reads the index as the internal value on a number state', () => {
      expect(validStates(['OFF', 'HEAT', 'COOL'], 'number')).to.deep.equal({ '0': 'OFF', '1': 'HEAT', '2': 'COOL' });
    });

    it('drops a non-string element individually, without shifting the indexes after it', () => {
      expect(validStates(['OFF', 5, 'COOL', null], 'number')).to.deep.equal({ '0': 'OFF', '2': 'COOL' });
    });

    // ioBroker's objects schema: a string state's array lists the allowed
    // VALUES, ['Start', 'Flight'] "is the same as {'Start': 'Start',
    // 'Flight': 'Flight'}". Read by index, "heat" would reverse to "1".
    it('reads each element as its own internal value on a string state', () => {
      expect(validStates(['auto', 7, 'heat'], 'string')).to.deep.equal({ auto: 'auto', heat: 'heat' });
    });

    it('reads [false label, true label] on a boolean state', () => {
      expect(validStates(['Closed', 'Open'], 'boolean')).to.deep.equal({ false: 'Closed', true: 'Open' });
    });

    it('returns undefined when the state type defines no reading, rather than guessing one', () => {
      expect(validStates(['OFF', 'ON'])).to.equal(undefined);
      expect(validStates(['OFF', 'ON'], 'mixed')).to.equal(undefined);
    });
  });

  describe('the deprecated "val1:text1;val2:text2" string form', () => {
    it('parses every part into a map', () => {
      expect(validStates('0:OFF;1:HEAT;2:COOL')).to.deep.equal({ '0': 'OFF', '1': 'HEAT', '2': 'COOL' });
    });

    it('splits each part on its FIRST colon only, so a colon inside a label survives', () => {
      expect(validStates('1:Heat: Eco;2:Cool')).to.deep.equal({ '1': 'Heat: Eco', '2': 'Cool' });
    });

    it('drops a malformed part individually without losing the good ones', () => {
      expect(validStates('0:OFF;garbage;;2:COOL;')).to.deep.equal({ '0': 'OFF', '2': 'COOL' });
    });

    it('trims the whitespace around each value and label', () => {
      expect(validStates(' 0 : Off; 1:On ')).to.deep.equal({ '0': 'Off', '1': 'On' });
    });

    it('returns undefined when no part is well-formed', () => {
      expect(validStates('heat')).to.equal(undefined);
      expect(validStates('')).to.equal(undefined);
    });

    it('does not split a JSON-encoded string into a garbage value and label', () => {
      expect(validStates('{"0":"Off","1":"On"}')).to.equal(undefined);
    });
  });

  // The exact chain main.ts's detectDevices feeds: validStates builds
  // ObjectMeta.states from common.states/common.type, mapControlToDevice
  // copies it into ChannelInput.states, synthClimate decodes MODE through it
  // (the real readEnum), and the decoded label goes back through
  // encodeChannelValue. No step is hand-built.
  describe('round-trips through the real detector, synth and encoder', () => {
    function decodeMode(states: unknown, type: 'number' | 'string', raw: number | string) {
      const control: DetectedControl = { type: 'airCondition', states: [{ id: 'ac.0.mode', name: 'MODE', write: true }] };
      const meta: Record<string, ObjectMeta> = {
        'ac.0.mode': { name: 'Mode', type, write: true, states: validStates(states, type) },
      };
      const device = mapControlToDevice('ac.0', control, meta);
      const entity = synthClimate(device!, 'climate.ac', { 'ac.0.mode': { val: raw, ack: true, q: 0, ts: 1 } });
      return { decoded: entity?.attributes.hvac_mode, codec: entity?.channelMeta?.mode };
    }

    it('array form on a Number MODE: raw 1 decodes to "HEAT" and encodes back to the number 1', () => {
      const { decoded, codec } = decodeMode(['OFF', 'HEAT', 'COOL'], 'number', 1);
      expect(decoded).to.equal('HEAT');
      const encoded = encodeChannelValue(codec, decoded as string);
      expect(encoded).to.equal(1);
      expect(typeof encoded).to.equal('number');
    });

    it('legacy form on a Number MODE: raw 1 decodes to "Heat: Eco" and encodes back to the number 1', () => {
      const { decoded, codec } = decodeMode('0:Off;1:Heat: Eco;2:Cool', 'number', 1);
      expect(decoded).to.equal('Heat: Eco');
      const encoded = encodeChannelValue(codec, decoded as string);
      expect(encoded).to.equal(1);
      expect(typeof encoded).to.equal('number');
    });

    it('array form on a String MODE: "HEAT" encodes back to "HEAT", never to its index "1"', () => {
      const { decoded, codec } = decodeMode(['AUTO', 'HEAT', 'COOL'], 'string', 'HEAT');
      expect(decoded).to.equal('HEAT');
      expect(encodeChannelValue(codec, decoded as string)).to.equal('HEAT');
      // The firmware trims and lowercases hvac_mode on ingest, so "heat" is
      // what a real panel sends back; the states map restores the exact case.
      expect(encodeChannelValue(codec, 'heat')).to.equal('HEAT');
    });
  });
});
