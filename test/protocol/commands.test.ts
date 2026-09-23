import { expect } from 'chai';
import {
  CommandError,
  parseClimateCommand,
  parseCommand,
  parseCoverCommand,
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

  // Round 2: this test pinned the clamp -- [999,-4,90] became [255,0,90] and
  // 90000 K became 15000, each written with ok:true. rgb components are still
  // refused, never clamped: the firmware sends uint8 components.
  //
  // Round 3 (Ruling 59) reverses the colour-temperature half: round 2 refused
  // 999 and 90000 K here, and with a mired bulb published as kelvin the
  // panel's own CT (370) fell outside that window and took "on" down with it.
  // A colour temperature never stops a light switching on: any positive
  // number passes, rounded, and the light's own range decides at dispatch; a
  // value that is no temperature at all is skipped, with its reason carried
  // to the dispatcher to log.
  it('refuses rgb components outside 0..255, and never refuses a light command for its colour temperature', () => {
    for (const rgb of [[999, 0, 90], [0, -4, 90], [0, 0, 256]]) {
      expect(() => parseLightCommand(JSON.stringify({ entity_id: 'light.d', rgb_color: rgb })), JSON.stringify(rgb)).to.throw(
        CommandError,
        'invalid_rgb',
      );
    }
    for (const kelvin of [90000, 15001, 999, 370.4]) {
      const call = parseLightCommand(JSON.stringify({ entity_id: 'light.d', state: 'on', color_temp_kelvin: kelvin }));
      expect((call as { kelvin?: number }).kelvin, String(kelvin)).to.equal(Math.round(kelvin));
    }
    for (const kelvin of ['warm', 0, -5, null]) {
      const call = parseLightCommand(JSON.stringify({ entity_id: 'light.d', state: 'on', brightness_pct: 40, color_temp_kelvin: kelvin }));
      expect(call, String(kelvin)).to.deep.include({ kind: 'set_light', state: 'on', brightnessPct: 40 });
      expect(call, String(kelvin)).to.not.have.property('kelvin');
      expect((call as { skippedKelvin?: string }).skippedKelvin, String(kelvin)).to.be.a('string');
    }
    expect(parseLightCommand('{"entity_id":"light.d","rgb_color":[255,0,89.6],"color_temp_kelvin":15000}')).to.deep.equal({
      kind: 'set_light',
      entityId: 'light.d',
      rgb: [255, 0, 90],
      kelvin: 15000,
    });
  });

  it('refuses a brightness outside 0..100 rather than clamping it (Task 8 round 1, M1b)', () => {
    // The firmware never sends one (mqttPublishLightCommand caps at 100);
    // clamping another client's 500 wrote 100 with ok:true.
    for (const pct of [500, 101, -1]) {
      expect(() => parseLightCommand(JSON.stringify({ entity_id: 'light.d', brightness_pct: pct })), String(pct)).to.throw(
        CommandError,
        'invalid_brightness',
      );
    }
    expect((parseLightCommand('{"entity_id":"light.d","brightness_pct":99.6}') as { brightnessPct: number }).brightnessPct).to.equal(100);
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

  // Cover: one topic, a "command" field, and the firmware's fixed ten-string
  // allow-list (mqttPublishCoverCommand, mqtt_handlers.cpp:2268-2271).
  describe('cover', () => {
    const cover = (fields: Record<string, unknown>): string => JSON.stringify({ entity_id: 'cover.blind', ...fields });

    it('parses seven of the eight payload-free commands to a kind of the same name', () => {
      for (const command of [
        'open_cover',
        'close_cover',
        'stop_cover',
        'open_cover_tilt',
        'close_cover_tilt',
        'stop_cover_tilt',
        'toggle_cover_tilt',
      ]) {
        expect(parseCoverCommand(cover({ command })), command).to.deep.equal({ kind: command, entityId: 'cover.blind' });
      }
    });

    it("parses the firmware's plain 'toggle' as toggle_cover, distinct from switch/light's toggle", () => {
      // Same string as the switch domain's toggle, different meaning: a cover
      // toggles by its open/closed state. A distinct kind keeps cmnd/cover
      // from ever reaching a switch or light (ALLOWED_CALLS).
      expect(parseCoverCommand(cover({ command: 'toggle' }))).to.deep.equal({ kind: 'toggle_cover', entityId: 'cover.blind' });
    });

    it('parses set_cover_position from "position" and set_cover_tilt_position from "tilt_position"', () => {
      expect(parseCoverCommand(cover({ command: 'set_cover_position', position: 40 }))).to.deep.equal({
        kind: 'set_cover_position',
        entityId: 'cover.blind',
        value: 40,
      });
      expect(parseCoverCommand(cover({ command: 'set_cover_tilt_position', tilt_position: 75 }))).to.deep.equal({
        kind: 'set_cover_tilt_position',
        entityId: 'cover.blind',
        value: 75,
      });
    });

    it('keeps a legitimate zero, rounds to the whole percent the firmware sends, and refuses one outside 0..100', () => {
      // mqtt_handlers.cpp:2290-2291 clamps before formatting an integer, so
      // the panel never sends one outside 0..100. Task 8 round 1 (M1b):
      // another client's -5 or 150 is refused, no longer clamped to 0 or 100.
      const position = (value: unknown): unknown =>
        (parseCoverCommand(cover({ command: 'set_cover_position', position: value })) as { value: number }).value;
      expect(position(0)).to.equal(0);
      expect(position(100)).to.equal(100);
      expect(position(33.6)).to.equal(34);
      for (const value of [-5, 150, 100.6]) {
        expect(() => position(value), String(value)).to.throw(CommandError, 'invalid_position');
        expect(() => parseCoverCommand(cover({ command: 'set_cover_tilt_position', tilt_position: value })), String(value)).to.throw(
          CommandError,
          'invalid_tilt_position',
        );
      }
    });

    it('rejects a missing, blank or non-numeric position rather than writing zero', () => {
      for (const value of [undefined, '', '50', null, 'abc', Number.NaN]) {
        expect(() => parseCoverCommand(cover({ command: 'set_cover_position', position: value })), String(value)).to.throw(
          CommandError,
          'invalid_position',
        );
        expect(() => parseCoverCommand(cover({ command: 'set_cover_tilt_position', tilt_position: value })), String(value)).to.throw(
          CommandError,
          'invalid_tilt_position',
        );
      }
      // Each command reads only its own key.
      expect(() => parseCoverCommand(cover({ command: 'set_cover_tilt_position', position: 50 }))).to.throw(CommandError);
    });

    it('rejects a command outside the allow-list, including case variants', () => {
      for (const command of ['bogus', 'OPEN_COVER', 'set_temperature', 'turn_on', '', 7]) {
        expect(() => parseCoverCommand(cover({ command })), String(command)).to.throw(CommandError, 'unsupported_cover_command');
      }
      expect(() => parseCoverCommand(cover({}))).to.throw(CommandError, 'unsupported_cover_command');
    });

    it('rejects a payload with no valid entity_id', () => {
      expect(() => parseCoverCommand('{"command":"open_cover"}')).to.throw(CommandError, 'missing_entity_id');
      expect(() => parseCoverCommand('{"entity_id":"blind","command":"open_cover"}')).to.throw(CommandError, 'invalid_entity_id');
    });

    it('dispatches the cover leaf through parseCommand', () => {
      expect(parseCommand('cover', cover({ command: 'stop_cover' })).kind).to.equal('stop_cover');
    });
  });
});
