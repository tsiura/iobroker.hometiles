import { expect } from 'chai';
import { createHash } from 'node:crypto';
import {
  buildControlPayload,
  buildValueAck,
  CONTROL_SESSION,
  controlRevision,
  MAX_CONTROL_BYTES,
  type ControlPayload,
} from '../../src/protocol/editable';
import { MAX_ENTITY_ID_LENGTH } from '../../src/registry/entity-id';
import type { VirtualEntity } from '../../src/registry/types';

/*
 * The /control payload of number, select and datetime (Task 14,
 * docs/contract-editable.md §3, §5, §6, §8). The firmware is the judge:
 * parse_editable_value (HomeTiles src/types/value/value_control.cpp:63-107)
 * rejects the whole message, or strips a capability, on any single mistake,
 * and never logs why. The Bridge's build_editable_payload
 * (editable_helpers.py:48-97) is the reference sender.
 */

const SESSION = '0123456789abcdef0123456789abcdef';

const NUMBER: VirtualEntity = {
  entityId: 'number.soll',
  domain: 'number',
  source: { set: '0_userdata.0.Heizung.Soll' },
  state: '21.5',
  attributes: { friendly_name: 'Soll', min: 15, max: 28, step: 0.5, unit_of_measurement: '°C' },
  available: true,
  lastChanged: 1_758_600_000_999,
  writable: { value: true },
};

const SELECT: VirtualEntity = {
  entityId: 'select.modus',
  domain: 'select',
  source: { set: '0_userdata.0.Heizung.Modus' },
  state: 'Eco',
  attributes: { friendly_name: 'Heizmodus', options: ['Aus', 'Eco', 'Komfort'] },
  available: true,
  lastChanged: 1_758_600_000_000,
  writable: { value: true },
};

const TIME: VirtualEntity = {
  entityId: 'datetime.wecker',
  domain: 'datetime',
  source: { set: '0_userdata.0.Wecker.Zeit' },
  state: '06:45',
  attributes: { friendly_name: 'Wecker', has_date: false, has_time: true },
  available: true,
  lastChanged: 1_758_600_000_000,
  writable: { value: true },
};

const change = (base: VirtualEntity, over: Partial<VirtualEntity>): VirtualEntity => ({ ...base, ...over });
const withAttributes = (base: VirtualEntity, attributes: Record<string, unknown>): VirtualEntity =>
  change(base, { attributes: { ...base.attributes, ...attributes } });

/** A select whose option list escaping takes over the panel's limit: 64 options of 255 quotes, 2 bytes each on the wire. */
const HUGE = withAttributes(SELECT, {
  options: Array.from({ length: 64 }, (_, index) => `${'"'.repeat(253)}${String(index).padStart(2, '0')}`),
});

/** The builder's result, which is never null: Ruling 98 keeps null for a case that cannot happen. */
function built(entity: VirtualEntity, session = SESSION): ControlPayload {
  const result = buildControlPayload(entity, session);
  expect(result, 'a published payload').to.not.equal(null);
  return result!;
}

/** A payload published whole, parsed. */
function control(entity: VirtualEntity, session = SESSION): Record<string, unknown> {
  const { payload, degraded } = built(entity, session);
  expect(degraded, 'published whole').to.equal(false);
  return JSON.parse(payload) as Record<string, unknown>;
}

const revisionOf = (entity: VirtualEntity, session = SESSION): unknown => control(entity, session).revision;
const utf8 = (text: string): number => Buffer.byteLength(text, 'utf8');

