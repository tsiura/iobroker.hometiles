import { expect } from 'chai';
import {
  CommandError,
  parseClimateCommand,
  parseCommand,
  parseLightCommand,
  parseSceneCommand,
  parseSwitchCommand,
} from '../../src/protocol/commands';

describe('protocol/commands', () => {
  it('parses a plain on command from the switch topic', () => {
    expect(parseSwitchCommand('{"entity_id":"switch.k","state":"on"}')).to.deep.equal({
      kind: 'turn_on',
      entityId: 'switch.k',
    });
  });

  it('parses off and toggle', () => {
    expect(parseSwitchCommand('{"entity_id":"switch.k","state":"off"}').kind).to.equal('turn_off');
    expect(parseSwitchCommand('{"entity_id":"switch.k","state":"toggle"}').kind).to.equal('toggle');
  });

  it('treats a missing state as toggle, which is what the firmware sends', () => {
    expect(parseSwitchCommand('{"entity_id":"switch.k"}').kind).to.equal('toggle');
  });

  it('parses an on-off-only light command as a plain turn_on', () => {
    expect(parseLightCommand('{"entity_id":"light.d","state":"on"}')).to.deep.equal({
      kind: 'turn_on',
      entityId: 'light.d',
    });
  });

  it('parses a light command carrying brightness', () => {
    expect(parseLightCommand('{"entity_id":"light.d","state":"on","brightness_pct":42}')).to.deep.equal({
      kind: 'set_light',
      entityId: 'light.d',
      state: 'on',
      brightnessPct: 42,
    });
  });

  it('parses rgb_color and color_temp_kelvin', () => {
    const call = parseLightCommand('{"entity_id":"light.d","rgb_color":[255,180,90],"color_temp_kelvin":3000}');
    expect(call).to.deep.equal({
      kind: 'set_light',
      entityId: 'light.d',
      rgb: [255, 180, 90],
      kelvin: 3000,
    });
  });

  it('clamps brightness, rgb components and kelvin at the boundary', () => {
    const call = parseLightCommand('{"entity_id":"light.d","brightness_pct":500,"rgb_color":[999,-4,90],"color_temp_kelvin":90000}');
    expect(call).to.deep.equal({
      kind: 'set_light',
      entityId: 'light.d',
      brightnessPct: 100,
      rgb: [255, 0, 90],
      kelvin: 15000,
    });
  });

  it('rejects a non-numeric brightness rather than coercing it to zero', () => {
    expect(() => parseLightCommand('{"entity_id":"light.d","brightness_pct":"bright"}')).to.throw(CommandError);
  });

  it('rejects an rgb_color that is not three numbers', () => {
    expect(() => parseLightCommand('{"entity_id":"light.d","rgb_color":[255,180]}')).to.throw(CommandError);
  });

  it('rejects a payload with no entity_id', () => {
    expect(() => parseSwitchCommand('{"state":"on"}')).to.throw(CommandError);
  });

  it('rejects an entity id with no domain separator', () => {
    expect(() => parseSwitchCommand('{"entity_id":"kaffee","state":"on"}')).to.throw(CommandError);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseSwitchCommand('not json')).to.throw(CommandError);
  });

  it('parses a scene command as plain text, not JSON', () => {
    expect(parseSceneCommand('  Gute Nacht  ')).to.deep.equal({ kind: 'activate_scene', alias: 'gute nacht' });
  });

  it('rejects an empty scene payload', () => {
    expect(() => parseSceneCommand('   ')).to.throw(CommandError);
  });

  it('bounds the scene alias length so a hostile payload cannot allocate freely', () => {
    expect(() => parseSceneCommand('x'.repeat(300))).to.throw(CommandError);
  });

  it('rejects an absurdly long entity id rather than passing it downstream', () => {
    const huge = `switch.${'a'.repeat(300)}`;
    expect(() => parseSwitchCommand(JSON.stringify({ entity_id: huge, state: 'on' }))).to.throw(
      /entity_id_too_long/,
    );
  });

  it('throws rather than returning undefined for an unknown topic leaf', () => {
    // parseCommand is typed to return a ServiceCall. A caller reaching it with
    // a wider string must fail loudly, not receive undefined.
    expect(() => parseCommand('bogus' as 'light', '{}')).to.throw(CommandError);
  });

  it('preserves a legitimate zero on every numeric field', () => {
    // Swallowed zeros have been a recurring defect class in this project.
    expect(parseLightCommand('{"entity_id":"light.d","brightness_pct":0}')).to.deep.equal({
      kind: 'set_light',
      entityId: 'light.d',
      brightnessPct: 0,
    });
    expect(parseLightCommand('{"entity_id":"light.d","rgb_color":[0,0,0]}')).to.deep.equal({
      kind: 'set_light',
      entityId: 'light.d',
      rgb: [0, 0, 0],
    });
  });

  it('clamps kelvin at both boundaries without rejecting them', () => {
    expect((parseLightCommand('{"entity_id":"light.d","color_temp_kelvin":1000}') as { kelvin: number }).kelvin).to.equal(1000);
    expect((parseLightCommand('{"entity_id":"light.d","color_temp_kelvin":15000}') as { kelvin: number }).kelvin).to.equal(15000);
  });

  it('dispatches by topic leaf', () => {
    expect(parseCommand('scene', 'Nacht').kind).to.equal('activate_scene');
    expect(parseCommand('light', '{"entity_id":"light.d","state":"off"}').kind).to.equal('turn_off');
    expect(parseCommand('switch', '{"entity_id":"switch.d","state":"on"}').kind).to.equal('turn_on');
  });

  // Climate: all seven commands share one topic and are discriminated by a
  // "command" field inside the payload (docs/contract-climate-cover.md).
  it('parses a single-value set_temperature command', () => {
    expect(
      parseClimateCommand('{"entity_id":"climate.hall","command":"set_temperature","temperature":21.5}'),
    ).to.deep.equal({ kind: 'set_temperature', entityId: 'climate.hall', value: 21.5 });
  });

  it('parses a dual-setpoint set_temperature range', () => {
    expect(
      parseClimateCommand(
        '{"entity_id":"climate.hall","command":"set_temperature","target_temp_low":18,"target_temp_high":24}',
      ),
    ).to.deep.equal({ kind: 'set_temperature', entityId: 'climate.hall', low: 18, high: 24 });
  });

  it('rejects a temperature range missing one bound rather than guessing the other', () => {
    expect(() =>
      parseClimateCommand('{"entity_id":"climate.hall","command":"set_temperature","target_temp_low":18}'),
    ).to.throw(CommandError);
  });

  it('rejects a set_temperature command with no temperature field at all', () => {
    expect(() => parseClimateCommand('{"entity_id":"climate.hall","command":"set_temperature"}')).to.throw(
      CommandError,
    );
  });

  it('rejects a blank temperature rather than coercing it to zero', () => {
    // Number('') is 0 and finite -- exactly how this class of bug got in before.
    expect(() =>
      parseClimateCommand('{"entity_id":"climate.hall","command":"set_temperature","temperature":""}'),
    ).to.throw(CommandError);
  });

  it('preserves a legitimate zero target temperature', () => {
    expect(
      (
        parseClimateCommand('{"entity_id":"climate.hall","command":"set_temperature","temperature":0}') as {
          value: number;
        }
      ).value,
    ).to.equal(0);
  });

  it('parses set_humidity', () => {
    expect(
      parseClimateCommand('{"entity_id":"climate.hall","command":"set_humidity","humidity":55.5}'),
    ).to.deep.equal({ kind: 'set_humidity', entityId: 'climate.hall', value: 55.5 });
  });

  it('rejects a blank humidity rather than coercing it to zero', () => {
    expect(() =>
      parseClimateCommand('{"entity_id":"climate.hall","command":"set_humidity","humidity":""}'),
    ).to.throw(CommandError);
  });

  it('parses set_hvac_mode, trimmed and lowercased', () => {
    expect(
      parseClimateCommand('{"entity_id":"climate.hall","command":"set_hvac_mode","hvac_mode":" Heat "}'),
    ).to.deep.equal({ kind: 'set_hvac_mode', entityId: 'climate.hall', mode: 'heat' });
  });

  it('rejects an empty hvac_mode', () => {
    expect(() =>
      parseClimateCommand('{"entity_id":"climate.hall","command":"set_hvac_mode","hvac_mode":""}'),
    ).to.throw(CommandError);
  });

  it('parses set_fan_mode', () => {
    expect(parseClimateCommand('{"entity_id":"climate.ac","command":"set_fan_mode","fan_mode":"High"}')).to.deep.equal(
      { kind: 'set_fan_mode', entityId: 'climate.ac', mode: 'high' },
    );
  });

  it('parses set_preset_mode when the name is one of the firmware-recognised eight', () => {
    expect(
      parseClimateCommand('{"entity_id":"climate.hall","command":"set_preset_mode","preset_mode":"Eco"}'),
    ).to.deep.equal({ kind: 'set_preset_mode', entityId: 'climate.hall', mode: 'eco' });
  });

  it('rejects a preset_mode outside the firmware-recognised eight names', () => {
    // climate_preset_id (tile_renderer.cpp) only recognises 8 HA-core names;
    // anything else is silently discarded on the firmware side, so it must
    // never be forwarded as if it were accepted.
    expect(() =>
      parseClimateCommand('{"entity_id":"climate.hall","command":"set_preset_mode","preset_mode":"custom_mode"}'),
    ).to.throw(CommandError);
  });

  it('parses set_swing_mode', () => {
    expect(
      parseClimateCommand('{"entity_id":"climate.ac","command":"set_swing_mode","swing_mode":"vertical"}'),
    ).to.deep.equal({ kind: 'set_swing_mode', entityId: 'climate.ac', mode: 'vertical' });
  });

  it('parses set_swing_horizontal_mode as a boolean toggle', () => {
    expect(
      parseClimateCommand(
        '{"entity_id":"climate.ac","command":"set_swing_horizontal_mode","swing_horizontal_mode":"on"}',
      ),
    ).to.deep.equal({ kind: 'set_swing_horizontal_mode', entityId: 'climate.ac', on: true });
    expect(
      parseClimateCommand(
        '{"entity_id":"climate.ac","command":"set_swing_horizontal_mode","swing_horizontal_mode":"Off"}',
      ),
    ).to.deep.equal({ kind: 'set_swing_horizontal_mode', entityId: 'climate.ac', on: false });
  });

  it('rejects a swing_horizontal_mode value that is not on or off', () => {
    // The only ioBroker channel this role ever maps to (synth/climate.ts's
    // SWING_TOGGLE) is a boolean, so a value like "auto" has nowhere real to go.
    expect(() =>
      parseClimateCommand(
        '{"entity_id":"climate.ac","command":"set_swing_horizontal_mode","swing_horizontal_mode":"auto"}',
      ),
    ).to.throw(CommandError);
  });

  it('rejects a climate payload whose command field is not one of the seven known kinds', () => {
    expect(() => parseClimateCommand('{"entity_id":"climate.hall","command":"bogus"}')).to.throw(CommandError);
  });

  it('rejects a climate payload with no recognisable command', () => {
    // Brief's literal example is parseCommand('cmnd/climate', '{"bogus":1}'):
    // 'cmnd/climate' is not a real leaf value (the leaf param takes bare
    // domain words, see 'dispatches by topic leaf' above) -- this exercises
    // the same intent through the real parseCommand('climate', ...) API.
    expect(() => parseCommand('climate', '{"bogus":1}')).to.throw(CommandError);
  });

  it('dispatches the climate leaf through parseCommand', () => {
    expect(
      parseCommand('climate', '{"entity_id":"climate.hall","command":"set_hvac_mode","hvac_mode":"cool"}').kind,
    ).to.equal('set_hvac_mode');
  });
});
