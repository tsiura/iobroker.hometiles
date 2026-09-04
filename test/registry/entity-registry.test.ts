import { expect } from 'chai';
import { EntityRegistry } from '../../src/registry/entity-registry';
import type { DeviceInput, SourceValue, VirtualEntity } from '../../src/registry/types';

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
});