describe('protocol/editable: the /control payload (Task 14)', () => {
  describe('the fields, as the panel reads them', () => {
    it('number: version, kind, state, availability, tokens, range, mode, unit and last_changed in seconds', () => {
      expect(control(NUMBER)).to.deep.equal({
        version: 1,
        kind: 'number',
        state: '21.5',
        available: true,
        writable: true,
        session: SESSION,
        revision: controlRevision(NUMBER, SESSION),
        min: 15,
        max: 28,
        step: 0.5,
        // ioBroker has no number mode; the panel's own default (value_control.cpp:87).
        mode: 'auto',
        unit: '°C',
        // Epoch seconds, as the Bridge sends it (__init__.py:1534-1536), floored.
        last_changed: 1_758_600_000,
      });
    });

    it('select: the complete option list, marked complete (value_control.cpp:90-104)', () => {
      expect(control(SELECT)).to.deep.equal({
        version: 1,
        kind: 'select',
        state: 'Eco',
        available: true,
        writable: true,
        session: SESSION,
        revision: controlRevision(SELECT, SESSION),
        options_complete: true,
        options: ['Aus', 'Eco', 'Komfort'],
        last_changed: 1_758_600_000,
      });
    });

    it('datetime: the kind from has_date and has_time, and nothing the panel does not read for it', () => {
      // No min/max/step/mode/unit/options (read for number and select only,
      // :81-104) and no time_zone, which the Bridge sends (editable_helpers.py:83)
      // and the firmware never reads.
      expect(control(TIME)).to.deep.equal({
        version: 1,
        kind: 'time',
        state: '06:45',
        available: true,
        writable: true,
        session: SESSION,
        revision: controlRevision(TIME, SESSION),
        last_changed: 1_758_600_000,
      });
      const kind = (has_date: unknown, has_time: unknown): unknown =>
        control(change(TIME, { attributes: { friendly_name: 'W', has_date, has_time } })).kind;
      expect(kind(true, false)).to.equal('date');
      expect(kind(false, true)).to.equal('time');
      expect(kind(true, true)).to.equal('datetime');
      // A text in no calendar shape carries no flags and is read-only (the
      // synth's rule); its kind is then the domain's own, which the panel
      // shows verbatim (contract §7).
      expect(control(change(TIME, { state: '23.09.2026', attributes: { friendly_name: 'W' }, writable: { value: false } }))).to.include({
        kind: 'datetime',
        state: '23.09.2026',
        writable: false,
      });
    });

    it('omits last_changed for a value never observed, rather than inventing a time (buildApplyPayload\'s rule)', () => {
      expect(control(change(NUMBER, { lastChanged: 0 }))).to.not.have.property('last_changed');
    });

    it('sends no key the panel does not read from /control: no name, icon, entity id or read-only reason', () => {
      const readOnly = change(NUMBER, { writable: { value: false }, readOnly: 'write is false', attributes: { ...NUMBER.attributes, icon: 'mdi:fire' } });
      const { payload } = built(readOnly);
      expect(Object.keys(JSON.parse(payload))).to.have.members([
        'version', 'kind', 'state', 'available', 'writable', 'session', 'revision', 'min', 'max', 'step', 'mode', 'unit', 'last_changed',
      ]);
      // VirtualEntity.readOnly (Task 13b) is a log line in main.ts, never wire data.
      expect(payload).to.not.include('write is false');
      expect(payload).to.not.include('readOnly');
    });
  });

  describe('unknown and unavailable (Ruling 91)', () => {
    it('sends an unknown value as the string "unknown", available and writable by its constraints', () => {
      // Never state null: the panel makes a null state unavailable and
      // unwritable (value_control.cpp:72, :76), so a fresh helper could never
      // be set. The Bridge sends "unknown" exactly so (editable_helpers.py:55-58).
      for (const entity of [NUMBER, SELECT, TIME]) {
        const p = control(change(entity, { state: 'unknown' }));
        expect(p, entity.domain).to.include({ state: 'unknown', available: true, writable: true });
      }
    });

    it('sends a bad-quality value as "unavailable", not available and not writable', () => {
      for (const entity of [NUMBER, SELECT, TIME]) {
        const p = control(change(entity, { state: 'unavailable', available: false }));
        expect(p, entity.domain).to.include({ state: 'unavailable', available: false, writable: false });
      }
    });

    it('is writable only when the value is available and the entity writable (value_control.cpp:77)', () => {
      expect(control(change(NUMBER, { writable: { value: false } }))).to.include({ writable: false });
      expect(control(change(NUMBER, { writable: undefined }))).to.include({ writable: false });
      expect(control(change(NUMBER, { writable: {} }))).to.include({ writable: false });
      // O3: a bad-quality value keeps writable.value true in the registry.
      expect(control(change(NUMBER, { state: 'unavailable', available: false, writable: { value: true } }))).to.include({ writable: false });
    });
  });

  describe('what the panel would reject or strip, never sent', () => {
    it('sends a state of up to 255 bytes, and "unknown" for a longer one, which the panel rejects whole (value_control.cpp:75)', () => {
      const bytes255 = '€'.repeat(85);
      expect(utf8(bytes255)).to.equal(255);
      expect(control(change(SELECT, { state: bytes255 })).state).to.equal(bytes255);
      // 86 characters but 258 bytes: the limit is the firmware's String::length(), bytes.
      expect(control(change(SELECT, { state: `${bytes255}€` })).state).to.equal('unknown');
      expect(control(change(SELECT, { state: 'x'.repeat(256) })).state).to.equal('unknown');
    });

    it('sends "unknown" for a state with a line break or NUL: two dropdown rows would shift every option by one', () => {
      // A select state that is no option is prepended as one placeholder row
      // (option_offset 1, value_control.cpp:844-845); a \n makes it two rows
      // in lv_dropdown, so a tap on "Aus" would submit the option below
      // (:497-498). NUL ends the panel's copy of the text.
      for (const state of ['Aus\nEco', 'Aus\rEco', 'Aus\0Eco']) {
        expect(control(change(SELECT, { state })).state, JSON.stringify(state)).to.equal('unknown');
      }
    });

    it('sends "unknown" for a state holding a lone UTF-16 surrogate, which the panel counts longer (review m1)', () => {
      // Node counts a lone surrogate as U+FFFD, 3 bytes. ArduinoJson 7.4.3
      // drops a lone high one and turns a lone low one into 4 bytes
      // (Utf16.hpp:36-50), so 255 bytes here are 256 on the panel, which then
      // drops the whole message (value_control.cpp:75).
      for (const state of [`${'x'.repeat(252)}\udc00`, `${'x'.repeat(249)}\udc00\udc00`, '\udc00'.repeat(64), 'Eco\ud800']) {
        expect(utf8(state), JSON.stringify(state)).to.be.at.most(255);
        expect(control(change(SELECT, { state })).state, JSON.stringify(state)).to.equal('unknown');
      }
      // A valid pair is one character, 4 bytes on both sides.
      expect(control(change(SELECT, { state: 'Sonne 😀' })).state).to.equal('Sonne 😀');
    });

    it('sends a unit of up to 128 bytes, and none for a longer one, which the panel would blank (value_control.cpp:89)', () => {
      const bytes128 = `${'€'.repeat(42)}xy`;
      expect(utf8(bytes128)).to.equal(128);
      expect(control(withAttributes(NUMBER, { unit_of_measurement: bytes128 })).unit).to.equal(bytes128);
      // 43 characters, 129 bytes.
      expect(control(withAttributes(NUMBER, { unit_of_measurement: '€'.repeat(43) }))).to.not.have.property('unit');
      expect(control(withAttributes(NUMBER, { unit_of_measurement: '' }))).to.not.have.property('unit');
      expect(control(withAttributes(NUMBER, { unit_of_measurement: undefined }))).to.not.have.property('unit');
    });

    it('sends only finite numbers as min, max and step; a missing one stays missing', () => {
      const p = control(change(NUMBER, { attributes: { friendly_name: 'Stufe' }, writable: { value: false } }));
      expect(p).to.not.have.any.keys('min', 'max', 'step');
      expect(p).to.include({ kind: 'number', mode: 'auto', writable: false });
      const odd = control(withAttributes(NUMBER, { min: Number.NaN, max: '28', step: Number.POSITIVE_INFINITY }));
      expect(odd).to.not.have.any.keys('min', 'max', 'step');
    });

    it('accepts the largest list the panel does: 64 options of 255 bytes each', () => {
      const options = Array.from({ length: 64 }, (_, index) => `${'€'.repeat(84)}${String(index).padStart(3, '0')}`);
      expect(options.every((option) => utf8(option) === 255)).to.equal(true);
      expect(control(withAttributes(SELECT, { options }))).to.deep.include({ options_complete: true, options, writable: true });
    });

    it('omits options entirely rather than sending a list the panel would drop, and is then read-only', () => {
      // No partial acceptance: one bad option clears the list and the select
      // goes read-only (contract §6, value_control.cpp:92-103).
      const lists: Array<[string, unknown]> = [
        ['no options', []],
        ['65 options', Array.from({ length: 65 }, (_, index) => `o${index}`)],
        ['an empty option', ['Aus', '']],
        ['an option of 256 bytes', ['Aus', 'x'.repeat(256)]],
        ['an option of 86 characters, 258 bytes', ['Aus', '€'.repeat(86)]],
        ['a newline', ['Aus', 'Eco\nKomfort']],
        ['a carriage return', ['Aus', 'Eco\rKomfort']],
        ['a NUL', ['Aus', 'Eco\0Komfort']],
        ['a lone low surrogate, 4 bytes on the panel', ['Aus', `${'x'.repeat(252)}\udc00`]],
        ['a lone high surrogate, dropped by the panel', ['Aus', 'Eco\ud800']],
        ['a duplicate', ['Aus', 'Eco', 'Aus']],
        ['a number', ['Aus', 2]],
        ['a null', ['Aus', null]],
        ['no array', 'Aus,Eco'],
        ['nothing', undefined],
      ];
      for (const [label, options] of lists) {
        const p = control(withAttributes(SELECT, { options }));
        expect(p, label).to.not.have.property('options');
        expect(p, label).to.not.have.property('options_complete');
        expect(p, label).to.include({ writable: false });
      }
    });

    it('throws on a session that is not exactly 32 bytes: the adapter\'s own programming error', () => {
      // A UUID is 36 and would silently break every editable tile (value_control.cpp:80).
      expect(() => buildControlPayload(NUMBER, '123e4567-e89b-12d3-a456-426614174000')).to.throw(/session/);
      expect(() => buildControlPayload(NUMBER, '')).to.throw(/session/);
      // 32 characters but 64 bytes: the panel counts bytes.
      expect(() => buildControlPayload(NUMBER, 'é'.repeat(32))).to.throw(/session/);
    });

    it('computes a revision of exactly 16 characters, which the panel requires (value_control.cpp:80)', () => {
      for (const entity of [NUMBER, SELECT, TIME]) expect(revisionOf(entity)).to.match(/^[0-9a-f]{16}$/);
    });
  });

  describe('the revision (Ruling 95)', () => {
    it('is the first 16 hex of sha256 over the sort-keyed JSON of every field but state, last_changed and revision', () => {
      const sorted =
        '{"available":true,"kind":"number","max":28,"min":15,"mode":"auto",' +
        `"session":"${SESSION}","step":0.5,"unit":"°C","version":1,"writable":true}`;
      expect(revisionOf(NUMBER)).to.equal(createHash('sha256').update(sorted).digest('hex').slice(0, 16));
    });

    it('stays the same while only the value changes: a new one aborts the panel\'s drag (value_control.cpp:816-817)', () => {
      for (const entity of [NUMBER, SELECT, TIME]) {
        const values = ['1', 'Komfort', '07:00', 'unknown'].map((state, index) => change(entity, { state, lastChanged: 1_758_600_100_000 + index * 60_000 }));
        expect(new Set([entity, ...values].map((each) => revisionOf(each))), entity.domain).to.have.property('size', 1);
      }
    });

    it('changes with every constraint: min, max, step, unit, options, availability, writability, kind and session', () => {
      const changed: Array<[string, VirtualEntity, VirtualEntity?]> = [
        ['min', withAttributes(NUMBER, { min: 16 })],
        ['max', withAttributes(NUMBER, { max: 27 })],
        ['step', withAttributes(NUMBER, { step: 1 })],
        ['unit', withAttributes(NUMBER, { unit_of_measurement: '°F' })],
        ['options', withAttributes(SELECT, { options: ['Aus', 'Eco', 'Komfort', 'Boost'] }), SELECT],
        ['option order', withAttributes(SELECT, { options: ['Eco', 'Aus', 'Komfort'] }), SELECT],
        ['availability', change(NUMBER, { state: 'unavailable', available: false })],
        ['writability', change(NUMBER, { writable: { value: false } })],
        ['kind', withAttributes(TIME, { has_date: true }), TIME],
      ];
      for (const [label, entity, base = NUMBER] of changed) {
        expect(revisionOf(entity), label).to.not.equal(revisionOf(base));
      }
      expect(revisionOf(NUMBER, 'f'.repeat(32)), 'session').to.not.equal(revisionOf(NUMBER));
    });

    it('does not depend on the order of the entity\'s keys or attributes', () => {
      const reordered: VirtualEntity = {
        writable: { value: true },
        lastChanged: NUMBER.lastChanged,
        available: true,
        attributes: { unit_of_measurement: '°C', step: 0.5, max: 28, min: 15, friendly_name: 'Soll' },
        state: '21.5',
        source: { set: '0_userdata.0.Heizung.Soll' },
        domain: 'number',
        entityId: 'number.soll',
      };
      expect(built(reordered)).to.deep.equal(built(NUMBER));
    });

    it('is what controlRevision gives, the comparison Task 15 makes for a command, a payload without its list included', () => {
      for (const entity of [NUMBER, SELECT, TIME, change(SELECT, { attributes: { friendly_name: 'x' } }), HUGE]) {
        expect(controlRevision(entity, SESSION), entity.entityId).to.equal(JSON.parse(built(entity).payload).revision);
      }
    });
  });

  describe('the session', () => {
    it('is one 32-hex token for this process', () => {
      expect(CONTROL_SESSION).to.match(/^[0-9a-f]{32}$/);
    });
  });

  describe('the size limit (Ruling 98)', () => {
    /**
     * A select whose whole payload is exactly `target` bytes: 48 options of
     * quotes (each 2 bytes on the wire as \"), unique by a two-digit suffix,
     * and one option of plain letters, 1 byte each, to top it up.
     */
    function selectOfSize(target: number): VirtualEntity {
      for (let quotes = 253; quotes > 0; quotes -= 1) {
        const heavy = Array.from({ length: 48 }, (_, index) => `${'"'.repeat(quotes)}${String(index).padStart(2, '0')}`);
        const probe = built(withAttributes(SELECT, { options: [...heavy, 'x'] }));
        const filler = probe.degraded ? 0 : 1 + target - utf8(probe.payload);
        if (filler >= 1 && filler <= 255) return withAttributes(SELECT, { options: [...heavy, 'x'.repeat(filler)] });
      }
      throw new Error(`no select of ${target} bytes`);
    }

    /**
     * Published without its option list: read-only, still showing its
     * current state, never a stale writable payload left on the panel
     * (review O1), and with the revision controlRevision gives.
     */
    function expectWithoutOptions(entity: VirtualEntity): string {
      const { payload, degraded } = built(entity);
      expect(degraded).to.equal(true);
      const fields = JSON.parse(payload) as Record<string, unknown>;
      expect(fields).to.not.have.any.keys('options', 'options_complete');
      expect(fields).to.include({ kind: 'select', state: entity.state, available: true, writable: false });
      expect(fields.revision).to.equal(controlRevision(entity, SESSION));
      return payload;
    }

    it('publishes a payload of exactly 24576 bytes whole, and one byte more without its option list (value_control.h:8, :65)', () => {
      expect(MAX_CONTROL_BYTES).to.equal(24576);
      const largest = built(selectOfSize(24576));
      expect([largest.degraded, utf8(largest.payload)]).to.deep.equal([false, 24576]);
      expect(JSON.parse(largest.payload)).to.include({ options_complete: true, writable: true });
      expectWithoutOptions(selectOfSize(24577));
    });

    it('counts UTF-8 bytes, not string length', () => {
      // 40 options of quotes and 24 of euro signs: under 24576 in UTF-16
      // units, over it in bytes, which is what the panel measures.
      const quotes = Array.from({ length: 40 }, (_, index) => `${'"'.repeat(253)}${String(index).padStart(2, '0')}`);
      const euros = Array.from({ length: 24 }, (_, index) => `${'€'.repeat(84)}${String(index).padStart(2, '0')}`);
      const wire = JSON.stringify({ options: [...quotes, ...euros] });
      // Room for the ~200 ASCII bytes of the other fields.
      expect(wire.length + 1000).to.be.below(MAX_CONTROL_BYTES);
      expect(utf8(wire)).to.be.above(MAX_CONTROL_BYTES);
      expectWithoutOptions(withAttributes(SELECT, { options: [...quotes, ...euros] }));
    });

    it('cannot be reached by multi-byte text alone: 64 options and a state of 255 bytes each stay far below it', () => {
      // JSON.stringify writes non-ASCII as raw UTF-8, never as \u escapes:
      // 4-, 2- and 3-byte characters, 255 bytes per option.
      const options = Array.from({ length: 64 }, (_, index) => `${'😀'.repeat(62)}é€${String(index).padStart(2, '0')}`);
      const state = `${'😀'.repeat(62)}é€xy`;
      expect([state, ...options].every((text) => utf8(text) === 255)).to.equal(true);
      const { payload } = built(withAttributes(change(SELECT, { state }), { options }));
      expect(control(withAttributes(change(SELECT, { state }), { options }))).to.deep.include({ state, options });
      expect(utf8(payload)).to.be.below(17_500);
    });

    it('leaves out an option list that escaping makes too large, and keeps the state it shows current', () => {
      // A skip would leave the panel's old retained payload up, writable,
      // and every command against it refused as "changed" (review O1).
      expectWithoutOptions(HUGE);
      expectWithoutOptions(change(HUGE, { state: 'Komfort' }));
    });

    it('always fits without its list: the list is the only unbounded part, so the null path cannot run', () => {
      // The worst escaping everywhere else: a state of 255 control characters,
      // 6 bytes each on the wire (\u0001), beside 64 such options.
      const state = '\u0001'.repeat(255);
      const options = Array.from({ length: 64 }, (_, index) => `${'\u0001'.repeat(253)}${String(index).padStart(2, '0')}`);
      const payload = expectWithoutOptions(withAttributes(change(SELECT, { state }), { options }));
      expect(utf8(payload)).to.be.below(2_000);
    });
  });
});

