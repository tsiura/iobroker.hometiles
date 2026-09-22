import { expect } from 'chai';
import { buildClimatePayload } from '../../src/protocol/climate';
import { synthClimate } from '../../src/registry/synth/climate';
import type { DeviceInput, VirtualEntity } from '../../src/registry/types';

function entity(over: Partial<VirtualEntity> = {}): VirtualEntity {
  return {
    entityId: 'climate.x',
    domain: 'climate',
    source: {},
    state: 'heat',
    attributes: {},
    available: true,
    lastChanged: 1_757_000_000_000,
    ...over,
  };
}

function entityWithOnly(attributes: Record<string, unknown>): VirtualEntity {
  return entity({ attributes });
}

function entityWithNoHvacMode(): VirtualEntity {
  return entity({ state: 'unknown', attributes: { current_temperature: 21 } });
}

function entityWithPreset(name: string): VirtualEntity {
  return entityWithOnly({ preset_mode: name });
}

describe('protocol/climate', () => {
  it('omits temperature, min_temp and max_temp when unknown, never fabricating the firmware defaults', () => {
    // Review round 1, C1: has_target_temperature (src/types/climate/state.h)
    // is only set when the firmware actually finds "temperature" in the
    // payload, and it gates a REAL, interactive, commandable UI slot
    // (renderer.cpp's slot_is_interactive) and the popup's single-vs-range
    // mode (climate_popup.cpp: has_range = has_target_range &&
    // !has_target_temperature). Fabricating 20.0/7.0/35.0 here would give a
    // read-only thermostat an interactive setpoint it never had, and would
    // permanently disable range mode for every dual-setpoint device.
    // Omission is how you tell the firmware "no such value".
    const p = JSON.parse(buildClimatePayload(entityWithOnly({ current_temperature: 21 })));
    expect(p).to.not.have.property('temperature');
    expect(p).to.not.have.property('min_temp');
    expect(p).to.not.have.property('max_temp');
  });

  it('uses the real temperature, min_temp and max_temp when known', () => {
    const p = JSON.parse(buildClimatePayload(entityWithOnly({ target_temperature: 22, min_temp: 10, max_temp: 30 })));
    // Wire key is "temperature", not "target_temperature":
    // docs/contract-climate-cover.md (citing tile_renderer.cpp:2233-2236) is
    // authoritative over the brief, which named the internal VirtualEntity
    // attribute instead of the wire key the firmware's scanner looks for.
    expect(p.temperature).to.equal(22);
    expect(p.min_temp).to.equal(10);
    expect(p.max_temp).to.equal(30);
  });

  it('treats a blank, non-finite or null value as unknown for every core numeric field, never zero or a fabricated default', () => {
    // Review round 1, M7. Covers null, a blank string, NaN and Infinity
    // across temperature/min_temp/max_temp/target_temp_low/target_temp_high
    // in one pass rather than one test per field x per bad-value shape.
    const p = JSON.parse(
      buildClimatePayload(
        entityWithOnly({
          target_temperature: '',
          min_temp: Number.NaN,
          max_temp: null,
          target_temp_low: '   ',
          target_temp_high: Number.POSITIVE_INFINITY,
        }),
      ),
    );
    expect(p).to.not.have.property('temperature');
    expect(p).to.not.have.property('min_temp');
    expect(p).to.not.have.property('max_temp');
    expect(p).to.not.have.property('target_temp_low');
    expect(p).to.not.have.property('target_temp_high');
  });

  it('never emits null for a string field', () => {
    const raw = buildClimatePayload(entityWithNoHvacMode());
    expect(raw).to.not.match(/"hvac_mode"\s*:\s*null/);
    expect(JSON.parse(raw)).to.not.have.property('hvac_mode');
  });

  it('never emits null for any recognised climate string field', () => {
    // Broader guard than the single hvac_mode case above: the same hand-
    // rolled scanner backs every one of these keys (docs/contract-climate-
    // cover.md, "null on a string field is actively dangerous").
    const raw = buildClimatePayload(entityWithOnly({}));
    for (const key of ['hvac_mode', 'hvac_action', 'fan_mode', 'swing_mode', 'swing_horizontal_mode', 'temperature_unit', 'preset_mode']) {
      expect(raw, key).to.not.match(new RegExp(`"${key}"\\s*:\\s*null`));
    }
  });

  it('treats an explicit null the same as absent for a climate string field', () => {
    const p = JSON.parse(buildClimatePayload(entityWithOnly({ hvac_mode: null, fan_mode: null, preset_mode: null })));
    expect(p).to.not.have.property('hvac_mode');
    expect(p).to.not.have.property('fan_mode');
    expect(p).to.not.have.property('preset_mode');
  });

  it('omits the dual setpoint entirely when only one side is known', () => {
    // Review round 1, I2: target_temp_low and target_temp_high share ONE
    // presence flag, so sending only one makes the firmware treat both as
    // fresh and silently revert the other to its default -- and that
    // fabricated default becomes a real, interactive, commandable range
    // bound the moment has_target_range is set. The fix is to never send
    // either side unless both are known, not to fill the gap with a default.
    const p = JSON.parse(buildClimatePayload(entityWithOnly({ target_temp_low: 18 })));
    expect(p).to.not.have.property('target_temp_low');
    expect(p).to.not.have.property('target_temp_high');
  });

  it('emits neither end of the dual setpoint when both are unknown', () => {
    const p = JSON.parse(buildClimatePayload(entityWithOnly({})));
    expect(p).to.not.have.property('target_temp_low');
    expect(p).to.not.have.property('target_temp_high');
  });

  it('passes through both ends of the dual setpoint verbatim when both are known', () => {
    const p = JSON.parse(buildClimatePayload(entityWithOnly({ target_temp_low: 19, target_temp_high: 26 })));
    expect(p.target_temp_low).to.equal(19);
    expect(p.target_temp_high).to.equal(26);
  });

  it('drops a custom preset rather than sending a name the firmware discards', () => {
    // Only 8 hardcoded HA-core preset names are recognised.
    const p = JSON.parse(buildClimatePayload(entityWithPreset('my_custom_mode')));
    expect(p.preset_mode).to.equal(undefined);
  });

  it('keeps a recognised preset name', () => {
    const p = JSON.parse(buildClimatePayload(entityWithPreset('eco')));
    expect(p.preset_mode).to.equal('eco');
  });

  it('matches preset names case-insensitively and trims them', () => {
    const p = JSON.parse(buildClimatePayload(entityWithPreset(' Away ')));
    expect(p.preset_mode).to.equal('away');
  });

  it('omits optional readouts that were never reported rather than reporting zero', () => {
    const p = JSON.parse(buildClimatePayload(entityWithOnly({})));
    expect(p).to.not.have.property('current_temperature');
    expect(p).to.not.have.property('current_humidity');
    expect(p).to.not.have.property('target_humidity');
  });

  it('includes optional readouts once they are known', () => {
    const p = JSON.parse(buildClimatePayload(entityWithOnly({ current_temperature: 21.4, current_humidity: 55, target_humidity: 50 })));
    expect(p.current_temperature).to.equal(21.4);
    expect(p.current_humidity).to.equal(55);
    expect(p.target_humidity).to.equal(50);
  });

  it('treats a blank numeric reading as unknown, never as zero', () => {
    // Number('') and Number('  ') are both 0 and finite -- this is how the
    // bug got in last time (v0.1's light/sensor readers guard the same trap).
    const p = JSON.parse(buildClimatePayload(entityWithOnly({ current_temperature: '', current_humidity: '   ' })));
    expect(p).to.not.have.property('current_temperature');
    expect(p).to.not.have.property('current_humidity');
  });

  it('treats a non-finite numeric reading as unknown', () => {
    const p = JSON.parse(buildClimatePayload(entityWithOnly({ current_temperature: Number.NaN, current_humidity: Number.POSITIVE_INFINITY })));
    expect(p).to.not.have.property('current_temperature');
    expect(p).to.not.have.property('current_humidity');
  });

  it('includes hvac_action, fan_mode, swing_mode and swing_horizontal_mode when known', () => {
    const p = JSON.parse(
      buildClimatePayload(
        entityWithOnly({
          hvac_mode: 'heat',
          hvac_action: 'heating',
          fan_mode: 'high',
          swing_mode: 'vertical',
          swing_horizontal_mode: 'on',
        }),
      ),
    );
    expect(p.hvac_mode).to.equal('heat');
    expect(p.hvac_action).to.equal('heating');
    expect(p.fan_mode).to.equal('high');
    expect(p.swing_mode).to.equal('vertical');
    expect(p.swing_horizontal_mode).to.equal('on');
  });

  it('omits a blank or whitespace-only string field instead of sending it empty', () => {
    const p = JSON.parse(buildClimatePayload(entityWithOnly({ hvac_action: '   ', fan_mode: '' })));
    expect(p).to.not.have.property('hvac_action');
    expect(p).to.not.have.property('fan_mode');
  });

  it('always includes the available flag', () => {
    expect(JSON.parse(buildClimatePayload(entity({ available: true }))).available).to.equal(true);
    expect(JSON.parse(buildClimatePayload(entity({ available: false }))).available).to.equal(false);
  });

  it('forwards only the validated non-climate keys: friendly_name, icon, power, boost', () => {
    const p = JSON.parse(
      buildClimatePayload(entityWithOnly({ friendly_name: 'Living room', icon: 'mdi:thermostat', power: 'on', boost: 'off' })),
    );
    expect(p.friendly_name).to.equal('Living room');
    expect(p.icon).to.equal('mdi:thermostat');
    expect(p.power).to.equal('on');
    expect(p.boost).to.equal('off');
  });

  it('does not forward an attribute outside the validated allow-list, even one the firmware would read as a fallback key', () => {
    // Review round 1, M5. unit_of_measurement (temperature_unit fallback),
    // humidity (target_humidity fallback), precision (target_temp_step
    // fallback), state (hvac_mode fallback), supported_features and a nested
    // "attributes" object are all names the firmware's scanner recognises
    // (tile_renderer.cpp:2148,2178,2230,2259,2270). An open-ended
    // pass-through would forward every one of these unvalidated -- including
    // as a literal null, reopening exactly the hazard the never-null string
    // rule above exists to close. supported_features is always COMPUTED from
    // `writable` (0 here: this entity has none), never the attribute's 999.
    const p = JSON.parse(
      buildClimatePayload(
        entityWithOnly({
          unit_of_measurement: null,
          humidity: 41,
          precision: 1,
          state: 'heat',
          supported_features: 999,
          attributes: { temperature: 99 },
          made_up_key: 'x',
        }),
      ),
    );
    expect(p).to.deep.equal({ available: true, supported_features: 0 });
  });

  describe('*_modes lists (Task 5b)', () => {
    const LIST_KEYS = ['hvac_modes', 'fan_modes', 'swing_modes', 'swing_horizontal_modes'] as const;

    it('forwards each non-empty list it is given, verbatim', () => {
      const lists = {
        hvac_modes: ['off', 'heat', 'cool'],
        fan_modes: ['auto', 'low'],
        swing_modes: ['vertical'],
        swing_horizontal_modes: ['off', 'on'],
      };
      const p = JSON.parse(buildClimatePayload(entityWithOnly(lists)));
      for (const key of LIST_KEYS) expect(p[key], key).to.deep.equal(lists[key]);
    });

    it('omits a list that is absent, empty, not an array or without one usable name -- never sending null', () => {
      // An absent array leaves its mask at 0: no option list at all
      // (tile_renderer.cpp:2190-2211). An empty or null-bearing one is never
      // the way to say that.
      const raw = buildClimatePayload(
        entityWithOnly({ hvac_modes: [], fan_modes: null, swing_modes: 'off,on', swing_horizontal_modes: [null, '  ', 5] }),
      );
      const p = JSON.parse(raw);
      for (const key of LIST_KEYS) expect(p, key).to.not.have.property(key);
      expect(raw).to.not.match(/null/);
    });
  });

  describe('supported_features (Task 5b)', () => {
    // HomeTiles src/ui/popups/climate/climate_popup.h:6-16. With no mask the
    // firmware assumes EVERY feature (renderer.cpp:74-77, climate_popup.cpp:
    // 280-286: legacy_supported = true), which is why a read-only setpoint
    // used to look tappable.
    const TARGET_TEMPERATURE = 1;
    const TARGET_TEMPERATURE_RANGE = 2;
    const TARGET_HUMIDITY = 4;
    const FAN_MODE = 8;
    const PRESET_MODE = 16;
    const SWING_MODE = 32;
    const SWING_HORIZONTAL_MODE = 512;

    function thermostat(setWritable: boolean) {
      const device: DeviceInput = {
        objectId: 'hm.0',
        name: 'Thermostat',
        detectorType: 'thermostat',
        domain: 'climate',
        channels: {
          set: { objectId: 'hm.0.set', type: 'number', write: setWritable },
          actual: { objectId: 'hm.0.actual', type: 'number', write: false },
        },
      };
      const values = { 'hm.0.set': { val: 21, ack: true, q: 0, ts: 1 }, 'hm.0.actual': { val: 20.5, ack: true, q: 0, ts: 1 } };
      return synthClimate(device, 'climate.hm', values)!;
    }

    it('makes a read-only setpoint non-interactive and keeps a writable one interactive', () => {
      // Built through the REAL synthClimate. An explicit mask without the
      // TARGET_TEMPERATURE bit is what slot_is_interactive (renderer.cpp:
      // 84-86), mini_target_command_supported (:150-152) and the popup's
      // temperature_control_available (climate_popup.cpp:288-296) all read
      // as "not adjustable"; the temperature itself is still displayed.
      const readOnly = JSON.parse(buildClimatePayload(thermostat(false)));
      expect(readOnly.temperature).to.equal(21);
      expect(readOnly).to.have.property('supported_features');
      expect(readOnly.supported_features & TARGET_TEMPERATURE).to.equal(0);

      const writable = JSON.parse(buildClimatePayload(thermostat(true)));
      expect(writable.supported_features & TARGET_TEMPERATURE).to.equal(TARGET_TEMPERATURE);
    });

    it('maps each writable role, alone, to exactly its own bit', () => {
      // One role at a time, so swapping any two bits in the table is caught;
      // an OR over every role cannot tell FAN from PRESET.
      const cases: Array<[Record<string, boolean>, number]> = [
        [{ setpoint: true }, TARGET_TEMPERATURE],
        [{ target_temp_low: true, target_temp_high: true }, TARGET_TEMPERATURE_RANGE],
        [{ target_humidity: true }, TARGET_HUMIDITY],
        [{ fan_mode: true }, FAN_MODE],
        [{ preset_mode: true }, PRESET_MODE],
        [{ swing_mode: true }, SWING_MODE],
        [{ swing_horizontal_mode: true }, SWING_HORIZONTAL_MODE],
        // The range needs both bounds: the firmware sends both in one command.
        [{ target_temp_low: true }, 0],
        [{ target_temp_high: true }, 0],
        [{ target_temp_low: true, target_temp_high: false }, 0],
        // No firmware bit exists for these (climate_popup.cpp:310-311 never
        // gates HVAC; power/boost are not climate controls at all).
        [{ hvac_mode: true }, 0],
        [{ power: true }, 0],
        [{ boost: true }, 0],
        // A role present but not writable sets nothing.
        [{ setpoint: false, fan_mode: false }, 0],
      ];
      for (const [writable, bit] of cases) {
        expect(JSON.parse(buildClimatePayload(entity({ writable }))).supported_features, JSON.stringify(writable)).to.equal(bit);
      }
    });

    it('combines the bits of every writable role', () => {
      const all = entity({
        writable: {
          setpoint: true,
          target_temp_low: true,
          target_temp_high: true,
          target_humidity: true,
          fan_mode: true,
          preset_mode: true,
          swing_mode: true,
          swing_horizontal_mode: true,
          hvac_mode: true,
          power: true,
          boost: true,
        },
      });
      expect(JSON.parse(buildClimatePayload(all)).supported_features).to.equal(
        TARGET_TEMPERATURE |
          TARGET_TEMPERATURE_RANGE |
          TARGET_HUMIDITY |
          FAN_MODE |
          PRESET_MODE |
          SWING_MODE |
          SWING_HORIZONTAL_MODE,
      );
    });
  });

  it('never sends a bare "state" key that would feed the hvac_mode fallback with a placeholder', () => {
    // entity.state is "unknown"/"unavailable" whenever hvac_mode is unset
    // (see synthClimate); the firmware falls back to a "state" key for
    // hvac_mode, so forwarding entity.state generically would smuggle that
    // placeholder in under a different name and defeat the omit-instead-of-
    // null rule above.
    const p = JSON.parse(buildClimatePayload(entityWithNoHvacMode()));
    expect(p).to.not.have.property('state');
  });
});
