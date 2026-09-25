import { expect } from 'chai';
import { parseMediaCommand } from '../../src/protocol/commands';
import { mapControlToDevice, type DetectedControl } from '../../src/registry/detector';
import { EntityRegistry } from '../../src/registry/entity-registry';
import type { DeviceInput, SourceValue, VirtualEntity } from '../../src/registry/types';
import { Dispatcher } from '../../src/runtime/dispatcher';

const NOW = 1_757_000_000_000;
const value = (val: unknown, ts = NOW): SourceValue => ({ val, ack: true, q: 0, ts });

const TEMP: DeviceInput = {
  objectId: 'zigbee.0.temp',
  name: 'Wohnzimmer',
  detectorType: 'temperature',
  domain: 'sensor',
  channels: { actual: { objectId: 'zigbee.0.temp.value', type: 'number', unit: '°C' } },
};

const PLUG: DeviceInput = {
  objectId: 'shelly.0.plug',
  name: 'Kaffee',
  detectorType: 'socket',
  domain: 'switch',
  channels: { set: { objectId: 'shelly.0.plug.on', type: 'boolean', write: true } },
};

function harness(coalesceMs = 0) {
  const changed: VirtualEntity[] = [];
  let membership = 0;
  const registry = new EntityRegistry(
    {
      onEntityChanged: (entity) => changed.push(entity),
      onMembershipChanged: () => {
        membership++;
      },
    },
    coalesceMs,
  );
  return { registry, changed, membership: () => membership };
}

