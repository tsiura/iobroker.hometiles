import { expect } from 'chai';
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
});
