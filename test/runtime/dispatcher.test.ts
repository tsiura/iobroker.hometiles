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

    it('writes hvac_mode through the MODE channel', async () => {
      const ac = entity({
        entityId: 'climate.ac',
        domain: 'climate',
        source: { mode: 'zig.0.ac.mode' },
        writable: { hvac_mode: true },
      });
      const d = new Dispatcher(lookup([ac]), write, silentLog);
      const result = await d.dispatch({ kind: 'set_hvac_mode', entityId: 'climate.ac', mode: 'cool' });
      expect(result).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['zig.0.ac.mode', 'cool']]);
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
      // -- '2' here stands in for a raw enum code (e.g. LOW), the only form
      // this layer can round-trip without the states map (see the case
      // comment in dispatcher.ts).
      const ac = entity({
        entityId: 'climate.ac',
        domain: 'climate',
        source: { speed: 'zig.0.ac.speed', speed_level: 'zig.0.ac.speed_pct' },
        writable: { fan_mode: true },
      });
      const d = new Dispatcher(lookup([ac]), write, silentLog);
      const result = await d.dispatch({ kind: 'set_fan_mode', entityId: 'climate.ac', mode: '2' });
      expect(result).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['zig.0.ac.speed', 2]]);
    });

    it('falls back to SPEED_LEVEL when the device has no named SPEED channel, coerced to a number', async () => {
      const ac = entity({
        entityId: 'climate.ac',
        domain: 'climate',
        source: { speed_level: 'zig.0.ac.speed_pct' },
        writable: { fan_mode: true },
      });
      const d = new Dispatcher(lookup([ac]), write, silentLog);
      const result = await d.dispatch({ kind: 'set_fan_mode', entityId: 'climate.ac', mode: '42' });
      expect(result).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['zig.0.ac.speed_pct', 42]]);
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
  });
});
