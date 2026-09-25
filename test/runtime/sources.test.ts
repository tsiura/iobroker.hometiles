import { expect } from 'chai';
import sinon from 'sinon';
import type { IoBrokerObject } from '../../src/registry/detector';
import { EntityRegistry } from '../../src/registry/entity-registry';
import type { DeviceInput } from '../../src/registry/types';
import { aliasProblem, connectSources, SOURCE_CALL_MS, type SourceAccess } from '../../src/runtime/sources';

/** A value as js-controller hands it. */
const state = (val: unknown): ioBroker.State => ({ val, ack: true, ts: 1_757_000_000_000, lc: 1_757_000_000_000, from: 'system.adapter.test.0', q: 0 }) as ioBroker.State;

/** A temperature sensor whose one state is `objectId`. */
const sensor = (root: string, name: string, objectId: string): DeviceInput => ({
  objectId: root,
  name,
  detectorType: 'temperature',
  domain: 'sensor',
  channels: { actual: { objectId, type: 'number', unit: '°C' } },
});

const TEMP = 'zigbee.0.t.temperature';
const HUNG = 'hm.0.h.temperature';
const alias = (id: unknown): IoBrokerObject => ({ type: 'state', common: { name: 'Alias', alias: { id } } });
const OBJECTS: Record<string, IoBrokerObject> = {
  [TEMP]: { type: 'state', common: { name: 'Temperature', type: 'number' } },
  [HUNG]: { type: 'state', common: { name: 'Temperature', type: 'number' } },
  'zigbee.0.t.set': { type: 'state', common: { name: 'Set', type: 'number' } },
  'hm.0.chan': { type: 'channel', common: { name: 'Channel' } },
  'alias.0.ok': alias(TEMP),
  'alias.0.split': alias({ read: TEMP, write: 'zigbee.0.t.set' }),
  'alias.0.none': { type: 'state', common: { name: 'No alias' } },
  'alias.0.empty': alias(''),
  'alias.0.noread': alias({ write: TEMP }),
  'alias.0.number': alias(42),
  'alias.0.dot': alias('zigbee.0.nirgends.'),
  'alias.0.gone': alias('zigbee.0.gone'),
  'alias.0.chan': alias('hm.0.chan'),
};

/** A registry of these devices, rebuilt: what connectSources is handed, and the entities it fills. */
function rebuild(...devices: DeviceInput[]): { registry: EntityRegistry; result: ReturnType<EntityRegistry['rebuild']> } {
  const registry = new EntityRegistry({ onEntityChanged: () => undefined, onMembershipChanged: () => undefined }, 0);
  return { registry, result: registry.rebuild(devices, {}) };
}

/** js-controller as seen from the adapter: each call recorded; `hang` ids never answered, as 5.0.19-7.2.3 do an alias they cannot subscribe. */
function controller(hang: { subscribe?: string[]; read?: string[] } = {}): SourceAccess & { calls: string[] } {
  const calls: string[] = [];
  const never = new Promise<never>(() => undefined);
  return {
    calls,
    subscribe: (id) => (calls.push(`subscribe ${id}`), hang.subscribe?.includes(id) ? never : Promise.resolve()),
    unsubscribe: (id) => (calls.push(`unsubscribe ${id}`), Promise.resolve()),
    read: (id) => (calls.push(`read ${id}`), hang.read?.includes(id) ? never : Promise.resolve(state(21.5))),
  };
}

