import { tests } from '@iobroker/testing';
import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DOMAINS } from '../src/registry/types';

// Validates package.json against io-package.json: name, version, licence,
// native/instanceObjects shape, and the adapter naming rules.
tests.packageFiles(path.join(__dirname, '..'));

const read = (file: string): string => readFileSync(path.join(__dirname, '..', file), 'utf8');

describe('release documentation and metadata (Task 25)', () => {
  it('documents every domain in the Domain union in docs/protocol.md', () => {
    const doc = read('docs/protocol.md');
    // A row of its entity state table, "| `number` |", not a mention: number,
    // select and scene are ordinary words that any text contains.
    const missing = DOMAINS.filter((domain) => !new RegExp(`^\\| \`${domain}\` \\|`, 'm').test(doc));
    expect(missing, 'domains without a row in the entity state table').to.deep.equal([]);
  });

  it('keeps the no-hardware disclosure in the README', () => {
    expect(read('README.md')).to.include('No physical panel has ever run this adapter');
  });

  it('gives package.json and io-package.json one version, with a news entry for it', () => {
    const { version } = JSON.parse(read('package.json')) as { version: string };
    const { common } = JSON.parse(read('io-package.json')) as { common: { version: string; news: Record<string, Record<string, unknown>> } };
    expect(common.version, 'io-package.json common.version').to.equal(version);
    expect(common.news, 'io-package.json common.news').to.have.property(version);
    expect(common.news[version]?.en, `the English news of ${version}`).to.be.a('string').that.is.not.empty;
  });

  it('requires an admin that encrypts the broker password with a prefix the migration can tell apart, and the minimums the repository checker asks for (Rulings 146, 149)', () => {
    // Admin 6.2.2 and older encrypt encryptedNative by XOR with no prefix, which
    // the 0.1 plain-password migration (config/options.ts storedPassword) would
    // take for plain text. js-controller checks globalDependencies only when the
    // adapter is installed from the ioBroker repository, never on an install or
    // upgrade from a URL, so the adapter checks at start too (main.ts onReady).
    const { common } = JSON.parse(read('io-package.json')) as { common: { dependencies?: unknown; globalDependencies?: unknown } };
    expect(common.dependencies).to.deep.equal([{ 'js-controller': '>=6.0.11' }]);
    expect(common.globalDependencies).to.deep.equal([{ admin: '>=7.6.17' }]);
  });
});
