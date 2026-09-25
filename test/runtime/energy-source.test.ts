import { expect } from 'chai';
import sinon from 'sinon';
import { buildApplyPayload } from '../../src/protocol/apply';
import { MAX_ENERGY_BYTES, MAX_ENERGY_VALUES, type EnergyCategory, type EnergyEntry, type EnergyPeriod } from '../../src/protocol/energy';
import type { IoBrokerObject } from '../../src/registry/detector';
import {
  consumption,
  energyCatalog,
  energyEntries,
  energyMeters,
  energyPeriod,
  EnergySource,
  localIso,
  type Consumption,
  type EnergyConfig,
  type EnergyMeter,
  type EnergyNames,
  type TotalNames,
} from '../../src/runtime/energy-source';
import { HISTORY_BUDGET_MS, HistoryProvider, PANEL_QUERIES, type Readings } from '../../src/runtime/history-provider';
import { panelEnergy, panelTotalText } from '../protocol/panel-energy';
import { panelEnergyCatalog } from '../protocol/panel-scan';
import { historyFake, logger, sqlFake, type Stored } from './history-ports';

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** A local time in the zone the tests set, month 1-based. */
const at = (year: number, month: number, day: number, hour = 0, minute = 0): number => new Date(year, month - 1, day, hour, minute).getTime();
/** The local hour of each time. */
const hours = (times: number[]): number[] => times.map((time) => new Date(time).getHours());

const TOTALS: TotalNames = {
  grid: 'Grid total',
  solar: 'Solar total',
  battery: 'Battery total',
  gas: 'Gas total',
  water: 'Water total',
  device: 'Devices total',
  device_water: 'Water devices total',
};
const NAMES: EnergyNames = { totals: TOTALS, consumption: 'Total consumption', untracked: 'Untracked consumption' };

/** A meter's, its cost's and its category's entries: the house's consumption apart (Ruling 132). */
const ownEntries = (...args: Parameters<typeof energyEntries>): EnergyEntry[] => energyEntries(...args).filter((entry) => entry.category !== 'consumption');
/** The entry of `id` in an energy/response. */
const entryOf = (payload: string, id = 'energy.netzbezug'): EnergyEntry => (JSON.parse(payload).entries as EnergyEntry[]).find((entry) => entry.id === id)!;

function meter(over: Partial<EnergyMeter> = {}): EnergyMeter {
  return { id: 'energy.netzbezug', stateId: 'shelly.0.em.total', category: 'grid', sign: 1, name: 'Netzbezug', unit: 'kWh', ...over };
}

const series = (entries: Array<[string, Consumption]>): Map<string, Consumption> => new Map(entries);