describe('runtime/sources: the calls a rebuild makes for its entities\' states (Ruling 150)', () => {
  let clock: sinon.SinonFakeTimers;
  beforeEach(() => {
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => clock.restore());

  it('finishes when js-controller never answers a subscribe: the other entities get their values, one warning names the state, no timer is left', async () => {
    const { registry, result } = rebuild(sensor('zigbee.0.t', 'Temp', TEMP), sensor('hm.0.h', 'Hang', HUNG));
    const js = controller({ subscribe: [HUNG] });
    const warnings: string[] = [];
    const done = connectSources(result, OBJECTS, js, (id, value) => registry.applyStateChange(id, value), { warn: (text) => void warnings.push(text) });
    await clock.tickAsync(SOURCE_CALL_MS);
    await done;
    expect(registry.byId('sensor.temp')).to.include({ state: '21.5', available: true });
    // Carried on without it: never read, unavailable until it changes, and asked for again at the next rebuild.
    expect(registry.byId('sensor.hang')).to.include({ state: 'unavailable' });
    expect(js.calls).to.not.include(`read ${HUNG}`);
    expect(warnings).to.have.lengthOf(1);
    expect(warnings[0]).to.include(`subscribing ${HUNG}`).and.include(`${SOURCE_CALL_MS / 1000} s`).and.not.include(TEMP);
    expect(clock.countTimers(), 'timers left').to.equal(0);
  });

  it('drops a read answered after its deadline, and names every call left unanswered in the one warning', async () => {
    const { registry, result } = rebuild(sensor('zigbee.0.t', 'Temp', TEMP), sensor('hm.0.h', 'Hang', HUNG));
    let answer: (value: ioBroker.State) => void = () => undefined;
    const js = controller({ subscribe: [HUNG] });
    js.read = (id) => (js.calls.push(`read ${id}`), new Promise((resolve) => (answer = resolve)));
    const warnings: string[] = [];
    const done = connectSources(result, OBJECTS, js, (id, value) => registry.applyStateChange(id, value), { warn: (text) => void warnings.push(text) });
    await clock.tickAsync(2 * SOURCE_CALL_MS);
    await done;
    answer(state(30));
    await clock.tickAsync(0);
    // The value came too late: applied now, it could overwrite a newer change the subscription brought.
    expect(registry.byId('sensor.temp')).to.include({ state: 'unavailable' });
    expect(warnings).to.have.lengthOf(1);
    expect(warnings[0]).to.include(`subscribing ${HUNG}`).and.include(`reading ${TEMP}`);
    expect(clock.countTimers(), 'timers left').to.equal(0);
  });

  it('lets a late rejection go without an unhandled rejection', async () => {
    const { result } = rebuild(sensor('zigbee.0.t', 'Temp', TEMP));
    let fail: (error: Error) => void = () => undefined;
    const js = controller();
    js.read = () => new Promise((_resolve, reject) => (fail = reject));
    const unhandled: unknown[] = [];
    const listen = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', listen);
    try {
      const done = connectSources(result, OBJECTS, js, () => undefined, { warn: () => undefined });
      await clock.tickAsync(SOURCE_CALL_MS);
      await done;
      fail(new Error('the database went away'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).to.deep.equal([]);
    } finally {
      process.off('unhandledRejection', listen);
    }
  });

  it('still fails the rebuild on a call js-controller refuses in time, as before', async () => {
    const { result } = rebuild(sensor('zigbee.0.t', 'Temp', TEMP));
    const js = controller();
    js.subscribe = () => Promise.reject(new Error('DB closed'));
    let error: unknown;
    await connectSources(result, OBJECTS, js, () => undefined, { warn: () => undefined }).catch((caught: unknown) => (error = caught));
    expect(error).to.be.an('error').with.property('message', 'DB closed');
    expect(clock.countTimers(), 'timers left').to.equal(0);
  });

  it('reads every source when each call answers in time, logs nothing and leaves no timer', async () => {
    const { registry, result } = rebuild(sensor('zigbee.0.t', 'Temp', TEMP), sensor('hm.0.h', 'Hang', HUNG));
    const js = controller();
    const warnings: string[] = [];
    await connectSources(result, OBJECTS, js, (id, value) => registry.applyStateChange(id, value), { warn: (text) => void warnings.push(text) });
    expect(registry.byId('sensor.temp')).to.include({ state: '21.5' });
    expect(registry.byId('sensor.hang')).to.include({ state: '21.5' });
    expect(warnings).to.deep.equal([]);
    expect(clock.countTimers(), 'timers left').to.equal(0);
  });

  describe('the alias check before subscribing (Ruling 150 b)', () => {
    it('names why an alias target cannot be read: none, an invalid one, one missing or not a state', () => {
      expect(aliasProblem(TEMP, OBJECTS), 'no alias').to.equal(undefined);
      expect(aliasProblem('alias.0.ok', OBJECTS), 'a target id').to.equal(undefined);
      expect(aliasProblem('alias.0.split', OBJECTS), 'read and write targets: the read one is read').to.equal(undefined);
      expect(aliasProblem('alias.0.none', OBJECTS)).to.equal('no target');
      expect(aliasProblem('alias.0.empty', OBJECTS)).to.equal('no target');
      expect(aliasProblem('alias.0.noread', OBJECTS)).to.equal('no read target');
      expect(aliasProblem('alias.0.number', OBJECTS)).to.equal('target 42 is invalid');
      // What js-controller's validateId refuses: an id ending in ".".
      expect(aliasProblem('alias.0.dot', OBJECTS)).to.equal('target "zigbee.0.nirgends." is invalid');
      expect(aliasProblem('alias.0.gone', OBJECTS)).to.equal('target zigbee.0.gone is missing or not a state');
      expect(aliasProblem('alias.0.chan', OBJECTS)).to.equal('target hm.0.chan is missing or not a state');
      // An object not read with the others is none of this check's business: js-controller answers for it.
      expect(aliasProblem('alias.0.unknown', OBJECTS)).to.equal(undefined);
    });

    it('neither subscribes nor reads an alias whose target cannot be read, names each with its target in one warning, and reads the rest', async () => {
      const { registry, result } = rebuild(
        sensor('zigbee.0.t', 'Temp', TEMP),
        sensor('alias.0.a', 'Dot', 'alias.0.dot'),
        sensor('alias.0.b', 'Gone', 'alias.0.gone'),
        sensor('alias.0.c', 'Ok', 'alias.0.ok'),
      );
      // As js-controller 7.2.2 does: a subscribe it cannot make is never answered.
      const js = controller({ subscribe: ['alias.0.dot', 'alias.0.gone'] });
      const warnings: string[] = [];
      const done = connectSources(result, OBJECTS, js, (id, value) => registry.applyStateChange(id, value), { warn: (text) => void warnings.push(text) });
      await clock.tickAsync(0);
      await done;
      expect(js.calls.filter((call) => call.includes('alias.0.dot') || call.includes('alias.0.gone'))).to.deep.equal([]);
      expect(registry.byId('sensor.temp')).to.include({ state: '21.5' });
      expect(registry.byId('sensor.ok')).to.include({ state: '21.5' });
      expect(registry.byId('sensor.dot')).to.include({ state: 'unavailable' });
      expect(registry.byId('sensor.gone')).to.include({ state: 'unavailable' });
      expect(warnings).to.deep.equal([
        '[Registry] Aliases left out, their target cannot be read: alias.0.dot (target "zigbee.0.nirgends." is invalid), ' +
          'alias.0.gone (target zigbee.0.gone is missing or not a state). ' +
          'Their devices show unavailable until the alias is repaired and the adapter restarted',
      ]);
    });
  });
});
