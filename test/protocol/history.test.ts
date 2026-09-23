import { expect } from 'chai';
import { parseHistoryRequest } from '../../src/protocol/history';

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
});
