import { expect } from 'chai';
import {
  buildDiscreteHistoryResponse,
  buildNumericHistoryResponse,
  parseHistoryRequest,
  type HistoryRequest,
} from '../../src/protocol/history';
import { synthBinarySensor } from '../../src/registry/synth/binary_sensor';
import type { Values } from '../../src/registry/synth/common';
import { synthNumber, synthSelect } from '../../src/registry/synth/editable';
import type { DeviceInput, VirtualEntity } from '../../src/registry/types';
import { dispatch, panelBinary, panelEditable, panelState } from './panel-history';

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
        maxTransitions: 48,
      });
    });

    it('parses the state discrete-history request exactly as mqttPublishStateHistoryRequest emits it', () => {
      const req = parseHistoryRequest(stateReq());
      expect(req).to.deep.equal({
        kind: 'state',
        entityId: 'sensor.vacuum_mode',
        hours: 168,
        maxTransitions: 48,
      });
    });

    it('parses the undocumented editable-popup request exactly as editable_request_history emits it', () => {
      const req = parseHistoryRequest(editableReq());
      expect(req).to.deep.equal({
        kind: 'editable',
        entityId: 'number.target_temperature',
        hours: 24,
        maxTransitions: 96,
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

    it('returns null when an editable request asks for a range the popup never shows (only 24 or 168)', () => {
      // The popup asks with its range's hours (sensor_popup.cpp:2536-2540,
      // :249-257) and drops a reply whose hours differ (:2255); the number
      // graph's period follows from them (5 or 60 minutes, :50-55).
      for (const hours of [0, 12, 48, 24.5, -24]) {
        const payload = `{"entity_id":"number.x","kind":"editable","version":1,"hours":${hours},"max_transitions":96,"request_id":"a"}`;
        expect(parseHistoryRequest(payload), payload).to.equal(null);
      }
      expect(
        parseHistoryRequest('{"entity_id":"number.x","kind":"editable","version":1,"hours":168,"max_transitions":96,"request_id":"a"}'),
      ).to.deep.equal({ kind: 'editable', entityId: 'number.x', hours: 168, maxTransitions: 96, requestId: 'a' });
    });
  });

  describe('max_transitions (Ruling 122)', () => {
    const shapes = {
      binary: (max: string) => `{"version":1,"kind":"binary","entity_id":"binary_sensor.x","hours":24${max}}`,
      state: (max: string) => `{"version":1,"kind":"state","entity_id":"sensor.x","hours":24${max}}`,
      editable: (max: string) => `{"entity_id":"number.x","kind":"editable","version":1,"hours":24${max},"request_id":"a"}`,
    };
    const limitOf = (payload: string): unknown => (parseHistoryRequest(payload) as { maxTransitions?: unknown } | null)?.maxTransitions;

    it('carries the limit the popup sends, capped at the 96 segments and entries it can hold', () => {
      // The popup always asks for kBinaryMaxSegments (sensor_popup.cpp:2549-2553,
      // :59); the publisher clamps to 2..96 (mqtt_handlers.cpp:2457-2459) and the
      // editable producer writes 96 (value_control.cpp:186).
      for (const shape of Object.values(shapes)) {
        expect(limitOf(shape(',"max_transitions":96'))).to.equal(96);
        expect(limitOf(shape(',"max_transitions":2'))).to.equal(2);
        expect(limitOf(shape(',"max_transitions":500'))).to.equal(96);
        expect(limitOf(shape(',"max_transitions":1e300'))).to.equal(96);
      }
    });

    it('reads a missing or null limit as the 48 the Bridge and the publisher default to', () => {
      // mqtt_handlers.cpp:2457 (0 -> 48); state_history.py:70-75 and
      // binary_history.py:62-67 (None -> 48).
      for (const shape of Object.values(shapes)) {
        expect(limitOf(shape(''))).to.equal(48);
        expect(limitOf(shape(',"max_transitions":null'))).to.equal(48);
      }
    });

    it('refuses a malformed limit with no request at all (Ruling 70)', () => {
      for (const [kind, shape] of Object.entries(shapes)) {
        for (const bad of ['0', '1', '-3', '2.5', '"48"', 'true', '1e400', '[]', '{}']) {
          const payload = shape(`,"max_transitions":${bad}`);
          expect(parseHistoryRequest(payload), `${kind} ${bad}`).to.equal(null);
        }
      }
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

  describe('discrete history responses: binary, state and editable popups', () => {
    type DiscreteRequest = Extract<HistoryRequest, { kind: 'binary' | 'state' | 'editable' }>;
    type Current = { state: string; available: boolean; lastChanged: number };
    type Sample = { ts: number; state: string };
    type Row = { ts: number; val: unknown; q?: number };

    const NOW = Date.UTC(2026, 8, 23, 12, 0, 0); // ioBroker's clock is epoch ms
    const NOW_S = NOW / 1000; // the panel's is epoch seconds
    const DAY_S = NOW_S - 24 * 3600;
    const WEEK_S = NOW_S - 168 * 3600;
    /** A row's stamp in epoch ms: the whole second `second`, plus `extra` ms. */
    const ms = (second: number, extra = 0): number => second * 1000 + extra;
    /** 768 bins over the day are 112.5 s each: a change every 225 s lands on every second bin edge. */
    const BIN2 = 225;
    const REQUEST_ID = '1a2b3c4d-005f31a0-00000001';
    const bins = (...runs: Array<[code: number, count: number]>): number[] => runs.flatMap(([code, count]) => new Array<number>(count).fill(code));

    /** Every request goes through the real parser, as the popup sends it: max_transitions is kBinaryMaxSegments (sensor_popup.cpp:2549-2553). */
    function discrete(payload: string): DiscreteRequest {
      const req = parseHistoryRequest(payload);
      if (!req || req.kind === 'numeric') throw new Error(`not a discrete request: ${payload}`);
      return req;
    }
    const binaryRequest = (hours = 24, max = 96): DiscreteRequest =>
      discrete(`{"version":1,"kind":"binary","entity_id":"binary_sensor.front_door","hours":${hours},"max_transitions":${max}}`);
    const stateRequest = (entity = 'sensor.vacuum_status', hours = 24, max = 96): DiscreteRequest =>
      discrete(`{"version":1,"kind":"state","entity_id":"${entity}","hours":${hours},"max_transitions":${max}}`);
    const editableRequest = (entity: string, hours = 24): DiscreteRequest =>
      discrete(`{"entity_id":"${entity}","kind":"editable","version":1,"hours":${hours},"max_transitions":96,"request_id":"${REQUEST_ID}"}`);

    function respond(req: DiscreteRequest, samples: Sample[], current: Current, now = NOW): string {
      const out: string | null = buildDiscreteHistoryResponse(req, samples, now, current);
      if (out === null) throw new Error('no response');
      return out;
    }

    /**
     * What Task 22 does with an ioBroker history row: the entity's own synth,
     * fed the row as its channel's value -- so a bad quality or a logging gap
     * (null) reads exactly as the live state would.
     */
    function statesOf(synth: (device: DeviceInput, id: string, values: Values) => VirtualEntity | null, device: DeviceInput, rows: Row[]): Sample[] {
      const objectId = Object.values(device.channels)[0]!.objectId;
      return rows.map(({ ts, val, q }) => ({ ts, state: synth(device, 'x.y', { [objectId]: { val, ack: true, q: q ?? 0, ts } })!.state }));
    }
    const DOOR: DeviceInput = {
      objectId: 'zigbee.0.00158d0001a2b3c4',
      name: 'Front door',
      detectorType: 'door',
      domain: 'binary_sensor',
      channels: { actual: { objectId: 'zigbee.0.00158d0001a2b3c4.opened', role: 'sensor.door', type: 'boolean' } },
    };
    const SETPOINT: DeviceInput = {
      objectId: 'hm-rpc.0.OEQ0123456.4',
      name: 'Setpoint',
      detectorType: 'slider',
      domain: 'number',
      channels: {
        set: { objectId: 'hm-rpc.0.OEQ0123456.4.SET_POINT_TEMPERATURE', role: 'level.temperature', type: 'number', min: 5, max: 30, step: 0.5, unit: '°C' },
      },
    };
    const MODE: DeviceInput = {
      objectId: 'javascript.0.heating.mode',
      name: 'Heating mode',
      detectorType: 'manual',
      domain: 'select',
      channels: { set: { objectId: 'javascript.0.heating.mode', type: 'number', states: { 0: 'Off', 1: 'Eco', 2: 'Comfort' } } },
    };
    const door = (rows: Row[]): Sample[] => statesOf(synthBinarySensor, DOOR, rows);

    describe('binary', () => {
      it('answers with exactly what apply_binary_history_payload reads, stamped in whole epoch seconds', () => {
        // Closed since before the window, opened at its midpoint: bin 384 of 768.
        const opened = DAY_S + 43200;
        const out = respond(binaryRequest(), door([{ ts: ms(DAY_S - 3600), val: false }, { ts: ms(opened), val: true }]), {
          state: 'on',
          available: true,
          lastChanged: ms(opened),
        });
        // kind, entity_id and hours lead: the dispatcher scans the first of each
        // (mqtt_handlers.cpp:1839-1853). Off is code 0 and on code 1, four to a
        // byte, high bits first: 0x00 and 0x55 (sensor_popup.cpp:1783-1798).
        expect(out).to.equal(
          JSON.stringify({
            kind: 'binary',
            entity_id: 'binary_sensor.front_door',
            hours: 24,
            range_start: DAY_S,
            range_end: NOW_S,
            history_available: true,
            current: 'on',
            available: true,
            last_changed: opened,
            timeline_points: 768,
            timeline_encoding: '2bit-hex',
            timeline_data: '00'.repeat(96) + '55'.repeat(96),
            segments: [
              { start: DAY_S, end: opened, state: 'off' },
              { start: opened, end: NOW_S, state: 'on' },
            ],
            activity: [{ timestamp: opened, state: 'on' }],
          }),
        );
        expect(panelBinary(out, 24)).to.deep.equal({
          available: true,
          segments: [
            { start: DAY_S, end: opened, state: 'off' },
            { start: opened, end: NOW_S, state: 'on' },
          ],
          activity: [{ timestamp: opened, state: 'on' }],
          bins: bins([0, 384], [1, 384]),
          palette: [],
          current: 'on',
        });
        expect(dispatch(out, { entityId: 'binary_sensor.front_door', kind: 'binary', hours: 24 })).to.deep.equal({
          clearsPending: true,
          toTileGraph: false,
        });
      });

      it('floors millisecond stamps to the second: extract_epoch drops a fraction as 0 (sensor_popup.cpp:836-851)', () => {
        const changed = DAY_S + 1000;
        const out = respond(
          binaryRequest(),
          door([{ ts: ms(DAY_S - 1), val: false }, { ts: ms(changed, 999), val: true }]),
          { state: 'on', available: true, lastChanged: ms(changed, 999) },
          NOW + 999,
        );
        const doc = JSON.parse(out);
        expect(doc).to.include({ range_start: DAY_S, range_end: NOW_S, last_changed: changed });
        expect(doc.activity).to.deep.equal([{ timestamp: changed, state: 'on' }]);
        expect(panelBinary(out, 24)?.activity).to.deep.equal([{ timestamp: changed, state: 'on' }]);
        expect(panelBinary(out, 24)?.segments).to.have.lengthOf(2);
        // A row in the window's last, unfinished second is no change yet: its
        // segment would end where it starts, which the panel drops (:1906-1908);
        // the live state brings it (binary_history.py:119).
        const late = JSON.parse(
          respond(binaryRequest(), door([{ ts: ms(DAY_S - 1), val: false }, { ts: ms(NOW_S, 200), val: true }]), { state: 'on', available: true, lastChanged: ms(NOW_S, 200) }, NOW + 999),
        );
        expect(late.activity).to.deep.equal([]);
        expect(late.segments).to.deep.equal([{ start: DAY_S, end: NOW_S, state: 'off' }]);
      });

      it('serves the seven-day range the same way, echoing hours 168 (the popup drops any other, :1843-1844)', () => {
        // 787.5 s a bin: a change 1575 s x 100 in lands on bin 200.
        const opened = WEEK_S + 1575 * 100;
        const out = respond(binaryRequest(168), door([{ ts: ms(WEEK_S - 60), val: false }, { ts: ms(opened), val: true }]), {
          state: 'on',
          available: true,
          lastChanged: ms(opened),
        });
        expect(JSON.parse(out)).to.include({ hours: 168, range_start: WEEK_S, range_end: NOW_S });
        expect(panelBinary(out, 24)).to.equal(null);
        expect(panelBinary(out, 168)?.bins).to.deep.equal(bins([0, 200], [1, 568]));
        expect(panelBinary(out, 168)?.activity).to.deep.equal([{ timestamp: opened, state: 'on' }]);
      });

      it('lets a short active moment win its bin: on over unavailable over unknown over off', () => {
        // The Bridge's priority (binary_history.py:26, :305-330) and the
        // panel's own (sensor_popup.cpp:876-883, :1126-1134): a ten-second
        // motion inside a 112.5 s bin still shows.
        const samples: Sample[] = [
          { ts: ms(DAY_S - 60), state: 'off' },
          { ts: ms(DAY_S + 11260), state: 'on' }, // bin 100
          { ts: ms(DAY_S + 11270), state: 'off' },
          { ts: ms(DAY_S + 22510), state: 'unavailable' }, // bin 200
          { ts: ms(DAY_S + 22520), state: 'off' },
          { ts: ms(DAY_S + 33760), state: 'on' }, // bin 300: on and unavailable
          { ts: ms(DAY_S + 33765), state: 'unavailable' },
          { ts: ms(DAY_S + 33780), state: 'off' },
          { ts: ms(DAY_S + 45010), state: 'unknown' }, // bin 400
          { ts: ms(DAY_S + 45020), state: 'off' },
        ];
        const out = respond(binaryRequest(), samples, { state: 'off', available: true, lastChanged: ms(DAY_S + 45020) });
        expect(panelBinary(out, 24)?.bins).to.deep.equal(
          bins([0, 100], [1, 1], [0, 99], [3, 1], [0, 99], [1, 1], [0, 99], [2, 1], [0, 367]),
        );
      });

      it('reads a bad quality or a logging gap (null) as unavailable, as the live state does', () => {
        const out = respond(
          binaryRequest(),
          door([
            { ts: ms(DAY_S - 600), val: false },
            { ts: ms(DAY_S + 3600), val: true },
            { ts: ms(DAY_S + 7200), val: true, q: 0x42 }, // device not connected
            { ts: ms(DAY_S + 7300), val: null }, // the history adapter's gap marker
            { ts: ms(DAY_S + 9000), val: false },
          ]),
          { state: 'off', available: true, lastChanged: ms(DAY_S + 9000) },
        );
        const doc = JSON.parse(out);
        expect(doc.activity).to.deep.equal([
          { timestamp: DAY_S + 3600, state: 'on' },
          { timestamp: DAY_S + 7200, state: 'unavailable' },
          { timestamp: DAY_S + 9000, state: 'off' },
        ]);
        expect(doc.segments).to.deep.equal([
          { start: DAY_S, end: DAY_S + 3600, state: 'off' },
          { start: DAY_S + 3600, end: DAY_S + 7200, state: 'on' },
          { start: DAY_S + 7200, end: DAY_S + 9000, state: 'unavailable' },
          { start: DAY_S + 9000, end: NOW_S, state: 'off' },
        ]);
      });

      it('never invents a change from a repeated value, or from another spelling of the same state', () => {
        const rows: Row[] = [
          { ts: ms(DAY_S - 50), val: false },
          { ts: ms(DAY_S + 100), val: false },
          { ts: ms(DAY_S + 300), val: true },
          { ts: ms(DAY_S + 400), val: 1 },
          { ts: ms(DAY_S + 500), val: 'true' },
          { ts: ms(DAY_S + 600), val: 0 },
          { ts: ms(DAY_S + 700), val: false },
        ];
        const doc = JSON.parse(respond(binaryRequest(), door(rows), { state: 'off', available: true, lastChanged: ms(DAY_S + 700) }));
        expect(doc.activity).to.deep.equal([
          { timestamp: DAY_S + 300, state: 'on' },
          { timestamp: DAY_S + 600, state: 'off' },
        ]);
        expect(doc.segments).to.have.lengthOf(3);
      });

      it('does not depend on the order rows arrive in', () => {
        const rows: Row[] = [
          { ts: ms(DAY_S - 600), val: false },
          { ts: ms(DAY_S + 3600), val: true },
          { ts: ms(DAY_S + 7200), val: true, q: 0x42 },
          { ts: ms(DAY_S + 7300), val: null },
          { ts: ms(DAY_S + 9000), val: false },
          { ts: ms(DAY_S + 9300), val: true },
        ];
        const current: Current = { state: 'on', available: true, lastChanged: ms(DAY_S + 9300) };
        const sorted = respond(binaryRequest(), door(rows), current);
        for (const order of [[5, 4, 3, 2, 1, 0], [2, 0, 5, 1, 4, 3], [3, 5, 0, 4, 2, 1]]) {
          expect(respond(binaryRequest(), door(order.map((i) => rows[i]!)), current)).to.equal(sorted);
        }
      });

      it('opens the window with the latest earlier row by time, and puts no earlier row into Activity', () => {
        const samples: Sample[] = [
          { ts: ms(DAY_S - 100), state: 'on' }, // the latest before the window
          { ts: ms(DAY_S - 7200), state: 'off' }, // older, though it comes later
          { ts: ms(DAY_S + 500), state: 'off' },
        ];
        const doc = JSON.parse(respond(binaryRequest(), samples, { state: 'off', available: true, lastChanged: ms(DAY_S + 500) }));
        expect(doc.segments).to.deep.equal([
          { start: DAY_S, end: DAY_S + 500, state: 'on' },
          { start: DAY_S + 500, end: NOW_S, state: 'off' },
        ]);
        expect(doc.activity).to.deep.equal([{ timestamp: DAY_S + 500, state: 'off' }]);
        // A row at the window's very first second opens it; it is no change within it.
        const opening = JSON.parse(
          respond(binaryRequest(), [{ ts: ms(DAY_S - 60), state: 'off' }, { ts: ms(DAY_S, 700), state: 'on' }], {
            state: 'on',
            available: true,
            lastChanged: ms(DAY_S, 700),
          }),
        );
        expect(opening.segments).to.deep.equal([{ start: DAY_S, end: NOW_S, state: 'on' }]);
        expect(opening.activity).to.deep.equal([]);
        // A stamp that is no time at all opens nothing.
        const stampless = JSON.parse(
          respond(
            binaryRequest(),
            [
              { ts: Number.NEGATIVE_INFINITY, state: 'on' },
              { ts: Number.NaN, state: 'on' },
              { ts: ms(DAY_S + 500), state: 'off' },
            ],
            { state: 'off', available: true, lastChanged: ms(DAY_S + 500) },
          ),
        );
        expect(stampless.segments).to.deep.equal([
          { start: DAY_S, end: DAY_S + 500, state: 'unknown' },
          { start: DAY_S + 500, end: NOW_S, state: 'off' },
        ]);
      });

      it('keeps the NEWEST 96 of more changes, oldest first on the wire -- and the panel keeps the same 96', () => {
        // 200 changes, one every 225 s: on after an odd one, off after an even
        // one. The popup keeps the FIRST 96 valid segments in wire order
        // (:1897-1899) and walks Activity from the end (:1923-1926), so only
        // the newest 96 of each, oldest first, survive as they should.
        const samples: Sample[] = [{ ts: ms(DAY_S - 1), state: 'off' }];
        for (let k = 1; k <= 200; k++) samples.push({ ts: ms(DAY_S + BIN2 * k), state: k % 2 ? 'on' : 'off' });
        const current: Current = { state: 'off', available: true, lastChanged: ms(DAY_S + BIN2 * 200) };
        const out = respond(binaryRequest(), samples, current);
        const doc = JSON.parse(out);
        const change = (k: number) => ({ timestamp: DAY_S + BIN2 * k, state: k % 2 ? 'on' : 'off' });
        const newest = Array.from({ length: 96 }, (_, i) => change(105 + i));
        expect(doc.activity).to.deep.equal(newest);
        expect(doc.segments).to.have.lengthOf(96);
        expect(doc.segments[0]).to.deep.equal({ start: DAY_S + BIN2 * 105, end: DAY_S + BIN2 * 106, state: 'on' });
        expect(doc.segments[95]).to.deep.equal({ start: DAY_S + BIN2 * 200, end: NOW_S, state: 'off' });

        const panel = panelBinary(out, 24)!;
        expect(panel.activity).to.deep.equal([...newest].reverse()); // stored newest first
        expect(panel.segments).to.deep.equal(doc.segments);
        // The bar still covers the whole window: the timeline is not capped.
        const expected = Array.from({ length: 768 }, (_, bin) => (bin < 400 && Math.floor(bin / 2) % 2 ? 1 : 0));
        expect(panel.bins).to.deep.equal(expected);

        // A client asking for fewer gets fewer, still the newest.
        const fewer = JSON.parse(respond(binaryRequest(24, 48), samples, current));
        expect(fewer.activity).to.deep.equal(newest.slice(-48));
        expect(fewer.segments).to.have.lengthOf(48);
        expect(fewer.segments[0].start).to.equal(DAY_S + BIN2 * 153);
      });

      it('collapses changes within one second to the last by the millisecond clock, whatever the input order', () => {
        const blip: Sample[] = [
          { ts: ms(DAY_S - 10), state: 'off' },
          { ts: ms(DAY_S + 1000, 900), state: 'off' },
          { ts: ms(DAY_S + 1000, 100), state: 'on' },
          { ts: ms(DAY_S + 2000, 900), state: 'on' },
          { ts: ms(DAY_S + 2000, 100), state: 'off' },
        ];
        const doc = JSON.parse(respond(binaryRequest(), blip, { state: 'on', available: true, lastChanged: ms(DAY_S + 2000, 900) }));
        expect(doc.activity).to.deep.equal([{ timestamp: DAY_S + 2000, state: 'on' }]);
        expect(doc.segments).to.deep.equal([
          { start: DAY_S, end: DAY_S + 2000, state: 'off' },
          { start: DAY_S + 2000, end: NOW_S, state: 'on' },
        ]);
      });

      it('closes the timeline with the live state when the history adapter lags behind it', () => {
        const logged: Sample[] = [
          { ts: ms(DAY_S - 10), state: 'off' },
          { ts: ms(DAY_S + 1000), state: 'on' },
          { ts: ms(DAY_S + 2000), state: 'off' },
        ];
        const lagging = JSON.parse(respond(binaryRequest(), logged, { state: 'on', available: true, lastChanged: ms(DAY_S + 5000) }));
        expect(lagging.activity).to.deep.equal([
          { timestamp: DAY_S + 1000, state: 'on' },
          { timestamp: DAY_S + 2000, state: 'off' },
          { timestamp: DAY_S + 5000, state: 'on' },
        ]);
        expect(lagging.segments.at(-1)).to.deep.equal({ start: DAY_S + 5000, end: NOW_S, state: 'on' });
        // Already logged: nothing added. Never observed (0): nothing added.
        const logged2 = JSON.parse(respond(binaryRequest(), logged, { state: 'off', available: true, lastChanged: ms(DAY_S + 2000) }));
        expect(logged2.activity).to.have.lengthOf(2);
        const unseen = JSON.parse(respond(binaryRequest(), logged, { state: 'on', available: true, lastChanged: 0 }));
        expect(unseen.activity).to.have.lengthOf(2);
      });

      it('answers an entity with no history with its live state across the window, never leaving a stale one up', () => {
        // The Bridge's rule with no Recorder rows (binary_history.py:144-146):
        // the live state stands for the window, and no change is made up from
        // its last_changed. History stays available: "no activity", not
        // "history unavailable".
        const out = respond(binaryRequest(), [], { state: 'on', available: true, lastChanged: ms(DAY_S + 5000) });
        const doc = JSON.parse(out);
        expect(doc).to.include({ history_available: true, current: 'on', available: true, last_changed: DAY_S + 5000 });
        expect(doc.segments).to.deep.equal([{ start: DAY_S, end: NOW_S, state: 'on' }]);
        expect(doc.activity).to.deep.equal([]);
        expect(doc.timeline_data).to.equal('55'.repeat(192));
        const panel = panelBinary(out, 24)!;
        expect(panel.available).to.equal(true);
        expect(panel.activity).to.deep.equal([]);

        const gone = JSON.parse(respond(binaryRequest(), [], { state: 'unavailable', available: false, lastChanged: ms(DAY_S + 5000) }));
        expect(gone).to.include({ current: 'unavailable', available: false });
        expect(gone.segments).to.deep.equal([{ start: DAY_S, end: NOW_S, state: 'unavailable' }]);
      });

      it('never sends null -- which would clear the popup (:1846-1870) -- and leaves out a last change it does not know', () => {
        const out = respond(binaryRequest(), [], { state: 'unknown', available: true, lastChanged: 0 });
        expect(JSON.parse(out)).to.not.have.property('last_changed');
        expect(out).to.not.match(/[:,[]null[,\]}]/);
      });
    });

    describe('state', () => {
      it('answers with exactly what apply_state_history_payload reads, texts escaped by JSON.stringify', () => {
        const at = (k: number): number => DAY_S + BIN2 * k;
        const samples: Sample[] = [
          { ts: ms(DAY_S - 60), state: 'Docked' },
          { ts: ms(at(10)), state: 'Cleaning [Zone 2]' },
          { ts: ms(at(20)), state: 'Error: "brush stuck"' },
          { ts: ms(at(30)), state: 'Docked' },
          { ts: ms(at(40)), state: 'Wäsche läuft' },
          { ts: ms(at(50)), state: 'エラー' },
          { ts: ms(at(60)), state: 'Docked' },
        ];
        const out = respond(stateRequest(), samples, { state: 'Docked', available: true, lastChanged: ms(at(60)) });
        // The palette opens with the two reserved states, then the newest first
        // (state_history.py:437-458); a timeline digit is a palette index.
        expect(out).to.equal(
          JSON.stringify({
            kind: 'state',
            entity_id: 'sensor.vacuum_status',
            hours: 24,
            range_start: DAY_S,
            range_end: NOW_S,
            history_available: true,
            current: 'Docked',
            timeline_points: 768,
            timeline_encoding: 'palette4-hex',
            timeline_data: '2'.repeat(20) + '6'.repeat(20) + '5'.repeat(20) + '2'.repeat(20) + '4'.repeat(20) + '3'.repeat(20) + '2'.repeat(648),
            palette: ['unknown', 'unavailable', 'Docked', 'エラー', 'Wäsche läuft', 'Error: "brush stuck"', 'Cleaning [Zone 2]'],
            palette_complete: true,
            segments: [
              { start: DAY_S, end: at(10), state: 'Docked' },
              { start: at(10), end: at(20), state: 'Cleaning [Zone 2]' },
              { start: at(20), end: at(30), state: 'Error: "brush stuck"' },
              { start: at(30), end: at(40), state: 'Docked' },
              { start: at(40), end: at(50), state: 'Wäsche läuft' },
              { start: at(50), end: at(60), state: 'エラー' },
              { start: at(60), end: NOW_S, state: 'Docked' },
            ],
            activity: [
              { timestamp: at(10), state: 'Cleaning [Zone 2]' },
              { timestamp: at(20), state: 'Error: "brush stuck"' },
              { timestamp: at(30), state: 'Docked' },
              { timestamp: at(40), state: 'Wäsche läuft' },
              { timestamp: at(50), state: 'エラー' },
              { timestamp: at(60), state: 'Docked' },
            ],
          }),
        );
        // Quotes escaped, UTF-8 kept as it is.
        expect(out).to.contain('"Error: \\"brush stuck\\""').and.to.contain('"エラー"');
        const panel = panelState(out, 24)!;
        expect(panel.current).to.equal('Docked');
        expect(panel.palette).to.deep.equal(JSON.parse(out).palette);
        expect(panel.bins.map((code) => panel.palette[code])).to.deep.equal([
          ...new Array(20).fill('Docked'),
          ...new Array(20).fill('Cleaning [Zone 2]'),
          ...new Array(20).fill('Error: "brush stuck"'),
          ...new Array(20).fill('Docked'),
          ...new Array(20).fill('Wäsche läuft'),
          ...new Array(20).fill('エラー'),
          ...new Array(648).fill('Docked'),
        ]);
        expect(panel.activity.map((entry) => entry.state)).to.deep.equal(['Docked', 'エラー', 'Wäsche läuft', 'Docked', 'Error: "brush stuck"', 'Cleaning [Zone 2]']);
      });

      it('names every state as normalize_state_history_value does, byte for byte (sensor_popup.cpp:917-953)', () => {
        // Hash suffixes computed with Python's hashlib over the firmware's
        // input: the text trimmed of ASCII blanks and cut to 255 bytes. The
        // Bridge hashes the whole text instead (state_history.py:575-589), which
        // for the 408-byte one gives ~a037a4ca -- a name the panel never uses.
        const texts: Array<[string, string]> = [
          ['Waiting for the next cleaning run', 'Waiting for the next cl~cd2bac7d'],
          ['Geschirrspüler läuft noch 1:30 h', 'Geschirrspüler läuft ~8d1d0d29'], // cut before byte 24, not re-trimmed
          ['Alarm im Wohnzimmer! 🔥 Feuer erkannt', 'Alarm im Wohnzimmer! ~454a720a'], // the emoji straddles byte 23
          [`Status: ${'ä'.repeat(200)}`, `Status: ${'ä'.repeat(7)}~d64001ac`],
          ['  UNKNOWN ', 'unknown'],
          ['Unavailable', 'unavailable'],
          ['\u00a0Idle\u00a0', '\u00a0Idle\u00a0'], // NBSP is no ASCII blank: kept
          ['  Idle\t', 'Idle'],
          // A lone surrogate reaches the panel over MQTT as U+FFFD; sent as the
          // escape \ud83d, ArduinoJson would make other bytes of it (Task 14 review m1).
          ['Fehler \ud83d', 'Fehler \ufffd'],
          ['', 'unknown'],
          ['unknown', 'unknown'], // the same state again: no change
        ];
        const samples: Sample[] = [{ ts: ms(DAY_S - 60), state: 'Docked' }, ...texts.map(([state], i) => ({ ts: ms(DAY_S + 100 * (i + 1)), state }))];
        const out = respond(stateRequest(), samples, { state: `Status: ${'ä'.repeat(200)}`, available: true, lastChanged: 0 });
        const doc = JSON.parse(out);
        expect(doc.activity.map((entry: { state: string }) => entry.state)).to.deep.equal(texts.slice(0, -1).map(([, label]) => label));
        // What we send is already the panel's own name: it keeps it unchanged.
        expect(panelState(out, 24)!.activity.map((entry) => entry.state).reverse()).to.deep.equal(doc.activity.map((e: { state: string }) => e.state));
        for (const { state } of doc.segments) expect(Buffer.byteLength(state)).to.be.at.most(32);
        expect(out).to.not.contain('\\ud83d');
        // current is the live value, which the panel cuts at 255 bytes (:917-926).
        expect(doc.current).to.equal(`Status: ${'ä'.repeat(123)}`);
      });

      it('fills at most 16 palette slots, newest states first, and shows the rest as unknown', () => {
        // kStateHistoryMaxPaletteEntries (sensor_popup.cpp:62; a longer list is
        // dropped whole, :2143-2150): reserved unknown/unavailable plus 14.
        const name = (k: number): string => `S${String(k).padStart(2, '0')}`;
        const samples: Sample[] = [{ ts: ms(DAY_S - 60), state: name(0) }];
        for (let k = 1; k <= 20; k++) samples.push({ ts: ms(DAY_S + BIN2 * k), state: name(k) });
        const out = respond(stateRequest(), samples, { state: name(20), available: true, lastChanged: ms(DAY_S + BIN2 * 20) });
        const doc = JSON.parse(out);
        expect(doc.palette).to.deep.equal(['unknown', 'unavailable', ...Array.from({ length: 14 }, (_, i) => name(20 - i))]);
        expect(doc.palette_complete).to.equal(false);
        // S00..S06 have no slot: unknown (0). S07 is index 15 (f) .. S20 index 2.
        expect(doc.timeline_data).to.equal('0'.repeat(14) + 'ffeeddccbbaa99887766554433' + '2'.repeat(728));
        expect(panelState(out, 24)!.palette).to.have.lengthOf(16);
        // Segments and Activity keep every state's own name.
        expect(doc.segments).to.have.lengthOf(21);
        expect(doc.activity.map((entry: { state: string }) => entry.state)).to.deep.equal(Array.from({ length: 20 }, (_, i) => name(i + 1)));
      });

      it('gives a bin to the state it ends in, as the panel fills a live change (sensor_popup.cpp:1389-1416)', () => {
        // Bin 100 is [11250, 11362.5): Idle for 100 s of it, Mowing for 12.5 s.
        const samples: Sample[] = [
          { ts: ms(DAY_S - 60), state: 'Idle' },
          { ts: ms(DAY_S + 11350), state: 'Mowing' },
        ];
        const doc = JSON.parse(respond(stateRequest(), samples, { state: 'Mowing', available: true, lastChanged: ms(DAY_S + 11350) }));
        expect(doc.palette).to.deep.equal(['unknown', 'unavailable', 'Mowing', 'Idle']);
        expect(doc.timeline_data).to.equal('3'.repeat(100) + '2'.repeat(668));
      });

      it('keeps kind, entity_id and hours ahead of every text, for the dispatcher\'s first-match scans', () => {
        // A state named like a key must not be what the dispatcher reads
        // (mqtt_handlers.cpp:326-350). If the pending request is not cleared,
        // the panel overwrites this reply 8 s later with "history unavailable"
        // (:541-553).
        const samples: Sample[] = [
          { ts: ms(DAY_S - 60), state: 'kind' },
          { ts: ms(DAY_S + 100), state: 'entity_id' },
          { ts: ms(DAY_S + 200), state: 'hours' },
          { ts: ms(DAY_S + 300), state: 'values' },
        ];
        const out = respond(stateRequest(), samples, { state: 'kind', available: true, lastChanged: ms(DAY_S + 300) });
        expect(dispatch(out, { entityId: 'sensor.vacuum_status', kind: 'state', hours: 24 })).to.deep.equal({ clearsPending: true, toTileGraph: false });
        expect(out.startsWith('{"kind":"state","entity_id":"sensor.vacuum_status","hours":24,')).to.equal(true);
      });

      it('answers "history unavailable" rather than a reply over the 32767 bytes the panel reads (mqtt_handlers.cpp:1496, :1836)', () => {
        // Pathological texts: 31 control characters each, six bytes apiece on
        // the wire. Cut, the reply would not parse, and the popup -- its pending
        // request already cleared by the scan -- would stay on "Loading".
        const samples: Sample[] = [{ ts: ms(DAY_S - 60), state: 'A' }];
        for (let k = 1; k <= 200; k++) samples.push({ ts: ms(DAY_S + BIN2 * k), state: '\u0001'.repeat(31) + (k % 2 ? 'B' : 'C') });
        const out = respond(stateRequest(), samples, { state: 'A', available: true, lastChanged: 0 });
        expect(out).to.equal('{"kind":"state","entity_id":"sensor.vacuum_status","hours":24,"history_available":false,"error":"response_too_large"}');
        expect(panelState(out, 24)!.available).to.equal(false);
        expect(dispatch(out, { entityId: 'sensor.vacuum_status', kind: 'state', hours: 24 }).clearsPending).to.equal(true);
      });

      it('keeps the largest realistic reply inside the 32767 bytes', () => {
        // The longest entity id, 96 changes among 20 states of 32 quote-heavy
        // bytes (each doubled by escaping), a 255-byte current value.
        const entity = `sensor.${'x'.repeat(248)}`;
        const label = (k: number): string => '"'.repeat(31) + String.fromCharCode(65 + (k % 20));
        const samples: Sample[] = [{ ts: ms(DAY_S - 60), state: label(0) }];
        for (let k = 1; k <= 200; k++) samples.push({ ts: ms(DAY_S + BIN2 * k), state: label(k) });
        const out = respond(stateRequest(entity), samples, { state: '"'.repeat(255), available: true, lastChanged: 0 });
        expect(JSON.parse(out)).to.include({ history_available: true, current: '"'.repeat(255) });
        expect(Buffer.byteLength(out)).to.be.at.most(32767);
      });
    });

    describe('editable (Ruling 121)', () => {
      it('answers a select popup with the state history, its request_id and hours echoed (sensor_popup.cpp:2252-2261)', () => {
        const select = statesOf(synthSelect, MODE, [
          { ts: ms(DAY_S - 60), val: 1 },
          { ts: ms(DAY_S + BIN2 * 100), val: 2 },
          { ts: ms(DAY_S + BIN2 * 200), val: 0 },
        ]);
        const out = respond(editableRequest('select.heating_mode'), select, { state: 'Off', available: true, lastChanged: ms(DAY_S + BIN2 * 200) });
        // "state" keeps it off the tile graphs (mqtt_handlers.cpp:1870-1871);
        // an editable popup reads no current (:2111).
        expect(out).to.equal(
          JSON.stringify({
            kind: 'state',
            entity_id: 'select.heating_mode',
            hours: 24,
            request_id: REQUEST_ID,
            range_start: DAY_S,
            range_end: NOW_S,
            history_available: true,
            timeline_points: 768,
            timeline_encoding: 'palette4-hex',
            timeline_data: '4'.repeat(200) + '3'.repeat(200) + '2'.repeat(368),
            palette: ['unknown', 'unavailable', 'Off', 'Comfort', 'Eco'],
            palette_complete: true,
            segments: [
              { start: DAY_S, end: DAY_S + BIN2 * 100, state: 'Eco' },
              { start: DAY_S + BIN2 * 100, end: DAY_S + BIN2 * 200, state: 'Comfort' },
              { start: DAY_S + BIN2 * 200, end: NOW_S, state: 'Off' },
            ],
            activity: [
              { timestamp: DAY_S + BIN2 * 100, state: 'Comfort' },
              { timestamp: DAY_S + BIN2 * 200, state: 'Off' },
            ],
          }),
        );
        const popup = { entityId: 'select.heating_mode', kind: 'select' as const, requestId: REQUEST_ID, hours: 24 as const };
        const shown = panelEditable(out, popup);
        expect(shown?.history.activity).to.deep.equal([
          { timestamp: DAY_S + BIN2 * 200, state: 'Off' },
          { timestamp: DAY_S + BIN2 * 100, state: 'Comfort' },
        ]);
        expect(shown?.history.bins).to.have.lengthOf(768);
        // A reply to another request, or for the other range, is dropped.
        expect(panelEditable(out, { ...popup, requestId: 'ffffffff-00000000-00000002' })).to.equal(null);
        expect(panelEditable(out, { ...popup, hours: 168 })).to.equal(null);
      });

      it('answers a number popup with Task 17 graph values beside its Activity, and nothing it would drop', () => {
        const setpoint = statesOf(synthNumber, SETPOINT, [
          { ts: ms(DAY_S - 600), val: 20 },
          { ts: ms(DAY_S + 3600), val: 21.5 }, // bucket 12 of 288
          { ts: ms(DAY_S + 7200), val: 21.5, q: 0x42 }, // unavailable: no reading
          { ts: ms(DAY_S + 9000), val: 22 }, // bucket 30
        ]);
        const out = respond(editableRequest('number.living_room_setpoint'), setpoint, { state: '22', available: true, lastChanged: ms(DAY_S + 9000) });
        // kind "number", never "state": for "state" the popup returns before its
        // graph (:2309-2310). period_minutes is the range's (:2287-2289). No
        // palette or bar: a number's bar is hidden (:2071), as the Bridge
        // leaves them out (editable_helpers.py:188-190). values before any text:
        // the tile graph takes the first "values" (tile_renderer.cpp:4521).
        const values = [...new Array(12).fill(20), ...new Array(18).fill(21.5), ...new Array(258).fill(22)];
        expect(out).to.equal(
          JSON.stringify({
            kind: 'number',
            entity_id: 'number.living_room_setpoint',
            hours: 24,
            request_id: REQUEST_ID,
            period_minutes: 5,
            range_start: DAY_S,
            range_end: NOW_S,
            history_available: true,
            values,
            activity: [
              { timestamp: DAY_S + 3600, state: '21.5' },
              { timestamp: DAY_S + 7200, state: 'unavailable' },
              { timestamp: DAY_S + 9000, state: '22' },
            ],
          }),
        );
        const popup = { entityId: 'number.living_room_setpoint', kind: 'number' as const, requestId: REQUEST_ID, hours: 24 as const };
        const shown = panelEditable(out, popup);
        expect(shown?.values).to.deep.equal(values);
        expect(shown?.history.activity.map((entry) => entry.state)).to.deep.equal(['22', 'unavailable', '21.5']);
      });

      it('gives a number popup 168 hourly values for the seven-day range', () => {
        const setpoint = statesOf(synthNumber, SETPOINT, [{ ts: ms(WEEK_S - 600), val: 19.5 }]);
        const out = respond(editableRequest('number.living_room_setpoint', 168), setpoint, { state: '19.5', available: true, lastChanged: ms(WEEK_S - 600) });
        const doc = JSON.parse(out);
        expect(doc).to.include({ kind: 'number', hours: 168, period_minutes: 60, request_id: REQUEST_ID });
        expect(doc.values).to.deep.equal(new Array(168).fill(19.5));
        const popup = { entityId: 'number.living_room_setpoint', kind: 'number' as const, requestId: REQUEST_ID, hours: 168 as const };
        expect(panelEditable(out, popup)?.values).to.have.lengthOf(168);
      });

      it('answers a date/time popup with the state history of its texts', () => {
        const samples: Sample[] = [
          { ts: ms(DAY_S - 60), state: '2026-09-22 06:30:00' },
          { ts: ms(DAY_S + 7200), state: '2026-09-23 07:00:00' },
        ];
        const out = respond(editableRequest('datetime.wake_up'), samples, { state: '2026-09-23 07:00:00', available: true, lastChanged: ms(DAY_S + 7200) });
        const doc = JSON.parse(out);
        expect(doc).to.include({ kind: 'state', request_id: REQUEST_ID, hours: 24 });
        expect(doc).to.not.have.property('current');
        const popup = { entityId: 'datetime.wake_up', kind: 'datetime' as const, requestId: REQUEST_ID, hours: 24 as const };
        expect(panelEditable(out, popup)?.history.activity).to.deep.equal([{ timestamp: DAY_S + 7200, state: '2026-09-23 07:00:00' }]);
      });

      it('answers an editable with no history with an empty graph and no Activity, never a stale one', () => {
        const out = respond(editableRequest('number.living_room_setpoint'), [], { state: '21', available: true, lastChanged: ms(DAY_S + 100) });
        const doc = JSON.parse(out);
        expect(doc.values).to.deep.equal(new Array(288).fill(null));
        expect(doc.activity).to.deep.equal([]);
        const popup = { entityId: 'number.living_room_setpoint', kind: 'number' as const, requestId: REQUEST_ID, hours: 24 as const };
        expect(panelEditable(out, popup)?.values).to.deep.equal(new Array(288).fill(null));
      });

      it('keeps request_id and hours on the "history unavailable" reply, so the popup takes it', () => {
        const samples: Sample[] = [{ ts: ms(DAY_S - 60), state: 'A' }];
        for (let k = 1; k <= 200; k++) samples.push({ ts: ms(DAY_S + BIN2 * k), state: '\u0001'.repeat(31) + (k % 2 ? 'B' : 'C') });
        const out = respond(editableRequest('select.heating_mode'), samples, { state: 'A', available: true, lastChanged: 0 });
        expect(out).to.equal(
          `{"kind":"state","entity_id":"select.heating_mode","hours":24,"request_id":"${REQUEST_ID}","history_available":false,"error":"response_too_large"}`,
        );
        const popup = { entityId: 'select.heating_mode', kind: 'select' as const, requestId: REQUEST_ID, hours: 24 as const };
        expect(panelEditable(out, popup)?.history.available).to.equal(false);
      });
    });

    it('refuses a request the parser would have refused, with no response at all', () => {
      const current: Current = { state: 'on', available: true, lastChanged: 0 };
      for (const maxTransitions of [0, 1, 97, 2.5, Number.NaN]) {
        const req: DiscreteRequest = { kind: 'binary', entityId: 'binary_sensor.x', hours: 24, maxTransitions };
        expect(buildDiscreteHistoryResponse(req, [], NOW, current), String(maxTransitions)).to.equal(null);
      }
      const odd = { kind: 'state', entityId: 'sensor.x', hours: 12, maxTransitions: 96 } as unknown as DiscreteRequest;
      expect(buildDiscreteHistoryResponse(odd, [], NOW, current)).to.equal(null);
    });
  });
});
