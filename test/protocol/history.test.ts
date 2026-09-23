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

    /** The payload to publish; a refusal (null) fails the test. */
    function responseFor(request: string, samples: Sample[]): string {
      const out: string | null = buildNumericHistoryResponse(numeric(request), samples, NOW);
      if (out === null) throw new Error(`no response to ${request}`);
      return out;
    }

    function valuesFor(request: string, samples: Sample[]): unknown {
      return JSON.parse(responseFor(request, samples)).values;
    }

    /** `count` values: null until the first change, then each change holds until the next. */
    function steps(count: number, changes: Record<number, number>): Array<number | null> {
      let value: number | null = null;
      return Array.from({ length: count }, (_, k) => (value = changes[k] ?? value));
    }

    it('emits only the keys the firmware reads: bare positional values, no timestamps, null before a reading', () => {
      const out = responseFor(numericReq(), [{ ts: NOW - 2 * MIN, val: 21.5 }]);
      // The whole wire string. Bucket 287 is the period ending now; no reading
      // exists before it, so the 287 periods before it stay null, keeping
      // every value at its time position.
      expect(out).to.equal(
        `{"entity_id":"sensor.temperature","hours":24,"period_minutes":5,"values":${JSON.stringify(
          steps(288, { 287: 21.5 }),
        )}}`,
      );
    });

    it('echoes entity_id, hours and period_minutes verbatim for both ranges the firmware requests', () => {
      const day = JSON.parse(responseFor(numericReq(), []));
      expect(day).to.include({ entity_id: 'sensor.temperature', hours: 24, period_minutes: 5 });
      expect(day.values).to.have.lengthOf(288);

      const week = JSON.parse(responseFor(numericReq7d(), []));
      expect(week).to.include({ entity_id: 'sensor.temperature', hours: 168, period_minutes: 60 });
      expect(week.values).to.have.lengthOf(168);
    });

    it('answers a valid range with no readings with every value null, so a stale tile graph clears', () => {
      // Only a malformed range goes unanswered: the tile graph is redrawn only
      // by a response (tile_renderer.cpp:4654-4667), so an entity without
      // history must still get one.
      expect(valuesFor(numericReq(), [])).to.deep.equal(new Array(288).fill(null));
      expect(valuesFor(numericReq7d(), [{ ts: NOW - MIN, val: 'unavailable' }])).to.deep.equal(
        new Array(168).fill(null),
      );
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

    it('keeps a sparse stream in place: samples 30 minutes apart land six buckets apart', () => {
      // The periods between carry the reading in effect (see the carry tests).
      expect(
        valuesFor(numericReq(), [
          { ts: in24(100), val: 1 },
          { ts: in24(100) + 30 * MIN, val: 2 },
        ]),
      ).to.deep.equal(steps(288, { 100: 1, 106: 2 }));
      // Two hours apart in the 7-day range's 60-minute periods: two buckets apart.
      expect(
        valuesFor(numericReq7d(), [
          { ts: DAY7_START + 3.5 * 60 * MIN, val: 1 },
          { ts: DAY7_START + 5.5 * 60 * MIN, val: 2 },
        ]),
      ).to.deep.equal(steps(168, { 3: 1, 5: 2 }));
    });

    it('averages a burst over its period, and splits a burst that straddles a period edge', () => {
      const burst = Array.from({ length: 12 }, (_, i) => ({ ts: in24(200, i * 20_000), val: 20 + i }));
      const edge = DAY24_START + 250 * 5 * MIN;
      const straddle = [
        { ts: edge - 3000, val: 1 },
        { ts: edge - 2000, val: 2 },
        { ts: edge - 1, val: 3 },
        // Asymmetric: the mean is 11, where a median gives 9 and a midrange 12.
        { ts: edge, val: 9 },
        { ts: edge + 1000, val: 9 },
        { ts: edge + 2000, val: 15 },
      ];
      // After a burst, its LAST reading is in effect (31, then 15), not its mean.
      expect(valuesFor(numericReq(), [...burst, ...straddle])).to.deep.equal(
        steps(288, { 200: 25.5, 201: 31, 249: 2, 250: 11, 251: 15 }),
      );
    });

    it('treats a non-numeric, blank or non-finite value as no reading, never as 0 -- but a real 0 is a value', () => {
      const samples: Sample[] = [
        // No reading exists yet, so these periods stay null.
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
        // After a reading, a blank is still no reading: the 22 stays in effect.
        { ts: in24(18), val: '' },
        { ts: in24(19), val: 0 },
        // A numeric string, as a string-typed state stores it.
        { ts: in24(20), val: ' 21.5 ' },
        { ts: in24(21), val: '0' },
      ];
      expect(valuesFor(numericReq(), samples)).to.deep.equal(steps(288, { 17: 21, 18: 22, 19: 0, 20: 21.5, 21: 0 }));
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
      expect(valuesFor(numericReq(), samples)).to.deep.equal(steps(288, { 0: 1.5, 1: 3, 287: 5 }));
    });

    it('carries the reading in effect, not the previous mean, into every empty period', () => {
      // A plug logged on change: 0 W, one 2000 W minute inside bucket 100,
      // then 0 W again. Both firmware readers fill a null by copying the
      // previous element (sensor_popup.cpp:2369-2380, tile_renderer.cpp:
      // 4573-4594), so a null after bucket 100 would draw its 1000 W mean
      // for the remaining 15 h 40 min.
      const plug: Sample[] = [
        { ts: DAY24_START - 60 * MIN, val: 0 },
        { ts: in24(100, 30_000), val: 2000 },
        { ts: in24(100, 90_000), val: 0 },
      ];
      const expected = steps(288, { 0: 0, 100: 1000, 101: 0 });
      expect(valuesFor(numericReq(), plug)).to.deep.equal(expected);
      // The latest reading is the latest by timestamp, not by input order.
      expect(valuesFor(numericReq(), [...plug].reverse())).to.deep.equal(expected);
    });

    it('starts the carry from the latest numeric reading before the window, and stays null while none exists', () => {
      const before: Sample[] = [
        { ts: DAY24_START - 60 * MIN, val: 18 },
        { ts: DAY24_START - 180 * MIN, val: 17 },
      ];
      expect(valuesFor(numericReq(), [...before, { ts: in24(150), val: 22 }])).to.deep.equal(
        steps(288, { 0: 18, 150: 22 }),
      );
      // Every sample lies before the window: the reading in effect is the whole graph.
      expect(valuesFor(numericReq(), before)).to.deep.equal(new Array(288).fill(18));
      // A period with a reading of its own keeps it, and that reading carries on.
      expect(valuesFor(numericReq(), [...before, { ts: in24(0), val: 20 }])).to.deep.equal(new Array(288).fill(20));
      // A non-numeric sample is no reading: the last numeric one stays in effect.
      expect(
        valuesFor(numericReq(), [
          ...before,
          { ts: DAY24_START - 1, val: 'unavailable' },
          { ts: in24(150), val: 22 },
        ]),
      ).to.deep.equal(steps(288, { 0: 18, 150: 22 }));
      // No numeric reading yet: null until the first one.
      expect(
        valuesFor(numericReq(), [
          { ts: DAY24_START - 60 * MIN, val: 'unavailable' },
          { ts: in24(150), val: 22 },
        ]),
      ).to.deep.equal(steps(288, { 150: 22 }));
    });

    it('refuses a zero, negative or non-finite range with no response at all, never dividing by zero', () => {
      const samples: Sample[] = [{ ts: NOW - MIN, val: 21 }];
      // [-24, -5] divides out to +288 buckets; the negative period must still refuse it.
      const ranges = [[0, 5], [24, 0], [0, 0], [-24, 5], [24, -5], [-24, -5], [0.01, 5]] as const;
      for (const [hours, periodMinutes] of ranges) {
        const request = rangeReq(hours, periodMinutes);
        expect(buildNumericHistoryResponse(numeric(request), samples, NOW), request).to.equal(null);
      }
      // The parser already refuses non-finite values; the builder must as well.
      for (const [hours, periodMinutes] of [[Infinity, 5], [24, Infinity], [NaN, 5], [24, NaN]] as const) {
        const req: NumericRequest = { kind: 'numeric', entityId: 'sensor.x', hours, periodMinutes };
        expect(buildNumericHistoryResponse(req, samples, NOW), `${hours}/${periodMinutes}`).to.equal(null);
      }
    });

    it('serves at most 288 values, the firmware largest request, and refuses a longer range', () => {
      const samples: Sample[] = [{ ts: NOW - MIN, val: 21 }];
      // 360 and 300 buckets; 6e19 buckets must not be allocated at all.
      for (const [hours, periodMinutes] of [[24, 4], [25, 5], [1e9, 1e-9]] as const) {
        const request = rangeReq(hours, periodMinutes);
        expect(buildNumericHistoryResponse(numeric(request), samples, NOW), request).to.equal(null);
      }
    });

    it('keeps the largest possible response inside the 32767 bytes the firmware reads', () => {
      // mqtt_handlers.cpp:1496, :1836 copy a history message into a 32768-byte
      // buffer and cut it at 32767 bytes; a cut message no longer parses, so
      // the whole graph would be dropped.
      const entityId = `sensor.${'x'.repeat(248)}`; // 255, the longest id the parser accepts
      const request = `{"entity_id":"${entityId}","hours":24,"period_minutes":5,"points":288,"stat":"mean"}`;
      const widest = -0.0000012345678901234567; // 25 characters, the longest a finite number serialises to
      const out = responseFor(request, Array.from({ length: 288 }, (_, k) => ({ ts: in24(k), val: widest })));
      expect(JSON.parse(out).values).to.deep.equal(new Array(288).fill(widest));
      expect(Buffer.byteLength(out)).to.be.at.most(32767);
    });
  });
});
