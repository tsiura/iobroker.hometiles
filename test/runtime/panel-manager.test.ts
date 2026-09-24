import { expect } from 'chai';
import type { EnergyCatalogEntry } from '../../src/protocol/energy';
import { Dispatcher } from '../../src/runtime/dispatcher';
import type { PublishRequest } from '../../src/runtime/mqtt-client';
import { PanelManager } from '../../src/runtime/panel-manager';
import type { PanelTransport } from '../../src/runtime/panel-session';
import type { VirtualEntity } from '../../src/registry/types';

function announcement(deviceId: string, baseTopic: string): string {
  return JSON.stringify({
    device_id: deviceId,
    base_topic: baseTopic,
    ha_prefix: 'ha/statestream',
    device_name: `Panel ${deviceId}`,
    model: 'waveshare_touch_lcd_8',
    sensors: [],
    binary_sensors: [],
    scene_map: {},
    local_io: [],
  });
}

const ENTITY: VirtualEntity = {
  entityId: 'switch.k',
  domain: 'switch',
  source: { set: 'shelly.0.on' },
  state: 'off',
  attributes: { friendly_name: 'K' },
  available: true,
  lastChanged: 1_757_000_000_000,
};

function harness(
  entities: () => VirtualEntity[] | null = () => [ENTITY],
  unpublished?: () => readonly string[],
  energy?: () => readonly EnergyCatalogEntry[],
) {
  const published: PublishRequest[] = [];
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  const warnings: string[] = [];
  const writes: Array<[string, unknown]> = [];
  const removedPanels: string[] = [];
  let sessionsChanged = 0;

  const log = {
    info: (): void => undefined,
    debug: (): void => undefined,
    error: (): void => undefined,
    warn: (message: string): void => void warnings.push(message),
  };
  const transport: PanelTransport = {
    publish: (request) => published.push(request),
    subscribe: async (topic) => void subscribed.push(topic),
    unsubscribe: async (topic) => void unsubscribed.push(topic),
  };
  const dispatcher = new Dispatcher(
    { byId: (id) => (id === ENTITY.entityId ? ENTITY : undefined), bySceneAlias: () => undefined },
    async (objectId, value) => void writes.push([objectId, value]),
    log,
  );
  const manager = new PanelManager({
    transport,
    dispatcher,
    log,
    entities,
    ...(unpublished ? { unpublished } : {}),
    ...(energy ? { energy } : {}),
    onSessionsChanged: () => {
      sessionsChanged++;
    },
    onPanelRemoved: (deviceId) => {
      removedPanels.push(deviceId);
    },
  });
  return {
    manager,
    published,
    subscribed,
    unsubscribed,
    warnings,
    writes,
    log,
    sessions: () => sessionsChanged,
    removedPanels,
  };
}

