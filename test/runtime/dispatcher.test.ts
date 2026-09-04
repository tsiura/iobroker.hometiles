import { expect } from 'chai';
import { Dispatcher, type EntityLookup } from '../../src/runtime/dispatcher';
import type { VirtualEntity } from '../../src/registry/types';

function entity(over: Partial<VirtualEntity>): VirtualEntity {
  return {
    entityId: 'switch.k',
    domain: 'switch',
    source: { set: 'shelly.0.plug.on' },
    state: 'off',
    attributes: {},
    available: true,
    lastChanged: 0,
    ...over,
  };
}

const LIGHT = entity({
  entityId: 'light.d',
  domain: 'light',
  state: 'off',
  source: {
    set: 'hue.0.d.on',
    dimmer: 'hue.0.d.level',
    red: 'hue.0.d.r',
    green: 'hue.0.d.g',
    blue: 'hue.0.d.b',
    temperature: 'hue.0.d.ct',
  },
});

const SWITCH = entity({});
const SENSOR = entity({ entityId: 'sensor.t', domain: 'sensor', source: { actual: 'zigbee.0.t.value' } });
const SCENE = entity({ entityId: 'scene.nacht', domain: 'scene', source: { set: 'scene.0.nacht' } });

function lookup(entities: VirtualEntity[], aliases: Record<string, string> = {}): EntityLookup {
  const byId = new Map(entities.map((e) => [e.entityId, e]));
  return {
    byId: (id) => byId.get(id),
    bySceneAlias: (alias) => {
      const target = aliases[alias];
      return target ? byId.get(target) : undefined;
    },
  };
}

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

