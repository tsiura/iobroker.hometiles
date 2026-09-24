import { expect } from 'chai';
import {
  applyEnergySign,
  bridgeRound,
  buildEnergyResponse,
  MAX_ENERGY_BYTES,
  MAX_ENERGY_VALUES,
  parseEnergyRequest,
  type EnergyEntry,
} from '../../src/protocol/energy';
import { panelEnergy, panelSign, panelTotalText, responsePeriod } from './panel-energy';

const START = '2026-09-25T00:00:00+02:00';

function entry(over: Partial<EnergyEntry> = {}): EnergyEntry {
  return { id: 'energy.haus', category: 'grid', sign: 1, values: [0.5, 1.25, null], total: 1.75, name: 'Haus', unit: 'kWh', ...over };
}

/** `count` entries of 24 values each, as a busy installation's day answer. */
function entries(count: number, values = 24): EnergyEntry[] {
  return Array.from({ length: count }, (_, i) =>
    entry({ id: `energy.zaehler_${String(i).padStart(3, '0')}`, name: `Zähler ${i}`, values: Array.from({ length: values }, (_, v) => 1.234 + v), total: 99.999 }),
  );
}

const bytes = (payload: string): number => Buffer.byteLength(payload, 'utf8');

describe('protocol/energy', () => {
  describe('parseEnergyRequest', () => {
    it('reads the period the panel asks for (mqtt_handlers.cpp:2531-2562)', () => {
      expect(parseEnergyRequest('{"period":"day"}')).to.deep.equal({ period: 'day' });
      expect(parseEnergyRequest('{"period":"week"}')).to.deep.equal({ period: 'week' });
      expect(parseEnergyRequest('{"period":"month"}')).to.deep.equal({ period: 'month' });
    });

    it('reads any other period as day, as the panel and the Bridge do', () => {
      for (const payload of ['{}', '{"period":""}', '{"period":"year"}', '{"period":5}', '{"period":null}', '{"period":["week"]}']) {
        expect(parseEnergyRequest(payload), payload).to.deep.equal({ period: 'day' });
      }
      // The Bridge trims and lowercases (__init__.py:2514).
      expect(parseEnergyRequest('{"period":" WEEK "}')).to.deep.equal({ period: 'week' });
    });

    it('answers nothing that is no request object', () => {
      for (const payload of ['', 'day', '{"period":', '[]', '"week"', '42', 'null']) {
        expect(parseEnergyRequest(payload), payload).to.equal(null);
      }
    });
  });

  describe('buildEnergyResponse', () => {
    it('echoes the period so the panel routes it to the right buffer', () => {
      for (const period of ['day', 'week', 'month'] as const) {
        const { payload } = buildEnergyResponse(period, START, [entry()]);
        expect(JSON.parse(payload).period).to.equal(period);
        expect(panelEnergy(payload)!.queue, period).to.equal(period);
      }
    });

    it('puts the period first: the panel routes by the first "period" anywhere in the text (energy_data.cpp:65-80)', () => {
      const decoys = [entry({ id: 'energy.a', name: 'period', unit: 'month' }), entry({ id: 'energy.b', category: 'period', name: 'week' })];
      const { payload } = buildEnergyResponse('week', START, decoys);
      expect(payload.startsWith('{"period":"week"')).to.equal(true);
      expect(responsePeriod(payload)).to.equal('week');
    });

    it('carries the start the popup labels the week with (energy_popup.cpp:224-255)', () => {
      const { payload } = buildEnergyResponse('week', START, [entry()]);
      expect(panelEnergy(payload)!.entries[0]!.start).to.equal(START);
    });

    it(`keeps at most ${MAX_ENERGY_VALUES} values, the first ones, as the panel would (energy_data.cpp:260)`, () => {
      const long = entry({ values: Array.from({ length: 50 }, (_, i) => i) });
      const parsed = JSON.parse(buildEnergyResponse('day', START, [long]).payload);
      expect(parsed.entries[0].values).to.have.lengthOf(MAX_ENERGY_VALUES);
      expect(parsed.entries[0].values).to.deep.equal(long.values.slice(0, MAX_ENERGY_VALUES));
      expect(parsed.entries[0].values).to.deep.equal(panelEnergy(buildEnergyResponse('day', START, [long]).payload)!.entries[0]!.values);
    });

    it('omits a total that is unknown: null and absent both show 0.000, and JSON has no NaN for "--" (energy_data.cpp:249-250)', () => {
      const unknown = entry({ values: [null, null], total: undefined });
      const { payload } = buildEnergyResponse('day', START, [unknown]);
      expect(JSON.parse(payload).entries[0]).to.not.have.property('total');
      expect(payload).to.not.include('null,"total"').and.not.include('"total":null');
      // What the brief feared would "clear" a cached total is the panel's
      // reading of both: the whole period cache is replaced by the entries.
      const [panel] = panelEnergy(payload)!.entries;
      expect(panelTotalText(panel!.total, false)).to.equal('0.000');
      const nulled = panelEnergy(payload.replace('"values":[null,null]', '"values":[null,null],"total":null'))!.entries[0]!;
      expect(nulled.total).to.equal(panel!.total);
    });

    it('never sends a total or a value that is not finite: NaN would go out as null', () => {
      const odd = entry({ values: [Number.NaN, Number.POSITIVE_INFINITY, 1], total: Number.NaN });
      const parsed = JSON.parse(buildEnergyResponse('day', START, [odd]).payload);
      expect(parsed.entries[0].values).to.deep.equal([null, null, 1]);
      expect(parsed.entries[0]).to.not.have.property('total');
    });

    it('keeps an unknown bucket as null, which the panel marks invalid, distinct from a real 0 (energy_data.cpp:262-269)', () => {
      const { payload } = buildEnergyResponse('day', START, [entry({ values: [0, null, 2] })]);
      expect(panelEnergy(payload)!.entries[0]!.values).to.deep.equal([0, null, 2]);
    });

    it('sends no cost key: present, even 0, it would set has_cost (energy_data.cpp:251-255); the Bridge sends none', () => {
      const { payload } = buildEnergyResponse('day', START, [entry(), entry({ id: 'energy.haus_cost', is_cost: true, unit: 'EUR' })]);
      expect(payload).to.not.include('"cost"');
      expect(panelEnergy(payload)!.entries.map((e) => e.hasCost)).to.deep.equal([false, false]);
    });

    describe(`the ${MAX_ENERGY_BYTES}-byte limit: the panel cuts a longer answer and cannot parse it (mqtt_handlers.cpp:1876-1883)`, () => {
      it('sends an answer that fits as it is', () => {
        const all = entries(20);
        const built = buildEnergyResponse('day', START, all);
        expect(built).to.include({ valuesDropped: 0, entriesDropped: 0 });
        expect(JSON.parse(built.payload).entries).to.deep.equal(JSON.parse(JSON.stringify(all)));
      });

      it('drops values before entries, the last entries first, and the panel still parses every entry kept', () => {
        const all = entries(200);
        expect(bytes(JSON.stringify({ period: 'day', start: START, entries: all }))).to.be.greaterThan(MAX_ENERGY_BYTES);
        const built = buildEnergyResponse('day', START, all);
        expect(bytes(built.payload)).to.be.at.most(MAX_ENERGY_BYTES);
        expect(built.entriesDropped).to.equal(0);
        expect(built.valuesDropped).to.be.greaterThan(0);
        const parsed = JSON.parse(built.payload) as { entries: EnergyEntry[] };
        const bare = parsed.entries.map((e) => !('values' in e));
        // Values go from the end: every entry that lost them follows every one that kept them.
        expect(bare.indexOf(true)).to.equal(200 - built.valuesDropped);
        expect(bare.slice(bare.indexOf(true)).every(Boolean)).to.equal(true);
        // Every total survives, and the panel reads every entry.
        expect(parsed.entries.map((e) => e.total)).to.deep.equal(all.map((e) => e.total));
        expect(panelEnergy(built.payload)!.entries).to.have.lengthOf(200);
      });

      it('drops the last entries only when the entries alone are too many', () => {
        const all = entries(600, 0);
        const built = buildEnergyResponse('day', START, all);
        expect(bytes(built.payload)).to.be.at.most(MAX_ENERGY_BYTES);
        expect(built.valuesDropped).to.equal(600);
        expect(built.entriesDropped).to.be.greaterThan(0);
        const kept = panelEnergy(built.payload)!.entries.map((e) => e.id);
        expect(kept).to.deep.equal(all.slice(0, 600 - built.entriesDropped).map((e) => e.id));
      });

      it(`sends exactly ${MAX_ENERGY_BYTES} bytes untouched, and trims at one more`, () => {
        const one = (name: string): EnergyEntry[] => [entry({ name, values: [1], total: 1 })];
        const base = bytes(buildEnergyResponse('day', START, one('')).payload);
        const fits = buildEnergyResponse('day', START, one('x'.repeat(MAX_ENERGY_BYTES - base)));
        expect(bytes(fits.payload)).to.equal(MAX_ENERGY_BYTES);
        expect(fits.valuesDropped).to.equal(0);
        expect(panelEnergy(fits.payload)).to.not.equal(null);
        const over = buildEnergyResponse('day', START, one('x'.repeat(MAX_ENERGY_BYTES - base + 1)));
        expect(over.valuesDropped).to.equal(1);
        expect(bytes(over.payload)).to.be.at.most(MAX_ENERGY_BYTES);
      });

      it('counts UTF-8 bytes, not characters', () => {
        const wide = entries(60).map((e) => ({ ...e, name: 'Wärmepumpe Außeneinheit ÄÖÜ'.repeat(8) }));
        const built = buildEnergyResponse('day', START, wide);
        expect(bytes(built.payload)).to.be.at.most(MAX_ENERGY_BYTES);
        expect(built.payload.length).to.be.lessThan(bytes(built.payload));
        expect(panelEnergy(built.payload)).to.not.equal(null);
      });
    });
  });

  describe('rounding and sign, as the Bridge and the panel do them', () => {
    it("rounds as the Bridge's Python round does: an exact tie to the even neighbour", () => {
      // python3 -c "print(round(0.125,2), round(0.375,2), round(2.675,2), round(0.0625,3), round(-0.125,2), round(1.0005,3), round(2.5,0), round(-0.0625,3), round(12.3445,3))"
      // 0.12 0.38 2.67 0.062 -0.12 1.0 2.0 -0.062 12.345
      const cases: Array<[number, number, number]> = [
        [0.125, 2, 0.12],
        [0.375, 2, 0.38],
        [2.675, 2, 2.67],
        [0.0625, 3, 0.062],
        [-0.125, 2, -0.12],
        [1.0005, 3, 1],
        [2.5, 0, 2],
        [-0.0625, 3, -0.062],
        [12.3445, 3, 12.345],
        [1234.567 - 1234.444, 3, 0.123],
      ];
      for (const [value, digits, python] of cases) expect(bridgeRound(value, digits), `${value}, ${digits}`).to.equal(python);
    });

    it('signs as the Bridge does (_apply_stat_sign, __init__.py:2703-2706): only a positive value turns negative', () => {
      expect(applyEnergySign(3.2, -1)).to.equal(-3.2);
      expect(applyEnergySign(-3.2, -1)).to.equal(-3.2);
      expect(applyEnergySign(0, -1)).to.equal(0);
      expect(applyEnergySign(3.2, 1)).to.equal(3.2);
      for (const value of [-2, -0.5, 0, 0.5, 2]) for (const sign of [-1, 1]) expect(applyEnergySign(value, sign)).to.equal(panelSign(value, sign));
    });

    it('a total signed once is not signed again on the panel; its values are signed there once', () => {
      // An export meter: the Bridge sends the changes as they are and the total signed (__init__.py:2783-2791).
      const exported = entry({ sign: -1, values: [0.4, 1.1, null], total: applyEnergySign(1.5, -1) });
      const [panel] = panelEnergy(buildEnergyResponse('day', START, [exported]).payload)!.entries;
      expect(panel!.total).to.equal(-1.5);
      expect(panel!.values).to.deep.equal([-0.4, -1.1, null]);
      expect(panelTotalText(panel!.total, false)).to.equal('-1.500');
    });

    it('shows a cost total with 2 decimals, any other with 3 (format_energy_total, energy_data.cpp:151-154)', () => {
      const { payload } = buildEnergyResponse('day', START, [entry({ total: 1.75 }), entry({ id: 'energy.haus_cost', is_cost: true, total: 0.53 })]);
      const panel = panelEnergy(payload)!.entries;
      expect(panel.map((e) => panelTotalText(e.total, e.isCost))).to.deep.equal(['1.750', '0.53']);
    });
  });
});
