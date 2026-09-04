import { expect } from 'chai';
import { buildApplyPayload, buildIconsPayload, configSignature } from '../../src/protocol/apply';
import type { VirtualEntity } from '../../src/registry/types';

function e(over: Partial<VirtualEntity>): VirtualEntity {
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

const ENTITIES: VirtualEntity[] = [
  e({ entityId: 'sensor.temp', state: '21.5', attributes: { friendly_name: 'Wohnzimmer', unit_of_measurement: '°C', icon: 'mdi:thermometer' } }),
  e({ entityId: 'binary_sensor.tuer', domain: 'binary_sensor', state: 'on', attributes: { friendly_name: 'Haustuer', device_class: 'door', icon: 'mdi:door' } }),
  e({ entityId: 'switch.kaffee', domain: 'switch', state: 'off', attributes: { friendly_name: 'Kaffee' } }),
  e({ entityId: 'light.decke', domain: 'light', state: 'on', attributes: { friendly_name: 'Decke', brightness_pct: 60 } }),
  e({ entityId: 'scene.nacht', domain: 'scene', state: 'unknown', attributes: { friendly_name: 'Gute Nacht' } }),
];

describe('protocol/apply', () => {
  it('emits every top-level key the firmware scanner looks for', () => {
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: {} }));
    for (const key of ['sensors', 'binary_sensors', 'lights', 'switches', 'media_players', 'climates', 'covers', 'cameras', 'weathers', 'scene_map']) {
      expect(parsed, `missing key ${key}`).to.have.property(key);
    }
  });

  it('routes each entity into the array for its domain', () => {
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: {} }));
    expect(parsed.sensors).to.deep.equal(['sensor.temp']);
    expect(parsed.binary_sensors).to.deep.equal(['binary_sensor.tuer']);
    expect(parsed.switches).to.deep.equal(['switch.kaffee']);
    expect(parsed.lights).to.deep.equal(['light.decke']);
  });

  it('emits empty arrays for the domains v0.1 does not implement', () => {
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: {} }));
    expect(parsed.media_players).to.deep.equal([]);
    expect(parsed.climates).to.deep.equal([]);
    expect(parsed.covers).to.deep.equal([]);
    expect(parsed.cameras).to.deep.equal([]);
    expect(parsed.weathers).to.deep.equal([]);
  });

  it('builds sensor_meta with the exact keys the firmware parser reads', () => {
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: {} }));
    expect(parsed.sensor_meta[0]).to.deep.equal({
      entity_id: 'sensor.temp',
      name: 'Wohnzimmer',
      unit: '°C',
      state: '21.5',
      value: '21.5',
      state_kind: 'number',
      number: true,
      icon: 'mdi:thermometer',
    });
  });

  it('marks a textual sensor with state_kind state and number false', () => {
    const text = e({ entityId: 'sensor.mode', state: 'heating', attributes: { friendly_name: 'Modus' } });
    const parsed = JSON.parse(buildApplyPayload({ entities: [text], sceneMap: {} }));
    expect(parsed.sensor_meta[0].state_kind).to.equal('state');
    expect(parsed.sensor_meta[0].number).to.equal(false);
  });

  it('builds binary_sensor_meta with availability and the localisable state labels', () => {
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: {} }));
    const meta = parsed.binary_sensor_meta[0];
    expect(meta.entity_id).to.equal('binary_sensor.tuer');
    expect(meta.device_class).to.equal('door');
    expect(meta.state).to.equal('on');
    expect(meta.available).to.equal(true);
    expect(meta.last_changed).to.equal(1_757_000_000);
    expect(meta.icon).to.equal('mdi:door');
  });

  it('omits last_changed entirely when the source has never produced a value', () => {
    // lastChanged 0 means never observed. Publishing unixSeconds(0) would claim
    // the entity last changed in 1970; fabricating a current timestamp would
    // make a dead entity look fresh on every push.
    const never = e({ entityId: 'binary_sensor.n', domain: 'binary_sensor', state: 'unavailable', available: false, lastChanged: 0, attributes: { friendly_name: 'N' } });
    const parsed = JSON.parse(buildApplyPayload({ entities: [never], sceneMap: {} }));
    expect(parsed.binary_sensor_meta[0]).to.not.have.property('last_changed');
  });

  it('reports an unavailable entity as available false in its metadata', () => {
    const gone = e({ entityId: 'binary_sensor.g', domain: 'binary_sensor', state: 'unavailable', available: false, attributes: { friendly_name: 'G' } });
    const parsed = JSON.parse(buildApplyPayload({ entities: [gone], sceneMap: {} }));
    expect(parsed.binary_sensor_meta[0].available).to.equal(false);
    expect(parsed.binary_sensor_meta[0].state).to.equal('unavailable');
  });

  it('passes the scene alias map through lowercased', () => {
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: { 'Gute Nacht': 'scene.nacht' } }));
    expect(parsed.scene_map).to.deep.equal({ 'gute nacht': 'scene.nacht' });
  });

  it('produces a stable signature for identical input and a different one after a change', () => {
    const a = buildApplyPayload({ entities: ENTITIES, sceneMap: {} });
    const b = buildApplyPayload({ entities: ENTITIES, sceneMap: {} });
    expect(configSignature(a)).to.equal(configSignature(b));

    const changed = buildApplyPayload({
      entities: [...ENTITIES, e({ entityId: 'sensor.new', attributes: { friendly_name: 'New' } })],
      sceneMap: {},
    });
    expect(configSignature(changed)).to.not.equal(configSignature(a));
  });

  it('orders entities deterministically so an unchanged registry never re-pushes', () => {
    const forward = buildApplyPayload({ entities: ENTITIES, sceneMap: {} });
    const reversed = buildApplyPayload({ entities: [...ENTITIES].reverse(), sceneMap: {} });
    expect(configSignature(forward)).to.equal(configSignature(reversed));
  });

  it('builds an icons-only payload keyed by entity id', () => {
    const parsed = JSON.parse(buildIconsPayload(ENTITIES));
    expect(parsed.icons).to.deep.equal({
      'sensor.temp': 'mdi:thermometer',
      'binary_sensor.tuer': 'mdi:door',
    });
  });
});
