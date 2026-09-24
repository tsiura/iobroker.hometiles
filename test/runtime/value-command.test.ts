import { expect } from 'chai';
import { parseAnnouncement } from '../../src/protocol/announce';
import { sentByPanel } from '../../src/protocol/arduinojson';
import { CONTROL_SESSION, controlRevision } from '../../src/protocol/editable';
import { synthDatetime, synthNumber, synthSelect } from '../../src/registry/synth/editable';
import type { ChannelInput, DatetimeKind, DeviceInput, SourceValue, VirtualEntity } from '../../src/registry/types';
import { Dispatcher, type StateWriter } from '../../src/runtime/dispatcher';
import type { Logger, PublishRequest } from '../../src/runtime/mqtt-client';
import { PanelSession, type PanelTransport } from '../../src/runtime/panel-session';

/*
 * The panel's value command, <base>/cmnd/value, and its answer on
 * <base>/stat/value (Task 15, docs/contract-editable.md §4, §5). The Bridge
 * is the reference receiver (Ruling 99): _async_handle_value_command,
 * __init__.py:1549-1590, and build_editable_service_call,
 * editable_helpers.py:100-152. The firmware reads the answer at
 * value_control.cpp:913-930: only the exact entity_id and id of its one
 * command in flight, and only the literal status "ok" as accepted.
 *
 * Every entity below comes out of the real synths, and every command runs
 * the whole session: parse, the panel's own checks, the dispatcher, the ack.
 */

const ANNOUNCE = JSON.stringify({
  device_id: 'a1',
  base_topic: 'hometiles',
  ha_prefix: 'ha/statestream',
  device_name: 'Panel',
  model: 'waveshare_touch_lcd_8',
  sensors: [],
  binary_sensors: [],
  scene_map: {},
  local_io: [],
});
const TOPIC = 'hometiles/cmnd/value';
const ACK = 'hometiles/stat/value';

/** The adapter's clock, in ms; the panel's deadline is epoch seconds, now + 10 (value_control.cpp:295, :309). */
const NOW = 1_790_000_000_000;
const SECONDS = NOW / 1000;

/** The state behind every entity named `test`; another name, another state. */
const ID = '0_userdata.0.test';
const value = (val: unknown, q = 0): SourceValue => ({ val, ack: true, q, ts: 1_758_600_000_000 });

interface Shape {
  /** ioBroker quality of the value. */
  q?: number;
  /** A manual datetime's declared kind (Ruling 92). */
  kind?: DatetimeKind;
  /** The entity is `<domain>.<name>`, its state `0_userdata.0.<name>`. */
  name?: string;
}

/** The entity the real synth makes of one writable state holding `raw` (no value for undefined). */
function editable(domain: 'number' | 'select' | 'datetime', channel: Partial<ChannelInput>, raw: unknown, shape: Shape = {}): VirtualEntity {
  const name = shape.name ?? 'test';
  const objectId = `0_userdata.0.${name}`;
  const device: DeviceInput = {
    objectId: `manual:${objectId}`,
    name,
    detectorType: 'manual',
    domain,
    channels: { set: { objectId, write: true, ...channel } },
    ...(shape.kind ? { kind: shape.kind } : {}),
  };
  const synth = domain === 'number' ? synthNumber : domain === 'select' ? synthSelect : synthDatetime;
  const entity = synth(device, `${domain}.${name}`, raw === undefined ? {} : { [objectId]: value(raw, shape.q) });
  if (!entity) throw new Error(`no ${domain} entity`);
  return entity;
}

const number = (channel: Partial<ChannelInput>, raw: unknown = 21, shape: Shape = {}): VirtualEntity =>
  editable('number', { type: 'number', ...channel }, raw, shape);
const SOLL = number({ min: 15, max: 28, step: 0.5, unit: '°C' });

let serial = 0;
/** A command exactly as the panel builds one for this entity (value_control.cpp:293-312). */
function command(entity: VirtualEntity, commanded: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  serial += 1;
  return {
    entity_id: entity.entityId,
    session: CONTROL_SESSION,
    revision: controlRevision(entity, CONTROL_SESSION),
    value: commanded,
    id: `1a2b3c4d-0002b1c8-${String(serial).padStart(8, '0')}`,
    deadline: SECONDS + 10,
    ...over,
  };
}

interface LogLine {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
}

