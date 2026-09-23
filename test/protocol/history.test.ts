import { expect } from 'chai';
import { buildNumericHistoryResponse, parseHistoryRequest, type HistoryRequest } from '../../src/protocol/history';

/**
 * Fixtures reconstructed verbatim from the firmware source (read-only
 * checkout at /home/user/webapp/zigbee/HomeTiles, v0.6.12 commit 5d25167),
 * per docs/contract-history-energy.md. Field order matches the firmware's
 * own string construction / ArduinoJson insertion order; JSON parsing does
 * not care about key order, but it makes the citation easy to eyeball.
 */

/** mqttPublishHistoryRequest, mqtt_handlers.cpp:2381-2447; wire payload built
 * at :2411-2419. No `kind` field is ever written -- confirmed by direct
 * read of the source (string concatenation has no "kind" key at all). */
function numericReq(): string {
  return '{"entity_id":"sensor.temperature","hours":24,"period_minutes":5,"points":288,"stat":"mean"}';
}

/** The popup's 7-day range: sensor_popup.cpp:2557 passes
 * get_history_range_config(Day7) = {168, 60, 168} (:53-55, :251-252) to the
 * same builder. With numericReq() (the 24-hour range, which is also what every
 * tile graph sends, tile_renderer.cpp:4673) these are the only two numeric
 * requests the firmware emits. */
function numericReq7d(): string {
  return '{"entity_id":"sensor.temperature","hours":168,"period_minutes":60,"points":168,"stat":"mean"}';
}

/** mqttPublishBinaryHistoryRequest -> mqttPublishDiscreteHistoryRequest,
 * mqtt_handlers.cpp:2449-2499 (kind="binary" branch :2501-2506); wire
 * payload built at :2476-2486. hours is snapped to 24 or 168 by the
 * firmware itself (:2456) before this is ever put on the wire. */
function binaryReq(): string {
  return '{"version":1,"kind":"binary","entity_id":"binary_sensor.front_door","hours":24,"max_transitions":48}';
}

/** mqttPublishStateHistoryRequest -> mqttPublishDiscreteHistoryRequest,
 * same implementation, kind="state" branch (mqtt_handlers.cpp:2508-2513).
 * Uses the other legal hours literal (168) to prove both are accepted. */
function stateReq(): string {
  return '{"version":1,"kind":"state","entity_id":"sensor.vacuum_mode","hours":168,"max_transitions":48}';
}

/** editable_request_history, value_control.cpp:179-189; the undocumented
 * fourth producer, called from Number/Select/DateTime popups
 * (sensor_popup.cpp:2540). request_id format is three 8-hex-digit groups
 * joined by "-" (esp_random()-millis()-sequence), built by request_id(),
 * value_control.cpp:36-42. This is the only one of the four shapes that
 * ever carries a request_id. */
function editableReq(): string {
  return '{"entity_id":"number.target_temperature","kind":"editable","version":1,"hours":24,"max_transitions":96,"request_id":"1a2b3c4d-005f31a0-00000001"}';
}