describe('protocol/editable: the answer to a value command (Task 15)', () => {
  // The panel reads it at value_control.cpp:913-930: <base>/stat/value, at
  // most 1024 bytes, entity_id and id exactly as it sent them, and only the
  // literal string "ok" as accepted. The Bridge sends the same three keys,
  // not retained (__init__.py:1584-1585).
  const REFUSALS = ['expired', 'changed', 'unavailable', 'invalid_value', 'invalid_step', 'invalid_option', 'failed'] as const;

  it('goes to <base>/stat/value, not retained, with exactly the three keys the panel reads', () => {
    expect(buildValueAck('hometiles', 'number.soll', '1a2b3c4d-0002b1c8-00000007', 'ok')).to.deep.equal({
      topic: 'hometiles/stat/value',
      payload: '{"entity_id":"number.soll","id":"1a2b3c4d-0002b1c8-00000007","status":"ok"}',
      retain: false,
    });
  });

  it('says ok as the literal string, and every refusal as another', () => {
    for (const status of REFUSALS) {
      const ack = JSON.parse(buildValueAck('hometiles', 'number.soll', 'abc', status).payload) as Record<string, unknown>;
      expect(ack).to.deep.equal({ entity_id: 'number.soll', id: 'abc', status });
      expect(ack.status).to.not.equal('ok');
    }
  });

  it('stays within the 1024 bytes the panel reads, for the longest entity id, id and status there are', () => {
    // An id of 48 characters that each escape to 6 bytes, the longest status.
    const entityId = `number.${'x'.repeat(MAX_ENTITY_ID_LENGTH - 'number.'.length)}`;
    const { payload } = buildValueAck('hometiles', entityId, '\u0001'.repeat(48), 'invalid_option');
    expect(Buffer.byteLength(payload)).to.be.at.most(1024);
  });
});
