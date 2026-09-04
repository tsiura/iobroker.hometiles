import { expect } from 'chai';
import { CommandError, parseCommand, parseLightCommand, parseSceneCommand, parseSwitchCommand } from '../../src/protocol/commands';

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

  it('dispatches by topic leaf', () => {
    expect(parseCommand('scene', 'Nacht').kind).to.equal('activate_scene');
    expect(parseCommand('light', '{"entity_id":"light.d","state":"off"}').kind).to.equal('turn_off');
    expect(parseCommand('switch', '{"entity_id":"switch.d","state":"on"}').kind).to.equal('turn_on');
  });
});
