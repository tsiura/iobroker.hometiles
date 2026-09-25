import { expect } from 'chai';
import { parseAnnouncement } from '../../src/protocol/announce';
import { Dispatcher } from '../../src/runtime/dispatcher';
import type { PublishRequest } from '../../src/runtime/mqtt-client';
import { PanelObjects, panelObjectDefs, parseBatteryPayload, type ObjectStore } from '../../src/runtime/panel-objects';
import { PanelSession, type PanelTransport } from '../../src/runtime/panel-session';

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

const ANNOUNCE = JSON.stringify({
  device_id: 'a1',
  base_topic: 'hometiles',
  ha_prefix: 'ha/statestream',
  device_name: 'Flur Panel',
  manufacturer: 'HomeTiles',
  model: 'waveshare_touch_lcd_8',
  local_io: [
    { id: 'relay_1', entity_id: 'switch.p_relay_1', name: 'Relay 1', type: 'relay' },
    { id: 'temp_1', entity_id: 'sensor.p_temp_1', name: 'Aussen', type: 'temperature' },
  ],
});

/** Same panel, but announcing the battery_soc capability (Task 25b). */
const WITH_BATTERY = JSON.stringify({ ...(JSON.parse(ANNOUNCE) as Record<string, unknown>), capabilities: { battery_soc: true } });

function harness(announce = ANNOUNCE) {
  const published: PublishRequest[] = [];
  const transport: PanelTransport = {
    publish: (request) => published.push(request),
    subscribe: async () => undefined,
    unsubscribe: async () => undefined,
  };
  const dispatcher = new Dispatcher({ byId: () => undefined, bySceneAlias: () => undefined }, async () => undefined, silentLog);
  const session = new PanelSession(parseAnnouncement('a1', announce), transport, dispatcher, silentLog);

  const objects: Array<[string, unknown]> = [];
  const states: Array<[string, unknown, boolean]> = [];
  const deleted: string[] = [];
  const store: ObjectStore = {
    setObject: async (id, obj) => {
      objects.push([id, obj]);
    },
    deleteObject: async (id) => {
      deleted.push(id);
    },
    setState: async (id, value, ack) => {
      states.push([id, value, ack]);
    },
  };
  return { session, published, objects, states, deleted, panelObjects: new PanelObjects(store, silentLog) };
}

