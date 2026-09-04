import { expect } from 'chai';
import { buildEntityId, resolveEntityIds, slugify } from '../../src/registry/entity-id';
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
});
