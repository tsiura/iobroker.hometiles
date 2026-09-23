import { expect } from 'chai';
import { buildClimatePayload } from '../../src/protocol/climate';
import { parseClimateCommand, parseCoverCommand, type ServiceCall } from '../../src/protocol/commands';
import { buildCoverPayload } from '../../src/protocol/cover';
import { synthClimate } from '../../src/registry/synth/climate';
import { synthCover } from '../../src/registry/synth/cover';
import { synthLight } from '../../src/registry/synth/light';
import { synthScene } from '../../src/registry/synth/scene';
import { synthSwitch } from '../../src/registry/synth/switch';
import { Dispatcher, type EntityLookup } from '../../src/runtime/dispatcher';
import type { ChannelInput, DeviceInput, SourceValue, VirtualEntity } from '../../src/registry/types';

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

  // Ruling 38: the v0.1 switch, light and scene paths never read a channel's
  // write flag, so a read-only object (e.g. a KNX switch status, common.write
  // false) was written and reported ok:true. Entities come from the REAL
  // synths, so the flag has to travel DeviceInput -> baseEntity -> channelMeta.
  describe('read-only channels (Ruling 38)', () => {
    const at = (val: unknown): SourceValue => ({ val, ack: true, q: 0, ts: 1 });
    const onOff = (objectId: string, write?: boolean): ChannelInput => ({ objectId, type: 'boolean', write });
    const device = (objectId: string, domain: DeviceInput['domain'], channels: DeviceInput['channels']): DeviceInput => ({
      objectId,
      name: objectId,
      detectorType: domain,
      domain,
      channels,
    });

    it('a read-only switch, light and scene each refuse their "on" command with nothing written', async () => {
      const sw = synthSwitch(device('knx.0.sw', 'switch', { set: onOff('knx.0.sw.status', false) }), 'switch.ro', {
        'knx.0.sw.status': at(false),
      });
      const light = synthLight(device('knx.0.li', 'light', { set: onOff('knx.0.li.status', false) }), 'light.ro', {
        'knx.0.li.status': at(false),
      });
      // A scene has no "turn_on": activate_scene is its only command (ALLOWED_CALLS).
      const scene = synthScene(device('hm.0.key', 'scene', { set: onOff('hm.0.key.PRESS', false) }), 'scene.ro', {});
      const d = new Dispatcher(lookup([sw, light, scene], { ro: 'scene.ro' }), write, silentLog);
      const calls: ServiceCall[] = [
        { kind: 'turn_on', entityId: 'switch.ro' },
        { kind: 'turn_off', entityId: 'switch.ro' },
        { kind: 'toggle', entityId: 'switch.ro' },
        { kind: 'turn_on', entityId: 'light.ro' },
        { kind: 'set_light', entityId: 'light.ro', state: 'on' },
        { kind: 'activate_scene', alias: 'ro' },
      ];
      for (const call of calls) {
        expect(await d.dispatch(call), JSON.stringify(call)).to.deep.equal({
          ok: false,
          reason: 'no_writable_channel',
          applied: 0,
        });
      }
      expect(writes).to.deep.equal([]);
    });

    it('still writes a channel whose write flag is undefined (object and pattern both silent)', async () => {
      const sw = synthSwitch(device('x.0.sw', 'switch', { set: onOff('x.0.sw.on') }), 'switch.silent', {});
      const d = new Dispatcher(lookup([sw]), write, silentLog);
      expect(await d.dispatch({ kind: 'turn_on', entityId: 'switch.silent' })).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['x.0.sw.on', true]]);
    });

    it('skips only the read-only channel of a multi-channel light command and writes the rest', async () => {
      const light = synthLight(
        device('x.0.li', 'light', {
          set: onOff('x.0.li.on', true),
          dimmer: { objectId: 'x.0.li.level', type: 'number', write: false },
        }),
        'light.half',
        {},
      );
      const d = new Dispatcher(lookup([light]), write, silentLog);
      const result = await d.dispatch({ kind: 'set_light', entityId: 'light.half', state: 'on', brightnessPct: 40 });
      expect(result).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['x.0.li.on', true]]);
    });
  });

  describe('climate', () => {
    it('rejects a setpoint command when the thermostat has no writable SET', async () => {
      // The v0.1 rule, applied to a new domain: writing nothing is not success.
      const readOnlyThermostat = entity({
        entityId: 'climate.hall',
        domain: 'climate',
        source: { set: 'zig.0.hall.set' },
        writable: { setpoint: false },
      });
      const d = new Dispatcher(lookup([readOnlyThermostat]), write, silentLog);
      const result = await d.dispatch({ kind: 'set_temperature', entityId: 'climate.hall', value: 21 });
      expect(result).to.deep.equal({ ok: false, reason: 'no_writable_channel', applied: 0 });
      expect(writes).to.have.length(0);
    });

    it('writes a single setpoint through its SET channel when writable', async () => {
      const thermostat = entity({
        entityId: 'climate.hall',
        domain: 'climate',
        source: { set: 'zig.0.hall.set' },
        writable: { setpoint: true },
      });
      const d = new Dispatcher(lookup([thermostat]), write, silentLog);
      const result = await d.dispatch({ kind: 'set_temperature', entityId: 'climate.hall', value: 21.5 });
      expect(result).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['zig.0.hall.set', 21.5]]);
    });

    it('routes a single setpoint to whichever channel writable.setpoint points at, not hardcoded to SET', async () => {
      // Forward-looking: a synth change lets a lone SET_HEATING (no plain SET,
      // no SET_COOLING) become the single-setpoint writer. The dispatcher must
      // not assume the channel is literally named 'set'.
      const singleViaHeating = entity({
        entityId: 'climate.single',
        domain: 'climate',
        source: { set_heating: 'zig.0.single.heat' },
        writable: { setpoint: true },
      });
      const d = new Dispatcher(lookup([singleViaHeating]), write, silentLog);
      const result = await d.dispatch({ kind: 'set_temperature', entityId: 'climate.single', value: 19 });
      expect(result).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['zig.0.single.heat', 19]]);
    });

    it('rejects a single-value setpoint on a true dual-setpoint device, which never gets writable.setpoint at all', async () => {
      // Fix-round I1: the synth's hasHeating && hasCooling branch sets
      // target_temp_low/target_temp_high but never touches writable.setpoint
      // (registry/synth/climate.ts) -- so a single-value set_temperature
      // aimed at a true dual-setpoint device must find nothing to write, not
      // fall through to set_heating/set_cooling as if it were the lone-side
      // case. The synth decides WHETHER a setpoint role exists; the
      // dispatcher's candidate order only decides WHICH channel backs one
      // that does. Fix-round 3: the fixture OMITS the key, matching real
      // synth output exactly -- a previous draft set `setpoint: false`
      // explicitly, which reads identically today (`!== true`) but would
      // stay green even if that check ever tightened to `=== false`, while a
      // real device (key simply absent) would still write 21 to set_heating.
      const trueDual = entity({
        entityId: 'climate.dual',
        domain: 'climate',
        source: { set_heating: 'zig.0.dual.heat', set_cooling: 'zig.0.dual.cool' },
        writable: { target_temp_low: true, target_temp_high: true },
      });
      const d = new Dispatcher(lookup([trueDual]), write, silentLog);
      const result = await d.dispatch({ kind: 'set_temperature', entityId: 'climate.dual', value: 21 });
      expect(result).to.deep.equal({ ok: false, reason: 'no_writable_channel', applied: 0 });
      expect(writes).to.have.length(0);
    });

    it('writes both bounds of a dual-setpoint range when both channels are writable', async () => {
      const dual = entity({
        entityId: 'climate.dual',
        domain: 'climate',
        source: { set_heating: 'zig.0.dual.heat', set_cooling: 'zig.0.dual.cool' },
        writable: { target_temp_low: true, target_temp_high: true },
      });
      const d = new Dispatcher(lookup([dual]), write, silentLog);
      const result = await d.dispatch({ kind: 'set_temperature', entityId: 'climate.dual', low: 18, high: 24 });
      expect(result).to.deep.equal({ ok: true, writes: 2 });
      expect(writes).to.deep.equal([
        ['zig.0.dual.heat', 18],
        ['zig.0.dual.cool', 24],
      ]);
    });

    it('succeeds for the one bound it can write when only one side of a dual setpoint is writable', async () => {
      // Same exception v0.1 established for set_light: a command carrying
      // several values succeeds for what it could write, and only fails
      // outright when NOTHING could be written.
      const heatOnly = entity({
        entityId: 'climate.dual',
        domain: 'climate',
        source: { set_heating: 'zig.0.dual.heat', set_cooling: 'zig.0.dual.cool' },
        writable: { target_temp_low: true, target_temp_high: false },
      });
      const d = new Dispatcher(lookup([heatOnly]), write, silentLog);
      const result = await d.dispatch({ kind: 'set_temperature', entityId: 'climate.dual', low: 18, high: 24 });
      expect(result).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['zig.0.dual.heat', 18]]);
    });

    it('rejects a dual-setpoint command when neither bound is writable', async () => {
      const neither = entity({
        entityId: 'climate.dual',
        domain: 'climate',
        source: { set_heating: 'zig.0.dual.heat', set_cooling: 'zig.0.dual.cool' },
        writable: { target_temp_low: false, target_temp_high: false },
      });
      const d = new Dispatcher(lookup([neither]), write, silentLog);
      const result = await d.dispatch({ kind: 'set_temperature', entityId: 'climate.dual', low: 18, high: 24 });
      expect(result).to.deep.equal({ ok: false, reason: 'no_writable_channel', applied: 0 });
      expect(writes).to.have.length(0);
    });

    it('routes swing and horizontal swing to different, independent channels, each correctly typed', async () => {
      // brief's literal assertion is r.writes[0].channel, but DispatchResult's
      // ok:true shape carries only a count (writes: number), unchanged since
      // v0.1 -- every existing dispatcher test relies on that. This pins the
      // same fact (the two commands land on different channels) through the
      // write-log the rest of this file already uses. Fix-round 2: 'vertical'
      // is only reachable through a states map (mirrors
      // test/registry/synth/climate.test.ts's airConditionWithBothSwings
      // fixture), so the numeric swing channel now needs one to stay
      // encodable; swing_toggle stays untyped to prove the boolean fallback.
      const acWithBothSwings = entity({
        entityId: 'climate.ac',
        domain: 'climate',
        source: { swing: 'zig.0.ac.swing', swing_toggle: 'zig.0.ac.swing_h' },
        writable: { swing_mode: true, swing_horizontal_mode: true },
        channelMeta: { swing: { type: 'number', states: { '3': 'vertical' } } },
      });
      const d = new Dispatcher(lookup([acWithBothSwings]), write, silentLog);

      await d.dispatch({ kind: 'set_swing_mode', entityId: 'climate.ac', mode: 'vertical' });
      expect(writes).to.deep.equal([['zig.0.ac.swing', 3]]);

      writes = [];
      await d.dispatch({ kind: 'set_swing_horizontal_mode', entityId: 'climate.ac', on: true });
      expect(writes).to.deep.equal([['zig.0.ac.swing_h', true]]);
      expect(typeof writes[0]?.[1]).to.equal('boolean');
    });

    it('rejects horizontal swing when only the vertical swing channel is writable', async () => {
      const verticalOnly = entity({
        entityId: 'climate.ac',
        domain: 'climate',
        source: { swing: 'zig.0.ac.swing', swing_toggle: 'zig.0.ac.swing_h' },
        writable: { swing_mode: true, swing_horizontal_mode: false },
      });
      const d = new Dispatcher(lookup([verticalOnly]), write, silentLog);
      const result = await d.dispatch({ kind: 'set_swing_horizontal_mode', entityId: 'climate.ac', on: true });
      expect(result).to.deep.equal({ ok: false, reason: 'no_writable_channel', applied: 0 });
    });

    it('refuses a label for a channel with no number/boolean type and no states map, even marked writable (Ruling 33)', async () => {
      // Supersedes the old passthrough ("cool" written verbatim into an
      // untyped MODE). The reviewer's three shapes, each the panel's lone
      // fallback option echoing the current value back lowercased: an
      // untyped MODE at raw 1 ("1" -- the string), a string SPEED with no
      // states at "HIGH" ("high"), a string swing toggle at "true" ("on").
      // writable is forced true to prove the ENCODER refuses; synthClimate
      // no longer marks such a role writable at all (Ruling 36).
      const ac = entity({
        entityId: 'climate.ac',
        domain: 'climate',
        source: { mode: 'zig.0.ac.mode', speed: 'zig.0.ac.speed', swing_toggle: 'zig.0.ac.swing_h' },
        writable: { hvac_mode: true, fan_mode: true, swing_horizontal_mode: true },
        channelMeta: { speed: { type: 'string' }, swing_toggle: { type: 'string' } },
      });
      const d = new Dispatcher(lookup([ac]), write, silentLog);
      const calls: ServiceCall[] = [
        { kind: 'set_hvac_mode', entityId: 'climate.ac', mode: '1' },
        { kind: 'set_fan_mode', entityId: 'climate.ac', mode: 'high' },
        { kind: 'set_swing_horizontal_mode', entityId: 'climate.ac', on: true },
      ];
      for (const call of calls) {
        expect(await d.dispatch(call), call.kind).to.deep.equal({ ok: false, reason: 'cannot_encode_value', applied: 0 });
      }
      expect(writes).to.have.length(0);
    });

    it('encodes hvac_mode through a numeric states map instead of writing the label verbatim (fix-round 2 CRITICAL)', async () => {
      // The bug: a thermostat with numeric modes (Homematic and most
      // ioBroker thermostats) has MODE decoded through states (raw 1 ->
      // "heat", synth/climate.ts's readEnum) but the dispatcher wrote the
      // label "heat" straight back, into a channel that expects the number
      // 1 -- and reported ok:true for a write that landed on nothing.
      const ac = entity({
        entityId: 'climate.ac',
        domain: 'climate',
        source: { mode: 'zig.0.ac.mode' },
        writable: { hvac_mode: true },
        channelMeta: { mode: { type: 'number', states: { '1': 'heat', '3': 'cool' } } },
      });
      const d = new Dispatcher(lookup([ac]), write, silentLog);
      const result = await d.dispatch({ kind: 'set_hvac_mode', entityId: 'climate.ac', mode: 'heat' });
      expect(result).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['zig.0.ac.mode', 1]]);
      expect(typeof writes[0]?.[1]).to.equal('number');
    });

    it('rejects an hvac_mode label absent from the states map rather than writing nothing while reporting success', async () => {
      const ac = entity({
        entityId: 'climate.ac',
        domain: 'climate',
        source: { mode: 'zig.0.ac.mode' },
        writable: { hvac_mode: true },
        channelMeta: { mode: { type: 'number', states: { '1': 'heat', '3': 'cool' } } },
      });
      const d = new Dispatcher(lookup([ac]), write, silentLog);
      const result = await d.dispatch({ kind: 'set_hvac_mode', entityId: 'climate.ac', mode: 'auto' });
      // Fix-round 3, fold-in 2: a value that can't be encoded is a different
      // problem from no writable channel -- the channel IS writable here.
      expect(result).to.deep.equal({ ok: false, reason: 'cannot_encode_value', applied: 0 });
      expect(writes).to.have.length(0);
    });

    it('writes fan_mode to the named SPEED channel when present, coerced to a number', async () => {
      // Fix-round I2: SPEED is Number-typed too (@iobroker/type-detector's
      // FanPatterns.speed), just usually decoded through a states label map
      // -- '2' here stands in for a raw enum code (e.g. LOW). With no map it
      // can only be the current value (Task 8 round 1, M1a), so the fixture
      // now carries that current value; any other number is refused.
      const ac = entity({
        entityId: 'climate.ac',
        domain: 'climate',
        source: { speed: 'zig.0.ac.speed', speed_level: 'zig.0.ac.speed_pct' },
        writable: { fan_mode: true },
        attributes: { fan_mode: '2' },
        channelMeta: { speed: { current: 2 }, speed_level: { current: 7 } },
      });
      const d = new Dispatcher(lookup([ac]), write, silentLog);
      const result = await d.dispatch({ kind: 'set_fan_mode', entityId: 'climate.ac', mode: '2' });
      expect(result).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['zig.0.ac.speed', 2]]);
      writes = [];
      expect((await d.dispatch({ kind: 'set_fan_mode', entityId: 'climate.ac', mode: '3' })).ok).to.equal(false);
      expect(writes).to.deep.equal([]);
    });

    it('falls back to SPEED_LEVEL when the device has no named SPEED channel, coerced to a number', async () => {
      const ac = entity({
        entityId: 'climate.ac',
        domain: 'climate',
        source: { speed_level: 'zig.0.ac.speed_pct' },
        writable: { fan_mode: true },
        attributes: { fan_mode: '42' },
        channelMeta: { speed_level: { current: 42 } },
      });
      const d = new Dispatcher(lookup([ac]), write, silentLog);
      const result = await d.dispatch({ kind: 'set_fan_mode', entityId: 'climate.ac', mode: '42' });
      expect(result).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['zig.0.ac.speed_pct', 42]]);
      writes = [];
      expect((await d.dispatch({ kind: 'set_fan_mode', entityId: 'climate.ac', mode: '43' })).ok).to.equal(false);
      expect(writes).to.deep.equal([]);
    });

    it('reverses a labelled SPEED through its states map -- the case fix-round 1 made refuse, which now works', async () => {
      // Round 1 made ANY non-numeric fan_mode fail outright, since it had no
      // way to reverse a label back to a raw code. With channelMeta this now
      // succeeds instead of refusing a value the device genuinely supports.
      const ac = entity({
        entityId: 'climate.ac',
        domain: 'climate',
        source: { speed: 'zig.0.ac.speed' },
        writable: { fan_mode: true },
        channelMeta: { speed: { type: 'number', states: { '0': 'auto', '1': 'high', '2': 'low' } } },
      });
      const d = new Dispatcher(lookup([ac]), write, silentLog);
      const result = await d.dispatch({ kind: 'set_fan_mode', entityId: 'climate.ac', mode: 'high' });
      expect(result).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['zig.0.ac.speed', 1]]);
      expect(typeof writes[0]?.[1]).to.equal('number');
    });

    it('rejects a blank, non-numeric or "NaN" fan_mode rather than writing 0 or a string into a numeric state', async () => {
      // Number('') is 0 and finite -- the exact trap that has introduced this
      // bug class before. A label SPEED cannot reverse without its states
      // map (see the case comment in dispatcher.ts) falls in the same bucket
      // as genuine garbage: refused, not written as the wrong type.
      const ac = entity({
        entityId: 'climate.ac',
        domain: 'climate',
        source: { speed_level: 'zig.0.ac.speed_pct' },
        writable: { fan_mode: true },
      });
      const d = new Dispatcher(lookup([ac]), write, silentLog);
      for (const mode of ['', 'abc', 'NaN']) {
        writes = [];
        const result = await d.dispatch({ kind: 'set_fan_mode', entityId: 'climate.ac', mode });
        // Fix-round 3, fold-in 2: distinct from no_writable_channel -- the
        // channel is writable, the value just can't be encoded for it.
        expect(result, mode).to.deep.equal({ ok: false, reason: 'cannot_encode_value', applied: 0 });
        expect(writes, mode).to.have.length(0);
      }
    });

    it('rejects set_humidity when the device has no writable humidity channel', async () => {
      // No ioBroker type-detector pattern this adapter recognises exposes a
      // settable target humidity (synth/climate.ts: HUMIDITY is read-only
      // telemetry) -- this must always fail, never silently succeed.
      const ac = entity({
        entityId: 'climate.ac',
        domain: 'climate',
        source: { humidity: 'zig.0.ac.humidity' },
        writable: {},
      });
      const d = new Dispatcher(lookup([ac]), write, silentLog);
      const result = await d.dispatch({ kind: 'set_humidity', entityId: 'climate.ac', value: 55 });
      expect(result).to.deep.equal({ ok: false, reason: 'no_writable_channel', applied: 0 });
    });

    it('rejects set_preset_mode when the device has no writable preset channel', async () => {
      const ac = entity({ entityId: 'climate.ac', domain: 'climate', source: {}, writable: {} });
      const d = new Dispatcher(lookup([ac]), write, silentLog);
      const result = await d.dispatch({ kind: 'set_preset_mode', entityId: 'climate.ac', mode: 'eco' });
      expect(result).to.deep.equal({ ok: false, reason: 'no_writable_channel', applied: 0 });
    });

    it('refuses a light-only call aimed at a climate entity', async () => {
      const ac = entity({
        entityId: 'climate.ac',
        domain: 'climate',
        source: { mode: 'zig.0.ac.mode' },
        writable: { hvac_mode: true },
      });
      const d = new Dispatcher(lookup([ac]), write, silentLog);
      expect(await d.dispatch({ kind: 'set_light', entityId: 'climate.ac', brightnessPct: 50 })).to.deep.equal({
        ok: false,
        reason: 'call_not_allowed_for_domain',
        applied: 0,
      });
    });

    // Task 5b: every name a panel is SHOWN must reach the device as the
    // channel's exact native value. Nothing here is hand-built: the entity
    // comes from the real synthClimate, the lists from the real MQTT payload,
    // the call from the real command parser, the write from this dispatcher.
    describe('published *_modes round trip (Task 5b)', () => {
      const COMMAND_FOR = {
        hvac_modes: ['set_hvac_mode', 'hvac_mode'],
        fan_modes: ['set_fan_mode', 'fan_mode'],
        swing_modes: ['set_swing_mode', 'swing_mode'],
        swing_horizontal_modes: ['set_swing_horizontal_mode', 'swing_horizontal_mode'],
      } as const;

      type Landed = Record<string, Record<string, [string, unknown]>>;

      /** list key -> name the panel sent -> [objectId, value] that landed. */
      async function roundTrip(device: DeviceInput, values: Record<string, SourceValue>): Promise<Landed> {
        const synthesised = synthClimate(device, 'climate.ac', values);
        expect(synthesised).to.not.equal(null);
        const published = JSON.parse(buildClimatePayload(synthesised!)) as Record<string, unknown>;
        const d = new Dispatcher(lookup([synthesised!]), write, silentLog);
        const landed: Landed = {};
        for (const [listKey, [command, field]] of Object.entries(COMMAND_FOR)) {
          const names = published[listKey];
          if (names === undefined) continue;
          const perName: Record<string, [string, unknown]> = {};
          for (const name of names as string[]) {
            // The firmware lowercases the list on ingest (tile_renderer.cpp:
            // 2019-2027) and sends the chosen option back verbatim
            // (climate_popup.cpp:1781-1818).
            const sent = name.trim().toLowerCase();
            writes = [];
            const result = await d.dispatch(parseClimateCommand(JSON.stringify({ entity_id: 'climate.ac', command, [field]: sent })));
            expect(result, `${listKey} "${sent}"`).to.deep.equal({ ok: true, writes: 1 });
            perName[sent] = writes[0] as [string, unknown];
          }
          landed[listKey] = perName;
        }
        return landed;
      }

      function expectNativeValues(landed: Landed, expected: Landed): void {
        expect(landed).to.deep.equal(expected);
        for (const [listKey, perName] of Object.entries(expected)) {
          for (const [name, [, value]] of Object.entries(perName)) {
            expect(typeof landed[listKey]?.[name]?.[1], `${listKey} "${name}"`).to.equal(typeof value);
          }
        }
      }

      const state = (val: unknown): SourceValue => ({ val, ack: true, q: 0, ts: 1 });

      it('writes every published name back as the numeric or boolean code the device uses', async () => {
        const device: DeviceInput = {
          objectId: 'ac.0',
          name: 'AC',
          detectorType: 'airCondition',
          domain: 'climate',
          channels: {
            mode: { objectId: 'ac.0.mode', type: 'number', write: true, states: { '0': 'OFF', '1': 'HEAT', '2': 'COOL', '3': 'MANU' } },
            // type-detector's own FanPatterns.speed / FanPatterns.swing defaultStates
            speed: {
              objectId: 'ac.0.speed',
              type: 'number',
              write: true,
              states: { '0': 'AUTO', '1': 'HIGH', '2': 'LOW', '3': 'MEDIUM', '4': 'QUIET', '5': 'TURBO' },
            },
            swing: {
              objectId: 'ac.0.swing',
              type: 'number',
              write: true,
              states: { '0': 'AUTO', '1': 'HORIZONTAL', '2': 'STATIONARY', '3': 'VERTICAL' },
            },
            swing_toggle: { objectId: 'ac.0.swing_toggle', type: 'boolean', write: true },
          },
        };
        const values = { 'ac.0.mode': state(3), 'ac.0.speed': state(4), 'ac.0.swing': state(2), 'ac.0.swing_toggle': state(false) };
        expectNativeValues(await roundTrip(device, values), {
          hvac_modes: { off: ['ac.0.mode', 0], heat: ['ac.0.mode', 1], cool: ['ac.0.mode', 2] },
          fan_modes: { auto: ['ac.0.speed', 0], low: ['ac.0.speed', 2], medium: ['ac.0.speed', 3], high: ['ac.0.speed', 1] },
          swing_modes: { vertical: ['ac.0.swing', 3], horizontal: ['ac.0.swing', 1] },
          swing_horizontal_modes: { off: ['ac.0.swing_toggle', false], on: ['ac.0.swing_toggle', true] },
        });
      });

      it('writes a string MODE back in its own case, not the lowercased name the panel sent', async () => {
        const device: DeviceInput = {
          objectId: 'ac.0',
          name: 'AC',
          detectorType: 'airCondition',
          domain: 'climate',
          channels: {
            mode: { objectId: 'ac.0.mode', type: 'string', write: true, states: { AUTO: 'Auto', HEAT: 'Heat', COOL: 'Cool', ECO: 'Eco' } },
          },
        };
        expectNativeValues(await roundTrip(device, { 'ac.0.mode': state('HEAT') }), {
          hvac_modes: { heat: ['ac.0.mode', 'HEAT'], cool: ['ac.0.mode', 'COOL'], auto: ['ac.0.mode', 'AUTO'] },
        });
      });

      // Ruling 36: with an empty list the popup still offers ONE option, the
      // current value lowercased (climate_popup.cpp:458-460), and the HVAC
      // dropdown has no bit to hide it (:310-311). So what a payload lets the
      // panel show must land exactly, and what cannot land must not be shown.
      describe('the lone fallback option (Ruling 36)', () => {
        const FIELD = {
          set_hvac_mode: 'hvac_mode',
          set_fan_mode: 'fan_mode',
          set_swing_horizontal_mode: 'swing_horizontal_mode',
        } as const;
        const MODE = { objectId: 'ac.0.mode', type: 'number' as const, write: true, states: { '0': 'OFF' } };
        const airCondition = (channels: DeviceInput['channels']): DeviceInput => ({
          objectId: 'ac.0',
          name: 'AC',
          detectorType: 'airCondition',
          domain: 'climate',
          channels,
        });

        /** Real synth -> real payload -> the panel taps its one option -> real parser -> dispatcher. */
        async function tapFallback(device: DeviceInput, values: Record<string, SourceValue>, command: keyof typeof FIELD) {
          const synthesised = synthClimate(device, 'climate.ac', values)!;
          const published = JSON.parse(buildClimatePayload(synthesised)) as Record<string, unknown>;
          const field = FIELD[command];
          const option = String(published[field]).trim().toLowerCase();
          writes = [];
          const d = new Dispatcher(lookup([synthesised]), write, silentLog);
          const result = await d.dispatch(parseClimateCommand(JSON.stringify({ entity_id: 'climate.ac', command, [field]: option })));
          return { published, features: published.supported_features as number, result, landed: writes };
        }

        it('(a) an untyped MODE: the HVAC option nothing can hide is refused, never written as the string "1"', async () => {
          const tap = await tapFallback(airCondition({ mode: { objectId: 'ac.0.mode', write: true } }), { 'ac.0.mode': state(1) }, 'set_hvac_mode');
          expect(tap.published.hvac_mode).to.equal('1');
          expect(tap.published).to.not.have.property('hvac_modes');
          expect(tap.result.ok).to.equal(false);
          expect(tap.landed).to.deep.equal([]);
        });

        it('(b) a string SPEED with no states map: no FAN bit, and its "high" is refused', async () => {
          const tap = await tapFallback(
            airCondition({ mode: MODE, speed: { objectId: 'ac.0.speed', type: 'string', write: true } }),
            { 'ac.0.speed': state('HIGH') },
            'set_fan_mode',
          );
          expect(tap.published.fan_mode).to.equal('HIGH');
          expect(tap.published).to.not.have.property('fan_modes');
          expect(tap.features & 8, 'FAN_MODE').to.equal(0);
          expect(tap.result.ok).to.equal(false);
          expect(tap.landed).to.deep.equal([]);
        });

        it('(c) a writable string swing toggle: no SWING_HORIZONTAL bit, and its "on" is refused', async () => {
          const tap = await tapFallback(
            airCondition({ mode: MODE, swing_toggle: { objectId: 'ac.0.swing_toggle', type: 'string', write: true } }),
            { 'ac.0.swing_toggle': state('true') },
            'set_swing_horizontal_mode',
          );
          expect(tap.published.swing_horizontal_mode).to.equal('on');
          expect(tap.published).to.not.have.property('swing_horizontal_modes');
          expect(tap.features & 512, 'SWING_HORIZONTAL_MODE').to.equal(0);
          expect(tap.result.ok).to.equal(false);
          expect(tap.landed).to.deep.equal([]);
        });

        it('a SPEED_LEVEL value outside its states map: the FAN bit stays, and "50" lands as the number 50', async () => {
          const tap = await tapFallback(
            airCondition({
              mode: MODE,
              speed_level: { objectId: 'ac.0.speed_level', type: 'number', write: true, states: { '0': 'AUS', '100': 'MAX' } },
            }),
            { 'ac.0.speed_level': state(50) },
            'set_fan_mode',
          );
          expect(tap.published.fan_mode).to.equal('50');
          expect(tap.published).to.not.have.property('fan_modes');
          expect(tap.features & 8, 'FAN_MODE').to.equal(8);
          expect(tap.result).to.deep.equal({ ok: true, writes: 1 });
          expect(tap.landed).to.deep.equal([['ac.0.speed_level', 50]]);
          expect(typeof tap.landed[0]?.[1]).to.equal('number');
        });
      });
    });

    // Ruling 41: re-selecting the current value writes the current value.
    // The encoder used to know nothing about the role's current value, so
    // Ruling 36's out-of-map fallback took ANY finite number from any MQTT
    // client, and a current value outside the map whose text equals another
    // entry's label reversed to that other entry. Real synth -> real parser
    // -> dispatcher, as the panel would drive it.
    describe('re-selecting the current value (Ruling 41)', () => {
      const at = (val: unknown): SourceValue => ({ val, ack: true, q: 0, ts: 1 });
      const airCondition = (channels: DeviceInput['channels']): DeviceInput => ({
        objectId: 'ac.0',
        name: 'AC',
        detectorType: 'airCondition',
        domain: 'climate',
        channels,
      });
      // A SPEED mapped 0..3, currently at 1 ("LOW").
      const FAN = airCondition({
        mode: { objectId: 'ac.0.mode', type: 'number', write: true },
        speed: { objectId: 'ac.0.speed', type: 'number', write: true, states: { '0': 'AUTO', '1': 'LOW', '2': 'MEDIUM', '3': 'HIGH' } },
      });

      async function send(device: DeviceInput, values: Record<string, SourceValue>, payload: Record<string, unknown>) {
        const entity = synthClimate(device, 'climate.ac', values)!;
        writes = [];
        const d = new Dispatcher(lookup([entity]), write, silentLog);
        return d.dispatch(parseClimateCommand(JSON.stringify({ entity_id: 'climate.ac', ...payload })));
      }

      it('refuses 7 into a SPEED mapped 0..3: an arbitrary number is not the current value', async () => {
        const result = await send(FAN, { 'ac.0.speed': at(1) }, { command: 'set_fan_mode', fan_mode: '7' });
        expect(result).to.deep.equal({ ok: false, reason: 'cannot_encode_value', applied: 0 });
        expect(writes).to.deep.equal([]);
      });

      it('still reverses a mapped label on the same channel', async () => {
        const result = await send(FAN, { 'ac.0.speed': at(1) }, { command: 'set_fan_mode', fan_mode: 'high' });
        expect(result).to.deep.equal({ ok: true, writes: 1 });
        expect(writes).to.deep.equal([['ac.0.speed', 3]]);
      });

      it('re-selecting {B1:"Boost"} at "BOOST" writes "BOOST", not the other entry\'s key "B1"', async () => {
        const mode: ChannelInput = { objectId: 'ac.0.mode', type: 'string', write: true, states: { B1: 'Boost' } };
        const result = await send(airCondition({ mode }), { 'ac.0.mode': at('BOOST') }, {
          command: 'set_hvac_mode',
          hvac_mode: 'boost',
        });
        expect(result).to.deep.equal({ ok: true, writes: 1 });
        expect(writes).to.deep.equal([['ac.0.mode', 'BOOST']]);
      });

      it('re-selecting "5" on {3:"5"} writes whichever raw value the device holds, 5 or 3', async () => {
        const mode: ChannelInput = { objectId: 'ac.0.mode', type: 'number', write: true, states: { '3': '5' } };
        for (const raw of [5, 3]) {
          const result = await send(airCondition({ mode }), { 'ac.0.mode': at(raw) }, { command: 'set_hvac_mode', hvac_mode: '5' });
          expect(result, `at ${raw}`).to.deep.equal({ ok: true, writes: 1 });
          expect(writes, `at ${raw}`).to.deep.equal([['ac.0.mode', raw]]);
        }
      });

      it('a SPEED_LEVEL at a value its map labels still re-selects: the panel shows the number, not the label', async () => {
        // The dead-button fix Ruling 41 keeps: synthClimate decodes SPEED_LEVEL
        // with readNumber, so at 100 the lone option is "100", never "MAX".
        const level: ChannelInput = { objectId: 'ac.0.speed_level', type: 'number', write: true, states: { '0': 'AUS', '100': 'MAX' } };
        const device = airCondition({ mode: { objectId: 'ac.0.mode', type: 'number', write: true }, speed_level: level });
        const result = await send(device, { 'ac.0.speed_level': at(100) }, { command: 'set_fan_mode', fan_mode: '100' });
        expect(result).to.deep.equal({ ok: true, writes: 1 });
        expect(writes).to.deep.equal([['ac.0.speed_level', 100]]);
      });

      // Task 8 round 1, M1a: an unmapped channel publishes no list, so the
      // panel's only option is the current value; the reviewer's probes wrote
      // these with ok:true.
      it('refuses anything but the current value on an unmapped channel: fan_mode "100000", hvac_mode "42"', async () => {
        const level = airCondition({
          mode: { objectId: 'ac.0.mode', type: 'number', write: true },
          speed_level: { objectId: 'ac.0.speed_level', type: 'number', write: true, min: 0, max: 100 },
        });
        expect(await send(level, { 'ac.0.speed_level': at(50) }, { command: 'set_fan_mode', fan_mode: '100000' })).to.deep.equal({
          ok: false,
          reason: 'cannot_encode_value',
          applied: 0,
        });
        expect(await send(level, { 'ac.0.speed_level': at(50) }, { command: 'set_fan_mode', fan_mode: '50' })).to.deep.equal({
          ok: true,
          writes: 1,
        });
        expect(writes).to.deep.equal([['ac.0.speed_level', 50]]);

        const mode = airCondition({ mode: { objectId: 'ac.0.mode', type: 'number', write: true } });
        expect((await send(mode, { 'ac.0.mode': at(1) }, { command: 'set_hvac_mode', hvac_mode: '42' })).ok).to.equal(false);
        expect(writes).to.deep.equal([]);
        expect((await send(mode, { 'ac.0.mode': at(1) }, { command: 'set_hvac_mode', hvac_mode: '1' })).ok).to.equal(true);
        expect(writes).to.deep.equal([['ac.0.mode', 1]]);
      });
    });

    // Task 8 round 1, M1b: a setpoint outside the channel's declared range is
    // refused -- never clamped, which would write something other than what
    // was asked and still report success. The range is also what the payload
    // now tells the panel (min_temp/max_temp), so the two are one set.
    describe('setpoints outside the declared range (Ruling 49)', () => {
      const at = (val: unknown): SourceValue => ({ val, ack: true, q: 0, ts: 1 });
      const setpoint = (objectId: string, min: number, max: number): ChannelInput => ({
        objectId,
        type: 'number',
        write: true,
        min,
        max,
      });
      const thermostat = (channels: DeviceInput['channels']): VirtualEntity =>
        synthClimate({ objectId: 'rt.0', name: 'RT', detectorType: 'thermostat', domain: 'climate', channels }, 'climate.rt', {
          'rt.0.set': at(21),
          'rt.0.heat': at(20),
          'rt.0.cool': at(24),
        })!;

      it('lands every setpoint inside the published min_temp..max_temp and refuses one outside it', async () => {
        const rt = thermostat({ set: setpoint('rt.0.set', 4.5, 30.5) });
        const published = JSON.parse(buildClimatePayload(rt)) as Record<string, unknown>;
        expect(published).to.include({ min_temp: 4.5, max_temp: 30.5 });
        const d = new Dispatcher(lookup([rt]), write, silentLog);
        for (const [value, lands] of [[4.5, true], [30.5, true], [21, true], [4.4, false], [30.6, false], [35, false]] as const) {
          writes = [];
          const result = await d.dispatch({ kind: 'set_temperature', entityId: 'climate.rt', value });
          if (lands) {
            expect(result, `${value}`).to.deep.equal({ ok: true, writes: 1 });
            expect(writes, `${value}`).to.deep.equal([['rt.0.set', value]]);
          } else {
            expect(result, `${value}`).to.deep.equal({ ok: false, reason: 'value_out_of_range', applied: 0 });
            expect(writes, `${value}`).to.deep.equal([]);
          }
        }
      });

      it('refuses the whole range command when either bound is out of range, writing neither', async () => {
        const dual = thermostat({ set_heating: setpoint('rt.0.heat', 5, 25), set_cooling: setpoint('rt.0.cool', 18, 32) });
        const d = new Dispatcher(lookup([dual]), write, silentLog);
        expect(await d.dispatch({ kind: 'set_temperature', entityId: 'climate.rt', low: 26, high: 30 })).to.deep.equal({
          ok: false,
          reason: 'value_out_of_range',
          applied: 0,
        });
        expect(writes).to.deep.equal([]);
        expect(await d.dispatch({ kind: 'set_temperature', entityId: 'climate.rt', low: 20, high: 30 })).to.deep.equal({
          ok: true,
          writes: 2,
        });
        expect(writes).to.deep.equal([
          ['rt.0.heat', 20],
          ['rt.0.cool', 30],
        ]);
      });

      it('refuses a target humidity outside its channel\'s declared range', async () => {
        // No detected pattern makes target humidity writable (synth/climate.ts),
        // so the entity is built by hand to exercise the shared numeric path.
        const ac = entity({
          entityId: 'climate.ac',
          domain: 'climate',
          source: { humidity: 'zig.0.ac.humidity' },
          writable: { target_humidity: true },
          channelMeta: { humidity: { type: 'number', min: 30, max: 70 } },
        });
        const d = new Dispatcher(lookup([ac]), write, silentLog);
        expect((await d.dispatch({ kind: 'set_humidity', entityId: 'climate.ac', value: 80 })).ok).to.equal(false);
        expect(writes).to.deep.equal([]);
        expect(await d.dispatch({ kind: 'set_humidity', entityId: 'climate.ac', value: 55 })).to.deep.equal({ ok: true, writes: 1 });
        expect(writes).to.deep.equal([['zig.0.ac.humidity', 55]]);
      });

      // Round 1 took these literally and refused (almost) every setpoint.
      // Ruling 55: an equal or inverted pair means nothing for an absolute
      // value, so it is neither published nor checked.
      it('ignores equal or inverted setpoint bounds: nothing published, nothing refused (Ruling 55)', async () => {
        for (const [min, max] of [
          [20, 20],
          [30, 5],
        ] as const) {
          const rt = thermostat({ set: setpoint('rt.0.set', min, max) });
          expect(JSON.parse(buildClimatePayload(rt)), `${min}..${max}`).to.not.have.any.keys('min_temp', 'max_temp');
          const d = new Dispatcher(lookup([rt]), write, silentLog);
          writes = [];
          expect(await d.dispatch({ kind: 'set_temperature', entityId: 'climate.rt', value: 21 }), `${min}..${max}`).to.deep.equal({
            ok: true,
            writes: 1,
          });
        }
      });
    });
  });

  // Task 8. docs/contract-climate-cover.md: one topic, cmnd/cover, ten
  // allow-listed commands. Entities come from the REAL synthCover and every
  // command is the panel's own bytes through the REAL parser.
  describe('cover', () => {
    const at = (val: unknown): SourceValue => ({ val, ack: true, q: 0, ts: 1 });
    const button = (name: string): ChannelInput => ({ objectId: `cover.0.${name}`, type: 'boolean', write: true });
    const level = (name: string): ChannelInput => ({ objectId: `cover.0.${name}`, type: 'number', write: true });
    const coverOf = (channels: DeviceInput['channels'], values: Record<string, SourceValue> = {}, detectorType = 'blind') =>
      synthCover({ objectId: 'cover.0', name: 'Cover', detectorType, domain: 'cover', channels }, 'cover.test', values);

    // type-detector 6.0.1 typePatterns.js: blinds (SET level.blind number,
    // OPEN/CLOSE/STOP buttons), blindButtons (OPEN/CLOSE/STOP only), gate
    // (SET switch.gate BOOLEAN, STOP), and the four TILT_* states.
    const BLIND = { set: level('set'), open: button('open'), close: button('close'), stop: button('stop') };
    const BLIND_BUTTONS = { open: button('open'), close: button('close'), stop: button('stop') };
    const GATE = { set: button('set'), stop: button('stop') };
    const TILT = {
      tilt_set: level('tilt_set'),
      tilt_open: button('tilt_open'),
      tilt_close: button('tilt_close'),
      tilt_stop: button('tilt_stop'),
    };

    async function send(entity: VirtualEntity, command: string, extra: Record<string, unknown> = {}) {
      writes = [];
      const d = new Dispatcher(lookup([entity]), write, silentLog);
      return d.dispatch(parseCoverCommand(JSON.stringify({ entity_id: entity.entityId, command, ...extra })));
    }

    it('refuses set_cover_position on a device with no position channel', async () => {
      const result = await send(coverOf(BLIND_BUTTONS, {}, 'blindButtons'), 'set_cover_position', { position: 50 });
      expect(result).to.deep.equal({ ok: false, reason: 'no_writable_channel', applied: 0 });
      expect(writes).to.deep.equal([]);
    });

    it('treats tilt commands as independent of position commands', async () => {
      const tiltOnly = coverOf(TILT);
      expect(await send(tiltOnly, 'set_cover_tilt_position', { tilt_position: 90 })).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['cover.0.tilt_set', 90]]);
      for (const [command, extra] of [
        ['open_cover', {}],
        ['close_cover', {}],
        ['stop_cover', {}],
        ['set_cover_position', { position: 90 }],
      ] as const) {
        expect((await send(tiltOnly, command, extra)).ok, `${command} on a tilt-only cover`).to.equal(false);
      }

      const positionOnly = coverOf({ set: level('set') });
      expect(await send(positionOnly, 'set_cover_position', { position: 90 })).to.deep.equal({ ok: true, writes: 1 });
      for (const [command, extra] of [
        ['open_cover_tilt', {}],
        ['close_cover_tilt', {}],
        ['stop_cover_tilt', {}],
        ['set_cover_tilt_position', { tilt_position: 90 }],
      ] as const) {
        expect((await send(positionOnly, command, extra)).ok, `${command} on a position-only cover`).to.equal(false);
      }
    });

    it("writes a blind's position into its numeric SET as a number", async () => {
      expect(await send(coverOf(BLIND), 'set_cover_position', { position: 30 })).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['cover.0.set', 30]]);
      expect(typeof writes[0]?.[1]).to.equal('number');
    });

    it('opens, closes and stops a blind by pressing its OPEN, CLOSE and STOP buttons', async () => {
      const blind = coverOf(BLIND);
      for (const [command, objectId] of [
        ['open_cover', 'cover.0.open'],
        ['close_cover', 'cover.0.close'],
        ['stop_cover', 'cover.0.stop'],
      ] as const) {
        expect(await send(blind, command), command).to.deep.equal({ ok: true, writes: 1 });
        expect(writes, command).to.deep.equal([[objectId, true]]);
      }
    });

    it("opens and closes a gate by writing true and false to its boolean SET, and refuses a position", async () => {
      const gate = coverOf(GATE, {}, 'gate');
      expect(await send(gate, 'open_cover')).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['cover.0.set', true]]);
      expect(await send(gate, 'close_cover')).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['cover.0.set', false]]);
      expect(await send(gate, 'stop_cover')).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['cover.0.stop', true]]);
      expect(await send(gate, 'set_cover_position', { position: 50 })).to.deep.equal({
        ok: false,
        reason: 'no_writable_channel',
        applied: 0,
      });
      expect(writes).to.deep.equal([]);
    });

    it('treats an untyped gate SET as the boolean toggle its pattern guarantees', async () => {
      const gate = coverOf({ set: { objectId: 'cover.0.set', write: true } }, {}, 'gate');
      await send(gate, 'open_cover');
      expect(writes).to.deep.equal([['cover.0.set', true]]);
      await send(gate, 'close_cover');
      expect(writes).to.deep.equal([['cover.0.set', false]]);
      // An untyped blind SET stays a position, and never a toggle.
      const blind = coverOf({ set: { objectId: 'cover.0.set', write: true } });
      expect(await send(blind, 'set_cover_position', { position: 20 })).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['cover.0.set', 20]]);
      expect((await send(blind, 'open_cover')).ok).to.equal(false);
    });

    it('drives the four tilt channels', async () => {
      const tilt = coverOf(TILT);
      for (const [command, extra, landed] of [
        ['open_cover_tilt', {}, ['cover.0.tilt_open', true]],
        ['close_cover_tilt', {}, ['cover.0.tilt_close', true]],
        ['stop_cover_tilt', {}, ['cover.0.tilt_stop', true]],
        ['set_cover_tilt_position', { tilt_position: 45 }, ['cover.0.tilt_set', 45]],
      ] as const) {
        expect(await send(tilt, command, extra), command).to.deep.equal({ ok: true, writes: 1 });
        expect(writes, command).to.deep.equal([landed]);
      }
    });

    it('refuses every command on a cover whose channels are all read-only', async () => {
      const readOnly = Object.fromEntries(
        Object.entries({ ...BLIND, ...TILT }).map(([name, channel]) => [name, { ...channel, write: false }]),
      );
      const blind = coverOf(readOnly, { 'cover.0.set': at(0), 'cover.0.tilt_set': at(0) });
      for (const [command, extra] of [
        ['open_cover', {}],
        ['close_cover', {}],
        ['stop_cover', {}],
        ['set_cover_position', { position: 10 }],
        ['open_cover_tilt', {}],
        ['close_cover_tilt', {}],
        ['stop_cover_tilt', {}],
        ['set_cover_tilt_position', { tilt_position: 10 }],
        ['toggle', {}],
        ['toggle_cover_tilt', {}],
      ] as const) {
        expect((await send(blind, command, extra)).ok, command).to.equal(false);
        expect(writes, command).to.deep.equal([]);
      }
    });

    // Neither has a caller anywhere in the firmware (allow-list only,
    // mqtt_handlers.cpp:2270-2271); implemented because the firmware
    // validates them as part of the contract.
    describe('toggle and toggle_cover_tilt', () => {
      it('toggle opens a closed cover and closes an open one', async () => {
        await send(coverOf(BLIND, { 'cover.0.set': at(0) }), 'toggle');
        expect(writes).to.deep.equal([['cover.0.open', true]]);
        await send(coverOf(BLIND, { 'cover.0.set': at(70) }), 'toggle');
        expect(writes).to.deep.equal([['cover.0.close', true]]);
        await send(coverOf(GATE, { 'cover.0.set': at(false) }, 'gate'), 'toggle');
        expect(writes).to.deep.equal([['cover.0.set', true]]);
        await send(coverOf(GATE, { 'cover.0.set': at(true) }, 'gate'), 'toggle');
        expect(writes).to.deep.equal([['cover.0.set', false]]);
      });

      it('toggle refuses a cover whose state is unknown rather than guess a direction', async () => {
        // No reading at all, and tilt known but open/closed not derivable.
        for (const entity of [coverOf(BLIND), coverOf({ ...BLIND, ...TILT }, { 'cover.0.tilt_set': at(30) })]) {
          expect(await send(entity, 'toggle'), entity.state).to.deep.equal({ ok: false, reason: 'state_unknown', applied: 0 });
          expect(writes).to.deep.equal([]);
        }
      });

      it('toggle refuses when the direction it needs cannot be commanded', async () => {
        const noOpenButton = coverOf({ set: level('set'), close: button('close') }, { 'cover.0.set': at(0) });
        expect(await send(noOpenButton, 'toggle')).to.deep.equal({ ok: false, reason: 'no_writable_channel', applied: 0 });
      });

      it('toggle_cover_tilt opens a tilt at 0 and closes any other', async () => {
        await send(coverOf(TILT, { 'cover.0.tilt_set': at(0) }), 'toggle_cover_tilt');
        expect(writes).to.deep.equal([['cover.0.tilt_open', true]]);
        await send(coverOf(TILT, { 'cover.0.tilt_set': at(40) }), 'toggle_cover_tilt');
        expect(writes).to.deep.equal([['cover.0.tilt_close', true]]);
      });

      it('toggle_cover_tilt refuses an unknown tilt position', async () => {
        expect(await send(coverOf(TILT), 'toggle_cover_tilt')).to.deep.equal({ ok: false, reason: 'state_unknown', applied: 0 });
        expect(writes).to.deep.equal([]);
      });
    });

    it('Ruling 32: a string- or mixed-typed SET advertises neither a position nor a toggle, and every SET command is refused', async () => {
      for (const type of ['string', 'mixed'] as const) {
        for (const detectorType of ['blind', 'gate']) {
          const label = `${type} SET on a ${detectorType}`;
          const entity = coverOf({ set: { objectId: 'cover.0.set', type, write: true } }, { 'cover.0.set': at('40') }, detectorType);
          const features = (JSON.parse(buildCoverPayload(entity)) as { supported_features: number }).supported_features;
          expect(features & (1 | 2 | 4), `${label}: OPEN|CLOSE|SET_POSITION`).to.equal(0);
          for (const [command, extra] of [
            ['open_cover', {}],
            ['close_cover', {}],
            ['set_cover_position', { position: 50 }],
            ['toggle', {}],
          ] as const) {
            expect((await send(entity, command, extra)).ok, `${label}: ${command}`).to.equal(false);
            expect(writes, `${label}: ${command}`).to.deep.equal([]);
          }
        }
      }
    });

    // What supported_features advertises (protocol/cover.ts, from `writable`)
    // and what the dispatcher accepts must be ONE set: a set bit whose command
    // is refused is a dead button, a clear bit whose command lands is a
    // control the panel was told does not exist. Each single-channel device
    // carries exactly one bit, so the matrix is diagonal and a swap of any two
    // commands or bits fails it.
    it('accepts a command exactly when its supported_features bit is set', async () => {
      const BIT_COMMANDS: ReadonlyArray<[bit: number, command: string, extra: Record<string, unknown>]> = [
        [1, 'open_cover', {}],
        [2, 'close_cover', {}],
        [4, 'set_cover_position', { position: 30 }],
        [8, 'stop_cover', {}],
        [16, 'open_cover_tilt', {}],
        [32, 'close_cover_tilt', {}],
        [64, 'stop_cover_tilt', {}],
        [128, 'set_cover_tilt_position', { tilt_position: 60 }],
      ];
      const readOnly = (channels: DeviceInput['channels']): DeviceInput['channels'] =>
        Object.fromEntries(Object.entries(channels).map(([name, channel]) => [name, { ...channel, write: false }]));
      const devices: ReadonlyArray<[label: string, entity: VirtualEntity, mask: number]> = [
        ['OPEN button only', coverOf({ open: button('open') }), 1],
        ['CLOSE button only', coverOf({ close: button('close') }), 2],
        ['numeric SET only', coverOf({ set: level('set') }), 4],
        ['STOP button only', coverOf({ stop: button('stop') }), 8],
        ['TILT_OPEN only', coverOf({ tilt_open: button('tilt_open') }), 16],
        ['TILT_CLOSE only', coverOf({ tilt_close: button('tilt_close') }), 32],
        ['TILT_STOP only', coverOf({ tilt_stop: button('tilt_stop') }), 64],
        ['numeric TILT_SET only', coverOf({ tilt_set: level('tilt_set') }), 128],
        ['gate', coverOf(GATE, {}, 'gate'), 1 | 2 | 8],
        ['blindButtons', coverOf(BLIND_BUTTONS, {}, 'blindButtons'), 1 | 2 | 8],
        ['blind with tilt', coverOf({ ...BLIND, ...TILT }), 255],
        ['every channel read-only', coverOf(readOnly({ ...BLIND, ...TILT })), 0],
        ['string SET', coverOf({ set: { objectId: 'cover.0.set', type: 'string', write: true } }), 0],
        ['mixed SET', coverOf({ set: { objectId: 'cover.0.set', type: 'mixed', write: true } }, {}, 'gate'), 0],
      ];
      for (const [label, entity, mask] of devices) {
        const features = (JSON.parse(buildCoverPayload(entity)) as { supported_features: number }).supported_features;
        expect(features, `${label}: supported_features`).to.equal(mask);
        for (const [bit, command, extra] of BIT_COMMANDS) {
          const result = await send(entity, command, extra);
          expect(result.ok, `${label}: ${command} with bit ${bit} ${features & bit ? 'set' : 'clear'}`).to.equal(
            (features & bit) !== 0,
          );
          expect(writes.length, `${label}: ${command}`).to.equal(result.ok ? 1 : 0);
        }
      }
    });

    it('refuses a cover command aimed at a switch, and a switch command aimed at a cover', async () => {
      const d = new Dispatcher(lookup([SWITCH, coverOf(BLIND)]), write, silentLog);
      expect(await d.dispatch({ kind: 'open_cover', entityId: 'switch.k' })).to.deep.equal({
        ok: false,
        reason: 'call_not_allowed_for_domain',
        applied: 0,
      });
      expect(await d.dispatch({ kind: 'toggle', entityId: 'cover.test' })).to.deep.equal({
        ok: false,
        reason: 'call_not_allowed_for_domain',
        applied: 0,
      });
      expect(writes).to.deep.equal([]);
    });

    // Task 8 round 1, Ruling 49: the panel's percentage lands scaled into the
    // channel's declared range. The reviewer's probe wrote 50 -- about 20% --
    // into a 0..255 blind with ok:true, and published raw 200 as 200%.
    it('publishes and writes a 0..255 position and tilt through the declared range', async () => {
      const wide = coverOf(
        {
          set: { ...level('set'), min: 0, max: 255 },
          tilt_set: { ...level('tilt_set'), min: 0, max: 255 },
        },
        { 'cover.0.set': at(200), 'cover.0.tilt_set': at(51) },
      );
      const published = JSON.parse(buildCoverPayload(wide)) as Record<string, unknown>;
      // 78.43...% goes out as 78: the firmware would truncate it (round 2, N1).
      expect(published).to.include({ current_position: 78, current_tilt_position: 20 });
      expect(await send(wide, 'set_cover_position', { position: 50 })).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['cover.0.set', 128]]);
      expect(await send(wide, 'set_cover_tilt_position', { tilt_position: 100 })).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['cover.0.tilt_set', 255]]);
    });

    it('writes a position unchanged into a 0..100 channel', async () => {
      await send(coverOf({ set: { ...level('set'), min: 0, max: 100 } }), 'set_cover_position', { position: 37 });
      expect(writes).to.deep.equal([['cover.0.set', 37]]);
    });

    // Round 1 passed a one-sided range through unscaled, so this blind took
    // 80% as raw 80 -- over its maximum -- and refused it. Ruling 55: a
    // percentage's missing min is 0, so the range is 0..255 and 50% is 128.
    it('scales a max-only 255 position from a floor of 0 (Ruling 55)', async () => {
      const maxOnly = coverOf({ set: { ...level('set'), max: 255 } }, { 'cover.0.set': at(128) });
      expect((JSON.parse(buildCoverPayload(maxOnly)) as Record<string, unknown>).current_position).to.equal(50);
      expect(await send(maxOnly, 'set_cover_position', { position: 50 })).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['cover.0.set', 128]]);
    });

    it('refuses a percentage outside 0..100 at the dispatcher itself, not only in the parser', async () => {
      // The parser refuses one first (requirePercent); this pins the
      // dispatcher's own check, which would otherwise scale 150% of 0..255
      // to 383 and write it.
      const wide = coverOf({ set: { ...level('set'), min: 0, max: 255 } });
      const d = new Dispatcher(lookup([wide]), write, silentLog);
      for (const value of [150, -1]) {
        expect(await d.dispatch({ kind: 'set_cover_position', entityId: 'cover.test', value }), String(value)).to.deep.equal({
          ok: false,
          reason: 'value_out_of_range',
          applied: 0,
        });
      }
      expect(writes).to.deep.equal([]);
    });

    it('withholds a position whose bounds are equal or inverted, and takes no command for it (Ruling 55)', async () => {
      for (const bounds of [{ min: 40, max: 40 }, { min: 255, max: 0 }]) {
        const odd = coverOf({ set: { ...level('set'), ...bounds } }, { 'cover.0.set': at(40) });
        const features = (JSON.parse(buildCoverPayload(odd)) as { supported_features: number }).supported_features;
        expect(features & 4, `${JSON.stringify(bounds)}: SET_POSITION`).to.equal(0);
        expect(await send(odd, 'set_cover_position', { position: 50 }), JSON.stringify(bounds)).to.deep.equal({
          ok: false,
          reason: 'no_writable_channel',
          applied: 0,
        });
        expect(writes).to.deep.equal([]);
      }
    });

    // Round 2, N1: what the panel is shown for a position must be what it
    // sent. Through the real dispatcher and the real synth, for every whole
    // percent over a sweep of declared ranges -- including 0.1..0.3, whose
    // 100% overshot max by float error before N2.
    it('publishes back exactly the percent it wrote, for every percent over a sweep of ranges', async () => {
      const mins = [0, 1, 10, -50, 0.1, 3.7];
      const maxes = [0.3, 1, 10, 50, 99, 100, 101, 254, 255, 1000, 65535];
      let ranges = 0;
      for (const min of mins) {
        for (const max of maxes.filter((candidate) => candidate > min)) {
          ranges++;
          const set = { ...level('set'), min, max };
          const d = new Dispatcher(lookup([coverOf({ set })]), write, silentLog);
          for (let percent = 0; percent <= 100; percent++) {
            writes = [];
            await d.dispatch({ kind: 'set_cover_position', entityId: 'cover.test', value: percent });
            const landed = writes[0]?.[1];
            expect(landed, `${min}..${max} at ${percent}%`).to.be.a('number');
            const shown = coverOf({ set }, { 'cover.0.set': at(landed) }).attributes.current_position;
            expect(shown, `${min}..${max} at ${percent}% (raw ${String(landed)})`).to.equal(percent);
          }
        }
      }
      expect(ranges, 'ranges swept').to.be.greaterThan(50);
    });
  });

  describe('lights: declared ranges and advertised controls (Task 8 round 1)', () => {
    const at = (val: unknown): SourceValue => ({ val, ack: true, q: 0, ts: 1 });
    const power: ChannelInput = { objectId: 'l.0.on', type: 'boolean', write: true };
    const channel = (name: string, over: Partial<ChannelInput> = {}): ChannelInput => ({
      objectId: `l.0.${name}`,
      type: 'number',
      write: true,
      ...over,
    });
    const lightOf = (channels: DeviceInput['channels']): VirtualEntity =>
      synthLight({ objectId: 'l.0', name: 'L', detectorType: 'rgb', domain: 'light', channels: { set: power, ...channels } }, 'light.l', {});

    it('writes the panel brightness into a 0..254 or 0..255 dimmer as the scaled raw value, and into a 0..100 one unchanged', async () => {
      for (const [max, landed] of [[254, 127], [255, 128], [100, 50]] as const) {
        writes = [];
        const d = new Dispatcher(lookup([lightOf({ dimmer: channel('level', { min: 0, max }) })]), write, silentLog);
        const result = await d.dispatch({ kind: 'set_light', entityId: 'light.l', state: 'on', brightnessPct: 50 });
        expect(result, `0..${max}`).to.deep.equal({ ok: true, writes: 2 });
        expect(writes, `0..${max}`).to.deep.equal([
          ['l.0.on', true],
          ['l.0.level', landed],
        ]);
      }
    });

    // Round 1 refused this whole command: a one-sided 60 passed 80% through
    // unscaled. Ruling 55: the percentage's missing min is 0, so 80% of 0..60
    // is 48, and it lands with the power.
    it('scales a max-only brightness from a floor of 0 (Ruling 55)', async () => {
      const d = new Dispatcher(lookup([lightOf({ brightness: channel('level', { max: 60 }) })]), write, silentLog);
      expect(await d.dispatch({ kind: 'set_light', entityId: 'light.l', state: 'on', brightnessPct: 80 })).to.deep.equal({
        ok: true,
        writes: 2,
      });
      expect(writes).to.deep.equal([
        ['l.0.on', true],
        ['l.0.level', 48],
      ]);
    });

    // Ruling 54: the panel draws a brightness slider for any colour or CT
    // mode, and both the slider and the power button send the brightness
    // along with "on" (light_popup.cpp:1167-1180, :1021-1038). A light whose
    // level cannot take it still switches on and takes its colour; the
    // brightness is skipped out loud, never silently.
    describe('a brightness the light cannot take (Ruling 54)', () => {
      const cases: Array<[string, DeviceInput['channels'], string]> = [
        ['no level at all', {}, 'no level channel'],
        ['a read-only level', { dimmer: channel('level', { write: false }) }, 'read-only'],
        ['a level with inverted bounds', { dimmer: channel('level', { min: 255, max: 0 }) }, 'no usable range'],
      ];
      const colour = { red: channel('r'), green: channel('g'), blue: channel('b') };

      for (const [label, level, reason] of cases) {
        it(`${label}: writes "on" and the colour, skips the brightness with a warning`, async () => {
          const warnings: string[] = [];
          const log = { ...silentLog, warn: (message: string): void => void warnings.push(message) };
          const d = new Dispatcher(lookup([lightOf({ ...level, ...colour })]), write, log);
          // The power button's own payload when switching on (light_popup.cpp:1664-1684).
          const result = await d.dispatch({ kind: 'set_light', entityId: 'light.l', state: 'on', brightnessPct: 40, rgb: [1, 2, 3] });
          expect(result).to.deep.equal({ ok: true, writes: 4 });
          expect(writes).to.deep.equal([
            ['l.0.on', true],
            ['l.0.r', 1],
            ['l.0.g', 2],
            ['l.0.b', 3],
          ]);
          expect(warnings.filter((w) => w.includes('brightness') && w.includes(reason)), warnings.join(' | ')).to.have.length(1);
        });
      }

      it('a brightness alone, with nothing else it could write, is still refused', async () => {
        const d = new Dispatcher(lookup([lightOf({ ...colour })]), write, silentLog);
        expect(await d.dispatch({ kind: 'set_light', entityId: 'light.l', brightnessPct: 40 })).to.deep.equal({
          ok: false,
          reason: 'no_writable_channel',
          applied: 0,
        });
      });
    });

    it('refuses a colour temperature outside the light\'s declared range, the whole command with it', async () => {
      const d = new Dispatcher(lookup([lightOf({ dimmer: channel('level'), temperature: channel('ct', { min: 2200, max: 6500 }) })]), write, silentLog);
      for (const kelvin of [2100, 6600]) {
        writes = [];
        expect(await d.dispatch({ kind: 'set_light', entityId: 'light.l', state: 'on', kelvin }), `${kelvin}`).to.deep.equal({
          ok: false,
          reason: 'value_out_of_range',
          applied: 0,
        });
        expect(writes, `${kelvin}`).to.deep.equal([]);
      }
      writes = [];
      expect(await d.dispatch({ kind: 'set_light', entityId: 'light.l', state: 'on', kelvin: 2200 })).to.deep.equal({ ok: true, writes: 2 });
      expect(writes).to.deep.equal([
        ['l.0.on', true],
        ['l.0.ct', 2200],
      ]);
    });

    it('publishes back exactly the brightness percent it wrote, for every percent over a sweep of ranges (N1)', async () => {
      for (const [min, max] of [
        [0, 100],
        [0, 254],
        [0, 255],
        [1, 254],
        [0, 1],
        [0.1, 0.3],
        [0, 10],
        [0, 65535],
      ]) {
        const light = lightOf({ dimmer: channel('level', { min, max }) });
        const d = new Dispatcher(lookup([light]), write, silentLog);
        for (let percent = 0; percent <= 100; percent++) {
          writes = [];
          await d.dispatch({ kind: 'set_light', entityId: 'light.l', brightnessPct: percent });
          const landed = writes[0]?.[1];
          const shown = synthLight(
            { objectId: 'l.0', name: 'L', detectorType: 'dimmer', domain: 'light', channels: { dimmer: channel('level', { min, max }) } },
            'light.l',
            { 'l.0.level': at(landed) },
          ).attributes.brightness_pct;
          expect(shown, `${min}..${max} at ${percent}% (raw ${String(landed)})`).to.equal(percent);
        }
      }
    });

    // M3: every control the payload advertises must land. The panel draws a
    // brightness slider for "brightness" AND for every colour and colour-
    // temperature mode (HomeTiles tile_renderer.cpp:1446), and sends that
    // slider as "on" plus the brightness (light_popup.cpp:1168-1180). Since
    // Ruling 54 (round 2) a colour or CT light without a commandable level
    // keeps its colour controls, so that implied slider's brightness is
    // skipped with a warning while its "on" lands -- never dropped silently.
    it('advertises no control whose command is dropped silently', async () => {
      const fixtures: Array<[string, DeviceInput['channels']]> = [
        ['on/off only', {}],
        ['writable dimmer', { dimmer: channel('level') }],
        ['read-only dimmer', { dimmer: channel('level', { write: false }) }],
        ['read-only BRIGHTNESS', { brightness: channel('level', { write: false }) }],
        ['colour and CT', { dimmer: channel('level'), temperature: channel('ct'), red: channel('r'), green: channel('g'), blue: channel('b') }],
        ['colour and CT, read-only dimmer', { dimmer: channel('level', { write: false }), temperature: channel('ct'), red: channel('r'), green: channel('g'), blue: channel('b') }],
        ['CT with no level at all', { temperature: channel('ct') }],
        ['read-only CT', { dimmer: channel('level'), temperature: channel('ct', { write: false }) }],
        ['one read-only colour component', { dimmer: channel('level'), red: channel('r'), green: channel('g', { write: false }), blue: channel('b') }],
      ];
      for (const [label, channels] of fixtures) {
        const light = lightOf(channels);
        const modes = light.attributes.supported_color_modes as string[];
        const warnings: string[] = [];
        const d = new Dispatcher(lookup([light]), write, { ...silentLog, warn: (message: string): void => void warnings.push(message) });
        const landsOn = async (call: Omit<Extract<ServiceCall, { kind: 'set_light' }>, 'kind' | 'entityId'>, objectId: string) => {
          writes = [];
          warnings.length = 0;
          await d.dispatch({ kind: 'set_light', entityId: 'light.l', ...call });
          return writes.some(([id]) => id === objectId);
        };
        if (modes.some((mode) => ['brightness', 'color_temp', 'rgb'].includes(mode))) {
          const landed = await landsOn({ state: 'on', brightnessPct: 40 }, 'l.0.level');
          if (modes.includes('brightness')) expect(landed, `${label}: the advertised brightness slider`).to.equal(true);
          const warned = warnings.some((message) => message.includes('brightness'));
          expect(landed || warned, `${label}: the brightness lands or is skipped out loud`).to.equal(true);
          expect(writes, `${label}: the slider's "on" lands either way`).to.deep.include(['l.0.on', true]);
        }
        if (modes.includes('color_temp')) {
          expect(await landsOn({ state: 'on', kelvin: 3000 }, 'l.0.ct'), `${label}: the CT slider`).to.equal(true);
        }
        if (modes.includes('rgb')) {
          expect(await landsOn({ state: 'on', rgb: [1, 2, 3] }, 'l.0.g'), `${label}: the colour wheel`).to.equal(true);
        }
      }
    });
  });
});
