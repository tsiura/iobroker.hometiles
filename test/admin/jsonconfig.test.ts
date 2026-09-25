import { expect } from 'chai';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PICKER_VERSION, validateOptions, type EnergyMeterRow, type ManualEntity } from '../../src/config/options';
import { ENERGY_CATEGORIES } from '../../src/protocol/energy';
import { MANUAL_DOMAINS } from '../../src/registry/manual';
import { mergeDetected } from '../../src/registry/overrides';
import { HVAC_MODE_NAMES } from '../../src/registry/synth/climate';
import { LACKS } from '../../src/registry/synth/index';
import { DOMAINS } from '../../src/registry/types';
import { PAIRING_FAILURES } from '../../src/runtime/pairing';

const config = JSON.parse(readFileSync(path.join(__dirname, '../../admin/jsonConfig.json'), 'utf8'));
const ioPackage = JSON.parse(readFileSync(path.join(__dirname, '../../io-package.json'), 'utf8'));
/** Every language admin/i18n has, by file name. */
const I18N = path.join(__dirname, '../../admin/i18n');
const translations: Record<string, Record<string, string>> = Object.fromEntries(
  readdirSync(I18N)
    .filter((file) => file.endsWith('.json'))
    .map((file) => [file.slice(0, -'.json'.length), JSON.parse(readFileSync(path.join(I18N, file), 'utf8'))]),
);

const MAIN = readFileSync(path.join(__dirname, '../../src/main.ts'), 'utf8');
/** The admin commands main.ts answers: the cases of its onMessage switch. */
const handled = new Set([...MAIN.matchAll(/^\s*case '([A-Za-z]+)':/gm)].map((match) => match[1]));

interface Column {
  type: string;
  attr: string;
  title?: string;
  noTranslation?: boolean;
  readOnly?: boolean;
  filter?: boolean;
  sort?: boolean;
  types?: string[];
  default?: unknown;
  disabled?: string;
  options?: Array<{ label: string; value: string; hidden?: string }>;
  command?: string;
  jsonData?: string;
  error?: Record<string, string>;
}
const columns = (table: { items: Column[] }): Record<string, Column> =>
  Object.fromEntries(table.items.map((column) => [column.attr, column]));

/**
 * A pattern as the admin evaluates it: a JavaScript template literal over the
 * form's data (json-config ConfigGeneric.getPatternAsync, escapeString). In a
 * table's cell `data` is the row and `globalData` the whole form (ConfigTable
 * itemTable, globalData: this.props.data).
 */
