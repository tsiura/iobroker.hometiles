import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const config = JSON.parse(readFileSync(path.join(__dirname, '../../admin/jsonConfig.json'), 'utf8'));
const ioPackage = JSON.parse(readFileSync(path.join(__dirname, '../../io-package.json'), 'utf8'));

/**
 * In a jsonConfig panel the native binding is the KEY of each entry in `items`.
 * Keys starting with an underscore are actions, not bindings.
 */
function boundNativeKeys(): string[] {
  const keys: string[] = [];
  for (const panel of Object.values(config.items) as Array<{ items: Record<string, unknown> }>) {
    for (const key of Object.keys(panel.items)) {
      if (key.startsWith('_')) continue;
      keys.push(key);
    }
  }
  return keys;
}

describe('admin/jsonConfig', () => {
  it('declares the json config version the admin expects', () => {
    expect(config.i18n).to.equal(true);
    expect(config.type).to.equal('tabs');
  });

  it('has the four tabs the design specifies', () => {
    expect(Object.keys(config.items)).to.deep.equal(['connection', 'devices', 'panels', 'advanced']);
  });

  it('binds every field to a native key that io-package.json defines', () => {
    const keys = boundNativeKeys();
    expect(keys.length, 'the UI must bind at least the connection fields').to.be.greaterThan(5);
    for (const key of keys) {
      expect(ioPackage.native, `native is missing ${key}`).to.have.property(key);
    }
  });

  it('covers every native key with a field so nothing is silently unconfigurable', () => {
    const keys = new Set(boundNativeKeys());
    expect(Object.keys(ioPackage.native).length, 'native must not be empty').to.be.greaterThan(5);
    for (const key of Object.keys(ioPackage.native)) {
      expect(keys, `no UI field binds native.${key}`).to.include(key);
    }
  });

  it('stores the broker password as a password field so it is encrypted', () => {
    const field = config.items.connection.items.brokerPassword;
    expect(field.type).to.equal('password');
  });

  it('keys the device overrides table by objectId', () => {
    const table = config.items.devices.items.deviceOverrides;
    expect(table.type).to.equal('table');
    expect(table.items.map((column: { attr: string }) => column.attr)).to.include('objectId');
  });

  it('offers only the v0.1 domains in the forced-domain column', () => {
    const table = config.items.devices.items.deviceOverrides;
    const column = table.items.find((item: { attr: string }) => item.attr === 'forcedDomain');
    const values = column.options.map((option: { value: string }) => option.value);
    expect(values).to.deep.equal(['', 'sensor', 'binary_sensor', 'switch', 'light', 'scene']);
  });

  it('wires each action button to a command the adapter implements', () => {
    const commands = new Set(['listDetected', 'testBroker', 'previewEntity', 'pairPanel']);
    const found = new Set<string>();
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (record.type === 'sendTo' && typeof record.command === 'string') found.add(record.command);
      for (const value of Object.values(record)) walk(value);
    };
    walk(config.items);
    expect(found.size).to.be.greaterThan(0);
    for (const command of found) expect(commands, `unknown command ${command}`).to.include(command);
  });

  it('ships both translation files with matching key sets', () => {
    const en = JSON.parse(readFileSync(path.join(__dirname, '../../admin/i18n/en.json'), 'utf8'));
    const de = JSON.parse(readFileSync(path.join(__dirname, '../../admin/i18n/de.json'), 'utf8'));
    expect(Object.keys(de).sort()).to.deep.equal(Object.keys(en).sort());
  });

  it('defines every identifier the UI actually references', () => {
    // Matching en against de is not enough: a label added to jsonConfig.json
    // and omitted from BOTH files leaves the two in agreement while the UI
    // renders the raw key id. This checks the referenced-vs-defined direction.
    const referenced = new Set<string>();
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      for (const prop of ['label', 'title', 'text', 'help']) {
        const value = record[prop];
        if (typeof value === 'string' && value) referenced.add(value);
      }
      for (const value of Object.values(record)) walk(value);
    };
    walk(config.items);

    const en = JSON.parse(readFileSync(path.join(__dirname, '../../admin/i18n/en.json'), 'utf8'));
    const de = JSON.parse(readFileSync(path.join(__dirname, '../../admin/i18n/de.json'), 'utf8'));

    expect(referenced.size, 'the walk must actually find identifiers').to.be.greaterThan(20);
    for (const key of referenced) {
      expect(en, `en.json is missing "${key}"`).to.have.property(key);
      expect(de, `de.json is missing "${key}"`).to.have.property(key);
    }
  });
});