describe('runtime/panel-manager', () => {
  it('creates a session and pushes config plus current state on announcement', async () => {
    const { manager, published } = harness();
    await manager.handleAnnouncement('a1', announcement('a1', 'panel-a'));
    expect(manager.get('a1')).to.not.equal(undefined);
    expect(published.some((p) => p.topic === 'tab5_lvgl/config/a1/bridge/apply')).to.equal(true);
    expect(published.some((p) => p.topic === 'ha/statestream/switch/k/state')).to.equal(true);
  });

  it("gives each panel's apply the energy catalog, at every push: announcement, refresh and a new announcement (Task 20b)", async () => {
    let catalog: EnergyCatalogEntry[] = [{ id: 'energy.netzbezug', name: 'Netzbezug', unit: 'kWh', category: 'grid' }];
    const { manager, published } = harness(() => [ENTITY], undefined, () => catalog);
    const applied = (): unknown => JSON.parse(published.filter((p) => p.topic === 'tab5_lvgl/config/a1/bridge/apply').at(-1)!.payload).energy;
    await manager.handleAnnouncement('a1', announcement('a1', 'panel-a'));
    expect(applied()).to.deep.equal(catalog);
    catalog = [...catalog, { id: 'energy.pv', name: 'PV', category: 'solar' }];
    await manager.handleMessage('tab5_lvgl/config/a1/bridge/request', 'force', false);
    expect(applied()).to.deep.equal(catalog);
    catalog = [];
    await manager.handleAnnouncement('a1', announcement('a1', 'panel-a'));
    expect(applied()).to.deep.equal([]);
    // Without a catalog, an empty one, as before.
    const bare = harness();
    await bare.manager.handleAnnouncement('a1', announcement('a1', 'panel-a'));
    expect(JSON.parse(bare.published.find((p) => p.topic === 'tab5_lvgl/config/a1/bridge/apply')!.payload).energy).to.deep.equal([]);
  });

  it("clears, after a new panel's configuration, the retained state of each entity the last run published and this one does not (Task 21b)", async () => {
    // An un-pick is a config save, so a restart: no rebuild of this run names
    // the entity, and the panel announces after the first one.
    const { manager, published } = harness(() => [ENTITY], () => ['sensor.balkon', 'number.soll']);
    await manager.handleAnnouncement('a1', announcement('a1', 'panel-a'));
    expect(published.map((p) => [p.topic, p.payload === '' ? 'cleared' : 'set', p.retain])).to.deep.equal([
      ['tab5_lvgl/config/a1/bridge/apply', 'set', true],
      ['tab5_lvgl/config/a1/bridge/icons', 'set', true],
      ['ha/statestream/switch/k/state', 'set', true],
      ['ha/statestream/sensor/balkon/state', 'cleared', true],
      ['ha/statestream/number/soll/control', 'cleared', true],
    ]);
    // Once per new session: a panel announcing again is not told twice.
    const count = published.length;
    await manager.handleAnnouncement('a1', announcement('a1', 'panel-a'));
    expect(published.slice(count).filter((p) => p.payload === '')).to.deep.equal([]);
  });

  it('clears nothing for a panel announcing before discovery has succeeded (Ruling 56)', async () => {
    const { manager, published } = harness(() => null, () => ['sensor.balkon']);
    await manager.handleAnnouncement('a1', announcement('a1', 'panel-a'));
    expect(published).to.deep.equal([]);
  });

  it('publishes nothing to a panel announcing before discovery has succeeded (Ruling 56)', async () => {
    const { manager, published } = harness(() => null);
    await manager.handleAnnouncement('a1', announcement('a1', 'panel-a'));
    expect(manager.get('a1')).to.not.equal(undefined);
    // Neither does the panel's own refresh request.
    await manager.handleMessage('tab5_lvgl/config/a1/bridge/request', 'force', false);
    expect(published).to.deep.equal([]);
  });

  it('rejects a malformed announcement without creating a session', async () => {
    const { manager, warnings } = harness();
    await manager.handleAnnouncement('bad', '{"local_io":[{"id":""}]}');
    expect(manager.get('bad')).to.equal(undefined);
    expect(warnings.some((w) => w.includes('Rejected announcement'))).to.equal(true);
  });

  it('treats an empty retained announcement as the panel withdrawing itself', async () => {
    const { manager, unsubscribed } = harness();
    await manager.handleAnnouncement('a1', announcement('a1', 'panel-a'));
    unsubscribed.length = 0;
    await manager.handleAnnouncement('a1', '');
    expect(manager.get('a1')).to.equal(undefined);
    expect(unsubscribed.length).to.be.greaterThan(0);
  });

  it('calls onPanelRemoved with the device id after a panel withdraws', async () => {
    // A withdrawn panel's `panels.<deviceId>.*` object tree must be cleaned
    // up, or later writes to the orphaned control states vanish silently.
    const { manager, removedPanels } = harness();
    await manager.handleAnnouncement('a1', announcement('a1', 'panel-a'));
    expect(removedPanels).to.deep.equal([]);
    await manager.handleAnnouncement('a1', '');
    expect(removedPanels).to.deep.equal(['a1']);
  });

  it('does not call onPanelRemoved for a device id that was never a session', async () => {
    const { manager, removedPanels } = harness();
    await manager.remove('ghost');
    expect(removedPanels).to.deep.equal([]);
  });

  it('updates an existing panel rather than creating a duplicate', async () => {
    const { manager } = harness();
    await manager.handleAnnouncement('a1', announcement('a1', 'panel-a'));
    await manager.handleAnnouncement('a1', announcement('a1', 'panel-a-renamed'));
    expect(manager.sessions()).to.have.length(1);
    expect(manager.get('a1')!.baseTopic).to.equal('panel-a-renamed');
  });

  it('executes a shared-base-topic command exactly once, not once per panel', async () => {
    // base_topic defaults to "hometiles" when omitted, so two panels can end up
    // sharing one command channel. Executing per session would turn one tap
    // into two writes, and a toggle into no visible change.
    const { manager, writes, warnings } = harness();
    await manager.handleAnnouncement('a1', announcement('a1', 'shared'));
    await manager.handleAnnouncement('a2', announcement('a2', 'shared'));
    expect(warnings.some((w) => w.includes('already used by panel'))).to.equal(true);

    await manager.handleMessage('shared/cmnd/switch', '{"entity_id":"switch.k","state":"on"}', false);
    expect(writes).to.deep.equal([['shelly.0.on', true]]);
  });

  it('ignores a retained command, yet a retained announcement starts the session and retained presence is read (Ruling 101, T1)', async () => {
    // What an adapter restart replays: the panel's retained announcement and
    // presence, and a command some client left retained. The manager never
    // sees an announcement's retain flag, and must not drop the rest.
    const { manager, writes, warnings } = harness();
    await manager.handleAnnouncement('a1', announcement('a1', 'panel-a'));
    await manager.handleMessage('panel-a/stat/connected', 'online', true);
    await manager.handleMessage('panel-a/stat/ip', '192.168.1.40', true);
    await manager.handleMessage('panel-a/cmnd/switch', '{"entity_id":"switch.k","state":"on"}', true);
    expect(manager.get('a1')).to.include({ online: true, ip: '192.168.1.40' });
    expect(writes).to.deep.equal([]);
    await manager.handleMessage('panel-a/cmnd/switch', '{"entity_id":"switch.k","state":"on"}', false);
    expect(writes).to.deep.equal([['shelly.0.on', true]]);
    expect(warnings).to.deep.equal([]);
  });

  it('releases subscriptions for every panel on stopAll', async () => {
    const { manager, unsubscribed } = harness();
    await manager.handleAnnouncement('a1', announcement('a1', 'panel-a'));
    await manager.handleAnnouncement('a2', announcement('a2', 'panel-b'));
    unsubscribed.length = 0;
    await manager.stopAll();
    expect(manager.sessions()).to.have.length(0);
    expect(unsubscribed.length).to.be.greaterThan(0);
  });
});
