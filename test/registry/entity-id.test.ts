import { expect } from 'chai';
import { requireEntityId } from '../../src/protocol/commands';
import { buildEntityId, parseStringMap, resolveEntityIds, slugify } from '../../src/registry/entity-id';
import type { DeviceInput } from '../../src/registry/types';

function device(objectId: string, name: string): DeviceInput {
  return { objectId, name, detectorType: 'socket', domain: 'switch', channels: {} };
}

describe('registry/entity-id', () => {
  it('lowercases and replaces every non-alphanumeric run with a single underscore', () => {
    expect(slugify('Küche Decke / 2')).to.equal('kuche_decke_2');
    expect(slugify('  Wohnzimmer--Lampe  ')).to.equal('wohnzimmer_lampe');
  });

  it('never produces a leading or trailing underscore', () => {
    expect(slugify('__abc__')).to.equal('abc');
  });

  it('falls back to a placeholder when nothing survives slugification', () => {
    expect(slugify('***')).to.equal('unnamed');
  });

  it('builds a domain-prefixed entity id', () => {
    expect(buildEntityId('light', 'hue.0.Kueche Decke', new Set())).to.equal('light.kueche_decke');
  });

  it('suffixes deterministically on collision', () => {
    const taken = new Set(['light.decke']);
    expect(buildEntityId('light', 'decke', taken)).to.equal('light.decke_2');
    taken.add('light.decke_2');
    expect(buildEntityId('light', 'decke', taken)).to.equal('light.decke_3');
  });

  it('keeps a persisted entity id when the ioBroker object is renamed', () => {
    const persisted = { 'hue.0.old_name': 'light.old_name' };
    const resolved = resolveEntityIds([{ ...device('hue.0.old_name', 'Brand New Name'), domain: 'light' }], persisted);
    expect(resolved['hue.0.old_name']).to.equal('light.old_name');
  });

  it('assigns fresh ids only to object ids that are not yet persisted', () => {
    const persisted = { 'hue.0.a': 'light.a' };
    const resolved = resolveEntityIds(
      [
        { ...device('hue.0.a', 'A'), domain: 'light' },
        { ...device('hue.0.b', 'B'), domain: 'light' },
      ],
      persisted,
    );
    expect(resolved).to.deep.equal({ 'hue.0.a': 'light.a', 'hue.0.b': 'light.b' });
  });

  it('does not let a new device steal an id already persisted for another object', () => {
    const persisted = { 'hue.0.a': 'light.decke' };
    const resolved = resolveEntityIds(
      [
        { ...device('hue.0.a', 'Decke'), domain: 'light' },
        { ...device('zigbee.0.x', 'Decke'), domain: 'light' },
      ],
      persisted,
    );
    expect(resolved['hue.0.a']).to.equal('light.decke');
    expect(resolved['zigbee.0.x']).to.equal('light.decke_2');
  });

  it('reserves a persisted id whose device is currently absent, so it can be reclaimed', () => {
    // This is the whole reason the reservation pass runs before assignment: an
    // offline device must find its id waiting for it, not taken by a newcomer.
    const persisted = { 'hue.0.gone': 'light.decke' };
    const resolved = resolveEntityIds([{ ...device('zigbee.0.x', 'Decke'), domain: 'light' }], persisted);
    expect(resolved['zigbee.0.x']).to.equal('light.decke_2');

    // And when the absent device comes back, it reclaims its original id.
    const afterReturn = resolveEntityIds(
      [
        { ...device('zigbee.0.x', 'Decke'), domain: 'light' },
        { ...device('hue.0.gone', 'Decke'), domain: 'light' },
      ],
      { ...persisted, 'zigbee.0.x': 'light.decke_2' },
    );
    expect(afterReturn['hue.0.gone']).to.equal('light.decke');
    expect(afterReturn['zigbee.0.x']).to.equal('light.decke_2');
  });

  it('does not reuse a persisted id saved under another domain', () => {
    // The firmware routes a command by the id's domain PREFIX: a light kept
    // at switch.flurlicht could never receive set_light, and a switch kept at
    // sensor.pumpe would have every press dropped.
    const resolved = resolveEntityIds(
      [
        { ...device('knx.0.Licht.Flur', 'Flurlicht'), domain: 'light' },
        { ...device('modbus.0.pumpe', 'Pumpe'), domain: 'switch' },
      ],
      { 'knx.0.Licht.Flur': 'switch.flurlicht', 'modbus.0.pumpe': 'sensor.pumpe' },
    );
    expect(resolved).to.deep.equal({ 'knx.0.Licht.Flur': 'light.flurlicht', 'modbus.0.pumpe': 'switch.pumpe' });
  });

  it('reads a stored id map only when it is a JSON object whose values are all strings (Ruling 51)', () => {
    expect(parseStringMap('{"hue.0.a":"light.a"}')).to.deep.equal({ 'hue.0.a': 'light.a' });
    expect(parseStringMap('{}')).to.deep.equal({});
    // Everything a hand edit can leave behind. JSON null used to come back as
    // null and throw inside discovery, stopping the adapter from starting.
    const malformed: unknown[] = ['null', '[]', '["light.a"]', '5', '"light.a"', 'true', '{"a":5}', '{"a":null}', '{"a":{}}', 'not json', '', 5, true, {}];
    for (const raw of malformed) expect(parseStringMap(raw), JSON.stringify(raw)).to.equal(undefined);
  });

  it('slugifies a display name whole instead of splitting it on a dot', () => {
    // "Sensor v1.2" must not become sensor.2.
    const resolved = resolveEntityIds([{ ...device('zigbee.0.abc', 'Sensor v1.2'), domain: 'sensor' }], {});
    expect(resolved['zigbee.0.abc']).to.equal('sensor.sensor_v1_2');
  });

  it('gives a persisted id to one device only, however the stored map was edited (Task 13b)', () => {
    // A detected socket keyed by its state and a manual entity on that same
    // state are two devices; two keys holding one id in a hand-edited store
    // must not fold them into one entity. The first device keeps the id.
    const resolved = resolveEntityIds(
      [device('zigbee.0.abc.state', 'Flur'), device('manual:zigbee.0.abc.state', 'Flur')],
      { 'zigbee.0.abc.state': 'switch.flur', 'manual:zigbee.0.abc.state': 'switch.flur' },
    );
    expect(resolved).to.deep.equal({ 'zigbee.0.abc.state': 'switch.flur', 'manual:zigbee.0.abc.state': 'switch.flur_2' });
  });

  it('keeps a derived id within the 255 characters a command may carry, suffix included, and never cuts a stored one (m4)', () => {
    // A 300-character name, detected or typed into a manual entry. The cut
    // lands on a separator, which does not stay at the end.
    const name = 'Zu '.repeat(100);
    expect(name).to.have.length(300);
    const resolved = resolveEntityIds([device('zigbee.0.a', name), device('zigbee.0.b', name)], {});
    expect(resolved['zigbee.0.a']).to.equal(`switch.${'zu_'.repeat(80)}zu`);
    expect(resolved['zigbee.0.b']).to.equal(`switch.${'zu_'.repeat(80)}zu_2`);
    // Room for the longest suffix, `_9999`, and the command parser takes each.
    expect(resolved['zigbee.0.a']!.length + '_9999'.length).to.be.at.most(255);
    for (const id of Object.values(resolved)) expect(requireEntityId({ entity_id: id })).to.equal(id);
    // No name: the object id's own tail, as long.
    const tail = resolveEntityIds([device(`zigbee.0.${'x'.repeat(300)}`, '')], {});
    expect(Object.values(tail)[0]).to.equal(`switch.${'x'.repeat(243)}`);
    // A stored id is the panel's, and is kept as it is (the first pass).
    const stored = `switch.${'x'.repeat(300)}`;
    expect(resolveEntityIds([device('zigbee.0.a', name)], { 'zigbee.0.a': stored })).to.deep.equal({ 'zigbee.0.a': stored });
  });

  it('falls back to the object id tail when the device has no name', () => {
    const resolved = resolveEntityIds([{ ...device('zigbee.0.kueche', '   '), domain: 'switch' }], {});
    expect(resolved['zigbee.0.kueche']).to.equal('switch.kueche');
  });
});