describe('registry/entity-registry', () => {
  it('builds entities and reports which object ids to subscribe to', () => {
    const { registry } = harness();
    const result = registry.rebuild([TEMP, PLUG], {});
    expect(result.subscribe.sort()).to.deep.equal(['shelly.0.plug.on', 'zigbee.0.temp.value']);
    expect(result.unsubscribe).to.deep.equal([]);
    expect(Object.values(result.entityIds).sort()).to.deep.equal(['sensor.wohnzimmer', 'switch.kaffee']);
  });

  it('starts every entity unavailable until a value arrives', () => {
    const { registry } = harness();
    registry.rebuild([TEMP], {});
    expect(registry.byId('sensor.wohnzimmer')!.state).to.equal('unavailable');
  });

  it('emits a change when a subscribed value arrives', () => {
    const { registry, changed } = harness();
    registry.rebuild([TEMP], {});
    changed.length = 0;
    registry.applyStateChange('zigbee.0.temp.value', value(21.5));
    expect(changed).to.have.length(1);
    expect(changed[0]!.state).to.equal('21.5');
  });

  it('does not emit when the recomputed entity is identical', () => {
    const { registry, changed } = harness();
    registry.rebuild([TEMP], {});
    registry.applyStateChange('zigbee.0.temp.value', value(21.5));
    changed.length = 0;
    registry.applyStateChange('zigbee.0.temp.value', value(21.5, NOW + 1000));
    expect(changed).to.have.length(0);
  });

  it('ignores a value for an object id nothing subscribes to', () => {
    const { registry, changed } = harness();
    registry.rebuild([TEMP], {});
    changed.length = 0;
    registry.applyStateChange('some.other.state', value(1));
    expect(changed).to.have.length(0);
  });

  it('never schedules a recompute for a channel the detector drops as noise', () => {
    // Proves the mechanism, not just IGNORED_CHANNELS's contents: rebuild()
    // watches every key in device.channels (see the loop below `synthesise`
    // in rebuild), so a channel that never becomes a key — because
    // mapControlToDevice's channelName dropped it — can never be watched,
    // and applyStateChange on its object id must be a complete no-op. VALVE
    // is a live analog percentage on a real thermostat; without this, every
    // tick would force a full synthClimate recompute and JSON.stringify diff.
    const control: DetectedControl = {
      type: 'thermostat',
      states: [
        { id: 'thermo.0.actual', name: 'ACTUAL' },
        { id: 'thermo.0.valve', name: 'VALVE' },
      ],
    };
    const device = mapControlToDevice('thermo.0', control, {});
    expect(device!.channels.valve, 'sanity check: not just the set contents').to.equal(undefined);

    const { registry, changed, membership } = harness();
    registry.rebuild([device!], {});
    changed.length = 0;
    const membershipBefore = membership();

    registry.applyStateChange('thermo.0.valve', value(42));

    expect(changed, 'a change on a dropped channel must not trigger a recompute').to.have.length(0);
    expect(membership()).to.equal(membershipBefore);
  });

  it('coalesces a burst into a single emission carrying the newest value', () => {
    const { registry, changed } = harness(200);
    registry.rebuild([TEMP], {});
    changed.length = 0;
    registry.applyStateChange('zigbee.0.temp.value', value(1));
    registry.applyStateChange('zigbee.0.temp.value', value(2));
    registry.applyStateChange('zigbee.0.temp.value', value(3));
    expect(changed, 'nothing emitted before the window closes').to.have.length(0);
    registry.flush();
    expect(changed).to.have.length(1);
    expect(changed[0]!.state).to.equal('3');
  });

  it('always delivers the trailing edge so the final value is never lost', () => {
    const { registry, changed } = harness(200);
    registry.rebuild([TEMP], {});
    changed.length = 0;
    for (let i = 0; i < 50; i++) registry.applyStateChange('zigbee.0.temp.value', value(i));
    registry.applyStateChange('zigbee.0.temp.value', value(99));
    registry.flush();
    expect(changed[changed.length - 1]!.state).to.equal('99');
  });

  it('reports removed entities and the object ids to unsubscribe when a device disappears', () => {
    const { registry } = harness();
    const first = registry.rebuild([TEMP, PLUG], {});
    const second = registry.rebuild([TEMP], first.entityIds);
    expect(second.removed).to.deep.equal(['switch.kaffee']);
    expect(second.unsubscribe).to.deep.equal(['shelly.0.plug.on']);
    expect(registry.byId('switch.kaffee')).to.equal(undefined);
  });

  it('leaves out a device no entity can be made of, names it, and keeps every other (Ruling 62)', () => {
    // A device synthesise throws on failed the whole discovery, retried
    // forever, with a log naming no object. Until Task 13 a hand-edited
    // forcedDomain of a domain with no synth did that; every domain has one
    // now, so a corrupt device stands in for whatever throws next.
    const { registry } = harness();
    const station = {
      ...TEMP,
      objectId: 'zigbee.0.station',
      name: 'Station',
      get channels(): DeviceInput['channels'] {
        throw new Error('corrupt device');
      },
    } as DeviceInput;
    const result = registry.rebuild([station, TEMP], {});
    expect(result.skipped).to.deep.equal([{ objectId: 'zigbee.0.station', reason: 'corrupt device' }]);
    expect(registry.all().map((entity) => entity.entityId)).to.deep.equal(['sensor.wohnzimmer']);
  });

  it('makes an entity of a device forced into number, select or datetime (Task 13)', () => {
    // A temperature that declares no write flag, forced into each. As a
    // number it has no bounds and as a select no states map, so neither is
    // editable. As a datetime its number is an epoch date still to be set:
    // editable, since only write false is read-only (Rulings 84, 88, 89).
    const { registry } = harness();
    const forced = (['number', 'select', 'datetime'] as const).map(
      (domain): DeviceInput => ({ ...TEMP, objectId: `zigbee.0.${domain}`, name: domain, domain }),
    );
    const result = registry.rebuild(forced, {});
    expect(result.skipped).to.deep.equal([]);
    expect(registry.all().map((entity) => [entity.entityId, entity.writable])).to.deep.equal([
      ['number.number', { value: false }],
      ['select.select', { value: false }],
      ['datetime.datetime', { value: true }],
    ]);
  });

  it('asks again for every source an attempt did not get to read (Ruling 60(3))', () => {
    // main.ts subscribes and reads what a rebuild asks for. When the attempt
    // fails part-way, the retry must ask again for what was never read, not
    // only for what is new: those sources would stay unsubscribed.
    const { registry, membership } = harness();
    const first = registry.rebuild([TEMP, PLUG], {});
    expect(first.subscribe).to.deep.equal(['shelly.0.plug.on', 'zigbee.0.temp.value']);
    registry.applyStateChange('shelly.0.plug.on', value(true));
    const before = membership();

    const retry = registry.rebuild([TEMP, PLUG], first.entityIds);
    expect(retry.subscribe).to.deep.equal(['zigbee.0.temp.value']);
    expect(membership(), 'the same entities: no membership change').to.equal(before);
  });

  it('keeps a persisted entity id when the device is renamed', () => {
    const { registry } = harness();
    const first = registry.rebuild([TEMP], {});
    const renamed = { ...TEMP, name: 'Ganz Anders' };
    const second = registry.rebuild([renamed], first.entityIds);
    expect(second.entityIds['zigbee.0.temp']).to.equal('sensor.wohnzimmer');
    expect(registry.byId('sensor.wohnzimmer')!.attributes.friendly_name).to.equal('Ganz Anders');
  });

  it('signals a membership change only when the entity set actually changes', () => {
    const { registry, membership } = harness();
    registry.rebuild([TEMP], {});
    const after = membership();
    registry.rebuild([TEMP], { 'zigbee.0.temp': 'sensor.wohnzimmer' });
    expect(membership()).to.equal(after);
  });

  it("reads a history row of one state as the entity's synth reads it live, for an entity it holds (Task 22)", () => {
    const { registry } = harness();
    const DOOR: DeviceInput = {
      objectId: 'zigbee.0.door',
      name: 'Tür',
      detectorType: 'door',
      domain: 'binary_sensor',
      channels: { actual: { objectId: 'zigbee.0.door.opened', type: 'boolean' } },
    };
    const { entityIds } = registry.rebuild([TEMP, DOOR], {});
    const doorId = entityIds['zigbee.0.door']!;
    const door = (row: SourceValue): string | undefined => registry.stateOf(doorId, 'zigbee.0.door.opened', row);
    expect([door(value(true)), door(value(false)), door({ ...value(true), q: 0x42 }), door(value(null))]).to.deep.equal(['on', 'off', 'unavailable', 'unavailable']);
    expect(registry.stateOf('sensor.wohnzimmer', 'zigbee.0.temp.value', value(21.5))).to.equal('21.5');
    // The live entity does not move.
    expect(registry.byId(doorId)!.state).to.equal('unavailable');
    expect(registry.stateOf('sensor.elsewhere', 'zigbee.0.temp.value', value(21.5))).to.equal(undefined);
  });

  it('resolves a scene by its configured alias, case-insensitively', () => {
    const { registry } = harness();
    const scene: DeviceInput = {
      objectId: 'scene.0.nacht',
      name: 'Gute Nacht',
      detectorType: 'button',
      domain: 'scene',
      channels: { set: { objectId: 'scene.0.nacht', write: true } },
    };
    registry.rebuild([scene], {});
    registry.setSceneAliases({ 'Gute Nacht': 'scene.gute_nacht' });
    expect(registry.bySceneAlias('gute nacht')!.entityId).to.equal('scene.gute_nacht');
    expect(registry.bySceneAlias('unknown')).to.equal(undefined);
  });

  it('cancels pending timers on dispose', () => {
    const { registry, changed } = harness(200);
    registry.rebuild([TEMP], {});
    changed.length = 0;
    registry.applyStateChange('zigbee.0.temp.value', value(5));
    registry.dispose();
    registry.flush();
    expect(changed).to.have.length(0);
  });

  it('clears entities so all() and byId() stop returning stale data after dispose', () => {
    const { registry } = harness();
    registry.rebuild([TEMP, PLUG], {});
    registry.applyStateChange('zigbee.0.temp.value', value(21.5));
    expect(registry.all()).to.have.length(2);

    registry.dispose();

    expect(registry.all()).to.deep.equal([]);
    expect(registry.byId('sensor.wohnzimmer')).to.equal(undefined);
    expect(registry.byId('switch.kaffee')).to.equal(undefined);
  });

  describe('the current value a re-select writes back (Ruling 41)', () => {
    // {3:'5'} decodes 3 and 5 alike: the panel sees "5" either way, so there
    // is nothing to re-publish -- but the value a re-select writes back is the
    // one the device holds NOW. A registry that handed out the entity from
    // before the change would write 3 into a device sitting at 5.
    const AC: DeviceInput = {
      objectId: 'ac.0',
      name: 'Klima',
      detectorType: 'airCondition',
      domain: 'climate',
      channels: { mode: { objectId: 'ac.0.mode', type: 'number', write: true, states: { '3': '5' } } },
    };
    const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

    async function reselectFive(registry: EntityRegistry, entityId: string): Promise<Array<[string, unknown]>> {
      const writes: Array<[string, unknown]> = [];
      const dispatcher = new Dispatcher(registry, async (objectId, val) => void writes.push([objectId, val]), silentLog);
      expect(await dispatcher.dispatch({ kind: 'set_hvac_mode', entityId, mode: '5' })).to.deep.equal({ ok: true, writes: 1 });
      return writes;
    }

    it('keeps the raw value behind an unchanged view current', async () => {
      const { registry, changed } = harness();
      const entityId = registry.rebuild([AC], {}).entityIds['ac.0']!;
      registry.applyStateChange('ac.0.mode', value(3));
      const shown = registry.byId(entityId)!;
      changed.length = 0;

      registry.applyStateChange('ac.0.mode', value(5, NOW + 1000));
      expect(changed, 'nothing the panel sees changed').to.have.length(0);
      expect(registry.byId(entityId)!.lastChanged, 'an unseen change is not a change').to.equal(shown.lastChanged);
      expect(await reselectFive(registry, entityId)).to.deep.equal([['ac.0.mode', 5]]);
    });

    it('applies a batched value before handing the entity to a command, inside a real batching window (M2)', async () => {
      // The default window is 200 ms (config/options.ts), up to 5000 ms. A
      // command arriving inside it used to read the entity from BEFORE the
      // value, and wrote 3 with ok:true.
      const { registry, changed } = harness(200);
      const entityId = registry.rebuild([AC], {}).entityIds['ac.0']!;
      registry.applyStateChange('ac.0.mode', value(3));
      registry.flush();
      changed.length = 0;

      registry.applyStateChange('ac.0.mode', value(5, NOW + 1000));
      expect(await reselectFive(registry, entityId)).to.deep.equal([['ac.0.mode', 5]]);

      // The window's own timer was consumed: nothing lands late or twice.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(changed).to.have.length(0);
    });
  });

  describe('a playing position the panel already shows is no change (Ruling 65(1))', () => {
    // The panel stamps each media payload with the time it RECEIVES it and
    // advances the position itself while playing (tile_renderer.cpp:4332,
    // media_popup.cpp:289-296). Republishing every elapsed-time tick re-parsed
    // every panel each second and undid its optimistic play/pause, seek and
    // volume (media_popup.cpp:410-416, :458-462).
    const PLAYER: DeviceInput = {
      objectId: 'sonos.0.root.player',
      name: 'Wohnzimmer',
      detectorType: 'media',
      domain: 'media_player',
      channels: {
        state: { objectId: 'player.state', type: 'boolean', write: true },
        seek: { objectId: 'player.seek', type: 'number', min: 0, max: 100, write: true },
        duration: { objectId: 'player.duration', type: 'number' },
        elapsed: { objectId: 'player.elapsed', type: 'number' },
        title: { objectId: 'player.title', type: 'string' },
      },
    };

    /** A player published playing at 42 s of 391 s, on a clock the test moves. */
    function playing() {
      let now = NOW;
      let position = 42;
      const changed: VirtualEntity[] = [];
      const registry = new EntityRegistry(
        { onEntityChanged: (entity) => changed.push(entity), onMembershipChanged: () => undefined },
        0,
        () => now,
      );
      registry.rebuild([PLAYER], {});
      const set = (name: string, val: unknown): void => registry.applyStateChange(`player.${name}`, value(val, now));
      set('state', true);
      set('duration', 391);
      set('title', 'Hotel California');
      set('elapsed', position);
      changed.length = 0;
      return {
        registry,
        changed,
        set,
        /** `seconds` later, the device reports its position `moved` seconds further. */
        tick: (seconds = 1, moved = seconds): void => {
          now += seconds * 1000;
          position += moved;
          set('elapsed', position);
        },
        seekTo: (to: number): void => {
          position = to;
          set('elapsed', to);
        },
      };
    }

    it('publishes a stream of one-second ticks once, not once per tick', () => {
      const { tick, changed } = playing();
      for (let i = 0; i < 29; i++) tick();
      expect(changed).to.have.length(0);
    });

    it('refreshes the retained state with the first tick 30 s after the last publish, at the fresh position', () => {
      const { tick, changed } = playing();
      for (let i = 0; i < 35; i++) tick();
      expect(changed.map((entity) => entity.attributes.media_position)).to.deep.equal([72]);
    });

    it('publishes a seek, a stall, a pause, a track change and a new duration at once', () => {
      const { tick, set, seekTo, changed } = playing();
      tick();
      tick();
      const published = (): number => changed.length;
      seekTo(150);
      expect(published(), 'a seek').to.equal(1);
      tick();
      expect(published(), 'the next tick, measured from the seek').to.equal(1);
      // 4 s later only 1 s further: 3 s behind what the panel shows. (A value
      // re-sent unchanged is no change at all, as before: a player that
      // reports only on events would pull the bar back on every repeat.)
      tick(4, 1);
      expect(published(), 'a device 3 s behind the panel').to.equal(2);
      set('state', false);
      expect(published(), 'a pause').to.equal(3);
      seekTo(200);
      expect(published(), 'a seek while paused: the panel does not advance it').to.equal(4);
      set('state', true);
      expect(published(), 'play').to.equal(5);
      set('title', 'Take It Easy');
      expect(published(), 'a track change').to.equal(6);
      set('duration', 211);
      expect(published(), 'a new duration').to.equal(7);
    });

    it('tolerates a device up to 2 s ahead of the panel, not more', () => {
      const { tick, changed } = playing();
      tick(1, 3);
      tick(1, 0.5);
      expect(changed, '2 s, then 1.5 s ahead').to.have.length(0);
      tick(1, 2);
      expect(changed.map((entity) => entity.attributes.media_position), '2.5 s ahead').to.deep.equal([47.5]);
    });

    it('stops at the duration, as the panel does', () => {
      const { tick, seekTo, changed } = playing();
      seekTo(389);
      // 390.9 of 391 s after 4 s: the panel shows 391, not 393.
      tick(4, 1.9);
      expect(changed.map((entity) => entity.attributes.media_position)).to.deep.equal([389]);
    });

    it('publishes nothing once disposed at unload, the refresh included', () => {
      const { registry, tick, changed } = playing();
      registry.dispose();
      for (let i = 0; i < 35; i++) tick();
      expect(changed).to.have.length(0);
    });

    it('Task 10: a seek command lands on SEEK, and the position the device then reports is published at once', async () => {
      const { registry, tick, seekTo, changed } = playing();
      tick();
      tick();
      const writes: Array<[string, unknown]> = [];
      const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
      const dispatcher = new Dispatcher(registry, async (objectId, val) => void writes.push([objectId, val]), log);
      const entityId = registry.all()[0]?.entityId;
      // The seek bar's own bytes: 195.5 s of the 391 s track is 50%.
      const seek = `{"entity_id":"${entityId}","command":"media_seek","seek_position":195.5}`;
      expect(await dispatcher.dispatch(parseMediaCommand(seek))).to.deep.equal({ ok: true, writes: 1 });
      expect(writes).to.deep.equal([['player.seek', 50]]);
      // The panel re-anchored at 195.5 on release (media_popup.cpp:510-512):
      // a tick from before the device moved would only drag its bar back.
      tick();
      expect(changed, 'a tick from before the seek').to.have.length(0);
      seekTo(195.5);
      expect(changed.map((entity) => entity.attributes.media_position), 'the device at its new position').to.deep.equal([195.5]);
    });
  });
});
