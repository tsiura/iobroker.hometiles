import { expect } from 'chai';
import { buildStateClear, buildStatePublish } from '../../src/protocol/state-payload';
import { buildWeatherPayload } from '../../src/protocol/weather';
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
    // setpoint, preset allow-list, has_* presence-flag correctness) lives in
    // protocol/climate.test.ts; this just pins that buildStatePublish
    // actually delegates to it rather than falling into the generic
    // attribute loop, which would forward entity.state under a "state" key
    // and forward arbitrary attributes the firmware's scanner recognises as
    // fallback keys, unvalidated.
    const p = buildStatePublish('ha/statestream', entity({ entityId: 'climate.living_room', domain: 'climate', attributes: { current_temperature: 21 } }));
    expect(p!.topic).to.equal('ha/statestream/climate/living_room/state');
    const parsed = JSON.parse(p!.payload) as Record<string, unknown>;
    // temperature/min_temp/max_temp are correctly absent here: this entity
    // only knows current_temperature, and has_target_temperature must never
    // be fabricated (review round 1, C1) -- see climate.test.ts for the full
    // rule and its rationale.
    expect(parsed).to.include.keys('current_temperature', 'available');
    expect(parsed).to.not.have.keys('temperature', 'min_temp', 'max_temp', 'state');
  });

  it('routes cover through buildCoverPayload instead of the generic JSON body', () => {
    // Full rule coverage (explicit supported_features, Ruling 27's gate
    // case, position/tilt 0-vs-absent) lives in protocol/cover.test.ts; this
    // just pins that buildStatePublish actually delegates to it rather than
    // falling into the generic attribute loop, which would forward whatever
    // is in attributes verbatim and never add supported_features at all --
    // silently handing capability inference back to the firmware.
    const p = buildStatePublish(
      'ha/statestream',
      entity({
        entityId: 'cover.kitchen_blind',
        domain: 'cover',
        state: 'open',
        attributes: { current_position: 40 },
        writable: { position: true, open: true, close: true, stop: true },
      }),
    );
    expect(p!.topic).to.equal('ha/statestream/cover/kitchen_blind/state');
    const parsed = JSON.parse(p!.payload) as Record<string, unknown>;
    expect(parsed.supported_features).to.be.a('number');
    expect(parsed).to.not.have.property('state', undefined);
    expect(parsed.state).to.equal('open');
  });

  it('routes media_player through buildMediaPayload instead of the generic JSON body', () => {
    // Full rule coverage lives in protocol/media.test.ts. The generic loop
    // would forward every attribute (friendly_name here) and, with no cover,
    // leave the artwork keys out -- which keeps the last track's cover up.
    const p = buildStatePublish(
      'ha/statestream',
      entity({
        entityId: 'media_player.wohnzimmer',
        domain: 'media_player',
        state: 'playing',
        attributes: { friendly_name: 'Wohnzimmer', media_title: 'Ruhe' },
      }),
    );
    expect(p!.topic).to.equal('ha/statestream/media_player/wohnzimmer/state');
    expect(JSON.parse(p!.payload)).to.deep.equal({ state: 'playing', entity_picture: '', media_title: 'Ruhe' });
  });

  it('routes weather through buildWeatherPayload, on the literal `weather` leaf the panel subscribes', () => {
    // Full rule coverage lives in protocol/weather.test.ts. The firmware
    // subscribes <prefix>/weather/<id>/weather only (mqtt_handlers.cpp:1415);
    // the generic loop would send the provider's text and icon URL as they are.
    const home = entity({
      entityId: 'weather.home',
      domain: 'weather',
      state: 'unknown',
      attributes: { friendly_name: 'Zuhause', weather_state: 'Leichter Regen', weather_icon: 'https://openweathermap.org/img/w/10d.png' },
    });
    const p = buildStatePublish('ha/statestream', home);
    expect(p).to.deep.equal({ topic: 'ha/statestream/weather/home/weather', payload: buildWeatherPayload(home), retain: true });
    expect(JSON.parse(p!.payload)).to.deep.equal({ state: 'rainy', condition: 'rainy', name: 'Zuhause' });
  });

  it('keeps every other domain on the state leaf', () => {
    for (const domain of DOMAINS.filter((d) => d !== 'weather' && d !== 'scene')) {
      expect(buildStatePublish('ha/statestream', entity({ entityId: `${domain}.t`, domain, state: 'on' }))!.topic, domain).to.equal(
        `ha/statestream/${domain}/t/state`,
      );
    }
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

  it('clears a weather entity on the weather leaf it was published on', () => {
    expect(buildStateClear('ha/statestream', 'weather.gone')).to.deep.equal({ topic: 'ha/statestream/weather/gone/weather', payload: '', retain: true });
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