describe('protocol/history', () => {
  describe('the four request shapes on one topic', () => {
    it('parses the numeric graph request exactly as mqttPublishHistoryRequest emits it', () => {
      const req = parseHistoryRequest(numericReq());
      expect(req).to.deep.equal({
        kind: 'numeric',
        entityId: 'sensor.temperature',
        hours: 24,
        periodMinutes: 5,
      });
    });

    it('parses the binary discrete-history request exactly as mqttPublishBinaryHistoryRequest emits it', () => {
      const req = parseHistoryRequest(binaryReq());
      expect(req).to.deep.equal({
        kind: 'binary',
        entityId: 'binary_sensor.front_door',
        hours: 24,
      });
    });

    it('parses the state discrete-history request exactly as mqttPublishStateHistoryRequest emits it', () => {
      const req = parseHistoryRequest(stateReq());
      expect(req).to.deep.equal({
        kind: 'state',
        entityId: 'sensor.vacuum_mode',
        hours: 168,
      });
    });

    it('parses the undocumented editable-popup request exactly as editable_request_history emits it', () => {
      const req = parseHistoryRequest(editableReq());
      expect(req).to.deep.equal({
        kind: 'editable',
        entityId: 'number.target_temperature',
        hours: 24,
        requestId: '1a2b3c4d-005f31a0-00000001',
      });
    });

    it('distinguishes all four shapes from a single call site, dispatching on payload only', () => {
      expect(parseHistoryRequest(numericReq())?.kind).to.equal('numeric');
      expect(parseHistoryRequest(binaryReq())?.kind).to.equal('binary');
      expect(parseHistoryRequest(stateReq())?.kind).to.equal('state');
      expect(parseHistoryRequest(editableReq())?.kind).to.equal('editable');
    });

    it('carries request_id only for the editable shape', () => {
      const editable = parseHistoryRequest(editableReq());
      expect(editable?.kind === 'editable' && editable.requestId).to.equal('1a2b3c4d-005f31a0-00000001');

      for (const req of [numericReq(), binaryReq(), stateReq()]) {
        const parsed = parseHistoryRequest(req) as Record<string, unknown> | null;
        expect(parsed).to.not.equal(null);
        expect(parsed).to.not.have.property('requestId');
      }
    });
  });

  describe('range fields are captured verbatim, never re-derived', () => {
    it('keeps the numeric hours/period_minutes exactly as sent, not recomputed from points', () => {
      // points=288 here is inconsistent with hours=24/period_minutes=5 only
      // by coincidence of the real default; changing points must not affect
      // the captured hours/periodMinutes, because a future responder must
      // echo hours/period_minutes -- not points -- back verbatim (contract
      // Sec. 4.1, Sec. 5).
      const req = parseHistoryRequest(
        '{"entity_id":"sensor.x","hours":168,"period_minutes":60,"points":168,"stat":"mean"}',
      );
      expect(req).to.deep.equal({ kind: 'numeric', entityId: 'sensor.x', hours: 168, periodMinutes: 60 });
    });
  });

  describe('shape ambiguity is resolved by the contract field (kind), not by check order', () => {
    it('rejects a discrete request with an out-of-range hours instead of silently reinterpreting it as numeric', () => {
      // Real firmware never sends this (mqtt_handlers.cpp:2456 snaps hours to
      // 24 or 168 before publish); a parser receiving it must reject it
      // outright rather than falling through to another shape.
      const req = parseHistoryRequest(
        '{"version":1,"kind":"binary","entity_id":"binary_sensor.x","hours":12,"max_transitions":48}',
      );
      expect(req).to.equal(null);
    });

    it('rejects a payload carrying an explicit but unrecognized "kind" value', () => {
      // The real numeric producer never writes a "kind" key at all (verified
      // against mqtt_handlers.cpp:2411-2419); "kind absent" is the actual
      // distinguishing signal for numeric, not "kind is anything else". A
      // payload that looks numeric but explicitly labels itself with a kind
      // no producer ever sends must not be accepted as numeric by accident.
      const req = parseHistoryRequest(
        '{"entity_id":"sensor.x","kind":"numeric","hours":24,"period_minutes":5,"points":288,"stat":"mean"}',
      );
      expect(req).to.equal(null);
    });

    it('ignores an unrelated extra field on an otherwise-valid numeric request', () => {
      const req = parseHistoryRequest(
        '{"entity_id":"sensor.x","hours":24,"period_minutes":5,"points":288,"stat":"mean","future_field":true}',
      );
      expect(req).to.deep.equal({ kind: 'numeric', entityId: 'sensor.x', hours: 24, periodMinutes: 5 });
    });
  });

  describe('malformed and hostile input never throws, always returns null', () => {
    it('returns null for a truncated / non-JSON payload', () => {
      expect(parseHistoryRequest('{')).to.equal(null);
      expect(parseHistoryRequest('not json at all')).to.equal(null);
      expect(parseHistoryRequest('')).to.equal(null);
    });

    it('returns null when JSON parses to a non-object', () => {
      expect(parseHistoryRequest('42')).to.equal(null);
      expect(parseHistoryRequest('null')).to.equal(null);
      expect(parseHistoryRequest('"sensor.x"')).to.equal(null);
      expect(parseHistoryRequest('[1,2,3]')).to.equal(null);
    });

    it('returns null when entity_id is missing', () => {
      expect(parseHistoryRequest('{"hours":24,"period_minutes":5,"points":288,"stat":"mean"}')).to.equal(null);
    });

    it('returns null when entity_id is the wrong type', () => {
      expect(
        parseHistoryRequest('{"entity_id":123,"hours":24,"period_minutes":5,"points":288,"stat":"mean"}'),
      ).to.equal(null);
    });

    it('returns null when entity_id does not match the domain.name shape', () => {
      expect(
        parseHistoryRequest('{"entity_id":"not_an_entity_id","hours":24,"period_minutes":5,"points":288,"stat":"mean"}'),
      ).to.equal(null);
    });

    it('returns null when entity_id exceeds the shared MAX_ENTITY_ID_LENGTH (255)', () => {
      const longId = `sensor.${'x'.repeat(255)}`;
      expect(
        parseHistoryRequest(`{"entity_id":"${longId}","hours":24,"period_minutes":5,"points":288,"stat":"mean"}`),
      ).to.equal(null);
    });

    it('returns null when a numeric request has wrong-typed hours/period_minutes', () => {
      expect(
        parseHistoryRequest('{"entity_id":"sensor.x","hours":"24","period_minutes":5,"points":288,"stat":"mean"}'),
      ).to.equal(null);
      expect(parseHistoryRequest('{"entity_id":"sensor.x","hours":24,"points":288,"stat":"mean"}')).to.equal(null);
    });

    it('returns null when a discrete request has an out-of-range hours (0, or any value other than 24/168)', () => {
      expect(
        parseHistoryRequest('{"version":1,"kind":"binary","entity_id":"binary_sensor.x","hours":0,"max_transitions":48}'),
      ).to.equal(null);
      expect(
        parseHistoryRequest('{"version":1,"kind":"state","entity_id":"sensor.x","hours":25,"max_transitions":48}'),
      ).to.equal(null);
    });

    it('returns null when a discrete request has wrong-typed hours', () => {
      expect(
        parseHistoryRequest('{"version":1,"kind":"binary","entity_id":"binary_sensor.x","hours":"24","max_transitions":48}'),
      ).to.equal(null);
    });

    it('returns null when the editable request is missing request_id', () => {
      expect(
        parseHistoryRequest('{"entity_id":"number.x","kind":"editable","version":1,"hours":24,"max_transitions":96}'),
      ).to.equal(null);
    });

    it('returns null when the editable request_id is the wrong type or empty', () => {
      expect(
        parseHistoryRequest(
          '{"entity_id":"number.x","kind":"editable","version":1,"hours":24,"max_transitions":96,"request_id":42}',
        ),
      ).to.equal(null);
      expect(
        parseHistoryRequest(
          '{"entity_id":"number.x","kind":"editable","version":1,"hours":24,"max_transitions":96,"request_id":""}',
        ),
      ).to.equal(null);
    });

    it('returns null when the editable request has wrong-typed hours', () => {
      expect(
        parseHistoryRequest(
          '{"entity_id":"number.x","kind":"editable","version":1,"hours":"24","max_transitions":96,"request_id":"a"}',
        ),
      ).to.equal(null);
    });
  });

  describe('numeric history response', () => {
    type NumericRequest = Extract<HistoryRequest, { kind: 'numeric' }>;
    type Sample = { ts: number; val: unknown };

    /** Every request goes through Task 16's real parser, never a hand-made object. */
    function numeric(payload: string): NumericRequest {
      const req = parseHistoryRequest(payload);
      if (req?.kind !== 'numeric') throw new Error(`not a numeric request: ${payload}`);
      return req;
    }

    function rangeReq(hours: number, periodMinutes: number): string {
      return `{"entity_id":"sensor.x","hours":${hours},"period_minutes":${periodMinutes},"points":288,"stat":"mean"}`;
    }

    // ioBroker history rows carry millisecond timestamps.
    const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
    const MIN = 60_000;
    const DAY24_START = NOW - 24 * 60 * MIN;
    const DAY7_START = NOW - 168 * 60 * MIN;

    /** A timestamp inside bucket k of the 24-hour range (5-minute periods). */
    function in24(k: number, offsetMs = MIN): number {
      return DAY24_START + k * 5 * MIN + offsetMs;
    }

    function valuesFor(payload: string, samples: Sample[]): unknown {
      return JSON.parse(buildNumericHistoryResponse(numeric(payload), samples, NOW)).values;
    }

    /** `count` gaps, with the given buckets set. */
    function buckets(count: number, set: Record<number, number>): Array<number | null> {
      const out: Array<number | null> = new Array<number | null>(count).fill(null);
      for (const [k, v] of Object.entries(set)) out[Number(k)] = v;
      return out;
    }

    it('emits only the keys the firmware reads: bare positional values, no timestamps, null for a gap', () => {
      const out = buildNumericHistoryResponse(numeric(numericReq()), [{ ts: NOW - 2 * MIN, val: 21.5 }], NOW);
      // The whole wire string. Bucket 287 is the period ending now; the 287
      // periods before it recorded nothing and stay null, keeping every value
      // at its time position.
      expect(out).to.equal(
        `{"entity_id":"sensor.temperature","hours":24,"period_minutes":5,"values":${JSON.stringify(
          buckets(288, { 287: 21.5 }),
        )}}`,
      );
    });

    it('echoes entity_id, hours and period_minutes verbatim for both ranges the firmware requests', () => {
      const day = JSON.parse(buildNumericHistoryResponse(numeric(numericReq()), [], NOW));
      expect(day).to.include({ entity_id: 'sensor.temperature', hours: 24, period_minutes: 5 });
      expect(day.values).to.have.lengthOf(288);

      const week = JSON.parse(buildNumericHistoryResponse(numeric(numericReq7d()), [], NOW));
      expect(week).to.include({ entity_id: 'sensor.temperature', hours: 168, period_minutes: 60 });
      expect(week.values).to.have.lengthOf(168);
    });

    it('maps a regular stream onto the index: one sample per period, oldest first, in any input order', () => {
      const samples = Array.from({ length: 168 }, (_, k) => ({ ts: DAY7_START + (k + 0.5) * 60 * MIN, val: 10 + k }));
      const expected = Array.from({ length: 168 }, (_, k) => 10 + k);
      expect(valuesFor(numericReq7d(), samples)).to.deep.equal(expected);
      expect(valuesFor(numericReq7d(), [...samples].reverse())).to.deep.equal(expected);
    });

    it('averages a regular raw stream: five one-minute samples per 5-minute period', () => {
      const samples = Array.from({ length: 24 * 60 }, (_, m) => ({ ts: DAY24_START + m * MIN, val: m }));
      // Bucket k holds minutes 5k..5k+4, whose mean is 5k+2.
      expect(valuesFor(numericReq(), samples)).to.deep.equal(Array.from({ length: 288 }, (_, k) => 5 * k + 2));
    });

    it('keeps a sparse stream sparse: samples 30 minutes apart land six buckets apart, gaps stay null', () => {
      expect(
        valuesFor(numericReq(), [
          { ts: in24(100), val: 1 },
          { ts: in24(100) + 30 * MIN, val: 2 },
        ]),
      ).to.deep.equal(buckets(288, { 100: 1, 106: 2 }));
      // Two hours apart in the 7-day range's 60-minute periods: two buckets apart.
      expect(
        valuesFor(numericReq7d(), [
          { ts: DAY7_START + 3.5 * 60 * MIN, val: 1 },
          { ts: DAY7_START + 5.5 * 60 * MIN, val: 2 },
        ]),
      ).to.deep.equal(buckets(168, { 3: 1, 5: 2 }));
    });

    it('collapses a burst into the mean of its period, and splits a burst that straddles a period edge', () => {
      const burst = Array.from({ length: 12 }, (_, i) => ({ ts: in24(200, i * 20_000), val: 20 + i }));
      const edge = DAY24_START + 250 * 5 * MIN;
      const straddle = [
        { ts: edge - 3000, val: 1 },
        { ts: edge - 2000, val: 2 },
        { ts: edge - 1, val: 3 },
        { ts: edge, val: 7 },
        { ts: edge + 1000, val: 8 },
        { ts: edge + 2000, val: 9 },
      ];
      expect(valuesFor(numericReq(), [...burst, ...straddle])).to.deep.equal(
        buckets(288, { 200: 25.5, 249: 2, 250: 8 }),
      );
    });

    it('treats a non-numeric, blank or non-finite value as a gap, never as 0 -- but a real 0 is a value', () => {
      const samples: Sample[] = [
        { ts: in24(10), val: '' }, // Number('') is 0 and finite: the trap
        { ts: in24(11), val: '   ' },
        { ts: in24(12), val: 'unavailable' },
        { ts: in24(13), val: null },
        { ts: in24(14), val: true },
        { ts: in24(14, 2 * MIN), val: false },
        { ts: in24(15), val: Number.NaN },
        { ts: in24(15, 2 * MIN), val: Number.POSITIVE_INFINITY },
        { ts: in24(16), val: undefined },
        { ts: in24(16, 2 * MIN), val: { val: 5 } },
        // Mixed: only the two numbers count toward the period's mean.
        { ts: in24(17, 0), val: 20 },
        { ts: in24(17, 10_000), val: '' },
        { ts: in24(17, 20_000), val: 'unavailable' },
        { ts: in24(17, 30_000), val: null },
        { ts: in24(17, 40_000), val: 22 },
        // A numeric string, as a string-typed state stores it.
        { ts: in24(18), val: ' 21.5 ' },
        { ts: in24(19), val: 0 },
        { ts: in24(20), val: '0' },
      ];
      expect(valuesFor(numericReq(), samples)).to.deep.equal(buckets(288, { 17: 21, 18: 21.5, 19: 0, 20: 0 }));
    });

    it('bounds the window: its first instant is bucket 0, now is the last bucket, later samples are dropped', () => {
      const samples: Sample[] = [
        { ts: DAY24_START, val: 1 },
        { ts: DAY24_START + 5 * MIN - 1, val: 2 },
        { ts: DAY24_START + 5 * MIN, val: 3 },
        { ts: NOW - 5 * MIN, val: 4 },
        { ts: NOW, val: 6 },
        { ts: NOW + 1, val: 999 },
        { ts: Number.NaN, val: 999 },
      ];
      expect(valuesFor(numericReq(), samples)).to.deep.equal(buckets(288, { 0: 1.5, 1: 3, 287: 5 }));
    });

    it('fills bucket 0 with the value in effect when the window opened, if bucket 0 recorded nothing itself', () => {
      // The firmware back-fills a leading gap with the first LATER value
      // (sensor_popup.cpp:2369-2373): without the carried-in 18, a reading
      // unchanged since before the window and then 22 would draw 22 all day.
      const before: Sample[] = [
        { ts: DAY24_START - 60 * MIN, val: 18 },
        { ts: DAY24_START - 180 * MIN, val: 17 },
      ];
      expect(valuesFor(numericReq(), [...before, { ts: in24(150), val: 22 }])).to.deep.equal(
        buckets(288, { 0: 18, 150: 22 }),
      );
      // Unchanged for the whole window: the carried-in value is the graph.
      expect(valuesFor(numericReq(), before)).to.deep.equal(buckets(288, { 0: 18 }));
      // Bucket 0 with a reading of its own keeps it.
      expect(valuesFor(numericReq(), [...before, { ts: in24(0), val: 20 }])).to.deep.equal(buckets(288, { 0: 20 }));
      // Unavailable when the window opened: nothing to carry in, even though
      // an older reading exists.
      expect(
        valuesFor(numericReq(), [
          ...before,
          { ts: DAY24_START - 1, val: 'unavailable' },
          { ts: in24(150), val: 22 },
        ]),
      ).to.deep.equal(buckets(288, { 150: 22 }));
    });

    it('answers zero or negative hours or period_minutes with no values and never divides by zero', () => {
      const samples: Sample[] = [{ ts: NOW - MIN, val: 21 }];
      // [-24, -5] divides out to +288 buckets; the negative period must still refuse it.
      const ranges = [[0, 5], [24, 0], [0, 0], [-24, 5], [24, -5], [-24, -5], [0.01, 5]] as const;
      for (const [hours, periodMinutes] of ranges) {
        const payload = rangeReq(hours, periodMinutes);
        expect(JSON.parse(buildNumericHistoryResponse(numeric(payload), samples, NOW)), payload).to.deep.equal({
          entity_id: 'sensor.x',
          hours,
          period_minutes: periodMinutes,
          values: [],
        });
      }
    });

    it('serves at most 288 values, the firmware largest request, and answers a longer range with none', () => {
      const samples: Sample[] = [{ ts: NOW - MIN, val: 21 }];
      // 360 and 300 buckets; 6e19 buckets must not be allocated at all.
      for (const [hours, periodMinutes] of [[24, 4], [25, 5], [1e9, 1e-9]] as const) {
        const payload = rangeReq(hours, periodMinutes);
        expect(valuesFor(payload, samples), payload).to.deep.equal([]);
      }
    });

    it('keeps the largest possible response inside the 32767 bytes the firmware reads', () => {
      // mqtt_handlers.cpp:1496, :1836 copy a history message into a 32768-byte
      // buffer and cut it at 32767 bytes; a cut message no longer parses, so
      // the whole graph would be dropped.
      const entityId = `sensor.${'x'.repeat(248)}`; // 255, the longest id the parser accepts
      const req = numeric(`{"entity_id":"${entityId}","hours":24,"period_minutes":5,"points":288,"stat":"mean"}`);
      const widest = -0.0000012345678901234567; // 25 characters, the longest a finite number serialises to
      const samples = Array.from({ length: 288 }, (_, k) => ({ ts: in24(k), val: widest }));
      const out = buildNumericHistoryResponse(req, samples, NOW);
      expect(JSON.parse(out).values).to.deep.equal(new Array(288).fill(widest));
      expect(Buffer.byteLength(out)).to.be.at.most(32767);
    });
  });
});