describe('runtime/energy-source', () => {
  let zone: string | undefined;
  before(() => {
    zone = process.env.TZ;
    // A zone with summer time: its days of 23 and 25 hours.
    process.env.TZ = 'Europe/Berlin';
  });
  after(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  describe('energyMeters: the Energy tab rows as meters', () => {
    const counter = (common: Record<string, unknown> = {}): IoBrokerObject => ({
      type: 'state',
      common: { name: 'Zählerstand', type: 'number', role: 'value.energy.consumed', unit: 'kWh', ...common },
    });
    const logged = { custom: { 'history.0': { enabled: true } } };

    it('makes each row a meter: its stored id, the name of the row or else of the object, the unit of the object', () => {
      const objects = {
        'shelly.0.em.total': counter({ name: 'Total', ...logged }),
        'shelly.0.em.returned': counter({ name: { en: 'Returned', de: 'Eingespeist' }, ...logged }),
        'modbus.0.pv': counter({ unit: undefined, type: 'mixed', ...logged }),
      };
      const { meters, ids, rejected, unlogged } = energyMeters(
        [
          { stateId: 'shelly.0.em.total', category: 'grid', sign: 1, name: 'Netzbezug', price: 0.32 },
          { stateId: 'shelly.0.em.returned', category: 'grid', sign: -1 },
          { stateId: 'modbus.0.pv', category: 'solar', sign: 1 },
        ],
        objects,
        { 'energy:shelly.0.em.total': 'energy.hausanschluss' },
        'hometiles.0',
        'history.0',
      );
      expect(meters).to.deep.equal([
        { id: 'energy.hausanschluss', stateId: 'shelly.0.em.total', category: 'grid', sign: 1, name: 'Netzbezug', unit: 'kWh', price: 0.32 },
        // A translated name is read as the id's last segment, as detection reads one (objectMeta).
        { id: 'energy.returned', stateId: 'shelly.0.em.returned', category: 'grid', sign: -1, name: 'returned', unit: 'kWh' },
        { id: 'energy.zahlerstand', stateId: 'modbus.0.pv', category: 'solar', sign: 1, name: 'Zählerstand' },
      ]);
      expect(ids).to.deep.equal({
        'energy:shelly.0.em.total': 'energy.hausanschluss',
        'energy:shelly.0.em.returned': 'energy.returned',
        'energy:modbus.0.pv': 'energy.zahlerstand',
      });
      expect(rejected).to.deep.equal([]);
      expect(unlogged).to.deep.equal([]);
    });

    it('leaves out a row whose state cannot be a counter, naming why', () => {
      const objects: Record<string, IoBrokerObject> = {
        'x.0.channel': { type: 'channel', common: { name: 'Kanal' } },
        'x.0.flag': counter({ type: 'boolean' }),
        'x.0.text': counter({ type: 'string' }),
        'hometiles.0.info.entities': counter(),
      };
      const rows = ['x.0.missing', 'x.0.channel', 'x.0.flag', 'x.0.text', 'hometiles.0.info.entities'].map((stateId) => ({
        stateId,
        category: 'device' as EnergyCategory,
        sign: 1 as const,
      }));
      const { meters, rejected } = energyMeters(rows, objects, {}, 'hometiles.0', '');
      // A counter written as text is read as a number, as history's rows are (usableNumber).
      expect(meters.map((m) => m.stateId)).to.deep.equal(['x.0.text']);
      expect(rejected).to.deep.equal([
        { stateId: 'x.0.missing', reason: 'no such object' },
        { stateId: 'x.0.channel', reason: 'not a state object (type channel)' },
        { stateId: 'x.0.flag', reason: 'a meter is a number, not a boolean' },
        { stateId: 'hometiles.0.info.entities', reason: "the adapter's own state" },
      ]);
    });

    it('draws a kWh meter named "... cost" with its category icon, never the currency (review m3)', () => {
      const objects = { 'x.0.grid': counter({ name: 'Grid cost' }) };
      const { meters } = energyMeters([{ stateId: 'x.0.grid', category: 'grid', sign: 1 }], objects, {}, 'hometiles.0', '');
      const apply = buildApplyPayload({ entities: [], sceneMap: {}, energy: energyCatalog(meters, 'EUR', NAMES) });
      expect(Object.fromEntries(panelEnergyCatalog(apply)!.icons)).to.deep.equal({ consumption_total: 'lightning-bolt', 'energy.grid_cost_meter': 'transmission-tower' });
    });

    it('names each meter the history instance does not log, and none when there is no instance', () => {
      const objects = {
        'a.0.logged': counter(logged),
        // `enabled` as truthy as the history adapters read it (Task 19 M-3).
        'a.0.script': counter({ custom: { 'history.0': { enabled: 'true' } } }),
        'a.0.other': counter({ custom: { 'sql.0': { enabled: true } } }),
        'a.0.disabled': counter({ custom: { 'history.0': { enabled: 0 } } }),
        'a.0.off': counter(),
      };
      const rows = Object.keys(objects).map((stateId) => ({ stateId, category: 'device' as EnergyCategory, sign: 1 as const }));
      expect(energyMeters(rows, objects, {}, 'hometiles.0', 'history.0').unlogged).to.deep.equal(['a.0.other', 'a.0.disabled', 'a.0.off']);
      expect(energyMeters(rows, objects, {}, 'hometiles.0', '').unlogged).to.deep.equal([]);
    });
  });

  describe('energyPeriod: the buckets, as the Bridge (__init__.py:2657-2668), in local time', () => {
    it('day: every hour from local midnight, the one running included', () => {
      const now = at(2026, 9, 25, 14, 35);
      const { start, boundaries } = energyPeriod('day', now);
      expect(start).to.equal(at(2026, 9, 25));
      expect(boundaries).to.deep.equal(Array.from({ length: 15 }, (_, h) => at(2026, 9, 25) + h * HOUR));
      expect(localIso(start)).to.equal('2026-09-25T00:00:00+02:00');
    });

    it('day: 23 hours on the spring day, the clock skipping 02:00', () => {
      const { boundaries } = energyPeriod('day', at(2026, 3, 29, 23, 30));
      expect(boundaries).to.have.lengthOf(23);
      expect(boundaries.slice(1).map((time, i) => time - boundaries[i]!)).to.satisfy((steps: number[]) => steps.every((step) => step === HOUR));
      expect(hours(boundaries).slice(0, 4)).to.deep.equal([0, 1, 3, 4]);
      expect(boundaries.at(-1)! + HOUR).to.equal(at(2026, 3, 30));
    });

    it('day: 25 hours on the autumn day, the clock going through 02:00 twice', () => {
      const { boundaries } = energyPeriod('day', at(2026, 10, 25, 23, 30));
      expect(boundaries).to.have.lengthOf(25);
      expect(hours(boundaries).slice(0, 5)).to.deep.equal([0, 1, 2, 2, 3]);
      expect(boundaries.at(-1)! + HOUR).to.equal(at(2026, 10, 26));
      expect(localIso(boundaries[3]!)).to.equal('2026-10-25T02:00:00+01:00');
    });

    it('week: the local midnights from 6 days ago, a 25-hour day among them', () => {
      const { start, boundaries } = energyPeriod('week', at(2026, 10, 28, 10));
      expect(boundaries).to.deep.equal([22, 23, 24, 25, 26, 27, 28].map((day) => at(2026, 10, day)));
      expect(start).to.equal(at(2026, 10, 22));
      expect(boundaries[4]! - boundaries[3]!).to.equal(25 * HOUR);
      expect(localIso(start)).to.equal('2026-10-22T00:00:00+02:00');
      expect(localIso(boundaries[4]!)).to.equal('2026-10-26T00:00:00+01:00');
    });

    it('month: every local midnight from the 1st, 31 of them on the 31st', () => {
      const { start, boundaries } = energyPeriod('month', at(2026, 10, 31, 20));
      expect(start).to.equal(at(2026, 10, 1));
      expect(boundaries).to.deep.equal(Array.from({ length: 31 }, (_, i) => at(2026, 10, i + 1)));
      expect(energyPeriod('month', at(2026, 11, 1, 0, 5)).boundaries).to.deep.equal([at(2026, 11, 1)]);
      expect(energyPeriod('month', at(2027, 2, 28, 12)).boundaries).to.have.lengthOf(28);
    });

    it(`never makes more than the ${MAX_ENERGY_VALUES} values a panel keeps (energy_data.h:7), at any hour of a year`, () => {
      let most = 0;
      for (let time = at(2026, 1, 1); time < at(2027, 1, 1); time += HOUR) {
        for (const period of ['day', 'week', 'month'] as EnergyPeriod[]) most = Math.max(most, energyPeriod(period, time + 59 * MINUTE).boundaries.length);
      }
      expect(most).to.equal(31);
      expect(most).to.be.at.most(MAX_ENERGY_VALUES);
    });
  });

  describe('consumption: the counter increase per bucket, from the reading before each boundary', () => {
    it('counts each bucket up to the next reading, and the running one up to the live one', () => {
      const { values, total } = consumption([1000, 1000.5, 1001.25], 1001.5);
      expect(values).to.deep.equal([0.5, 0.75, 0.25]);
      expect(total).to.equal(1.5);
    });

    it('counts a decrease as a reset: that bucket 0, the next from the new reading', () => {
      expect(consumption([1000, 1002, 3], 5)).to.deep.equal({ values: [2, 0, 2], total: 4 });
    });

    it('gives a bucket with no reading before it yet null, and the total the rest', () => {
      expect(consumption([null, null, 7], 9)).to.deep.equal({ values: [null, null, 2], total: 2 });
      // A reading before the period counts from the period start.
      expect(consumption([990, 1000], 1001)).to.deep.equal({ values: [10, 1], total: 11 });
    });

    it('gives the running bucket null when the live reading is none', () => {
      expect(consumption([1, 2], null)).to.deep.equal({ values: [1, null], total: 1 });
    });

    it('has no total when no bucket has a value', () => {
      expect(consumption([null, null], null)).to.deep.equal({ values: [null, null], total: null });
      expect(consumption([], 5)).to.deep.equal({ values: [], total: null });
    });

    it('reads noise below 1e-9 as no change, as the Bridge does (__init__.py:2729-2730)', () => {
      expect(consumption([0.1 + 0.2, 0.3], 0.3).values).to.deep.equal([0, 0]);
    });

    it('spans a gap in the total: the increase between each two readings known, the bars null where unknown (review I1)', () => {
      expect(consumption([1000, null, 1002], 1003)).to.deep.equal({ values: [null, null, 1], total: 3 });
      // Every bucket unknown, both ends known.
      expect(consumption([1000, null, null], 1005)).to.deep.equal({ values: [null, null, null], total: 5 });
      // A reset inside the gap counts as one: only increases.
      expect(consumption([1000, null, 5], 7)).to.deep.equal({ values: [null, null, 2], total: 2 });
      // One reading known is no increase.
      expect(consumption([null, 5], null)).to.deep.equal({ values: [null, null], total: null });
    });
  });

  describe('energyEntries: the Bridge\'s entries (__init__.py:2770-2880)', () => {
    it('gives a meter its values to 3 decimals and its total rounded from the unrounded sum', () => {
      const [entry] = ownEntries([meter()], 'EUR', NAMES, series([['energy.netzbezug', { values: [0.0004, 0.0004, 0.0004, null], total: 0.0012 }]]));
      expect(entry).to.deep.equal({
        id: 'energy.netzbezug',
        category: 'grid',
        sign: 1,
        values: [0, 0, 0, null],
        total: 0.001,
        name: 'Netzbezug',
        unit: 'kWh',
      });
    });

    it('sends an export meter its values as measured and its total signed; the panel signs each once', () => {
      const exported = meter({ id: 'energy.einspeisung', sign: -1 });
      const entries = ownEntries([exported], 'EUR', NAMES, series([['energy.einspeisung', { values: [1.2, 0.3], total: 1.5 }]]));
      expect(entries[0]).to.include({ total: -1.5, sign: -1 });
      expect(entries[0]!.values).to.deep.equal([1.2, 0.3]);
      const [panel] = panelEnergy(JSON.stringify({ period: 'day', entries }))!.entries;
      expect(panel!.values).to.deep.equal([-1.2, -0.3]);
      expect(panel!.total).to.equal(-1.5);
      expect(panelTotalText(panel!.total, false)).to.equal('-1.500');
    });

    it('adds a cost entry for a meter with a price: the rounded values priced, to 4 decimals, the total to 2', () => {
      const priced = meter({ price: 0.3 });
      const entries = ownEntries([priced], 'EUR', NAMES, series([['energy.netzbezug', { values: [1.2345, null, 0.5], total: 1.7345 }]]));
      expect(entries).to.have.lengthOf(2);
      expect(entries[1]).to.deep.equal({
        id: 'energy.netzbezug_cost',
        category: 'grid',
        sign: 1,
        // 1.2345 is 1.234 first (Python round), then priced: 0.3702, never 0.3704.
        values: [0.3702, null, 0.15],
        total: 0.52,
        unit: 'EUR',
        is_cost: true,
        name: 'Netzbezug (EUR)',
      });
      const panel = panelEnergy(JSON.stringify({ period: 'day', entries }))!.entries;
      // 1.7345 is 1.734 to Python, as its binary value lies below the tie.
      expect(panel.map((e) => panelTotalText(e.total, e.isCost))).to.deep.equal(['1.734', '0.52']);
    });

    it('spans the gaps in a cost total too, at the same price, and prices the rounded values as the Bridge where there is none (review I1)', () => {
      const [, spanned] = ownEntries([meter({ price: 0.3 })], 'EUR', NAMES, series([['energy.netzbezug', { values: [1, null, null, 1], total: 5 }]]));
      expect(spanned).to.deep.include({ values: [0.3, null, null, 0.3], total: 1.5 });
      const [, unknown] = ownEntries([meter({ price: 0.3 })], 'EUR', NAMES, series([['energy.netzbezug', { values: [null, null], total: 5 }]]));
      expect(unknown).to.deep.include({ values: [null, null], total: 1.5 });
    });

    it('prices an export meter as the Bridge does: its values as they are, its total signed', () => {
      const feedIn = meter({ id: 'energy.einspeisung', sign: -1, price: 0.08 });
      const [, cost] = ownEntries([feedIn], 'EUR', NAMES, series([['energy.einspeisung', { values: [2, 3], total: 5 }]]));
      expect(cost).to.deep.include({ values: [0.16, 0.24], total: -0.4, sign: -1 });
    });

    it('adds a cost entry at a price of 0, and none without a price', () => {
      const data = series([['energy.a', { values: [1], total: 1 }], ['energy.b', { values: [1], total: 1 }]]);
      const entries = ownEntries([meter({ id: 'energy.a', price: 0 }), meter({ id: 'energy.b' })], 'CHF', NAMES, data);
      expect(entries.map((e) => e.id)).to.deep.equal(['energy.a', 'energy.a_cost', 'energy.b', 'grid_total']);
      expect(entries[1]).to.deep.include({ values: [0], total: 0, unit: 'CHF' });
    });

    it('sends no total for a meter with no value, nor for its cost', () => {
      const entries = ownEntries([meter({ price: 0.3 })], 'EUR', NAMES, series([['energy.netzbezug', { values: [null, null], total: null }]]));
      for (const entry of entries) {
        expect(entry, entry.id).to.not.have.property('total');
        expect(entry.values, entry.id).to.deep.equal([null, null]);
      }
    });

    it('totals a category of two or more, kWh and cost apart, signed, under a translated name (__init__.py:2826-2880)', () => {
      const meters = [
        meter({ id: 'energy.bezug', price: 0.3 }),
        meter({ id: 'energy.einspeisung', sign: -1, price: 0.08 }),
        meter({ id: 'energy.pv', category: 'solar' }),
      ];
      const data = series([
        ['energy.bezug', { values: [1, null, 2], total: 3 }],
        ['energy.einspeisung', { values: [0.5, null, null], total: 0.5 }],
        ['energy.pv', { values: [4, 4, 4], total: 12 }],
      ]);
      const names: EnergyNames = { ...NAMES, totals: { ...TOTALS, grid: 'Netz gesamt' } };
      const entries = ownEntries(meters, 'EUR', names, data);
      expect(entries.map((e) => e.id)).to.deep.equal([
        'energy.bezug',
        'energy.bezug_cost',
        'energy.einspeisung',
        'energy.einspeisung_cost',
        'energy.pv',
        'grid_total',
        'grid_total_cost',
      ]);
      expect(entries[5]).to.deep.equal({
        id: 'grid_total',
        category: 'grid',
        sign: 1,
        name: 'Netz gesamt',
        values: [0.5, null, 2],
        total: 2.5,
        is_total: true,
        unit: 'kWh',
      });
      expect(entries[6]).to.deep.equal({
        id: 'grid_total_cost',
        category: 'grid',
        sign: 1,
        name: 'Netz gesamt (EUR)',
        values: [0.26, null, 0.6],
        total: 0.86,
        is_total: true,
        unit: 'EUR',
        is_cost: true,
      });
      // The panel leaves a total alone: its sign is 1.
      const panel = panelEnergy(JSON.stringify({ period: 'day', entries }))!.entries;
      expect(panel.find((e) => e.id === 'grid_total')!.values).to.deep.equal([0.5, null, 2]);
    });

    it('gives a category total no total while no member has one', () => {
      const data = series([
        ['energy.a', { values: [null], total: null }],
        ['energy.b', { values: [null], total: null }],
      ]);
      const [, , total] = ownEntries([meter({ id: 'energy.a' }), meter({ id: 'energy.b' })], 'EUR', NAMES, data);
      expect(total).to.deep.include({ id: 'grid_total', values: [null] });
      expect(total).to.not.have.property('total');
    });
  });

  describe("energyEntries: the house's consumption, as the Bridge's (__init__.py:2882-2944, Ruling 132)", () => {
    it('sums every grid, solar and battery meter, each signed -- export and charging count negative -- slot by slot; untracked less the devices; named; first', () => {
      const meters = [
        meter({ id: 'energy.bezug', price: 0.3 }),
        meter({ id: 'energy.einspeisung', sign: -1 }),
        meter({ id: 'energy.pv', category: 'solar' }),
        meter({ id: 'energy.akku_laden', category: 'battery', sign: -1 }),
        meter({ id: 'energy.waschen', category: 'device' }),
        meter({ id: 'energy.gas', category: 'gas', unit: 'm³' }),
      ];
      const data = series([
        ['energy.bezug', { values: [1, 0, 2], total: 3 }],
        ['energy.einspeisung', { values: [0.5, 0, 0], total: 0.5 }],
        ['energy.pv', { values: [4, 4, 4], total: 12 }],
        ['energy.akku_laden', { values: [1, 0, 0], total: 1 }],
        ['energy.waschen', { values: [0.2, 0.3, null], total: 0.5 }],
        ['energy.gas', { values: [1, 1, 1], total: 3 }],
      ]);
      const entries = energyEntries(meters, 'EUR', { ...NAMES, consumption: 'Gesamtverbrauch', untracked: 'Nicht erfasster Verbrauch' }, data);
      expect(entries.slice(0, 2)).to.deep.equal([
        { id: 'consumption_total', category: 'consumption', sign: 1, name: 'Gesamtverbrauch', unit: 'kWh', values: [3.5, 4, 6], total: 13.5, is_total: true },
        { id: 'consumption_untracked', category: 'consumption', sign: 1, name: 'Nicht erfasster Verbrauch', unit: 'kWh', values: [3.3, 3.7, 6], total: 13, is_total: true },
      ]);
      // No cost entry, category total or gas meter counts; the rest follow as before. First, the size
      // guard strips them last (energy.ts buildEnergyResponse, review trap 8).
      expect(entries.slice(2).map((e) => e.id)).to.deep.equal([
        'energy.bezug',
        'energy.bezug_cost',
        'energy.einspeisung',
        'energy.pv',
        'energy.akku_laden',
        'energy.waschen',
        'energy.gas',
        'grid_total',
      ]);
      // The panel leaves them as they are: their sign is 1.
      const panel = panelEnergy(JSON.stringify({ period: 'day', entries }))!.entries;
      expect(panel.slice(0, 2).map((e) => [e.values, e.total])).to.deep.equal([
        [[3.5, 4, 6], 13.5],
        [[3.3, 3.7, 6], 13],
      ]);
    });

    it("subtracts a device meter's values as measured and its total as signed, as the Bridge (:2918, :2928); no untracked without a device", () => {
      const data = series([
        ['energy.bezug', { values: [2, 2], total: 4 }],
        ['energy.balkon', { values: [0.5, null], total: 0.5 }],
      ]);
      // The Bridge's arithmetic; the Energy tab refuses a device of sign -1 since review N1 (validateOptions).
      const entries = energyEntries([meter({ id: 'energy.bezug' }), meter({ id: 'energy.balkon', category: 'device', sign: -1 })], 'EUR', NAMES, data);
      expect(entries[1]).to.deep.include({ id: 'consumption_untracked', values: [1.5, 2], total: 4.5 });
      expect(energyEntries([meter({ id: 'energy.bezug' })], 'EUR', NAMES, data).map((e) => e.id)).to.deep.equal(['consumption_total', 'energy.bezug']);
    });

    it("is known only where every grid, solar and battery meter is: a partial sum would read as the house's (review N2)", () => {
      const meters = [
        meter({ id: 'energy.bezug' }),
        meter({ id: 'energy.einspeisung', sign: -1 }),
        meter({ id: 'energy.pv', category: 'solar' }),
        meter({ id: 'energy.waschen', category: 'device' }),
      ];
      const house = (pv: Consumption): EnergyEntry[] =>
        energyEntries(
          meters,
          'EUR',
          NAMES,
          series([
            ['energy.bezug', { values: [1, 1], total: 2 }],
            ['energy.einspeisung', { values: [7, 8], total: 15 }],
            ['energy.pv', pv],
            // A device not known counts 0, as in the Bridge: only the electric meters must be complete.
            ['energy.waschen', { values: [0.5, null], total: 0.5 }],
          ]),
        ).slice(0, 2);
      // The review's probe: import 2 and export 15 with solar unknown read [-6, -7] and -13 as the house's.
      for (const entry of house({ values: [null, null], total: null })) {
        expect(entry.values, entry.id).to.deep.equal([null, null]);
        expect(entry, entry.id).to.not.have.property('total');
      }
      // Complete: 2 - 15 + 20.
      const [total, untracked] = house({ values: [10, 10], total: 20 });
      expect(total).to.deep.include({ id: 'consumption_total', values: [4, 3], total: 7 });
      expect(untracked).to.deep.include({ id: 'consumption_untracked', values: [3.5, 3], total: 6.5 });
      // Slot by slot: the second slot, and the total, wait for the solar meter.
      for (const entry of house({ values: [10, null], total: null })) {
        expect(entry.values, entry.id).to.deep.equal(entry.id === 'consumption_total' ? [4, null] : [3.5, null]);
        expect(entry, entry.id).to.not.have.property('total');
      }
    });

    it("takes the first meter's unit where the Bridge writes kWh (review trap 7), none when it has none", () => {
      const [wh] = energyEntries([meter({ unit: 'Wh' }), meter({ id: 'energy.pv', category: 'solar' })], 'EUR', NAMES, series([]));
      expect(wh).to.include({ id: 'consumption_total', unit: 'Wh' });
      const [bare] = energyEntries([meter({ unit: undefined })], 'EUR', NAMES, series([]));
      expect(bare).to.include({ id: 'consumption_total' }).and.not.have.property('unit');
    });

    it('makes none without a grid, solar or battery meter: gas and devices alone', () => {
      const entries = energyEntries([meter({ id: 'energy.gas', category: 'gas' }), meter({ id: 'energy.waschen', category: 'device' })], 'EUR', NAMES, series([]));
      expect(entries.map((e) => e.id)).to.deep.equal(['energy.gas', 'energy.waschen']);
    });
  });

  describe('energyCatalog: the bridge/apply catalog (contract §6.4)', () => {
    it('lists every id an answer carries, with its name, unit and category', () => {
      const meters = [meter({ price: 0.3 }), meter({ id: 'energy.einspeisung', sign: -1, name: 'Einspeisung', unit: undefined })];
      const catalog = energyCatalog(meters, 'EUR', NAMES);
      expect(catalog).to.deep.equal([
        { id: 'consumption_total', name: 'Total consumption', unit: 'kWh', category: 'consumption' },
        { id: 'energy.netzbezug', name: 'Netzbezug', unit: 'kWh', category: 'grid' },
        { id: 'energy.netzbezug_cost', name: 'Netzbezug (EUR)', unit: 'EUR', category: 'grid' },
        { id: 'energy.einspeisung', name: 'Einspeisung', category: 'grid' },
        { id: 'grid_total', name: 'Grid total', unit: 'kWh', category: 'grid' },
      ]);
      const answered = energyEntries(meters, 'EUR', NAMES, series([]));
      expect(catalog.map((entry) => entry.id)).to.deep.equal(answered.map((entry) => entry.id));
    });
  });

  describe('EnergySource: the answer to energy/request', () => {
    const NOW = (): number => at(2026, 9, 25, 14, 35);
    /** A counter at 1000 at local midnight, 0.5 more each hour. */
    const reading = (time: number): number => 1000 + ((time - at(2026, 9, 25)) / HOUR) * 0.5;
    let clock: sinon.SinonFakeTimers;
    beforeEach(() => {
      clock = sinon.useFakeTimers({ now: NOW(), toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });
    afterEach(() => clock.restore());

    /** A history that answers every boundary from `read`, and records what it was asked. */
    function fakeHistory(read: (id: string, time: number) => number | null = (_, time) => reading(time)) {
      const asked: Array<{ id: string; times: readonly number[]; panel: string }> = [];
      return {
        asked,
        readingsBefore: async (id: string, times: readonly number[], panel: string): Promise<Readings> => {
          asked.push({ id, times, panel });
          return { readings: times.map((time) => read(id, time)), available: true };
        },
      };
    }
    const states = (live: Record<string, unknown>) => ({ getForeignStateAsync: async (id: string): Promise<unknown> => live[id] ?? null });
    const configured = (over: Partial<EnergyConfig> = {}): EnergyConfig => ({ armed: true, meters: [meter()], currency: 'EUR', names: NAMES, ...over });

    it('answers a day request on energy/response with the consumption of each hour since midnight', async () => {
      const history = fakeHistory();
      const source = new EnergySource(history, states({ 'shelly.0.em.total': { val: 1007.3, q: 0 } }), logger());
      source.configure(configured());
      const answer = await source.answer('a1b2c3', '{"period":"day"}');
      expect(answer!.topic).to.equal('tab5_lvgl/config/a1b2c3/energy/response');
      const parsed = JSON.parse(answer!.payload);
      expect(parsed).to.include({ period: 'day', start: '2026-09-25T00:00:00+02:00' });
      expect((parsed.entries as EnergyEntry[]).map((e) => e.id)).to.deep.equal(['consumption_total', 'energy.netzbezug']);
      const entry = entryOf(answer!.payload);
      expect(entry!.values).to.deep.equal([...Array(14).fill(0.5), 0.3]);
      expect(entry!.total).to.equal(7.3);
      expect(history.asked).to.deep.equal([{ id: 'shelly.0.em.total', times: energyPeriod('day', NOW()).boundaries, panel: 'a1b2c3' }]);
      // What the panel's energy tile shows (energy_data.cpp:173-199).
      const panel = panelEnergy(answer!.payload)!;
      expect(panel.queue).to.equal('day');
      expect(panelTotalText(panel.entries.find((e) => e.id === 'energy.netzbezug')!.total, false)).to.equal('7.300');
    });

    it('answers week and month with a value per day', async () => {
      const source = new EnergySource(fakeHistory(), states({ 'shelly.0.em.total': { val: 1007.3, q: 0 } }), logger());
      source.configure(configured());
      const week = JSON.parse((await source.answer('a1', '{"period":"week"}'))!.payload);
      expect(week).to.include({ period: 'week', start: '2026-09-19T00:00:00+02:00' });
      expect(week.entries[1].values).to.have.lengthOf(7);
      const month = JSON.parse((await source.answer('a1', '{"period":"month"}'))!.payload);
      expect(month).to.include({ period: 'month', start: '2026-09-01T00:00:00+02:00' });
      expect(month.entries[1].values).to.have.lengthOf(25);
    });

    it('answers nothing while the adapter is not armed (Rulings 116, 118), and asks no history', async () => {
      const history = fakeHistory();
      const source = new EnergySource(history, states({}), logger());
      expect(await source.answer('a1', '{"period":"day"}')).to.equal(null);
      source.configure(configured({ armed: false }));
      expect(await source.answer('a1', '{"period":"day"}')).to.equal(null);
      expect(history.asked).to.deep.equal([]);
    });

    it('gives panels its meters only once armed, and while one is set: an apply is worth sending for them alone (Rulings 118, 131)', () => {
      const source = new EnergySource(fakeHistory(), states({}), logger());
      expect([source.content(), source.catalog()]).to.deep.equal([false, []]);
      source.configure(configured({ armed: false }));
      expect([source.content(), source.catalog()]).to.deep.equal([false, []]);
      source.configure(configured({ meters: [] }));
      expect([source.content(), source.catalog()]).to.deep.equal([false, []]);
      source.configure(configured());
      expect([source.content(), source.catalog()]).to.deep.equal([true, energyCatalog([meter()], 'EUR', NAMES)]);
    });

    it('answers nothing to a payload that is no request', async () => {
      const source = new EnergySource(fakeHistory(), states({}), logger());
      source.configure(configured());
      expect(await source.answer('a1', 'not json')).to.equal(null);
    });

    it('answers nothing while no meter is set, and says so once an hour', async () => {
      const log = logger();
      const source = new EnergySource(fakeHistory(), states({}), log);
      source.configure(configured({ meters: [] }));
      expect(await source.answer('a1', '{"period":"day"}')).to.equal(null);
      expect(await source.answer('a1', '{"period":"week"}')).to.equal(null);
      expect(log.lines).to.have.lengthOf(1);
      expect(log.lines[0]).to.include('a1').and.include('Energy tab');
      clock.tick(HOUR);
      await source.answer('a1', '{"period":"day"}');
      expect(log.lines).to.have.lengthOf(2);
    });

    it('ends the running hour at the live reading only when it is good: bad quality or no number is none', async () => {
      for (const live of [{ val: 1007.3, q: 0x42 }, { val: 'n/a', q: 0 }, null]) {
        const source = new EnergySource(fakeHistory(), states({ 'shelly.0.em.total': live }), logger());
        source.configure(configured());
        const entry = entryOf((await source.answer('a1', '{"period":"day"}'))!.payload);
        expect(entry!.values.at(-1), JSON.stringify(live)).to.equal(null);
        expect(entry!.total, JSON.stringify(live)).to.equal(7);
      }
    });

    it('answers a meter the history instance does not log with every value null and no total', async () => {
      const history = fakeHistory((id, time) => (id === 'x.0.unlogged' ? null : reading(time)));
      const meters = [meter(), meter({ id: 'energy.pumpe', stateId: 'x.0.unlogged', category: 'device', price: 0.3 })];
      const source = new EnergySource(history, states({ 'shelly.0.em.total': { val: 1007.3, q: 0 }, 'x.0.unlogged': { val: 55, q: 0 } }), logger());
      source.configure(configured({ meters }));
      const entries = JSON.parse((await source.answer('a1', '{"period":"day"}'))!.payload).entries as EnergyEntry[];
      expect(entries.map((e) => e.id)).to.deep.equal(['consumption_total', 'consumption_untracked', 'energy.netzbezug', 'energy.pumpe', 'energy.pumpe_cost']);
      for (const entry of entries.slice(3)) {
        expect(entry.values, entry.id).to.deep.equal(Array(15).fill(null));
        expect(entry, entry.id).to.not.have.property('total');
      }
    });

    it(`stays within the ${MAX_ENERGY_BYTES} bytes a panel parses, and says once an hour what it left out`, async () => {
      const log = logger();
      const meters = Array.from({ length: 120 }, (_, i) => meter({ id: `energy.zaehler_${i}`, stateId: `x.0.m${i}`, name: `Zähler ${i}`, price: 0.3 }));
      const source = new EnergySource(fakeHistory(), states({}), log);
      source.configure(configured({ meters }));
      const answer = await source.answer('a1', '{"period":"day"}');
      expect(Buffer.byteLength(answer!.payload)).to.be.at.most(MAX_ENERGY_BYTES);
      // The house's consumption, 120 meters, their 120 cost entries, and the grid's two totals: every total goes out.
      const entries = panelEnergy(answer!.payload)!.entries;
      expect(entries).to.have.lengthOf(243);
      // The house's consumption goes first: the last entries lose their values first (review trap 8).
      expect(entries[0]).to.deep.include({ id: 'consumption_total', total: 840 });
      expect(entries[0]!.values).to.have.lengthOf(15);
      await source.answer('a1', '{"period":"day"}');
      expect(log.lines).to.have.lengthOf(1);
      expect(log.lines[0]).to.match(/^warn: \[Energy\] /).and.include(String(MAX_ENERGY_BYTES)).and.include('Energy tab');
    });

    it(`reads the meters ${PANEL_QUERIES} at a time, the panel's slots, each within the one budget of the answer (Ruling 133)`, async () => {
      let running = 0;
      let most = 0;
      const deadlines: Array<number | undefined> = [];
      const history = {
        readingsBefore: async (id: string, times: readonly number[], panel: string, deadline?: number): Promise<Readings> => {
          deadlines.push(deadline);
          most = Math.max(most, ++running);
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          running--;
          return { readings: times.map((time) => reading(time)), available: true };
        },
      };
      const meters = [1, 2, 3].map((n) => meter({ id: `energy.m${n}`, stateId: `x.0.m${n}` }));
      const source = new EnergySource(history, states({}), logger());
      source.configure(configured({ meters }));
      let answered = false;
      const pending = source.answer('a1', '{"period":"day"}').then((answer) => {
        answered = true;
        return answer;
      });
      await clock.tickAsync(2_000);
      expect(answered).to.equal(false);
      // Two at once, then the third: 4 s, where one after another took 6.
      await clock.tickAsync(2_000);
      expect(answered).to.equal(true);
      expect(most).to.equal(PANEL_QUERIES);
      expect(deadlines).to.deep.equal(meters.map(() => NOW() + HISTORY_BUDGET_MS));
      const { payload } = (await pending)!;
      expect(meters.map((m) => entryOf(payload, m.id).total)).to.deep.equal([7, 7, 7]);
    });

    it('answers a meter that missed the budget with the readings kept, and names it once per rebuild (Ruling 133)', async () => {
      const slow = meter({ id: 'energy.slow', stateId: 'x.0.slow' });
      // The midnight kept from an earlier answer, the hours not read in time.
      const history = {
        readingsBefore: async (id: string, times: readonly number[]): Promise<Readings> =>
          id === 'x.0.slow'
            ? { readings: times.map((time, i) => (i === 0 ? reading(time) : null)), available: false, reason: 'timeout' }
            : { readings: times.map((time) => reading(time)), available: true },
      };
      const log = logger();
      const source = new EnergySource(history, states({ 'shelly.0.em.total': { val: 1007.3, q: 0 }, 'x.0.slow': { val: 1007.3, q: 0 } }), log);
      source.configure(configured({ meters: [meter(), slow] }));
      const day = (await source.answer('a1', '{"period":"day"}'))!.payload;
      // Its bars null, its day total whole: its tile keeps its value (review trap 11).
      expect(entryOf(day, 'energy.slow')).to.deep.include({ values: Array(15).fill(null), total: 7.3 });
      expect(entryOf(day)).to.deep.include({ total: 7.3 });
      await source.answer('a1', '{"period":"week"}');
      expect(log.lines).to.have.lengthOf(1);
      expect(log.lines[0]).to.match(/^warn: \[Energy\] /).and.include('x.0.slow').and.not.include('shelly.0.em.total');
      // Named again after the next rebuild.
      source.configure(configured({ meters: [meter(), slow] }));
      await source.answer('a1', '{"period":"day"}');
      expect(log.lines).to.have.lengthOf(2);
    });

    it('never throws into the MQTT handler: a failing read is none', async () => {
      const source = new EnergySource(
        fakeHistory(),
        {
          getForeignStateAsync: async () => {
            throw new Error('states database gone');
          },
        },
        logger(),
      );
      source.configure(configured());
      const entry = entryOf((await source.answer('a1', '{"period":"day"}'))!.payload);
      expect(entry!.values.at(-1)).to.equal(null);
    });

    describe('with the history provider: its boundary cache (Task 19 C2)', () => {
      /** The counter every 10 minutes since yesterday 20:00, 0.1 kWh a row. */
      const rows = (): Stored[] =>
        Array.from({ length: 112 }, (_, i) => ({ ts: at(2026, 9, 24, 20) + i * 10 * MINUTE, val: 900 + i / 10, ack: true, q: 0 }));

      it('asks for no boundary again within the hour; the next hour, for that one only; each time the live reading', async () => {
        const fake = sqlFake(rows());
        fake.states['shelly.0.em.total'] = { val: 911.2, q: 0 };
        const source = new EnergySource(new HistoryProvider(fake, logger(), 'sql.0'), fake, logger());
        source.configure(configured());
        const first = await source.answer('a1', '{"period":"day"}');
        const asked = fake.calls.length;
        expect(asked).to.be.greaterThan(0);
        clock.tick(20 * MINUTE);
        const second = await source.answer('a1', '{"period":"day"}');
        expect(fake.calls).to.have.lengthOf(asked);
        expect(entryOf(second!.payload).values.slice(0, -1)).to.deep.equal(entryOf(first!.payload).values.slice(0, -1));
        clock.tick(10 * MINUTE); // 15:05: the 15:00 boundary is new
        await source.answer('a1', '{"period":"day"}');
        const next = fake.calls.slice(asked).map((call) => call.options.end ?? call.options.start);
        expect(next).to.deep.equal([at(2026, 9, 25, 15) - 1, at(2026, 9, 25, 15) - 1]);
      });

      it('reads a busy week at each midnight on its own, however many rows lie between (Task 19 C2)', async () => {
        // A reading every 30 seconds for eight days and more: far past the rows one window keeps.
        const first = at(2026, 9, 17);
        const busy = Array.from({ length: Math.floor((NOW() - first) / 30_000) }, (_, i) => ({ ts: first + i * 30_000, val: 5000 + i / 1000, ack: true, q: 0 }));
        const fake = sqlFake(busy);
        fake.states['shelly.0.em.total'] = { val: (busy.at(-1)!.val as number) + 0.001, q: 0 };
        const source = new EnergySource(new HistoryProvider(fake, logger(), 'sql.0'), fake, logger());
        source.configure(configured());
        const entry = entryOf((await source.answer('a1', '{"period":"week"}'))!.payload);
        // 2880 readings a day, 0.001 kWh each.
        expect(entry!.values.slice(0, 6)).to.deep.equal(Array(6).fill(2.88));
        expect(fake.calls.every((call) => call.options.count === 3)).to.equal(true);
      });

      it("keeps a dense meter's day total whole after a restart: live less the reading before midnight (review I1)", async () => {
        // +0.001 kWh every 10 s since 20:00; asked first at 15:00:30. The window
        // from 01:00 keeps its newest 5000 rows, from 01:07:10: 01:00 reads null.
        const first = at(2026, 9, 24, 20);
        const now = at(2026, 9, 25, 15) + 30_000;
        const rows: Stored[] = Array.from({ length: (now - first) / 10_000 }, (_, i) => ({ ts: first + i * 10_000, val: 900 + i / 1000, ack: true, q: 0 }));
        const live = (rows.at(-1)!.val as number) + 0.001;
        const beforeMidnight = rows.filter((row) => row.ts < at(2026, 9, 25)).at(-1)!.val as number;
        const split = at(2026, 9, 25, 13);
        for (const fake of [sqlFake(rows), historyFake(rows.filter((row) => row.ts >= split), rows.filter((row) => row.ts < split))]) {
          clock.setSystemTime(now);
          fake.states['shelly.0.em.total'] = { val: live, q: 0 };
          const source = new EnergySource(new HistoryProvider(fake, logger(), fake.instance), fake, logger());
          source.configure(configured());
          const day = async (): Promise<EnergyEntry> => entryOf((await source.answer('a1', '{"period":"day"}'))!.payload);
          const entry = await day();
          expect(entry.values, fake.instance).to.deep.equal([null, null, ...Array(13).fill(0.36), 0.004]);
          expect(entry.total, fake.instance).to.equal(5.404);
          expect(entry.total, fake.instance).to.equal(Math.round((live - beforeMidnight) * 1000) / 1000);
          // A minute later the nulls are kept, and the total stays whole.
          clock.tick(MINUTE);
          expect((await day()).total, fake.instance).to.equal(5.404);
        }
      });

      it("answers within its budget, the time waiting for the panel's slots included: what it could not read is null (Ruling 133)", async () => {
        const fake = sqlFake(rows());
        fake.states['shelly.0.em.total'] = { val: 911.2, q: 0 };
        const answer = fake.getHistoryAsync.bind(fake);
        // A hung instance for two popups' histories: they hold the panel's two slots.
        fake.getHistoryAsync = (id, options) => {
          if (!id.startsWith('x.0.popup')) return answer(id, options);
          fake.calls.push({ id, options });
          return new Promise<{ result?: unknown }>(() => undefined);
        };
        const provider = new HistoryProvider(fake, logger(), 'sql.0');
        const popups = [1, 2].map((n) => provider.query(`x.0.popup${n}`, { start: NOW() - HOUR, kind: 'numeric', panel: 'a1' }));
        const log = logger();
        const source = new EnergySource(provider, fake, log);
        source.configure(configured());
        let answered: { topic: string; payload: string } | null | undefined;
        void source.answer('a1', '{"period":"day"}').then((result) => (answered = result));
        await clock.tickAsync(HISTORY_BUDGET_MS);
        expect(answered, 'an answer within the budget').to.not.equal(undefined);
        expect(entryOf(answered!.payload).values).to.deep.equal(Array(15).fill(null));
        expect(fake.calls.filter((call) => call.id === 'shelly.0.em.total')).to.deep.equal([]);
        expect(log.lines).to.have.lengthOf(1);
        expect(log.lines[0]).to.include('shelly.0.em.total');
        provider.close();
        await Promise.all(popups);
      });

      it('sums a day to its total from real rows, whichever history adapter answers', async () => {
        const all = rows();
        for (const fake of [sqlFake(all), historyFake(all.filter((row) => row.ts >= at(2026, 9, 25, 13)), all.filter((row) => row.ts < at(2026, 9, 25, 13)))]) {
          fake.states['shelly.0.em.total'] = { val: 911.2, q: 0 };
          const source = new EnergySource(new HistoryProvider(fake, logger(), fake.instance), fake, logger());
          source.configure(configured());
          const entry = entryOf((await source.answer('a1', '{"period":"day"}'))!.payload);
          const values = entry!.values as number[];
          expect(values, fake.instance).to.have.lengthOf(15);
          // 23:50 read 902.3 before midnight, 14:30 read 911.1, live 911.2.
          expect(values.reduce((sum, value) => sum + value, 0)).to.be.closeTo(entry!.total!, 1e-9);
          expect(entry!.total, fake.instance).to.equal(8.9);
          expect(values.slice(0, 14), fake.instance).to.deep.equal(Array(14).fill(0.6));
        }
      });
    });
  });
});