function evaluatePattern(pattern: string, data: Record<string, unknown>, globalData?: Record<string, unknown>): string {
  return new Function('data', 'globalData', `return \`${pattern.replace(/`/g, '\\`')}\``)(data, globalData) as string;
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

  it('has the tabs the design specifies, and the Energy tab beside the devices (Task 20b)', () => {
    expect(Object.keys(config.items)).to.deep.equal(['connection', 'devices', 'energy', 'panels', 'advanced']);
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

  it('stores the broker password as a password field that io-package.json declares encrypted and protected, as every password field (Ruling 143)', () => {
    const field = config.items.connection.items.brokerPassword;
    expect(field.type).to.equal('password');
    // admin encrypts on save what the instance lists in encryptedNative (json-config JsonConfig.onSave), js-controller
    // decrypts it into this.config on start (adapter.js), and hides what it lists in protectedNative from other adapters.
    const passwords: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if ((value as { type?: unknown } | null)?.type === 'password') passwords.push(key);
        walk(value);
      }
    };
    walk(config.items);
    expect(passwords).to.deep.equal(['brokerPassword']);
    expect(ioPackage.encryptedNative).to.deep.equal(passwords);
    expect(ioPackage.protectedNative).to.deep.equal(passwords);
  });

  it('keys the device overrides table by objectId', () => {
    const table = config.items.devices.items.deviceOverrides;
    expect(table.type).to.equal('table');
    expect(table.items.map((column: { attr: string }) => column.attr)).to.include('objectId');
  });

  it('offers every domain the adapter publishes as a forced type, Auto first, each under its own label, never camera (Task 23)', () => {
    const column = columns(config.items.devices.items.deviceOverrides).forcedDomain!;
    // '' is Auto: validateOptions keeps it, applyOverrides takes the detected domain for it (overrides.ts isDomain).
    const values = column.options!.map((option) => option.value);
    expect(values).to.deep.equal(['', ...DOMAINS]);
    expect(values).to.not.include('camera');
    expect(column.options!.map((option) => option.label)).to.deep.equal(['domain_auto', ...DOMAINS.map((domain) => `domain_${domain}`)]);
    // Saved as the admin stores a row, each one is kept as it is.
    const rows = values.map((forcedDomain, i) => ({ objectId: `x.0.${i}`, include: true, forcedDomain, detectedDomain: 'sensor' }));
    const { options, warnings } = validateOptions({ deviceOverrides: rows });
    expect([options.deviceOverrides, warnings]).to.deep.equal([rows, []]);
  });

  it('fills the detected devices table through the form, sending the rows the form holds, unsaved choices included (Task 21b)', () => {
    const button = config.items.devices.items._detected;
    expect(button).to.include({ type: 'sendTo', command: 'refreshDetected', useNative: true });
    // jsonData and data exclude each other (json-config README, sendTo).
    expect(button).to.not.have.property('data');
    // Text that would break a pattern or a JSON literal, were it spliced in raw.
    const rows = [{ objectId: 'hue.0.a', include: true, name: 'Decke "oben" `1` ${data.x} \\ }', forcedDomain: '' }];
    // With the form's marker: whether this picker armed it, so whether its ticks are the user's (Ruling 120, N2).
    expect(JSON.parse(evaluatePattern(button.jsonData, { deviceOverrides: rows, brokerHost: 'x', pickerArmed: PICKER_VERSION }))).to.deep.equal({
      rows,
      pickerArmed: PICKER_VERSION,
    });
    expect(JSON.parse(evaluatePattern(button.jsonData, { deviceOverrides: rows, pickerArmed: true }))).to.deep.equal({ rows, pickerArmed: true });
    // A form that holds no rows and no marker yet sends an empty list, and no marker.
    expect(JSON.parse(evaluatePattern(button.jsonData, {}))).to.deep.equal({ rows: [], pickerArmed: null });
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
    // Exactly the fields a refreshed row holds, beside the preview button (_preview), which is no field.
    const [row] = mergeDetected([], [{ objectId: 'hue.0.a', detectedName: 'A', detectedDomain: 'light', room: 'Flur' }]);
    expect(Object.keys(byAttr).filter((attr) => !attr.startsWith('_'))).to.have.members(Object.keys(row!));
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

  it("previews each row of the Detected devices table from the row itself, its unsaved type and name included (Task 23, Task 21b C5)", () => {
    const preview = columns(config.items.devices.items.deviceOverrides)._preview!;
    expect(preview).to.include({ type: 'sendTo', command: 'previewEntity' });
    // A table renders each cell with its row as `data` (json-config ConfigTable.itemTable:
    // custom, data), and a sendTo evaluates jsonData over {_origin, _originIp, ...data}
    // (ConfigSendto._onClick). Text that would break a pattern or a JSON literal, were it spliced in raw:
    const row = { objectId: 'alias.0.Decke "oben" `1` ${data.x} \\ }', include: false, name: 'Licht "oben"', forcedDomain: 'datetime', detectedName: 'D', detectedDomain: 'light', room: '' };
    // With it, every row of the form and its Climate modes, unsaved ones included: the entity id and the modes
    // come out as saving them would give them, resolved over every picked device (review m1, Ruling 141).
    const other = { objectId: 'hm-rpc.0.A', include: true, name: '', forcedDomain: '', detectedName: 'D', detectedDomain: 'light', room: '' };
    const climateModes = [{ device: 'hm-rpc.0.T.1', deviceMode: 'MANU "1"', panelMode: 'heat' }];
    const form = { brokerPassword: 'x', deviceOverrides: [other, row], climateModes };
    expect(JSON.parse(evaluatePattern(preview.jsonData!, { _origin: 'http://x', _originIp: 'http://y', ...row }, form))).to.deep.equal({
      objectId: row.objectId,
      forcedDomain: 'datetime',
      name: 'Licht "oben"',
      rows: [other, row],
      climateModes,
    });
    // A form that holds neither yet, and a json-config that passes no globalData: null, and the adapter takes the saved ones.
    expect(JSON.parse(evaluatePattern(preview.jsonData!, row, {}))).to.include({ rows: null, climateModes: null });
    expect(JSON.parse(evaluatePattern(preview.jsonData!, row))).to.include({ rows: null, climateModes: null });
    // A row the table's "+" added holds null in each column (ConfigTable.onAdd), and an earlier
    // version's row has no name or forced type at all: still JSON (JSON.stringify(undefined) is
    // no text), and text.
    expect(JSON.parse(evaluatePattern(preview.jsonData!, { objectId: null, include: false, name: null, forcedDomain: null }))).to.deep.equal({
      objectId: '',
      forcedDomain: '',
      name: '',
      rows: null,
      climateModes: null,
    });
    expect(JSON.parse(evaluatePattern(preview.jsonData!, { objectId: 'hue.0.a', include: true }))).to.deep.equal({
      objectId: 'hue.0.a',
      forcedDomain: '',
      name: '',
      rows: null,
      climateModes: null,
    });
    // Each error the adapter answers the preview with has a text of its own (ConfigSendto: schema.error[response.error]).
    const { errors } = answered('previewEntity');
    expect(errors.length, 'the preview answers errors').to.be.greaterThan(1);
    expect(Object.keys(preview.error!)).to.have.members(errors);
    // No button anywhere asks for a preview without naming the object: the one below the tables did (Task 21b C5).
    const previews: Array<Record<string, unknown>> = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (record.type === 'sendTo' && record.command === 'previewEntity') previews.push(record);
      for (const value of Object.values(record)) walk(value);
    };
    walk(config.items);
    expect(previews).to.deep.equal([preview]);
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

  it('offers the instances that answer getHistory as the history instance, none meaning the system default (Task 19)', () => {
    const field = config.items.advanced.items.historyInstance;
    // json-config 10.0.6 ConfigInstanceSelect: `_dataSources` lists every
    // instance whose common.getHistory is set (:17-25), and unless
    // allowDeactivate is false a "none" choice stores ConfigGeneric.NONE_VALUE,
    // '' (:54-56; ConfigGeneric.js:57), the value validateOptions keeps as none.
    expect(field).to.include({ type: 'instance', adapter: '_dataSources' });
    expect(field.allowDeactivate).to.not.equal(false);
    expect(field).to.not.have.property('long');
    expect(field).to.not.have.property('short');
    expect(ioPackage.native.historyInstance).to.equal('');
    const { options, warnings } = validateOptions({ historyInstance: ioPackage.native.historyInstance });
    expect([options.historyInstance, warnings]).to.deep.equal(['', []]);
  });

  it('lets the user declare energy meters: a state, a category the panel draws, a direction, a name and a price (Task 20b)', () => {
    const table = config.items.energy.items.energyMeters;
    expect(table.type).to.equal('table');
    const byAttr = columns(table);
    // Exactly the fields validateOptions keeps of a complete row.
    const row: EnergyMeterRow = { stateId: 'shelly.0.em.returned', category: 'grid', sign: -1, name: 'Einspeisung', price: 0.08 };
    expect(Object.keys(byAttr)).to.have.members(Object.keys(validateOptions({ energyMeters: [row] }).options.energyMeters[0]!));
    expect(byAttr.stateId).to.include({ type: 'objectId' });
    expect(byAttr.stateId!.types).to.deep.equal(['state']);
    // json-config 10.0.6 ConfigSelect keeps an option's value as it is, a number too (MenuItem value :257, onChange :239).
    expect(byAttr.category!.options!.map((option) => option.value)).to.deep.equal([...ENERGY_CATEGORIES]);
    expect(byAttr.sign!.options!.map((option) => option.value)).to.deep.equal([1, -1]);
    // ConfigNumber stores a number, or '' once cleared (:154-170); a price is never negative.
    expect(byAttr.price).to.include({ type: 'number', min: 0 });
    expect(byAttr.name).to.include({ type: 'text' });
    // ConfigTable marks a repeated state (validateUniqueProps, :355-380); validateOptions keeps the first anyway.
    expect(table.uniqueColumns).to.deep.equal(['stateId']);
    // A row the admin adds holds each column's default, else null (ConfigTable.onAdd, :704-732):
    // once its state is picked it is a meter, and costs no warning.
    const added = Object.fromEntries(table.items.map((column: Column) => [column.attr, column.default ?? null]));
    const { options, warnings } = validateOptions({ energyMeters: [{ ...added, stateId: 'shelly.0.em.total' }] as EnergyMeterRow[] });
    expect(options.energyMeters).to.deep.equal([{ stateId: 'shelly.0.em.total', category: 'grid', sign: 1 }]);
    expect(warnings).to.deep.equal([]);
    expect(ioPackage.native.energyMeters).to.deep.equal([]);
  });

  it('offers a device row no export sign: the adapter takes a device as consumption only (Task 23, energy round 2 C1)', () => {
    const sign = columns(config.items.energy.items.energyMeters).sign!;
    // json-config hides an option whose `hidden` formula holds, evaluated over the row
    // (ConfigSelect.isHidden: executeCustom(item.hidden, data); a table cell's data is its row).
    const shown = (category: string): unknown[] =>
      sign
        .options!.filter((option) => {
          if (!option.hidden) return true;
          return !new Function('data', option.hidden.includes('return') ? option.hidden : `return ${option.hidden}`)({ stateId: 'x.0.m', category, sign: 1 });
        })
        .map((option) => option.value);
    for (const category of ENERGY_CATEGORIES) {
      const expected = category === 'device' || category === 'device_water' ? [1] : [1, -1];
      expect(shown(category), category).to.deep.equal(expected);
      // What it offers, validateOptions keeps as it is.
      for (const value of expected) {
        const { options, warnings } = validateOptions({ energyMeters: [{ stateId: 'x.0.m', category, sign: value }] as EnergyMeterRow[] });
        expect([options.energyMeters[0]?.sign, warnings], `${category} ${String(value)}`).to.deep.equal([value, []]);
      }
    }
  });

  it('asks for the currency the prices are in, EUR by default (Task 20b)', () => {
    const field = config.items.energy.items.currency;
    expect(field).to.include({ type: 'text' });
    expect(ioPackage.native.currency).to.equal('EUR');
    expect(validateOptions({ currency: ioPackage.native.currency }).options.currency).to.equal('EUR');
  });

  it('asks for counters that only grow, never one that resets daily: its week and month would be wrong (review m5)', () => {
    expect(translations.en!.energy_info).to.include('never a counter that resets daily');
    expect(translations.de!.energy_info).to.include('nie ein Zähler, der täglich zurückgesetzt wird');
  });

  it("gives the signs the house's consumption depends on: solar and discharge import, charging export (review N3)", () => {
    expect(translations.en!.energy_info).to.include('Solar and battery discharge count as import; battery charging, like grid feed-in, as export.');
    expect(translations.de!.energy_info).to.include('PV und Batterieentladung zählen als Bezug; das Laden der Batterie, wie die Netzeinspeisung, als Abgabe.');
  });

  it('warns on the Energy tab too that meters alone prune the panels once Refresh is saved, to export their layout first (Ruling 131)', () => {
    for (const [language, strings] of Object.entries(translations)) {
      expect(strings.energy_info, language).to.include(strings.refresh_detected);
      expect(strings.energy_info, language).to.match(/export/i);
    }
  });

  it("names each category's total in every language, where the Bridge sends German (Ruling 124)", () => {
    for (const [language, strings] of Object.entries(translations)) {
      for (const category of ENERGY_CATEGORIES) expect(strings, language).to.have.property(`energy_total_${category}`);
    }
    expect(translations.de!.energy_total_grid).to.equal('Netz gesamt');
  });

  it("names the house's consumption totals in every language, the Bridge's German in German (Ruling 132)", () => {
    for (const [language, strings] of Object.entries(translations)) {
      expect(strings, language).to.have.property('energy_consumption_total');
      expect(strings, language).to.have.property('energy_consumption_untracked');
    }
    // __init__.py:2906, :2939
    expect(translations.de!.energy_consumption_total).to.equal('Gesamtverbrauch');
    expect(translations.de!.energy_consumption_untracked).to.equal('Nicht erfasster Verbrauch');
  });

  it('wires each action button to a command the adapter implements', () => {
    // Read from main.ts itself, so a command it stops answering fails here.
    expect([...handled]).to.include.members(['listDetected', 'refreshDetected', 'testBroker', 'previewEntity', 'pairPanel', 'climateDevices']);
    const commands = handled;
    const found = new Set<string>();
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      // A selectSendTo asks for its options the same way (json-config ConfigSelectSendTo.askInstance).
      if ((record.type === 'sendTo' || record.type === 'selectSendTo') && typeof record.command === 'string') found.add(record.command);
      for (const value of Object.values(record)) walk(value);
    };
    walk(config.items);
    expect(found).to.include('climateDevices');
    for (const command of found) expect(commands, `unknown command ${command}`).to.include(command);
  });

  it('names the Refresh button in every language, and warns that saving a pick prunes the panels, to export their layout first (Rulings 118, 119 M6)', () => {
    for (const [language, strings] of Object.entries(translations)) {
      expect(strings.devices_info, language).to.include(strings.refresh_detected);
      expect(strings.devices_info, language).to.match(/export/i);
    }
  });

  it('says in every language that saving after Refresh publishes every manual entity too, ticked rows or not (Ruling 120, N3)', () => {
    for (const [language, strings] of Object.entries(translations)) {
      expect(strings.devices_info, language).to.include(strings.manual_entities);
      expect(strings.refresh_result, language).to.include(strings.manual_entities);
    }
  });

  it("says on the Devices tab too, in every language, that saving after Refresh publishes the Energy tab's meters, ticked rows or not (Task 23, Ruling 131)", () => {
    for (const [language, strings] of Object.entries(translations)) {
      expect(strings.devices_info, language).to.include(strings.tab_energy);
      expect(strings.refresh_result, language).to.include(strings.tab_energy);
    }
  });

  it("maps a thermostat's own modes to the panel's on the Climate modes table: a detected thermostat, its mode as its state holds it, a panel mode by the panel's own names (Ruling 141)", () => {
    const items = config.items.devices.items;
    const table = items.climateModes;
    expect(table).to.include({ type: 'table', label: 'climate_modes' });
    // Explained right above it.
    const keys = Object.keys(items);
    expect(keys.indexOf('_climateModesInfo')).to.equal(keys.indexOf('climateModes') - 1);
    expect(items._climateModesInfo).to.include({ type: 'staticText', text: 'climate_modes_info' });
    const byAttr = columns(table);
    // The row's fields are the ones validateOptions keeps, and no more.
    const kept = validateOptions({ climateModes: [{ device: 'd', deviceMode: 'm', panelMode: 'heat' }] }).options.climateModes;
    expect(Object.keys(byAttr)).to.deep.equal(Object.keys(kept[0]!));
    // The thermostats the adapter detected, asked for as the list opens (json-config ConfigSelectSendTo: a list of
    // {label, value}); a device's name is no translation key. Typed by hand while the adapter is not running.
    expect(byAttr.device).to.include({ type: 'selectSendTo', command: 'climateDevices', noTranslation: true });
    expect(handled).to.include('climateDevices');
    expect(byAttr.deviceMode).to.include({ type: 'text' });
    // Exactly the firmware's hvac names, each under a label of its own, none chosen for the user.
    expect(byAttr.panelMode).to.include({ type: 'select' }).and.not.have.property('default');
    expect(byAttr.panelMode!.options!.map((option) => option.value)).to.deep.equal([...HVAC_MODE_NAMES]);
    expect(byAttr.panelMode!.options!.map((option) => option.label)).to.deep.equal(HVAC_MODE_NAMES.map((name) => `hvac_${name}`));
    // Named as the panel names them (HomeTiles src/core/i18n/i18n.cpp:1331-1332, 1412-1413, read only).
    expect(HVAC_MODE_NAMES.map((name) => translations.en![`hvac_${name}`])).to.deep.equal(['Off', 'Heat', 'Cool', 'Heat/Cool', 'Auto', 'Dry', 'Fan only']);
    expect(HVAC_MODE_NAMES.map((name) => translations.de![`hvac_${name}`])).to.deep.equal(['Aus', 'Heizen', 'Kühlen', 'Heizen/Kühlen', 'Auto', 'Entfeuchten', 'Lüfter']);
    for (const [language, strings] of Object.entries(translations)) {
      for (const column of table.items as Column[]) expect(strings, `${language}: ${column.title}`).to.have.property(column.title!);
      expect(strings.climate_modes_info, language).to.include(strings.column_panel_mode);
    }
  });

  it("says on the Energy tab, in every language, to save and reopen the settings when Direction offers no export after a row's Category changed (review m4)", () => {
    for (const [language, strings] of Object.entries(translations)) {
      expect(strings.energy_info, language).to.include(strings.column_sign).and.include(strings.column_category);
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
      // A sendTo's result and error texts are translations too (json-config types.d.ts,
      // ConfigItemSendTo; ConfigSendto._onClick passes each through getText).
      if (record.type === 'sendTo') {
        for (const texts of [record.result, record.error]) {
          for (const value of Object.values((texts ?? {}) as Record<string, unknown>)) if (typeof value === 'string') referenced.add(value);
        }
      }
      for (const value of Object.values(record)) walk(value);
    };
    walk(config.items);

    expect(referenced.size, 'the walk must actually find identifiers').to.be.greaterThan(20);
    expect(referenced, 'the result text').to.include('refresh_result');
    expect(referenced, 'an error text').to.include('preview_no_entity');
    for (const key of referenced) {
      for (const [language, strings] of Object.entries(translations)) {
        expect(strings, `${language}.json is missing "${key}"`).to.have.property(key);
      }
    }
  });

  it('defines in every language each text the adapter itself reads from admin/i18n (Task 23)', () => {
    // main.ts writes these into the admin form or its replies (adminText, adminTexts), in the system language.
    const read = new Set([...MAIN.matchAll(/adminTexts?\('([a-z_]+)'/g)].map((match) => match[1]!));
    expect([...read]).to.include.members(['not_detected', 'energy_consumption_total', 'preview_degraded', 'preview_no_state']);
    // And what a device lacks for a type (synth lacks, Ruling 139): the preview's reason, and the log's in English.
    expect(MAIN).to.include('adminText(`lack_${');
    for (const lack of LACKS) read.add(`lack_${lack}`);
    for (const key of read) {
      for (const [language, strings] of Object.entries(translations)) expect(strings, `${language}.json is missing "${key}"`).to.have.property(key);
    }
  });

  it('uses every text it defines: in the form, as a text the adapter reads, or as the title of its preview dialog (review m5)', () => {
    // Anywhere in jsonConfig.json: a label, a title, a text, an option, a sendTo's result or error text.
    const inForm = new Set<string>();
    const walk = (node: unknown): void => {
      if (typeof node === 'string') inForm.add(node);
      else if (node && typeof node === 'object') for (const value of Object.values(node)) walk(value);
    };
    walk(config);
    // What main.ts reads with adminText/adminTexts, the keys it builds from a prefix among them.
    const read = new Set([...MAIN.matchAll(/adminTexts?\('([a-z_]+)'/g)].map((match) => match[1]!));
    expect(MAIN).to.include('adminText(`energy_total_${category}`');
    for (const category of ENERGY_CATEGORIES) read.add(`energy_total_${category}`);
    expect(MAIN).to.include('adminText(`lack_${');
    for (const lack of LACKS) read.add(`lack_${lack}`);
    // The preview's copyDialog title, which admin translates (ConfigSendto.renderCopyDialog).
    expect(MAIN).to.include("copyDialog: { title: 'column_preview'");
    read.add('column_preview');
    const dead = Object.keys(translations.en!).filter((key) => !inForm.has(key) && !read.has(key));
    expect(dead).to.deep.equal([]);
  });

  /** The codes one case of main.ts's onMessage answers with: `result: '…'` and `error: '…'`. */
  function answered(command: string): { results: string[]; errors: string[] } {
    const start = MAIN.indexOf(`case '${command}'`);
    const body = MAIN.slice(start, MAIN.indexOf("case '", start + 1));
    const codes = (key: string): string[] => [...new Set([...body.matchAll(new RegExp(`${key}: '([a-z_]+)'`, 'g'))].map((match) => match[1]!))];
    return { results: codes('result'), errors: codes('error') };
  }

  it('tests the broker with the Connection tab as typed, unsaved fields included, and shows what came of it (Ruling 140)', () => {
    const button = config.items.connection.items._testBroker;
    expect(button).to.include({ type: 'sendTo', command: 'testBroker', useNative: true, showProcess: true });
    expect(button).to.not.have.property('data');
    // Evaluated over the form's data (json-config ConfigSendto._onClick), what is typed and not saved yet included.
    // A password that would break a pattern or a JSON literal, were it spliced in raw:
    const typed = {
      brokerHost: ' mqtt.lan ',
      brokerPort: 8883,
      brokerTls: true,
      brokerUser: 'päneel',
      brokerPassword: 'ge"heim\\ `1` ${data.x} }\n',
      clientId: 'tab5',
    };
    const form = { ...typed, baseTopic: 'hometiles', deviceOverrides: [], _origin: 'http://x', _originIp: 'http://y' };
    expect(JSON.parse(evaluatePattern(button.jsonData, form))).to.deep.equal(typed);
    // A port the number field was cleared of ('', json-config ConfigNumber) goes as it is: the adapter says it is none.
    expect(JSON.parse(evaluatePattern(button.jsonData, { ...form, brokerPort: '' })).brokerPort).to.equal('');
    // Fields the form does not hold yet are sent empty, never as broken JSON.
    expect(JSON.parse(evaluatePattern(button.jsonData, {}))).to.deep.equal({
      brokerHost: '',
      brokerPort: null,
      brokerTls: false,
      brokerUser: '',
      brokerPassword: '',
      clientId: '',
    });
    // Each answer has a text of its own (ConfigSendto: schema.result[result], schema.error[error]); "Ok" alone is never one.
    const { results, errors } = answered('testBroker');
    expect(Object.keys(button.result)).to.have.members(results);
    expect(Object.keys(button.error)).to.have.members(errors);
    expect(results).to.deep.equal(['connected']);
    expect(errors).to.have.members(['invalid_port', 'failed', 'timeout']);
  });

  it('pairs the panel at the address typed on the Panels tab, a field never saved, and shows what came of it (Ruling 140)', () => {
    const panels = config.items.panels.items;
    // An underscore keeps it out of the saved config (json-config JsonConfig.onSave), not out of the form's data.
    expect(panels._pairHost).to.include({ type: 'text', label: 'pair_host' });
    expect(Object.keys(panels).indexOf('_pairHost')).to.be.below(Object.keys(panels).indexOf('_pairPanel'));
    const button = panels._pairPanel;
    expect(button).to.include({ type: 'sendTo', command: 'pairPanel', useNative: true, showProcess: true });
    expect(button).to.not.have.property('data');
    expect(JSON.parse(evaluatePattern(button.jsonData, { brokerHost: 'x', _pairHost: ' 192.168.1.50 ' }))).to.deep.equal({ host: ' 192.168.1.50 ' });
    expect(JSON.parse(evaluatePattern(button.jsonData, {}))).to.deep.equal({ host: '' });
    // Each answer has a text: success, and every failure pushCredentials names (pairing.ts).
    const { results } = answered('pairPanel');
    expect(results).to.deep.equal(['paired']);
    expect(Object.keys(button.result)).to.deep.equal(results);
    expect(Object.keys(button.error)).to.have.members([...PAIRING_FAILURES]);
  });
});
