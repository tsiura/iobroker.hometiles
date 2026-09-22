import { expect } from 'chai';
import { buildStateClear, buildStatePublish } from '../../src/protocol/state-payload';
import { DOMAINS, type VirtualEntity } from '../../src/registry/types';

function entity(over: Partial<VirtualEntity>): VirtualEntity {
  return {
    entityId: 'sensor.x',
    domain: 'sensor',
    source: {},
    state: '1',
    attributes: {},
    available: true,
    lastChanged: 1_757_000_000_000,
    ...over,
  };
}

describe('protocol/state-payload', () => {
  it('publishes a sensor as a bare string, not JSON', () => {
    const p = buildStatePublish('ha/statestream', entity({ entityId: 'sensor.temp', state: '21.5' }));
    expect(p).to.not.equal(null);
    expect(p!.topic).to.equal('ha/statestream/sensor/temp/state');
    expect(p!.payload).to.equal('21.5');
    expect(p!.retain).to.equal(true);
  });

  it('publishes a binary sensor as a bare on or off', () => {
    const p = buildStatePublish('ha/statestream', entity({ entityId: 'binary_sensor.d', domain: 'binary_sensor', state: 'on' }));
    expect(p!.payload).to.equal('on');
  });

  it('publishes a switch as a bare on or off', () => {
    const p = buildStatePublish('ha/statestream', entity({ entityId: 'switch.k', domain: 'switch', state: 'off' }));
    expect(p!.payload).to.equal('off');
  });

  it('publishes unavailable as the bare literal for a bare-string domain', () => {
    const p = buildStatePublish('ha/statestream', entity({ entityId: 'sensor.t', state: 'unavailable', available: false }));
    expect(p!.payload).to.equal('unavailable');
  });

  it('publishes a light as JSON carrying state plus its attributes', () => {
    const p = buildStatePublish(
      'ha/statestream',
      entity({
        entityId: 'light.decke',
        domain: 'light',
        state: 'on',
        attributes: { friendly_name: 'Decke', brightness_pct: 60, rgb_color: [255, 180, 90] },
      }),
    );
    expect(p!.topic).to.equal('ha/statestream/light/decke/state');
    expect(JSON.parse(p!.payload)).to.deep.equal({
      state: 'on',
      friendly_name: 'Decke',
      brightness_pct: 60,
      rgb_color: [255, 180, 90],
    });
  });

  it('lets state win over an attribute that happens to be called state', () => {
    const p = buildStatePublish(
      'ha/statestream',
      entity({ entityId: 'light.d', domain: 'light', state: 'off', attributes: { state: 'on' } }),
    );
    expect(JSON.parse(p!.payload).state).to.equal('off');
  });

  it('drops undefined attributes rather than emitting null', () => {
    const p = buildStatePublish(
      'ha/statestream',
      entity({ entityId: 'light.d', domain: 'light', state: 'on', attributes: { brightness: undefined, icon: 'mdi:bulb' } }),
    );
    const parsed = JSON.parse(p!.payload);
    expect(parsed).to.not.have.property('brightness');
    expect(parsed.icon).to.equal('mdi:bulb');
  });

  it('publishes an unavailable light as JSON so the panel keeps parsing it the same way', () => {
    const p = buildStatePublish(
      'ha/statestream',
      entity({ entityId: 'light.d', domain: 'light', state: 'unavailable', available: false, attributes: { friendly_name: 'D' } }),
    );
    expect(JSON.parse(p!.payload).state).to.equal('unavailable');
  });

  it('routes climate through buildClimatePayload instead of the generic JSON body', () => {
    // Full rule coverage (overwrite semantics, null-string hazard, paired
    // setpoint, preset allow-list) lives in protocol/climate.test.ts; this
    // just pins that buildStatePublish actually delegates to it rather than
    // falling into the generic attribute loop, which would diff instead of
    // always publishing the complete attribute set.
    const p = buildStatePublish('ha/statestream', entity({ entityId: 'climate.living_room', domain: 'climate', attributes: { current_temperature: 21 } }));
    expect(p!.topic).to.equal('ha/statestream/climate/living_room/state');
    const parsed = JSON.parse(p!.payload) as Record<string, unknown>;
    expect(parsed).to.include.keys('temperature', 'min_temp', 'max_temp', 'available');
    expect(parsed).to.not.have.property('state');
  });

  it('publishes nothing for a scene', () => {
    expect(buildStatePublish('ha/statestream', entity({ entityId: 'scene.n', domain: 'scene' }))).to.equal(null);
  });

  it('clears a retained entity with an empty retained payload', () => {
    const p = buildStateClear('ha/statestream', 'sensor.gone');
    expect(p.topic).to.equal('ha/statestream/sensor/gone/state');
    expect(p.payload).to.equal('');
    expect(p.retain).to.equal(true);
  });

  it('assigns every domain an explicit payload shape', () => {
    // Guards the exhaustive switch: a domain added to the union without a
    // decided payload shape must fail to compile, never default into JSON.
    // This test pins the runtime half of that contract for every domain,
    // v0.1 and v0.2 alike.
    const shapes = DOMAINS.map((domain) => {
      const publish = buildStatePublish('ha/statestream', entity({ entityId: `${domain}.t`, domain, state: 'on' }));
      if (!publish) return [domain, 'none'] as const;
      return [domain, publish.payload.startsWith('{') ? 'json' : 'bare'] as const;
    });
    expect(Object.fromEntries(shapes)).to.deep.equal({
      sensor: 'bare',
      binary_sensor: 'bare',
      switch: 'bare',
      light: 'json',
      scene: 'none',
      climate: 'json',
      cover: 'json',
      media_player: 'json',
      weather: 'json',
      number: 'json',
      select: 'json',
      datetime: 'json',
    });
  });
});
