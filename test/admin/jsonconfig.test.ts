import { expect } from 'chai';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { validateOptions, type ManualEntity } from '../../src/config/options';
import { MANUAL_DOMAINS } from '../../src/registry/manual';
import { mergeDetected } from '../../src/registry/overrides';

const config = JSON.parse(readFileSync(path.join(__dirname, '../../admin/jsonConfig.json'), 'utf8'));
const ioPackage = JSON.parse(readFileSync(path.join(__dirname, '../../io-package.json'), 'utf8'));
/** Every language admin/i18n has, by file name. */
const I18N = path.join(__dirname, '../../admin/i18n');
const translations: Record<string, Record<string, string>> = Object.fromEntries(
  readdirSync(I18N)
    .filter((file) => file.endsWith('.json'))
    .map((file) => [file.slice(0, -'.json'.length), JSON.parse(readFileSync(path.join(I18N, file), 'utf8'))]),
);

/** The admin commands main.ts answers: the cases of its onMessage switch. */
const handled = new Set(
  [...readFileSync(path.join(__dirname, '../../src/main.ts'), 'utf8').matchAll(/^\s*case '([A-Za-z]+)':/gm)].map((match) => match[1]),
);

interface Column {
  type: string;
  attr: string;
  readOnly?: boolean;
  filter?: boolean;
  sort?: boolean;
  types?: string[];
  default?: unknown;
  disabled?: string;
  options?: Array<{ label: string; value: string }>;
}
const columns = (table: { items: Column[] }): Record<string, Column> =>
  Object.fromEntries(table.items.map((column) => [column.attr, column]));

/**
 * A pattern as the admin evaluates it: a JavaScript template literal over the
 * form's data (json-config ConfigGeneric.getPatternAsync, escapeString).
 */
