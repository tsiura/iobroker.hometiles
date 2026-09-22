import { expect } from 'chai';
import { buildClimatePayload } from '../../src/protocol/climate';
import type { VirtualEntity } from '../../src/registry/types';

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
  it('emits every attribute on every publish, not a diff', () => {
    const p = JSON.parse(buildClimatePayload(entityWithOnly({ current_temperature: 21 })));
    // Omitting these would snap the panel to 20.0/7.0/35.0. Wire key is
    // "temperature", not "target_temperature": docs/contract-climate-cover.md
    // (citing tile_renderer.cpp:2233-2236) is authoritative over the brief,
    // which named the internal VirtualEntity attribute instead of the wire
    // key the firmware's scanner actually looks for.
    expect(p).to.include.keys('temperature', 'min_temp', 'max_temp');
  });

  it('uses the real target temperature, min_temp and max_temp when known', () => {
    const p = JSON.parse(buildClimatePayload(entityWithOnly({ target_temperature: 22, min_temp: 10, max_temp: 30 })));
    expect(p.temperature).to.equal(22);
    expect(p.min_temp).to.equal(10);
    expect(p.max_temp).to.equal(30);
  });

  it('falls back to the firmware defaults for temperature/min_temp/max_temp when unknown', () => {
    const p = JSON.parse(buildClimatePayload(entityWithOnly({})));
    expect(p.temperature).to.equal(20.0);
    expect(p.min_temp).to.equal(7.0);
    expect(p.max_temp).to.equal(35.0);
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

  it('emits both ends of the dual setpoint or neither', () => {
    // target_temp_low and target_temp_high share ONE presence flag: sending
    // only one makes the firmware treat both as fresh and silently revert the
    // other to its default.
    const p = JSON.parse(buildClimatePayload(entityWithOnly({ target_temp_low: 18 })));
    const has = 'target_temp_low' in p === ('target_temp_high' in p);
    expect(has).to.equal(true);
    // The known side keeps its real value, the unknown side gets the
    // firmware's own default rather than an arbitrary fabricated number.
    expect(p.target_temp_low).to.equal(18);
    expect(p.target_temp_high).to.equal(24.0);
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

  it('forwards attributes outside the climate schema unchanged, like the generic JSON domains do', () => {
    const p = JSON.parse(
      buildClimatePayload(entityWithOnly({ friendly_name: 'Living room', icon: 'mdi:thermostat', power: 'on', boost: 'off' })),
    );
    expect(p.friendly_name).to.equal('Living room');
    expect(p.icon).to.equal('mdi:thermostat');
    expect(p.power).to.equal('on');
    expect(p.boost).to.equal('off');
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
