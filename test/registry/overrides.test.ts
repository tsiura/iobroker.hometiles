import { expect } from 'chai';
import { applyOverrides } from '../../src/registry/overrides';
import type { DeviceInput } from '../../src/registry/types';

const DEVICES: DeviceInput[] = [
  { objectId: 'a', name: 'A', detectorType: 'socket', domain: 'switch', channels: { set: { objectId: 'a.set' } } },
  { objectId: 'b', name: 'B', detectorType: 'temperature', domain: 'sensor', channels: { actual: { objectId: 'b.val' } } },
];

describe('registry/overrides', () => {
  it('keeps every device when no override exists', () => {
    expect(applyOverrides(DEVICES, [])).to.deep.equal(DEVICES);
  });

  it('excludes a device whose override sets include false', () => {
    const result = applyOverrides(DEVICES, [{ objectId: 'a', include: false }]);
    expect(result.map((d) => d.objectId)).to.deep.equal(['b']);
  });

  it('renames a device', () => {
    const result = applyOverrides(DEVICES, [{ objectId: 'a', include: true, name: 'Kaffee' }]);
    expect(result[0]!.name).to.equal('Kaffee');
  });

  it('forces a different domain', () => {
    const result = applyOverrides(DEVICES, [{ objectId: 'b', include: true, forcedDomain: 'binary_sensor' }]);
    expect(result.find((d) => d.objectId === 'b')!.domain).to.equal('binary_sensor');
  });

  it('ignores a forced domain that is not a v0.1 domain', () => {
    const result = applyOverrides(DEVICES, [{ objectId: 'b', include: true, forcedDomain: 'climate' }]);
    expect(result.find((d) => d.objectId === 'b')!.domain).to.equal('sensor');
  });

  it('ignores an override for an object id that no longer exists', () => {
    expect(applyOverrides(DEVICES, [{ objectId: 'gone', include: false }])).to.have.length(2);
  });

  it('matches overrides by object id, never by position', () => {
    const reordered = [...DEVICES].reverse();
    const result = applyOverrides(reordered, [{ objectId: 'a', include: true, name: 'Renamed' }]);
    expect(result.find((d) => d.objectId === 'a')!.name).to.equal('Renamed');
    expect(result.find((d) => d.objectId === 'b')!.name).to.equal('B');
  });

  it('ignores an empty name override rather than blanking the device name', () => {
    const result = applyOverrides(DEVICES, [{ objectId: 'a', include: true, name: '   ' }]);
    expect(result[0]!.name).to.equal('A');
  });
});