function evaluatePattern(pattern: string, data: Record<string, unknown>): string {
  return new Function('data', `return \`${pattern.replace(/`/g, '\\`')}\``)(data) as string;
}

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

  it('fills the detected devices table through the form, sending the rows the form holds, unsaved choices included (Task 21b)', () => {
    const button = config.items.devices.items._detected;
    expect(button).to.include({ type: 'sendTo', command: 'refreshDetected', useNative: true });
    // jsonData and data exclude each other (json-config README, sendTo).
    expect(button).to.not.have.property('data');
    // Text that would break a pattern or a JSON literal, were it spliced in raw.
    const rows = [{ objectId: 'hue.0.a', include: true, name: 'Decke "oben" `1` ${data.x} \\ }', forcedDomain: '' }];
    expect(JSON.parse(evaluatePattern(button.jsonData, { deviceOverrides: rows, brokerHost: 'x' }))).to.deep.equal({ rows });
    // A form that holds no rows yet sends an empty list.
    expect(JSON.parse(evaluatePattern(button.jsonData, {}))).to.deep.equal({ rows: [] });
    expect(Object.keys(button.result)).to.deep.equal(['refreshed']);
  });

  it("shows what detection found read-only beside the user's choices, filterable but never sorted, and lets a row be deleted (Task 21b, Rulings 117, 119)", () => {
    const table = config.items.devices.items.deviceOverrides;
    expect(table.type).to.equal('table');
    // noDelete would take the delete button with the add button (json-config ConfigTable).
    expect(table.noDelete, 'rows can be deleted').to.not.equal(true);
    const byAttr = columns(table);
    // A row added by hand holds a text object id, which selects nothing and
    // costs no warning (validateOptions), rather than null.
    expect(byAttr.objectId!.default).to.equal('');
    expect(validateOptions({ deviceOverrides: [{ objectId: byAttr.objectId!.default as string, include: false }] }).warnings).to.deep.equal([]);
    // The adapter marks a row whose device is detected no more in the
    // system's language (Ruling 117): every language has the text.
    for (const [language, strings] of Object.entries(translations)) expect(strings, language).to.have.property('not_detected');
    // Exactly the fields a refreshed row holds.
    const [row] = mergeDetected([], [{ objectId: 'hue.0.a', detectedName: 'A', detectedDomain: 'light', room: 'Flur' }]);
    expect(Object.keys(byAttr)).to.have.members(Object.keys(row!));
    expect(byAttr.include).to.include({ type: 'checkbox' });
    for (const attr of ['include', 'name', 'forcedDomain']) expect(byAttr[attr]!.readOnly, attr).to.not.equal(true);
    for (const attr of ['detectedName', 'detectedDomain', 'room', 'objectId']) {
      expect(byAttr[attr], attr).to.include({ type: 'text', readOnly: true, filter: true });
    }
    // A column sort reorders only what the table shows (json-config
    // ConfigTable.handleRequestSort), never the form's rows that Refresh
    // sends and replaces, and a select keeps the value it mounted with
    // (ConfigSelect._getValue): after a Refresh a sorted table would show one
    // device's forced type beside another (Ruling 119, M2).
    for (const column of table.items) expect(column.sort, column.attr).to.not.equal(true);
  });

  it('lets the user add manual entities: a state picker, the domains one state can serve, a name and a datetime kind (Task 21b)', () => {
    const table = config.items.devices.items.manualEntities;
    expect(table.type).to.equal('table');
    const byAttr = columns(table);
    // Exactly the fields validateOptions keeps of a complete entry.
    const entry: ManualEntity = { stateId: '0_userdata.0.a', domain: 'datetime', name: 'A', kind: 'time' };
    expect(Object.keys(byAttr)).to.have.members(Object.keys(validateOptions({ manualEntities: [entry] }).options.manualEntities[0]!));
    expect(byAttr.stateId).to.include({ type: 'objectId' });
    expect(byAttr.stateId!.types).to.deep.equal(['state']);
    expect(byAttr.domain!.options!.map((option) => option.value)).to.deep.equal([...MANUAL_DOMAINS]);
    expect(MANUAL_DOMAINS).to.include(byAttr.domain!.default);

    const kinds = byAttr.kind!.options!.map((option) => option.value);
    expect(kinds).to.deep.equal(['', 'date', 'time', 'datetime']);
    // validateOptions takes each: the empty one as no kind, and silently.
    const { options, warnings } = validateOptions({ manualEntities: kinds.map((kind) => ({ ...entry, kind }) as ManualEntity) });
    expect(options.manualEntities.map((kept) => kept.kind)).to.deep.equal([undefined, 'date', 'time', 'datetime']);
    expect(warnings).to.deep.equal([]);
    // A kind is a datetime's alone: the admin evaluates `disabled` on the row.
    const disabled = (domain: string): unknown => new Function('data', `return ${byAttr.kind!.disabled}`)({ domain });
    expect(MANUAL_DOMAINS.map((domain) => [domain, disabled(domain)])).to.deep.equal(
      MANUAL_DOMAINS.map((domain) => [domain, domain !== 'datetime']),
    );
  });

  it('wires each action button to a command the adapter implements', () => {
    // Read from main.ts itself, so a command it stops answering fails here.
    expect([...handled]).to.include.members(['listDetected', 'refreshDetected', 'testBroker', 'previewEntity', 'pairPanel']);
    const commands = handled;
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

  it('names the Refresh button in every language, and warns that saving a pick prunes the panels, to export their layout first (Rulings 118, 119 M6)', () => {
    for (const [language, strings] of Object.entries(translations)) {
      expect(strings.devices_info, language).to.include(strings.refresh_detected);
      expect(strings.devices_info, language).to.match(/export/i);
    }
  });

  it('ships every translation file with the key set of the English source', () => {
    const en = JSON.parse(readFileSync(path.join(__dirname, '../../admin/i18n/en.json'), 'utf8'));
    expect(Object.keys(translations).sort()).to.include.members(['de', 'en']);
    for (const [language, strings] of Object.entries(translations)) {
      expect(Object.keys(strings).sort(), language).to.deep.equal(Object.keys(en).sort());
    }
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
      // A sendTo's result texts are translations too (json-config types.d.ts, ConfigItemSendTo).
      if (record.type === 'sendTo' && record.result) {
        for (const value of Object.values(record.result as Record<string, unknown>)) if (typeof value === 'string') referenced.add(value);
      }
      for (const value of Object.values(record)) walk(value);
    };
    walk(config.items);

    expect(referenced.size, 'the walk must actually find identifiers').to.be.greaterThan(20);
    expect(referenced, 'the result text').to.include('refresh_result');
    for (const key of referenced) {
      for (const [language, strings] of Object.entries(translations)) {
        expect(strings, `${language}.json is missing "${key}"`).to.have.property(key);
      }
    }
  });
});