describe('runtime/panel-objects', () => {
  it('creates the device, info, control and io objects for a panel', async () => {
    const { session, panelObjects, objects } = harness();
    await panelObjects.sync(session);
    const ids = objects.map(([id]) => id);
    expect(ids).to.include('panels.a1');
    expect(ids).to.include('panels.a1.info.connected');
    expect(ids).to.include('panels.a1.info.ip');
    expect(ids).to.include('panels.a1.control.display_brightness');
    expect(ids).to.include('panels.a1.control.screensaver_brightness');
    expect(ids).to.include('panels.a1.control.display_sleep');
    expect(ids).to.include('panels.a1.control.pair');
    expect(ids).to.include('panels.a1.control.refresh');
    expect(ids).to.include('panels.a1.io.relay_1');
    expect(ids).to.include('panels.a1.io.temp_1');
  });

  it('names the device from the announcement', async () => {
    const { session, panelObjects, objects } = harness();
    await panelObjects.sync(session);
    const device = objects.find(([id]) => id === 'panels.a1');
    expect((device![1] as { common: { name: string } }).common.name).to.equal('Flur Panel');
  });

  it('types a relay channel as a writable boolean and a temperature channel as a read-only number', async () => {
    const { session, panelObjects, objects } = harness();
    await panelObjects.sync(session);
    const relay = objects.find(([id]) => id === 'panels.a1.io.relay_1')![1] as { common: Record<string, unknown> };
    const temp = objects.find(([id]) => id === 'panels.a1.io.temp_1')![1] as { common: Record<string, unknown> };
    expect(relay.common.type).to.equal('boolean');
    expect(relay.common.write).to.equal(true);
    expect(temp.common.type).to.equal('number');
    expect(temp.common.write).to.equal(false);
    expect(temp.common.unit).to.equal('°C');
  });

  it('types each control the way the firmware actually parses it', () => {
    const defs = panelObjectDefs(harness().session);
    const common = (id: string): Record<string, unknown> =>
      (defs.find((d) => d.id === id)!.obj as { common: Record<string, unknown> }).common;
    expect(common('panels.a1.control.display_brightness').type).to.equal('number');
    expect(common('panels.a1.control.display_rotate').type).to.equal('boolean');
    expect(common('panels.a1.control.display_sleep').type).to.equal('boolean');
    expect(common('panels.a1.control.sleep_mains').type).to.equal('string');
  });

  it('bounds the brightness controls to the visible 1..100 range', () => {
    const defs = panelObjectDefs(harness().session);
    const brightness = defs.find((d) => d.id === 'panels.a1.control.display_brightness')!;
    const common = (brightness.obj as { common: Record<string, unknown> }).common;
    expect(common.min).to.equal(1);
    expect(common.max).to.equal(100);
    expect(common.unit).to.equal('%');
  });

  it('writes a panel stat back with ack true', async () => {
    const { session, panelObjects, states } = harness();
    await panelObjects.applyPanelStat(session, 'display_brightness', '65');
    expect(states).to.deep.equal([['panels.a1.control.display_brightness', 65, true]]);
  });

  it('rescales a legacy 121..255 brightness stat onto 1..100', async () => {
    const { session, panelObjects, states } = harness();
    await panelObjects.applyPanelStat(session, 'display_brightness', '255');
    expect(states[0]![1]).to.equal(100);
    states.length = 0;
    await panelObjects.applyPanelStat(session, 'display_brightness', '121');
    expect(states[0]![1]).to.equal(1);
  });

  it('ignores a blank numeric stat rather than writing zero', async () => {
    // Number('') is 0 and 0 is finite, so a bare isFinite guard would write a
    // confident 0 % brightness for a panel that reported nothing.
    const { session, panelObjects, states } = harness();
    await panelObjects.applyPanelStat(session, 'display_brightness', '   ');
    expect(states).to.have.length(0);
  });

  it('writes null, not zero, for a blank temperature io stat', async () => {
    // 0 is a plausible temperature. A DS18B20 that reported nothing must not
    // render as 0 degrees on a wall panel.
    const { session, panelObjects, states } = harness();
    await panelObjects.applyIoStat(session, 'temp_1', '  ');
    expect(states[0]).to.deep.equal(['panels.a1.io.temp_1', null, true]);
  });

  it('ignores a blank control write rather than clamping it to the minimum', () => {
    const { session, panelObjects, published } = harness();
    panelObjects.handleControlWrite(session, 'control.display_brightness', '   ');
    expect(published).to.have.length(0);
  });

  it('ignores an unparseable numeric stat rather than writing zero', async () => {
    const { session, panelObjects, states } = harness();
    await panelObjects.applyPanelStat(session, 'display_brightness', 'nonsense');
    expect(states).to.have.length(0);
  });

  it('treats display_sleep and display_rotate as booleans, not durations', async () => {
    // The firmware parses both with parseBoolPayload and echoes ON / OFF.
    // display_sleep means "asleep right now", not a timeout.
    const { session, panelObjects, states } = harness();
    await panelObjects.applyPanelStat(session, 'display_sleep', 'ON');
    await panelObjects.applyPanelStat(session, 'display_rotate', 'OFF');
    expect(states).to.deep.equal([
      ['panels.a1.control.display_sleep', true, true],
      ['panels.a1.control.display_rotate', false, true],
    ]);
  });

  it('ignores a stat that is not a value the firmware would ever send', async () => {
    const { session, panelObjects, states } = harness();
    await panelObjects.applyPanelStat(session, 'display_rotate', '2');
    expect(states).to.have.length(0);
  });

  it('passes a sleep timeout label through as a string', async () => {
    const { session, panelObjects, states } = harness();
    await panelObjects.applyPanelStat(session, 'sleep_mains', '15 min');
    expect(states).to.deep.equal([['panels.a1.control.sleep_mains', '15 min', true]]);
  });

  it('publishes ON or OFF for a boolean control write', () => {
    const { session, panelObjects, published } = harness();
    panelObjects.handleControlWrite(session, 'control.display_rotate', true);
    expect(published[0]).to.deep.equal({
      topic: 'hometiles/cmnd/display_rotate',
      payload: 'ON',
      retain: false,
    });
  });

  it('passes a duration control write through for the firmware to validate', () => {
    // parseSleepPayload accepts labels, free-form durations and disable words;
    // enumerating them here would only reject valid input.
    const { session, panelObjects, published } = harness();
    panelObjects.handleControlWrite(session, 'control.sleep_battery', '30s');
    expect(published[0]!.payload).to.equal('30s');
    panelObjects.handleControlWrite(session, 'control.sleep_mains', 'never');
    expect(published[1]!.payload).to.equal('never');
  });

  it('maps a relay io stat onto a boolean and a temperature io stat onto a number', async () => {
    const { session, panelObjects, states } = harness();
    await panelObjects.applyIoStat(session, 'relay_1', 'ON');
    expect(states[0]).to.deep.equal(['panels.a1.io.relay_1', true, true]);
    states.length = 0;
    await panelObjects.applyIoStat(session, 'temp_1', '21.5');
    expect(states[0]).to.deep.equal(['panels.a1.io.temp_1', 21.5, true]);
  });

  it('writes null rather than zero for an unavailable temperature channel', async () => {
    const { session, panelObjects, states } = harness();
    await panelObjects.applyIoStat(session, 'temp_1', 'unavailable');
    expect(states[0]).to.deep.equal(['panels.a1.io.temp_1', null, true]);
  });

  it('skips a blank relay stat instead of writing it as OFF', async () => {
    // text.toUpperCase() === 'ON' used to make an empty retained payload read
    // as false, the same swallowed-blank defect class as the temperature
    // branch just above already guards against.
    const { session, panelObjects, states } = harness();
    await panelObjects.applyIoStat(session, 'relay_1', '');
    expect(states).to.have.length(0);
  });

  it('ignores a relay stat payload the firmware would never send instead of guessing OFF', async () => {
    const { session, panelObjects, states } = harness();
    await panelObjects.applyIoStat(session, 'relay_1', 'garbage');
    expect(states).to.have.length(0);
  });

  it('ignores an io stat for a channel the panel never announced', async () => {
    const { session, panelObjects, states } = harness();
    await panelObjects.applyIoStat(session, 'ghost', 'ON');
    expect(states).to.have.length(0);
  });

  it('turns a control write into the matching cmnd publish', () => {
    const { session, panelObjects, published } = harness();
    panelObjects.handleControlWrite(session, 'control.display_brightness', 42);
    expect(published[0]).to.deep.equal({ topic: 'hometiles/cmnd/display_brightness', payload: '42', retain: false });
  });

  it('refuses a non-finite numeric write instead of publishing it', () => {
    // NaN and Infinity are numbers, so the already-a-number branch needs its
    // own finite check. NaN previously published the literal string "NaN" and
    // Infinity silently clamped to the maximum.
    const { session, panelObjects, published } = harness();
    panelObjects.handleControlWrite(session, 'control.display_brightness', Number.NaN);
    panelObjects.handleControlWrite(session, 'control.display_brightness', Number.POSITIVE_INFINITY);
    expect(published).to.have.length(0);
  });

  it('clamps a control write outside the allowed range', () => {
    const { session, panelObjects, published } = harness();
    panelObjects.handleControlWrite(session, 'control.display_brightness', 900);
    expect(published[0]!.payload).to.equal('100');
  });

  it('turns an io write into an ON or OFF command', () => {
    const { session, panelObjects, published } = harness();
    panelObjects.handleControlWrite(session, 'io.relay_1', true);
    expect(published[0]).to.deep.equal({ topic: 'hometiles/cmnd/io/relay_1', payload: 'ON', retain: false });
  });

  it('refuses to command a temperature io channel', () => {
    const { session, panelObjects, published } = harness();
    panelObjects.handleControlWrite(session, 'io.temp_1', true);
    expect(published).to.have.length(0);
  });

  it('deletes the whole panel branch on removal', async () => {
    const { panelObjects, deleted } = harness();
    await panelObjects.remove('a1');
    expect(deleted).to.deep.equal(['panels.a1']);
  });

  describe('the battery charge (Task 25b)', () => {
    it('adds info.battery only for a panel that announces the battery_soc capability', () => {
      expect(panelObjectDefs(harness().session).some((d) => d.id === 'panels.a1.info.battery')).to.equal(false);

      const withBattery = panelObjectDefs(harness(WITH_BATTERY).session).find((d) => d.id === 'panels.a1.info.battery');
      expect(withBattery).to.not.equal(undefined);
      const common = (withBattery!.obj as { common: Record<string, unknown> }).common;
      // Exactly these fields, and no `def`: the state stays null until the panel sends a value, never 0.
      expect(common).to.deep.equal({ name: 'Battery', read: true, write: false, type: 'number', role: 'value.battery', unit: '%', min: 0, max: 100 });
    });

    it('adds info.battery once the running session updates into the capability, without needing a new session', async () => {
      // PanelManager re-runs panelObjectDefs (via syncPanelObjects) after every
      // updateAnnouncement; this is how a capability flip false -> true creates
      // the object on the SAME session the manager already holds.
      const { session } = harness();
      expect(panelObjectDefs(session).some((d) => d.id === 'panels.a1.info.battery')).to.equal(false);
      await session.updateAnnouncement(parseAnnouncement('a1', WITH_BATTERY));
      expect(panelObjectDefs(session).some((d) => d.id === 'panels.a1.info.battery')).to.equal(true);
    });

    it('parses the panel-sent charge exactly as the firmware can send it', () => {
      const cases: Array<[string, number | null | undefined]> = [
        ['87', 87],
        [' 87 ', 87],
        ['87%', 87],
        ['87.6', 88],
        ['-3', 0],
        ['140', 100],
        ['', null],
        ['unavailable', null],
        ['Unavailable', null],
        ['unknown', null],
        ['abc', undefined],
        ['0x10', undefined],
        ['1e2', undefined],
        ['%', undefined],
        ['NaN', undefined],
        ['Infinity', undefined],
      ];
      for (const [input, expected] of cases) {
        expect(parseBatteryPayload(input), JSON.stringify(input)).to.equal(expected);
      }
    });

    it('writes nothing for a panel that never announced the capability', async () => {
      const { session, panelObjects, states } = harness();
      await panelObjects.applyBattery(session, '55');
      expect(states).to.have.length(0);
    });

    it('writes null, not zero, for a blank or unavailable charge', async () => {
      const { session, panelObjects, states } = harness(WITH_BATTERY);
      await panelObjects.applyBattery(session, '');
      expect(states).to.deep.equal([['panels.a1.info.battery', null, true]]);
    });

    it('writes the parsed charge with ack true', async () => {
      const { session, panelObjects, states } = harness(WITH_BATTERY);
      await panelObjects.applyBattery(session, '55');
      expect(states).to.deep.equal([['panels.a1.info.battery', 55, true]]);
    });

    it('ignores a charge the firmware would never send', async () => {
      const { session, panelObjects, states } = harness(WITH_BATTERY);
      await panelObjects.applyBattery(session, 'abc');
      expect(states).to.have.length(0);
    });
  });
});