describe('runtime/dispatcher', () => {
  let writes: Array<[string, unknown]>;
  const write = async (objectId: string, value: unknown): Promise<void> => {
    writes.push([objectId, value]);
  };

  beforeEach(() => {
    writes = [];
  });

  it('turns a switch on through its SET channel', async () => {
    const d = new Dispatcher(lookup([SWITCH]), write, silentLog);
    const result = await d.dispatch({ kind: 'turn_on', entityId: 'switch.k' });
    expect(result).to.deep.equal({ ok: true, writes: 1 });
    expect(writes).to.deep.equal([['shelly.0.plug.on', true]]);
  });

  it('toggles from the entity current state', async () => {
    const d = new Dispatcher(lookup([entity({ state: 'on' })]), write, silentLog);
    await d.dispatch({ kind: 'toggle', entityId: 'switch.k' });
    expect(writes).to.deep.equal([['shelly.0.plug.on', false]]);
  });

  it('treats toggle from an unavailable state as turn on', async () => {
    const d = new Dispatcher(lookup([entity({ state: 'unavailable', available: false })]), write, silentLog);
    await d.dispatch({ kind: 'toggle', entityId: 'switch.k' });
    expect(writes).to.deep.equal([['shelly.0.plug.on', true]]);
  });

  it('writes brightness back as an ioBroker 0..100 percent', async () => {
    const d = new Dispatcher(lookup([LIGHT]), write, silentLog);
    await d.dispatch({ kind: 'set_light', entityId: 'light.d', state: 'on', brightnessPct: 42 });
    expect(writes).to.deep.include(['hue.0.d.level', 42]);
    expect(writes).to.deep.include(['hue.0.d.on', true]);
  });

  it('writes brightness to the BRIGHTNESS channel when the device has no DIMMER channel', async () => {
    // hue, ct, cie, rgb, rgbSingle and rgbwSingle carry their level on DIMMER
    // *or* BRIGHTNESS. Writing unconditionally to 'dimmer' left such a bulb's
    // slider publishing nothing at all.
    const brightnessOnly = entity({
      entityId: 'light.ct',
      domain: 'light',
      source: { set: 'zig.0.ct.on', brightness: 'zig.0.ct.level', temperature: 'zig.0.ct.ct' },
    });
    const d = new Dispatcher(lookup([brightnessOnly]), write, silentLog);
    const result = await d.dispatch({ kind: 'set_light', entityId: 'light.ct', brightnessPct: 77 });
    expect(result).to.deep.equal({ ok: true, writes: 1 });
    expect(writes).to.deep.equal([['zig.0.ct.level', 77]]);
  });

  it('splits rgb into the three component channels', async () => {
    const d = new Dispatcher(lookup([LIGHT]), write, silentLog);
    await d.dispatch({ kind: 'set_light', entityId: 'light.d', rgb: [255, 180, 90] });
    expect(writes).to.deep.equal([
      ['hue.0.d.r', 255],
      ['hue.0.d.g', 180],
      ['hue.0.d.b', 90],
    ]);
  });

  it('writes colour temperature to the temperature channel', async () => {
    const d = new Dispatcher(lookup([LIGHT]), write, silentLog);
    await d.dispatch({ kind: 'set_light', entityId: 'light.d', kelvin: 3000 });
    expect(writes).to.deep.equal([['hue.0.d.ct', 3000]]);
  });

  it('silently skips a channel the device does not have instead of failing the whole call', async () => {
    const noColour = entity({ entityId: 'light.p', domain: 'light', source: { set: 'x.0.on', dimmer: 'x.0.level' } });
    const d = new Dispatcher(lookup([noColour]), write, silentLog);
    const result = await d.dispatch({ kind: 'set_light', entityId: 'light.p', brightnessPct: 50, rgb: [1, 2, 3] });
    expect(result).to.deep.equal({ ok: true, writes: 1 });
    expect(writes).to.deep.equal([['x.0.level', 50]]);
  });

  it('refuses an entity that is not in the registry', async () => {
    const d = new Dispatcher(lookup([]), write, silentLog);
    expect(await d.dispatch({ kind: 'turn_on', entityId: 'switch.evil' })).to.deep.equal({
      ok: false,
      reason: 'unknown_entity',
      applied: 0,
    });
    expect(writes).to.have.length(0);
  });

  it('refuses a call that is not allowed for the entity domain', async () => {
    const d = new Dispatcher(lookup([SENSOR]), write, silentLog);
    expect(await d.dispatch({ kind: 'turn_on', entityId: 'sensor.t' })).to.deep.equal({
      ok: false,
      reason: 'call_not_allowed_for_domain',
      applied: 0,
    });
    expect(writes).to.have.length(0);
  });

  it('refuses a set_light aimed at a switch', async () => {
    const d = new Dispatcher(lookup([SWITCH]), write, silentLog);
    expect(await d.dispatch({ kind: 'set_light', entityId: 'switch.k', brightnessPct: 50 })).to.deep.equal({
      ok: false,
      reason: 'call_not_allowed_for_domain',
      applied: 0,
    });
  });

  it('activates a scene through its alias', async () => {
    const d = new Dispatcher(lookup([SCENE], { 'gute nacht': 'scene.nacht' }), write, silentLog);
    const result = await d.dispatch({ kind: 'activate_scene', alias: 'gute nacht' });
    expect(result).to.deep.equal({ ok: true, writes: 1 });
    expect(writes).to.deep.equal([['scene.0.nacht', true]]);
  });

  it('refuses an unknown scene alias', async () => {
    const d = new Dispatcher(lookup([SCENE], {}), write, silentLog);
    expect(await d.dispatch({ kind: 'activate_scene', alias: 'nope' })).to.deep.equal({
      ok: false,
      reason: 'unknown_scene',
      applied: 0,
    });
  });

  it('reports a write failure without throwing into the MQTT handler', async () => {
    const failing = async (): Promise<void> => {
      throw new Error('object not writable');
    };
    const d = new Dispatcher(lookup([SWITCH]), failing, silentLog);
    expect(await d.dispatch({ kind: 'turn_on', entityId: 'switch.k' })).to.deep.equal({
      ok: false,
      reason: 'write_failed',
      applied: 0,
    });
  });

  it('rejects a call that resolves to zero writes instead of reporting success', async () => {
    // Reproduces the buttonSensor-derived scene: its only channels are the
    // read-only PRESS/PRESS_LONG, so nothing ever lands in source.set and the
    // plan step produces no writes at all. That must not report ok:true.
    const noWritableChannel = entity({ entityId: 'scene.silent', domain: 'scene', source: {} });
    const d = new Dispatcher(lookup([noWritableChannel], { silent: 'scene.silent' }), write, silentLog);
    const result = await d.dispatch({ kind: 'activate_scene', alias: 'silent' });
    expect(result).to.deep.equal({ ok: false, reason: 'no_writable_channel', applied: 0 });
    expect(writes).to.have.length(0);
  });

  it('reports how many writes landed before a mid-sequence failure', async () => {
    // A light turned on but not dimmed is a different problem from one that
    // was never touched, and the panel's own display cannot distinguish them.
    let calls = 0;
    const failSecond = async (objectId: string, value: unknown): Promise<void> => {
      calls++;
      if (calls === 2) throw new Error('not writable');
      writes.push([objectId, value]);
    };
    const d = new Dispatcher(lookup([LIGHT]), failSecond, silentLog);
    const result = await d.dispatch({ kind: 'set_light', entityId: 'light.d', state: 'on', brightnessPct: 42 });
    expect(result).to.deep.equal({ ok: false, reason: 'write_failed', applied: 1 });
    expect(writes).to.deep.equal([['hue.0.d.on', true]]);
  });
});