function panel(entities: VirtualEntity[], write?: StateWriter) {
  let clock = NOW;
  const published: PublishRequest[] = [];
  const writes: Array<[string, unknown]> = [];
  const logs: LogLine[] = [];
  const at = (level: LogLine['level']) => (message: string): void => void logs.push({ level, message });
  const log: Logger = { info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') };
  const registry = new Map(entities.map((entity) => [entity.entityId, entity]));
  const dispatcher = new Dispatcher(
    { byId: (id) => registry.get(id), bySceneAlias: () => undefined },
    write ??
      (async (objectId, written) => {
        writes.push([objectId, written]);
      }),
    log,
  );
  const transport: PanelTransport = {
    publish: (request) => void published.push(request),
    subscribe: async () => undefined,
    unsubscribe: async () => undefined,
  };
  const session = new PanelSession(parseAnnouncement('a1', ANNOUNCE), transport, dispatcher, log, () => clock);
  // Pushed to this panel: its /control went out (the Bridge's "configured" entities).
  for (const entity of entities) session.pushEntityState(entity);
  published.length = 0;

  const send = (payload: Record<string, unknown> | string, retain = false): Promise<boolean> =>
    session.handleMessage(TOPIC, typeof payload === 'string' ? payload : JSON.stringify(payload), retain);
  /** The status of the answer to this one command, or undefined when it was dropped without one. */
  const status = async (payload: Record<string, unknown> | string, retain = false): Promise<string | undefined> => {
    const before = published.length;
    await send(payload, retain);
    const ack = published.slice(before).find((request) => request.topic === ACK);
    return ack ? (JSON.parse(ack.payload) as { status: string }).status : undefined;
  };
  const tick = (ms: number): void => {
    clock += ms;
  };
  return { session, published, writes, logs, registry, send, status, tick };
}

const loud = (logs: LogLine[]): LogLine[] => logs.filter((line) => line.level !== 'debug');

describe('runtime/panel-session value commands (Task 15)', () => {
  describe('the answer', () => {
    it('writes the value, answers "ok" on stat/value, not retained, then publishes the /control again (Bridge order)', async () => {
      const p = panel([SOLL]);
      const sent = command(SOLL, 22);
      expect(await p.send(sent)).to.equal(true);
      expect(p.writes).to.deep.equal([[ID, 22]]);
      expect(p.published.map((request) => [request.topic, request.retain])).to.deep.equal([
        [ACK, false],
        ['ha/statestream/number/test/control', true],
      ]);
      // Exactly the three keys, status the literal string (value_control.cpp:919-924).
      expect(JSON.parse(p.published[0]!.payload)).to.deep.equal({ entity_id: 'number.test', id: sent.id, status: 'ok' });
      expect(loud(p.logs)).to.deep.equal([]);
    });

    it('answers a refusal too, and publishes the /control after it', async () => {
      const p = panel([SOLL]);
      await p.send(command(SOLL, 21.3));
      expect(p.writes).to.deep.equal([]);
      expect(p.published.map((request) => request.topic)).to.deep.equal([ACK, 'ha/statestream/number/test/control']);
      expect(JSON.parse(p.published[0]!.payload).status).to.equal('invalid_step');
    });

    it('echoes the entity_id and id the panel sent, byte for byte', async () => {
      const p = panel([SOLL]);
      const id = 'Ä"\\\u0001 😀';
      await p.send(command(SOLL, 22, { id }));
      expect(JSON.parse(p.published[0]!.payload)).to.deep.equal({ entity_id: 'number.test', id, status: 'ok' });
    });
  });

  describe('dropped without an answer, as the Bridge drops them (__init__.py:1550-1559, :1568-1569)', () => {
    async function silent(p: ReturnType<typeof panel>, payload: Record<string, unknown> | string, retain = false): Promise<void> {
      expect(await p.send(payload, retain), 'the topic is still this panel').to.equal(true);
      expect(p.published, JSON.stringify(payload).slice(0, 80)).to.deep.equal([]);
      expect(p.writes).to.deep.equal([]);
    }

    it('a retained command: it would run again at every subscription', async () => {
      const p = panel([SOLL]);
      await silent(p, command(SOLL, 22), true);
    });

    it('a command over 2048 bytes; one of exactly 2048 is taken', async () => {
      const p = panel([SOLL]);
      const sized = (bytes: number, filler = 'x'): string => {
        const base = JSON.stringify({ ...command(SOLL, 22), pad: '' });
        const fill = filler.repeat(Math.ceil((bytes - Buffer.byteLength(base)) / Buffer.byteLength(filler)));
        return JSON.stringify({ ...command(SOLL, 22), pad: fill });
      };
      const over = sized(2049);
      expect(Buffer.byteLength(over)).to.equal(2049);
      await silent(p, over);
      // Bytes, not characters: 2 bytes each.
      const wide = sized(2050, 'é');
      expect(Buffer.byteLength(wide)).to.be.greaterThan(2048);
      expect(wide.length).to.be.lessThan(2048);
      await silent(p, wide);
      const exact = sized(2048);
      expect(Buffer.byteLength(exact)).to.equal(2048);
      expect(await p.status(exact)).to.equal('ok');
    });

    it('no JSON object', async () => {
      const p = panel([SOLL]);
      for (const payload of ['not json', 'null', '[]', '"number.test"', '42', '']) await silent(p, payload);
    });

    it('an entity_id that is no number, select or datetime of this panel', async () => {
      const sensor: VirtualEntity = { ...SOLL, entityId: 'sensor.t', domain: 'sensor', attributes: { friendly_name: 'T' } };
      const p = panel([SOLL, sensor]);
      // In the registry, but never pushed to this panel.
      const elsewhere = { ...SOLL, entityId: 'number.elsewhere' };
      p.registry.set(elsewhere.entityId, elsewhere);
      for (const over of [{ entity_id: undefined }, { entity_id: 7 }, { entity_id: 'number.unknown' }, { entity_id: 'sensor.t' }, { entity_id: 'number.elsewhere' }, { entity_id: 'NUMBER.TEST' }, { entity_id: ' number.test' }]) {
        await silent(p, command(SOLL, 22, over));
      }
    });

    it('an entity taken off this panel', async () => {
      const p = panel([SOLL]);
      p.session.clearEntityState('number.test');
      p.published.length = 0;
      await silent(p, command(SOLL, 22));
    });

    it('an id that is no string of 1 to 48 characters', async () => {
      const p = panel([SOLL]);
      for (const id of [undefined, null, 7, '', 'x'.repeat(49)]) await silent(p, command(SOLL, 22, { id }));
      expect(await p.status(command(SOLL, 22, { id: 'x'.repeat(48) }))).to.equal('ok');
      // Characters as the Bridge counts them, code points: 48 of them in 96 UTF-16 units.
      expect(await p.status(command(SOLL, 22, { id: '😀'.repeat(48) }))).to.equal('ok');
      p.published.length = 0;
      p.writes.length = 0;
      await silent(p, command(SOLL, 22, { id: '😀'.repeat(49) }));
    });

    it('an id seen before, while its deadline runs, even with another value', async () => {
      const p = panel([SOLL]);
      const first = command(SOLL, 22);
      expect(await p.status(first)).to.equal('ok');
      p.published.length = 0;
      await p.send(first);
      await p.send({ ...first, value: 23 });
      expect(p.published).to.deep.equal([]);
      expect(p.writes).to.deep.equal([[ID, 22]]);
    });

    it('a duplicate that arrives while the first is still being written: one write, one answer (review m5)', async () => {
      // The id is held before the write is awaited: held after it, the
      // duplicate would find it free and write again.
      const written: unknown[] = [];
      let release = (): void => undefined;
      const slow = new Promise<void>((resolve) => {
        release = resolve;
      });
      const p = panel([SOLL], async (_objectId, value) => {
        written.push(value);
        await slow;
      });
      const first = command(SOLL, 22);
      const both = Promise.all([p.send(first), p.send(first)]);
      release();
      await both;
      expect(written).to.deep.equal([22]);
      expect(p.published.filter((request) => request.topic === ACK).map((request) => JSON.parse(request.payload).status)).to.deep.equal(['ok']);
    });

    it('any command while 128 ids are held; one again once their deadlines pass', async () => {
      const p = panel([SOLL]);
      for (let i = 0; i < 128; i++) expect(await p.status(command(SOLL, 15 + (i % 26) / 2))).to.equal('ok');
      expect(p.writes).to.have.length(128);
      p.published.length = 0;
      await p.send(command(SOLL, 22));
      expect(p.published).to.deep.equal([]);
      expect(p.writes).to.have.length(128);
      // Every held id expires at its deadline, now + 10.
      p.tick(10_000);
      expect(await p.status(command(SOLL, 22, { deadline: SECONDS + 20 }))).to.equal('ok');
      expect(p.writes).to.have.length(129);
      expect(loud(p.logs)).to.deep.equal([]);
    });
  });

  describe('"expired": the deadline and the session (__init__.py:1562-1566)', () => {
    it('takes a deadline up to 15 s ahead, in epoch seconds, and nothing at or before now or beyond 15 s', async () => {
      const cases: Array<[unknown, string]> = [
        [SECONDS + 10, 'ok'],
        [SECONDS + 15, 'ok'],
        [SECONDS + 0.001, 'ok'],
        [SECONDS, 'expired'],
        [SECONDS + 15.001, 'expired'],
        [SECONDS - 1, 'expired'],
        [SECONDS - 10, 'expired'],
        // Milliseconds are no seconds: far beyond 15 s.
        [NOW + 10_000, 'expired'],
        [true, 'expired'],
        [false, 'expired'],
        [String(SECONDS + 10), 'expired'],
        [null, 'expired'],
        [undefined, 'expired'],
      ];
      for (const [deadline, expected] of cases) {
        const p = panel([SOLL]);
        expect(await p.status(command(SOLL, 22, { deadline })), String(deadline)).to.equal(expected);
        expect(p.writes.length, String(deadline)).to.equal(expected === 'ok' ? 1 : 0);
      }
    });

    it("takes this process's session only", async () => {
      // Exactly this one: even a session one character off is another.
      const near = `${CONTROL_SESSION[0] === 'a' ? 'b' : 'a'}${CONTROL_SESSION.slice(1)}`;
      for (const session of ['0123456789abcdef0123456789abcdef', near, '', undefined, 42]) {
        const p = panel([SOLL]);
        expect(await p.status(command(SOLL, 22, { session })), String(session)).to.equal('expired');
        expect(p.writes).to.deep.equal([]);
        expect(p.published.map((request) => request.topic)).to.deep.equal([ACK, 'ha/statestream/number/test/control']);
      }
    });

    it('does not hold the id of an expired command, whatever its deadline (__init__.py:1567-1570 run after)', async () => {
      const p = panel([SOLL]);
      const late = command(SOLL, 22, { deadline: SECONDS - 1 });
      expect(await p.status(late)).to.equal('expired');
      expect(await p.status({ ...late, deadline: SECONDS + 10 })).to.equal('ok');
      // Still ahead, so a held id would still be held.
      const foreign = command(SOLL, 23, { session: '0123456789abcdef0123456789abcdef' });
      expect(await p.status(foreign)).to.equal('expired');
      expect(await p.status({ ...foreign, session: CONTROL_SESSION })).to.equal('ok');
      const early = command(SOLL, 24, { deadline: SECONDS + 20 });
      expect(await p.status(early)).to.equal('expired');
      expect(await p.status({ ...early, deadline: SECONDS + 10 })).to.equal('ok');
      expect(p.writes).to.deep.equal([
        [ID, 22],
        [ID, 23],
        [ID, 24],
      ]);
    });
  });

  describe('"changed": a revision other than the one published (__init__.py:1571-1574)', () => {
    it('refuses a wrong or missing revision', async () => {
      for (const revision of ['ffffffffffffffff', '', undefined, 7]) {
        const p = panel([SOLL]);
        expect(await p.status(command(SOLL, 22, { revision })), String(revision)).to.equal('changed');
        expect(p.writes).to.deep.equal([]);
      }
    });

    it('refuses a revision from before the range changed, and takes one from before the value changed', async () => {
      const p = panel([SOLL]);
      const wider = number({ min: 15, max: 30, step: 0.5, unit: '°C' });
      const stale = command(SOLL, 22);
      p.registry.set(wider.entityId, wider);
      expect(await p.status(stale)).to.equal('changed');
      // The value alone never moves the revision (Task 14): a drag stays valid.
      p.registry.set(SOLL.entityId, number({ min: 15, max: 28, step: 0.5, unit: '°C' }, 25));
      expect(await p.status(command(SOLL, 22))).to.equal('ok');
    });
  });

  describe('"unavailable": not writable, or not available (editable_helpers.py:103-104)', () => {
    it('refuses a read-only state', async () => {
      const readOnly = number({ min: 15, max: 28, step: 0.5, write: false });
      const p = panel([readOnly]);
      expect(await p.status(command(readOnly, 22))).to.equal('unavailable');
      expect(p.writes).to.deep.equal([]);
    });

    it('refuses a value of bad quality, which keeps writable true but is not available (O3)', async () => {
      const bad = number({ min: 15, max: 28, step: 0.5 }, 21, { q: 0x44 });
      expect(bad.writable).to.deep.equal({ value: true });
      expect(bad.available).to.equal(false);
      const p = panel([bad]);
      expect(await p.status(command(bad, 22))).to.equal('unavailable');
      expect(p.writes).to.deep.equal([]);
    });

    it('refuses a number without a range and a select without options', async () => {
      const bare = number({});
      const listless = editable('select', { type: 'number' }, 1, { name: 'listless' });
      const p = panel([bare, listless]);
      expect(await p.status(command(bare, 1))).to.equal('unavailable');
      expect(await p.status(command(listless, '1'))).to.equal('unavailable');
      expect(p.writes).to.deep.equal([]);
    });
  });

  describe('number: the range and step the panel was given (editable_helpers.py:106-119)', () => {
    async function outcome(entity: VirtualEntity, commanded: unknown): Promise<[string | undefined, unknown]> {
      const p = panel([entity]);
      const status = await p.status(command(entity, commanded));
      return [status, p.writes[0]?.[1]];
    }

    it('writes a value on the grid, and refuses one off it or out of range', async () => {
      expect(await outcome(SOLL, 21.5)).to.deep.equal(['ok', 21.5]);
      expect(await outcome(SOLL, 15)).to.deep.equal(['ok', 15]);
      expect(await outcome(SOLL, 28)).to.deep.equal(['ok', 28]);
      expect(await outcome(SOLL, 21.3)).to.deep.equal(['invalid_step', undefined]);
      expect(await outcome(SOLL, 28.5)).to.deep.equal(['invalid_value', undefined]);
      expect(await outcome(SOLL, 14.5)).to.deep.equal(['invalid_value', undefined]);
    });

    it('refuses anything but a JSON number, as the panel sends one (value_control.cpp:306)', async () => {
      for (const commanded of ['21.5', true, null, undefined, [21.5], { value: 21.5 }]) {
        expect(await outcome(SOLL, commanded), JSON.stringify(commanded)).to.deep.equal(['invalid_value', undefined]);
      }
    });

    it('checks the published step and range, never channelMeta (T81-4)', async () => {
      // No common.step: Home Assistant's, 1, exists in the attributes alone (Ruling 81).
      const derived = number({ min: 15, max: 28 });
      expect(derived.attributes.step).to.equal(1);
      expect(await outcome(derived, 21.5)).to.deep.equal(['invalid_step', undefined]);
      expect(await outcome(derived, 22)).to.deep.equal(['ok', 22]);
      // A percent without bounds: 0..100 in the attributes alone (Ruling 82).
      const percent = number({ unit: '%' }, 40);
      expect(await outcome(percent, 100)).to.deep.equal(['ok', 100]);
      expect(await outcome(percent, 101)).to.deep.equal(['invalid_value', undefined]);
      // The attribute wins over a channel that says otherwise.
      const declared = { ...derived, channelMeta: { set: { ...derived.channelMeta!.set, step: 0.5, min: 0, max: 100 } } };
      expect(await outcome(declared, 21.5)).to.deep.equal(['invalid_step', undefined]);
      expect(await outcome(declared, 50)).to.deep.equal(['invalid_value', undefined]);
    });

    it('writes the step as the panel printed it, without binary noise (0.1 × 3 is 0.3)', async () => {
      const tenths = number({ min: 0, max: 1, step: 0.1 }, 0);
      expect(await outcome(tenths, 0.3)).to.deep.equal(['ok', 0.3]);
      expect(await outcome(tenths, 0.7)).to.deep.equal(['ok', 0.7]);
    });

    describe("the panel's own rounding of the numbers it was given, and no more (Task 14 O4)", () => {
      // ArduinoJson 7.4.3 on the panel re-reads min, max and step with 9
      // decimals as a double, or 6 as a float (value_control.cpp:28-34), and
      // prints the commanded value the same way (:306). Each value below is
      // what the library itself produces (tools/arduinojson-probe.cpp).
      it('at the upper bound: a max of 0.9999999996 is 1 on the panel', async () => {
        const top = number({ min: 0, max: 0.9999999996, step: 0.1 }, 0);
        // Written as the object's own bound, never past it.
        expect(await outcome(top, 1)).to.deep.equal(['ok', 0.9999999996]);
        expect(await outcome(top, 1.000001)).to.deep.equal(['invalid_value', undefined]);
      });

      it('at the lower bound: a min of 0.1234567894 is 0.123456789 on the panel', async () => {
        const bottom = number({ min: 0.1234567894, max: 1, step: 0.1 }, 0.5);
        expect(await outcome(bottom, 0.123456789)).to.deep.equal(['ok', 0.1234567894]);
        expect(await outcome(bottom, 0.123456788)).to.deep.equal(['invalid_value', undefined]);
      });

      it("on the step: a step of 0.08197082 is the float 0.081971 on the panel, and its grid is the panel's", async () => {
        const odd = number({ min: 0, max: 1, step: 0.08197082 }, 0);
        // Ten of the panel's steps: what it sends, and what it then waits to see.
        expect(await outcome(odd, 0.81971)).to.deep.equal(['ok', 0.81971]);
        // Ten of ours: no panel sends it.
        expect(await outcome(odd, 0.8197082)).to.deep.equal(['invalid_step', undefined]);
      });

      it('in the value it prints: 26500 steps of 1/3 go out as 8833.333324, 1.5e-6 steps off the grid', async () => {
        const thirds = number({ min: 0, max: 10000, step: 1 / 3 }, 0);
        // The panel's own draft, 26500 × 0.333333333, as it printed it (%.15g).
        expect(await outcome(thirds, 8833.333324)).to.deep.equal(['ok', 8833.3333245]);
        // One unit further in the last digit is no print of any step.
        expect(await outcome(thirds, 8833.333325)).to.deep.equal(['invalid_step', undefined]);
      });

      it('writes the grid point the panel printed, not the one it held, when a float holds it with more than 7 digits (review m1)', async () => {
        // The panel keeps such a double as a float and prints 6 decimals
        // (value_control.cpp:306): it sends another grid point, which is
        // written and answered "ok", as the Bridge does. The panel then
        // waits in vain for its own and shows an error after 30 s (:801).
        // Documented, not refused: no text tells the two apart (contract §5).
        expect(sentByPanel(20000002)).to.equal(20000000);
        expect(await outcome(number({ min: 0, max: 33554432, step: 1 }, 0), 20000000)).to.deep.equal(['ok', 20000000]);
        // Four steps away.
        expect(sentByPanel(10307966)).to.equal(10307970);
        expect(await outcome(number({ min: 0, max: 4294967295, step: 1 }, 0), 10307970)).to.deep.equal(['ok', 10307970]);
      });
    });

    it('refuses a value whose step count is no finite number, as the panel does (value_control.cpp:305, review m2)', async () => {
      // A step the synth publishes, with a range too wide for it to count.
      const fine = number({ min: 0, max: 1e10, step: 1e-300 }, 0);
      expect(fine.writable).to.deep.equal({ value: true });
      expect(await outcome(fine, 5e9)).to.deep.equal(['invalid_step', undefined]);
    });
  });

  describe('select: an exact option (editable_helpers.py:120-123)', () => {
    const modes = editable('select', { type: 'number', states: { 0: 'Aus', 1: 'Eco', 2: 'Komfort' } }, 1);
    const profile = editable('select', { type: 'string', states: { eco: 'Eco', comfort: 'Komfort' } }, 'eco', { name: 'profil' });

    it('writes the raw value behind the option, in the type of the state', async () => {
      const p = panel([modes, profile]);
      expect(await p.status(command(modes, 'Komfort'))).to.equal('ok');
      expect(await p.status(command(profile, 'Komfort'))).to.equal('ok');
      expect(p.writes).to.deep.equal([
        [ID, 2],
        ['0_userdata.0.profil', 'comfort'],
      ]);
    });

    it('refuses anything but an exact option: case, spaces, the raw value, no text', async () => {
      const p = panel([modes]);
      for (const commanded of ['komfort', 'KOMFORT', ' Komfort', 'Komfort ', '2', 2, null, undefined, ['Komfort']]) {
        expect(await p.status(command(modes, commanded)), JSON.stringify(commanded)).to.equal('invalid_option');
      }
      expect(p.writes).to.deep.equal([]);
    });

    it("refuses the current value when it is no option: the panel's placeholder is never sent (value_control.cpp:497-498)", async () => {
      const outside = editable('select', { type: 'number', states: { 0: 'Aus', 1: 'Eco' } }, 7);
      expect(outside.state).to.equal('7');
      const p = panel([outside]);
      expect(await p.status(command(outside, '7'))).to.equal('invalid_option');
      expect(p.writes).to.deep.equal([]);
    });

    it("writes the option's own key, not a current raw value that only reads like it (no currentLabel)", async () => {
      // A script left the label itself in the state: shown as "ECO", no option.
      const shouting = editable('select', { type: 'string', states: { eco: 'Eco', comfort: 'Komfort' } }, 'ECO');
      expect(shouting.state).to.equal('ECO');
      const p = panel([shouting]);
      expect(await p.status(command(shouting, 'Eco'))).to.equal('ok');
      expect(p.writes).to.deep.equal([[ID, 'eco']]);
    });
  });

  describe('date and time (editable_helpers.py:124-152, T84-4)', () => {
    // Pinned: an epoch is read and written in the host zone (T84-6).
    let zone: string | undefined;
    before(() => {
      zone = process.env.TZ;
      process.env.TZ = 'Europe/Berlin';
    });
    after(() => {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    });

    const epoch = (raw: unknown = 1_758_600_000_000): VirtualEntity => editable('datetime', { type: 'number', role: 'value.time' }, raw);
    const text = (raw: unknown, kind?: DatetimeKind): VirtualEntity => editable('datetime', { type: 'string' }, raw, kind ? { kind } : {});

    async function outcome(entity: VirtualEntity, commanded: unknown): Promise<[string | undefined, unknown]> {
      const p = panel([entity]);
      const status = await p.status(command(entity, commanded));
      return [status, p.writes[0]?.[1]];
    }

    it('writes an epoch number as the local time the panel sent, which reads back as the same text', async () => {
      const [status, written] = await outcome(epoch(), '2026-09-24 08:15:00');
      expect([status, written]).to.deep.equal(['ok', Date.UTC(2026, 8, 24, 6, 15, 0)]);
      // The same synth, reading the value back, shows what the panel waits for (value_control.cpp:330-334).
      expect(epoch(written).state).to.equal('2026-09-24 08:15:00');
      // No value yet: the first date may be set (Ruling 88).
      expect(await outcome(epoch(undefined), '2026-09-24 08:15:00')).to.deep.equal(['ok', Date.UTC(2026, 8, 24, 6, 15, 0)]);
    });

    it('refuses a local time the zone skips: 02:30 on the spring day does not exist', async () => {
      expect(await outcome(epoch(), '2026-03-29 02:30:00')).to.deep.equal(['invalid_value', undefined]);
      expect(await outcome(epoch(), '2026-03-29 01:59:59')).to.deep.equal(['ok', Date.UTC(2026, 2, 29, 0, 59, 59)]);
      expect(await outcome(epoch(), '2026-03-29 03:00:00')).to.deep.equal(['ok', Date.UTC(2026, 2, 29, 1, 0, 0)]);
    });

    it('takes the repeated autumn hour as its first instant, summer time; both read back as the same text', async () => {
      // Documented, not refused as the Bridge does (Ruling 99): the panel
      // shows both instants alike and cannot say which it meant either.
      const [status, written] = await outcome(epoch(), '2026-10-25 02:30:00');
      expect([status, written]).to.deep.equal(['ok', Date.UTC(2026, 9, 25, 0, 30, 0)]);
      expect(epoch(Date.UTC(2026, 9, 25, 1, 30, 0)).state).to.equal('2026-10-25 02:30:00');
      expect(epoch(written).state).to.equal('2026-10-25 02:30:00');
    });

    it("takes the Bridge's grammar: a 'T', and no seconds", async () => {
      expect(await outcome(epoch(), '2026-09-24T08:15')).to.deep.equal(['ok', Date.UTC(2026, 8, 24, 6, 15, 0)]);
    });

    it('writes a text back in its own shape: T or space, seconds or none', async () => {
      expect(await outcome(text('2026-09-23T07:30'), '2026-09-24 08:15:00')).to.deep.equal(['ok', '2026-09-24T08:15']);
      expect(await outcome(text('2026-09-23 07:30:00'), '2026-09-24 08:15:30')).to.deep.equal(['ok', '2026-09-24 08:15:30']);
      expect(await outcome(text('07:30:00'), '08:15:30')).to.deep.equal(['ok', '08:15:30']);
      expect(await outcome(text('07:30'), '08:15:00')).to.deep.equal(['ok', '08:15']);
      expect(await outcome(text('2026-09-23'), '2026-09-24')).to.deep.equal(['ok', '2026-09-24']);
      // A helper with no value yet, its kind declared (Ruling 92): the panel's own shape.
      expect(await outcome(text(null, 'time'), '07:45:00')).to.deep.equal(['ok', '07:45:00']);
    });

    it('refuses seconds a text without them cannot hold, which the panel would wait for in vain', async () => {
      expect(await outcome(text('07:30'), '08:15:30')).to.deep.equal(['invalid_value', undefined]);
      expect(await outcome(text('2026-09-23T07:30'), '2026-09-24 08:15:30')).to.deep.equal(['invalid_value', undefined]);
    });

    it('refuses another kind, a text outside the grammar, a date that does not exist, and no text', async () => {
      const cases: Array<[VirtualEntity, unknown]> = [
        [text('07:30:00'), '2026-09-24'],
        [text('07:30:00'), '2026-09-24 08:15:00'],
        [text('2026-09-23'), '08:15:00'],
        [epoch(), '2026-09-24'],
        [epoch(), '08:15:00'],
        [epoch(), '2026-9-24 8:15:00'],
        [epoch(), '2026-02-30 08:00:00'],
        [epoch(), '2026-09-24 24:00:00'],
        [epoch(), '2026-09-24 08:15:00Z'],
        [epoch(), ' 2026-09-24 08:15:00'],
        [text('07:30:00'), '7:30:00'],
        [text('07:30:00'), '07:60:00'],
        [epoch(), 1_790_230_500_000],
        [epoch(), null],
      ];
      for (const [entity, commanded] of cases) {
        expect(await outcome(entity, commanded), `${entity.state} <- ${JSON.stringify(commanded)}`).to.deep.equal(['invalid_value', undefined]);
      }
    });
  });

  describe('"failed": an unexpected failure (__init__.py:1581-1583)', () => {
    it('answers "failed" when the write is refused, with one English error line', async () => {
      const p = panel([SOLL], async () => {
        throw new Error('permission denied');
      });
      expect(await p.status(command(SOLL, 22))).to.equal('failed');
      expect(loud(p.logs).map((line) => line.level)).to.deep.equal(['error']);
      expect(loud(p.logs)[0]!.message).to.include('number.test').and.include('permission denied');
    });

    it('logs a run of failures once a minute, then with how many failed meanwhile', async () => {
      const p = panel([SOLL], async () => {
        throw new Error('permission denied');
      });
      for (let i = 0; i < 3; i++) expect(await p.status(command(SOLL, 22))).to.equal('failed');
      expect(loud(p.logs)).to.have.length(1);
      p.tick(59_999);
      expect(await p.status(command(SOLL, 22, { deadline: (NOW + 59_999) / 1000 + 10 }))).to.equal('failed');
      expect(loud(p.logs)).to.have.length(1);
      p.tick(1);
      expect(await p.status(command(SOLL, 22, { deadline: (NOW + 60_000) / 1000 + 10 }))).to.equal('failed');
      expect(loud(p.logs).map((line) => line.message)).to.deep.equal([
        '[Panel a1] Value command for number.test failed: permission denied',
        '[Panel a1] Value command for number.test failed: permission denied (and 3 more since the last such line)',
      ]);
    });

    it('answers "failed" when anything else throws, with one English error line', async () => {
      const p = panel([SOLL]);
      p.registry.get = (): VirtualEntity => {
        throw new Error('registry exploded');
      };
      expect(await p.status(command(SOLL, 22))).to.equal('failed');
      expect(loud(p.logs).map((line) => line.level)).to.deep.equal(['error']);
      expect(loud(p.logs)[0]!.message).to.include('number.test').and.include('registry exploded');
    });
  });

  describe('the clock warning (Rulings 102, 105)', () => {
    // The panel sends now + 10 in whole seconds (value_control.cpp:295, :309),
    // and a command is taken while 0 < deadline - now <= 15: the panel's clock
    // may be about 5 s ahead of this host's and 10 s behind (review m3). 2 s or
    // more beyond either edge, every command expires, which one warning an
    // hour per panel names. Transit and the panel's whole seconds only ever
    // make its clock look further behind; the margin keeps one borderline
    // expiry quiet.
    const warnings = (p: ReturnType<typeof panel>): string[] => p.logs.filter((line) => line.level === 'warn').map((line) => line.message);
    const debugs = (p: ReturnType<typeof panel>): string[] => p.logs.filter((line) => line.level === 'debug').map((line) => line.message);
    const off = (seconds: number, at = NOW): number => at / 1000 + 10 + seconds;
    const warning = (apart: string): string =>
      `[Panel a1] Value commands on hometiles/cmnd/value expire: their deadline puts the sending panel's clock about ${apart} ` +
      "this host's. A command is accepted only while it is at most about 5 s ahead or 10 s behind: check the time sync (NTP) " +
      'of the panel and of this host';

    it('warns once for a panel 8 s ahead, with the offset, the topic and the time sync, and not again within the hour', async () => {
      const p = panel([SOLL]);
      expect(await p.status(command(SOLL, 22, { deadline: off(8) }))).to.equal('expired');
      expect(warnings(p)).to.deep.equal([warning('8 s ahead of')]);
      p.tick(3_599_999);
      expect(await p.status(command(SOLL, 22, { deadline: off(8, NOW + 3_599_999) }))).to.equal('expired');
      expect(warnings(p)).to.have.length(1);
      p.tick(1);
      expect(await p.status(command(SOLL, 22, { deadline: off(8, NOW + 3_600_000) }))).to.equal('expired');
      expect(warnings(p)).to.deep.equal([warning('8 s ahead of'), warning('8 s ahead of')]);
      expect(p.writes).to.deep.equal([]);
    });

    it('warns for a panel 13 s behind', async () => {
      const p = panel([SOLL]);
      expect(await p.status(command(SOLL, 22, { deadline: off(-13) }))).to.equal('expired');
      expect(warnings(p)).to.deep.equal([warning('13 s behind')]);
    });

    it('does not warn for a panel 6 s ahead or 11 s behind: expired, but within 2 s of the window', async () => {
      for (const seconds of [6, -11]) {
        const p = panel([SOLL]);
        expect(await p.status(command(SOLL, 22, { deadline: off(seconds) })), String(seconds)).to.equal('expired');
        expect(warnings(p), String(seconds)).to.deep.equal([]);
      }
    });

    it('warns from 2 s beyond either edge: 7 s ahead and 12 s behind', async () => {
      for (const [seconds, apart] of [
        [7, '7 s ahead of'],
        [-12, '12 s behind'],
      ] as const) {
        const p = panel([SOLL]);
        expect(await p.status(command(SOLL, 22, { deadline: off(seconds) })), String(seconds)).to.equal('expired');
        expect(warnings(p), String(seconds)).to.deep.equal([warning(apart)]);
      }
    });

    it('does not warn in the window, not even where a session from before a restart expires the command', async () => {
      const p = panel([SOLL]);
      for (const seconds of [5, 0, -9]) {
        expect(await p.status(command(SOLL, 22, { deadline: off(seconds) })), String(seconds)).to.equal('ok');
        expect(await p.status(command(SOLL, 22, { deadline: off(seconds), session: '0123456789abcdef0123456789abcdef' })), String(seconds)).to.equal('expired');
      }
      expect(warnings(p)).to.deep.equal([]);
    });

    it('limits the warning per panel: another panel still warns within the hour', async () => {
      const first = panel([SOLL]);
      const second = panel([SOLL]);
      for (const p of [first, second, first]) expect(await p.status(command(SOLL, 22, { deadline: off(8) }))).to.equal('expired');
      expect(warnings(first)).to.deep.equal([warning('8 s ahead of')]);
      expect(warnings(second)).to.deep.equal([warning('8 s ahead of')]);
    });

    it('names the estimated offset in the debug line of every expired command', async () => {
      const p = panel([SOLL]);
      await p.send(command(SOLL, 22, { deadline: off(6) }));
      await p.send(command(SOLL, 22, { deadline: off(-11) }));
      await p.send(command(SOLL, 22, { session: '0123456789abcdef0123456789abcdef' }));
      await p.send(command(SOLL, 22, { deadline: 'soon' }));
      expect(debugs(p)).to.deep.equal([
        "[Panel a1] Value command for number.test refused: expired (by its deadline, the panel's clock is about 6 s ahead of this host's)",
        "[Panel a1] Value command for number.test refused: expired (by its deadline, the panel's clock is about 11 s behind this host's)",
        "[Panel a1] Value command for number.test refused: expired (by its deadline, the panel's clock is in step with this host's)",
        '[Panel a1] Value command for number.test refused: expired (its deadline is no number)',
      ]);
    });

    it('does not warn for a session from before a restart, nor a deadline that is no time in seconds (T7, T12)', async () => {
      const p = panel([SOLL]);
      for (const over of [
        // The first command after every restart of the adapter: the clocks are fine.
        { session: '0123456789abcdef0123456789abcdef' },
        { deadline: String(off(3600)) },
        { deadline: true },
        { deadline: null },
        // Milliseconds: a broken sender, not a clock 57,000 years off.
        { deadline: NOW + 10_000 },
      ]) {
        expect(await p.status(command(SOLL, 22, over)), JSON.stringify(over)).to.equal('expired');
      }
      // JSON.parse reads 1e400 as Infinity.
      const infinite = JSON.stringify(command(SOLL, 22)).replace(/"deadline":[0-9.]+/, '"deadline":1e400');
      expect(await p.status(infinite)).to.equal('expired');
      expect(loud(p.logs)).to.deep.equal([]);
    });

    it('does not warn for a command it drops first: retained, malformed, or no editable of this panel (T13)', async () => {
      const p = panel([SOLL]);
      await p.send(command(SOLL, 22, { deadline: off(3600) }), true);
      await p.send(JSON.stringify(command(SOLL, 22, { deadline: off(3600) })).slice(0, -1));
      await p.send(command(SOLL, 22, { deadline: off(3600), entity_id: 'number.unknown' }));
      expect(p.published).to.deep.equal([]);
      expect(loud(p.logs)).to.deep.equal([]);
    });

    it("keeps its hour apart from the failures' minute (T10)", async () => {
      const p = panel([SOLL], async () => {
        throw new Error('permission denied');
      });
      expect(await p.status(command(SOLL, 22))).to.equal('failed');
      expect(await p.status(command(SOLL, 22, { deadline: off(3600) }))).to.equal('expired');
      expect(await p.status(command(SOLL, 22))).to.equal('failed');
      expect(loud(p.logs).map((line) => line.level)).to.deep.equal(['error', 'warn']);
    });
  });

  it('logs an id or entity_id from the wire escaped and cut short (review m6)', async () => {
    const p = panel([SOLL]);
    // Long, yet within the 2048 bytes a command may have.
    const forged = `number.x\n[Panel a1] Value command for number.test failed: forged ${'y'.repeat(1500)}`;
    await p.send(command(SOLL, 22, { entity_id: forged }));
    const replayed = command(SOLL, 22, { id: 'id\nforged line' });
    await p.send(replayed);
    await p.send(replayed);
    const lines = p.logs.filter((line) => line.level === 'debug').map((line) => line.message);
    expect(lines).to.have.length(2);
    for (const line of lines) {
      expect(line).to.not.match(/[\r\n]/);
      expect(line.length).to.be.below(200);
    }
    expect(lines[0]).to.include('"number.x\\n[Panel a1]');
    expect(lines[1]).to.include('"id\\nforged line"');
  });

  it('logs no refusal and no drop above debug: the answer says it, and a flood must not fill the log', async () => {
    const readOnly = number({ min: 15, max: 28, step: 0.5, write: false }, 21, { name: 'fest' });
    const p = panel([SOLL, readOnly]);
    await p.send(command(SOLL, 22), true);
    await p.send('not json');
    await p.send(command(SOLL, 22, { entity_id: 'number.unknown' }));
    await p.send(command(SOLL, 22, { deadline: SECONDS }));
    await p.send(command(SOLL, 22, { revision: 'ffffffffffffffff' }));
    await p.send(command(readOnly, 22));
    await p.send(command(SOLL, 21.3));
    await p.send(command(SOLL, 30));
    expect(p.writes).to.deep.equal([]);
    expect(loud(p.logs)).to.deep.equal([]);
  });
});
