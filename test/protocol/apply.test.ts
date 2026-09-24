import { expect } from 'chai';
import { buildApplyPayload, buildIconsPayload, configSignature, listsAnyEntity, splitEditables } from '../../src/protocol/apply';
import { DOMAINS, type VirtualEntity } from '../../src/registry/types';
import type { EnergyCatalogEntry } from '../../src/protocol/energy';
import { panelBinaryMeta, panelEnergyCatalog, panelIconMap, panelIconUpdate, panelIcons, panelList, panelNameIndex, panelNames, panelSensorMeta } from './panel-scan';

function e(over: Partial<VirtualEntity>): VirtualEntity {
  return {
    entityId: 'sensor.x',
    domain: 'sensor',
    source: {},
    state: '1',
    attributes: {},
    available: true,
    lastChanged: 1_757_000_000_000,
    ...over,
  };
}

const ENTITIES: VirtualEntity[] = [
  e({ entityId: 'sensor.temp', state: '21.5', attributes: { friendly_name: 'Wohnzimmer', unit_of_measurement: '°C', icon: 'mdi:thermometer', state_class: 'measurement' } }),
  e({ entityId: 'binary_sensor.tuer', domain: 'binary_sensor', state: 'on', attributes: { friendly_name: 'Haustuer', device_class: 'door', icon: 'mdi:door' } }),
  e({ entityId: 'switch.kaffee', domain: 'switch', state: 'off', attributes: { friendly_name: 'Kaffee' } }),
  e({ entityId: 'light.decke', domain: 'light', state: 'on', attributes: { friendly_name: 'Decke', brightness_pct: 60 } }),
  e({ entityId: 'scene.nacht', domain: 'scene', state: 'unknown', attributes: { friendly_name: 'Gute Nacht' } }),
];

describe('protocol/apply', () => {
  it('emits every top-level key the firmware scanner looks for', () => {
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: {} }));
    for (const key of ['sensors', 'binary_sensors', 'lights', 'switches', 'media_players', 'climates', 'covers', 'weathers', 'numbers', 'selects', 'datetimes', 'energy', 'scene_map']) {
      expect(parsed, `missing key ${key}`).to.have.property(key);
    }
  });

  it('routes each entity into the array for its domain', () => {
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: {} }));
    expect(parsed.sensors).to.deep.equal(['sensor.temp']);
    expect(parsed.binary_sensors).to.deep.equal(['binary_sensor.tuer']);
    expect(parsed.switches).to.deep.equal(['switch.kaffee']);
    expect(parsed.lights).to.deep.equal(['light.decke']);
  });

  it('sends every list, an empty one too: the panel keeps a list whose key is absent', () => {
    // numbers, selects and datetimes (ha_bridge_config.cpp:581-587), weathers
    // (:599-602), climates (:621-624) and covers (:626-629) are replaced only
    // when their key is there. Left out, a panel that ran the Home Assistant
    // Bridge would keep its lists, and go on subscribing to every number,
    // select and datetime in them (mqtt_handlers.cpp:1306-1314).
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: {} }));
    for (const key of ['media_players', 'climates', 'covers', 'weathers', 'numbers', 'selects', 'datetimes']) {
      expect(parsed[key], key).to.deep.equal([]);
    }
  });

  it('emits an empty energy array so the firmware does not keep a stale migrated configuration', () => {
    // ha_bridge_config.cpp scans for "energy" specifically and keeps whatever
    // it last had when the key is absent, unlike the other domains above.
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: {} }));
    expect(parsed.energy).to.deep.equal([]);
  });

  it('builds sensor_meta with exactly the keys the firmware parser reads (Ruling 109)', () => {
    // parseSensorMetaSection reads entity_id, unit, name, value and
    // state_kind (ha_bridge_config.cpp:1209-1236), the icon walker the icon;
    // nothing reads state or number.
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: {} }));
    expect(parsed.sensor_meta[0]).to.deep.equal({
      entity_id: 'sensor.temp',
      name: 'Wohnzimmer',
      unit: '°C',
      value: '21.5',
      state_kind: 'number',
      icon: 'mdi:thermometer',
    });
  });

  it('marks a textual sensor with state_kind state', () => {
    const text = e({ entityId: 'sensor.mode', state: 'heating', attributes: { friendly_name: 'Modus' } });
    const parsed = JSON.parse(buildApplyPayload({ entities: [text], sceneMap: {} }));
    expect(parsed.sensor_meta[0].state_kind).to.equal('state');
  });

  it('derives state_kind from the declared numeric type, not from the current state string', () => {
    // bridge/apply is only re-pushed when registry membership changes, not on
    // every state change, so classifying by the current value would let a
    // transient "unavailable" at startup decide the panel's rendering mode
    // permanently, even once the sensor starts reporting real numbers.
    const startingUp = e({
      entityId: 'sensor.temp',
      state: 'unavailable',
      available: false,
      attributes: { friendly_name: 'Wohnzimmer', state_class: 'measurement' },
    });
    const parsed = JSON.parse(buildApplyPayload({ entities: [startingUp], sceneMap: {} }));
    expect(parsed.sensor_meta[0].state_kind).to.equal('number');
  });

  it('does not read a numeric-looking transient string as state_kind number without a declared measurement type', () => {
    // isNumericState(entity.state) used to accept anything Number() parsed,
    // including "0x10". state_kind must come from the declared type only.
    const notDeclared = e({ entityId: 'sensor.raw', state: '0x10', attributes: { friendly_name: 'Raw' } });
    const parsed = JSON.parse(buildApplyPayload({ entities: [notDeclared], sceneMap: {} }));
    expect(parsed.sensor_meta[0].state_kind).to.equal('state');
  });

  it('builds binary_sensor_meta with exactly the keys the firmware reads, no state labels (Ruling 109)', () => {
    // parseBinarySensorMetaSection reads entity_id, name, state, available,
    // device_class, icon and last_changed (ha_bridge_config.cpp:1259-1313);
    // on/off/unknown/unavailable are compared with state, never read as keys.
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: {} }));
    expect(parsed.binary_sensor_meta[0]).to.deep.equal({
      entity_id: 'binary_sensor.tuer',
      name: 'Haustuer',
      device_class: 'door',
      state: 'on',
      available: true,
      last_changed: 1_757_000_000,
      icon: 'mdi:door',
    });
  });

  it('omits last_changed entirely when the source has never produced a value', () => {
    // lastChanged 0 means never observed. Publishing unixSeconds(0) would claim
    // the entity last changed in 1970; fabricating a current timestamp would
    // make a dead entity look fresh on every push.
    const never = e({ entityId: 'binary_sensor.n', domain: 'binary_sensor', state: 'unavailable', available: false, lastChanged: 0, attributes: { friendly_name: 'N' } });
    const parsed = JSON.parse(buildApplyPayload({ entities: [never], sceneMap: {} }));
    expect(parsed.binary_sensor_meta[0]).to.not.have.property('last_changed');
  });

  it('reports an unavailable entity as available false in its metadata', () => {
    const gone = e({ entityId: 'binary_sensor.g', domain: 'binary_sensor', state: 'unavailable', available: false, attributes: { friendly_name: 'G' } });
    const parsed = JSON.parse(buildApplyPayload({ entities: [gone], sceneMap: {} }));
    expect(parsed.binary_sensor_meta[0].available).to.equal(false);
    expect(parsed.binary_sensor_meta[0].state).to.equal('unavailable');
  });

  it('passes the scene alias map through lowercased', () => {
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: { 'Gute Nacht': 'scene.nacht' } }));
    expect(parsed.scene_map).to.deep.equal({ 'gute nacht': 'scene.nacht' });
  });

  it('produces a stable signature for identical input and a different one after a change', () => {
    const a = buildApplyPayload({ entities: ENTITIES, sceneMap: {} });
    const b = buildApplyPayload({ entities: ENTITIES, sceneMap: {} });
    expect(configSignature(a)).to.equal(configSignature(b));

    const changed = buildApplyPayload({
      entities: [...ENTITIES, e({ entityId: 'sensor.new', attributes: { friendly_name: 'New' } })],
      sceneMap: {},
    });
    expect(configSignature(changed)).to.not.equal(configSignature(a));
  });

  it('orders entities deterministically so an unchanged registry never re-pushes', () => {
    const forward = buildApplyPayload({ entities: ENTITIES, sceneMap: {} });
    const reversed = buildApplyPayload({ entities: [...ENTITIES].reverse(), sceneMap: {} });
    expect(configSignature(forward)).to.equal(configSignature(reversed));
  });

  it('builds bridge/icons as the flat map the panel reads: each entity its MDI icon, or "" (m1, Ruling 110)', () => {
    // applyIconUpdate takes each top-level pair as entity id and icon
    // (ha_bridge_config.cpp:743-771), as the Bridge sends it
    // (__init__.py:3529-3530); "" removes an icon the panel holds (:757-762).
    expect(buildIconsPayload(ENTITIES)).to.equal(
      '{"binary_sensor.tuer":"mdi:door","light.decke":"","scene.nacht":"","sensor.temp":"mdi:thermometer","switch.kaffee":""}',
    );
  });
});

describe('protocol/apply: the v0.2 domains (Task 21)', () => {
  const V02: VirtualEntity[] = [
    e({ entityId: 'climate.wohnzimmer', domain: 'climate', state: 'heat', attributes: { friendly_name: 'Klima Wohnzimmer', icon: 'mdi:air-conditioner', hvac_mode: 'heat' } }),
    e({ entityId: 'cover.rollladen', domain: 'cover', state: 'open', attributes: { friendly_name: 'Rollladen', current_position: 100 } }),
    e({ entityId: 'media_player.kueche', domain: 'media_player', state: 'playing', attributes: { friendly_name: 'Küchenradio', icon: 'mdi:radio' } }),
    e({ entityId: 'weather.station', domain: 'weather', state: 'sunny', attributes: { friendly_name: 'Wetterstation', icon: 'mdi:weather-partly-cloudy', weather_icon: '/icons/sun.png' } }),
    e({ entityId: 'number.vorlauf', domain: 'number', state: '45', attributes: { friendly_name: 'Vorlauf Soll', min: 20, max: 60, step: 0.5, unit_of_measurement: '°C' } }),
    e({ entityId: 'select.betriebsart', domain: 'select', state: 'Eco', attributes: { friendly_name: 'Betriebsart', icon: 'mdi:tune', options: ['Aus', 'Eco'] } }),
    e({ entityId: 'datetime.weckzeit', domain: 'datetime', state: '06:45', attributes: { friendly_name: 'Weckzeit', has_date: false, has_time: true } }),
  ];
  const payload = (entities: VirtualEntity[], sceneMap: Record<string, string> = {}): string => buildApplyPayload({ entities, sceneMap });

  it('lists each entity in the array of its domain, read the way the panel reads it', () => {
    const apply = payload([...ENTITIES, ...V02]);
    expect(panelList(apply, 'climates')).to.deep.equal(['climate.wohnzimmer']);
    expect(panelList(apply, 'covers')).to.deep.equal(['cover.rollladen']);
    expect(panelList(apply, 'media_players')).to.deep.equal(['media_player.kueche']);
    expect(panelList(apply, 'weathers')).to.deep.equal(['weather.station']);
    expect(panelList(apply, 'numbers')).to.deep.equal(['number.vorlauf']);
    expect(panelList(apply, 'selects')).to.deep.equal(['select.betriebsart']);
    expect(panelList(apply, 'datetimes')).to.deep.equal(['datetime.weckzeit']);
    // The v0.1 lists hold none of them.
    expect(panelList(apply, 'sensors')).to.deep.equal(['sensor.temp']);
    expect(panelList(apply, 'switches')).to.deep.equal(['switch.kaffee']);
  });

  it('puts number, select and datetime all in editable_meta, and in no meta section of their own', () => {
    const apply = payload(V02);
    expect(JSON.parse(apply).editable_meta.map((m: { entity_id: string }) => m.entity_id)).to.deep.equal([
      'datetime.weckzeit',
      'number.vorlauf',
      'select.betriebsart',
    ]);
    expect(apply).to.not.match(/"number_meta"|"select_meta"|"datetime_meta"/);
  });

  it('never sends a cameras or camera_meta section (Ruling 107)', () => {
    const apply = payload([...ENTITIES, ...V02], { 'gute nacht': 'scene.nacht' });
    expect(apply).to.not.match(/"cameras"|"camera_meta"/);
    expect(panelList(apply, 'cameras')).to.equal(undefined);
  });

  it('gives each meta entry the entity id, the name and, when the entity has one, the icon (Ruling 106)', () => {
    // Every *_meta section is read for icons (parseIconMetaSections,
    // ha_bridge_config.cpp:1382-1394), not only for names.
    const parsed = JSON.parse(payload(V02));
    expect(parsed.climate_meta).to.deep.equal([{ entity_id: 'climate.wohnzimmer', name: 'Klima Wohnzimmer', icon: 'mdi:air-conditioner' }]);
    expect(parsed.cover_meta).to.deep.equal([{ entity_id: 'cover.rollladen', name: 'Rollladen' }]);
    expect(parsed.media_player_meta).to.deep.equal([{ entity_id: 'media_player.kueche', name: 'Küchenradio', icon: 'mdi:radio' }]);
    // The entity's icon, not weather_icon: that is the condition's picture.
    expect(parsed.weather_meta).to.deep.equal([{ entity_id: 'weather.station', name: 'Wetterstation', icon: 'mdi:weather-partly-cloudy' }]);
    expect(parsed.editable_meta).to.deep.equal([
      { entity_id: 'datetime.weckzeit', name: 'Weckzeit' },
      { entity_id: 'number.vorlauf', name: 'Vorlauf Soll' },
      { entity_id: 'select.betriebsart', name: 'Betriebsart', icon: 'mdi:tune' },
    ]);
  });

  it('names an entity without a friendly name by its entity id, as every other meta section does', () => {
    const bare = e({ entityId: 'cover.garage', domain: 'cover', attributes: {} });
    expect(JSON.parse(payload([bare])).cover_meta).to.deep.equal([{ entity_id: 'cover.garage', name: 'cover.garage' }]);
  });

  it('gets every name and icon across to the panel', () => {
    const apply = payload(V02);
    // Names are read from these four (ha_bridge_config.cpp:657-661) ...
    expect(panelNames(apply, 'climate_meta')).to.deep.equal({ 'climate.wohnzimmer': 'Klima Wohnzimmer' });
    expect(panelNames(apply, 'cover_meta')).to.deep.equal({ 'cover.rollladen': 'Rollladen' });
    expect(panelNames(apply, 'media_player_meta')).to.deep.equal({ 'media_player.kueche': 'Küchenradio' });
    expect(panelNames(apply, 'editable_meta')).to.deep.equal({
      'datetime.weckzeit': 'Weckzeit',
      'number.vorlauf': 'Vorlauf Soll',
      'select.betriebsart': 'Betriebsart',
    });
    // ... icons from those and from weather_meta (:1386-1393).
    expect(panelIcons(apply, 'climate_meta')).to.deep.equal({ 'climate.wohnzimmer': 'mdi:air-conditioner' });
    expect(panelIcons(apply, 'media_player_meta')).to.deep.equal({ 'media_player.kueche': 'mdi:radio' });
    expect(panelIcons(apply, 'weather_meta')).to.deep.equal({ 'weather.station': 'mdi:weather-partly-cloudy' });
    expect(panelIcons(apply, 'editable_meta')).to.deep.equal({ 'select.betriebsart': 'mdi:tune' });
  });

  it('lists every entity before the first free text, so no name, state or alias spelled like a key shadows one', () => {
    // The panel takes the FIRST occurrence of each quoted key (applyJson,
    // ha_bridge_config.cpp:567-636), then the first '[' and ']' after it.
    const lists = ['sensors', 'binary_sensors', 'lights', 'switches', 'media_players', 'climates', 'covers', 'weathers', 'numbers', 'selects', 'datetimes'];
    const decoys = lists.map((key, i) =>
      e({ entityId: `sensor.decoy_${i}`, state: key, attributes: { friendly_name: key, unit_of_measurement: key, icon: key } }),
    );
    const sceneMap = Object.fromEntries(lists.map((key) => [key, 'scene.nacht']));
    const apply = payload([...ENTITIES, ...V02, ...decoys], sceneMap);
    const parsed = JSON.parse(apply) as Record<string, string[]>;
    for (const key of lists) expect(panelList(apply, key), key).to.deep.equal(parsed[key]);
    expect(panelList(apply, 'numbers')).to.deep.equal(['number.vorlauf']);
  });

  // Every domain, every rule: the whole payload, derived by hand from the
  // rules, not from the code. It replaces 526ef5b's golden, which Rulings
  // 109, 110 and 112 break by design, and pins the key order with it: the
  // lists first, then energy and scene_map, then the meta sections.
  const EVERY_DOMAIN: VirtualEntity[] = [
    e({ entityId: 'sensor.temp', state: '21.5', attributes: { friendly_name: 'Wohnzimmer', unit_of_measurement: '°C', icon: 'mdi:thermometer', state_class: 'measurement' } }),
    e({ entityId: 'sensor.mode', state: 'heating', attributes: { friendly_name: 'Modus "Heizung"' } }),
    e({ entityId: 'binary_sensor.tuer', domain: 'binary_sensor', state: 'on', attributes: { friendly_name: 'Haustür', device_class: 'door', icon: 'mdi:door' } }),
    e({ entityId: 'binary_sensor.never', domain: 'binary_sensor', state: 'unavailable', available: false, lastChanged: 0, attributes: { friendly_name: 'Nie' } }),
    e({ entityId: 'switch.kaffee', domain: 'switch', state: 'off', attributes: { friendly_name: 'Kaffee', icon: 'img/kaffee.png' } }),
    e({ entityId: 'light.decke', domain: 'light', state: 'on', attributes: { friendly_name: 'Decke', brightness_pct: 60, icon: 'mdi:ceiling-light' } }),
    e({ entityId: 'scene.nacht', domain: 'scene', state: 'unknown', attributes: { friendly_name: 'Gute Nacht', icon: 'mdi:weather-night' } }),
    ...V02,
  ];
  const GOLDEN = String.raw`{"sensors":["sensor.mode","sensor.temp"],"binary_sensors":["binary_sensor.never","binary_sensor.tuer"],"lights":["light.decke"],"switches":["switch.kaffee"],"media_players":["media_player.kueche"],"climates":["climate.wohnzimmer"],"covers":["cover.rollladen"],"weathers":["weather.station"],"numbers":["number.vorlauf"],"selects":["select.betriebsart"],"datetimes":["datetime.weckzeit"],"energy":[],"scene_map":{"gute nacht":"scene.nacht"},"sensor_meta":[{"entity_id":"sensor.mode","name":"Modus 'Heizung'","unit":"","value":"heating","state_kind":"state"},{"entity_id":"sensor.temp","name":"Wohnzimmer","unit":"°C","value":"21.5","state_kind":"number","icon":"mdi:thermometer"}],"binary_sensor_meta":[{"entity_id":"binary_sensor.never","name":"Nie","device_class":"","state":"unavailable","available":false},{"entity_id":"binary_sensor.tuer","name":"Haustür","device_class":"door","state":"on","available":true,"last_changed":1757000000,"icon":"mdi:door"}],"light_meta":[{"entity_id":"light.decke","icon":"mdi:ceiling-light"}],"switch_meta":[],"scene_meta":[{"entity_id":"scene.nacht","icon":"mdi:weather-night"}],"media_player_meta":[{"entity_id":"media_player.kueche","name":"Küchenradio","icon":"mdi:radio"}],"climate_meta":[{"entity_id":"climate.wohnzimmer","name":"Klima Wohnzimmer","icon":"mdi:air-conditioner"}],"cover_meta":[{"entity_id":"cover.rollladen","name":"Rollladen"}],"weather_meta":[{"entity_id":"weather.station","name":"Wetterstation","icon":"mdi:weather-partly-cloudy"}],"editable_meta":[{"entity_id":"datetime.weckzeit","name":"Weckzeit"},{"entity_id":"number.vorlauf","name":"Vorlauf Soll"},{"entity_id":"select.betriebsart","name":"Betriebsart","icon":"mdi:tune"}]}`;

  it('builds, for every domain, exactly the golden payload (Rulings 106-112)', () => {
    expect(payload(EVERY_DOMAIN, { 'Gute Nacht': 'scene.nacht', Leer: '' })).to.equal(GOLDEN);
  });
});

describe('protocol/apply: what the panel can parse (Task 21 fix round 1)', () => {
  const payload = (entities: VirtualEntity[], sceneMap: Record<string, string> = {}): string => buildApplyPayload({ entities, sceneMap });
  const sensor = (id: string, name: string, over: Partial<VirtualEntity> = {}): VirtualEntity =>
    e({ entityId: `sensor.${id}`, state: '230', attributes: { friendly_name: name, unit_of_measurement: 'W', state_class: 'measurement' }, ...over });

  describe('Ruling 109: nothing the panel does not read', () => {
    it('sends light_meta, switch_meta and scene_meta as icon maps, leaving out an entity without an icon', () => {
      // Read for icons alone (ha_bridge_config.cpp:1388-1390): not in the
      // name sections (:657-661), and nothing reads their state.
      const parsed = JSON.parse(payload(ENTITIES));
      expect([parsed.light_meta, parsed.switch_meta, parsed.scene_meta]).to.deep.equal([[], [], []]);
      const lit = e({ entityId: 'light.flur', domain: 'light', state: 'on', attributes: { friendly_name: 'Flur', icon: 'mdi:ceiling-light' } });
      expect(JSON.parse(payload([...ENTITIES, lit])).light_meta).to.deep.equal([{ entity_id: 'light.flur', icon: 'mdi:ceiling-light' }]);
    });
  });

  describe('Ruling 110: an icon only when it is an MDI name', () => {
    // A name the panel cannot draw becomes a "?" glyph that replaces the
    // tile's own icon, and a cover's open/closed one (mdi_icons.cpp:7549,
    // cover/renderer.cpp:304-311).
    const NOT_MDI = ['img/blind.png', '/icons/lamp.svg', 'data:image/svg+xml;utf8,<svg x="1"/>', 'lamp', 'mdi-lamp', 'mdi:', 'mdi:lamp"x', 'mdi:lamp]', 'mdi:lamp.png', ' mdi:lamp'];
    const DOMAINS = ['sensor', 'binary_sensor', 'light', 'switch', 'scene', 'climate', 'cover', 'media_player', 'weather', 'number', 'select', 'datetime'] as const;
    const withIcon = (icon: string): VirtualEntity[] =>
      DOMAINS.map((domain) => e({ entityId: `${domain}.x`, domain, attributes: { friendly_name: 'X', icon } }));

    for (const icon of NOT_MDI) {
      it(`sends no ${JSON.stringify(icon)} icon, in any section or on bridge/icons`, () => {
        const apply = payload(withIcon(icon));
        expect(panelIconMap(apply, new Map())).to.deep.equal(new Map());
        expect(JSON.parse(apply), apply).to.satisfy((parsed: Record<string, unknown[]>) =>
          Object.values(parsed).every((section) => !Array.isArray(section) || section.every((entry) => typeof entry !== 'object' || !('icon' in (entry as object)))),
        );
        expect(Object.values(JSON.parse(buildIconsPayload(withIcon(icon))))).to.satisfy((icons: string[]) => icons.every((i) => i === ''));
      });
    }

    it('sends an MDI name in any case, which the panel lowercases (mdi_icons.cpp:7508-7521), in every section', () => {
      const apply = payload(withIcon('MDI:Lamp-Outline'));
      expect([...panelIconMap(apply, new Map()).entries()].sort()).to.deep.equal(DOMAINS.map((domain) => [`${domain}.x`, 'MDI:Lamp-Outline']).sort());
      expect(Object.values(JSON.parse(buildIconsPayload(withIcon('mdi:lamp'))))).to.deep.equal(DOMAINS.map(() => 'mdi:lamp'));
    });
  });

  describe('the zero-icons trap (Ruling 113 item 4)', () => {
    it('clears through bridge/icons the icons a panel still holds, although an apply with no icon keeps them', () => {
      // What an earlier apply left: "?" paths on two of this adapter's
      // entities, and an MDI icon that has since gone from its object.
      const held = new Map([
        ['sensor.temp', 'img/temp.png'],
        ['light.decke', 'mdi:ceiling-light'],
        ['switch.kaffee', 'img/kaffee.png'],
      ]);
      // The same entities now: no MDI icon among them, one a path still.
      const now = ENTITIES.map((entity) =>
        e({ ...entity, attributes: { friendly_name: entity.attributes.friendly_name, ...(entity.entityId === 'sensor.temp' ? { icon: 'img/temp.png' } : {}) } }),
      );
      // No icon in the apply: the panel keeps the map it had (:663-665) ...
      const afterApply = panelIconMap(payload(now), held);
      expect(afterApply).to.deep.equal(held);
      // ... and an empty map clears nothing: only a pair per entity does.
      expect(panelIconUpdate(new Map(afterApply), '{}')).to.equal(false);
      expect(panelIconUpdate(afterApply, buildIconsPayload(now))).to.equal(true);
      expect(afterApply).to.deep.equal(new Map());
    });
  });

  describe('Ruling 111: at most 128 numbers, selects and datetimes', () => {
    const editables = (domain: 'number' | 'select' | 'datetime', count: number): VirtualEntity[] =>
      Array.from({ length: count }, (_, i) => e({ entityId: `${domain}.v_${String(i).padStart(3, '0')}`, domain, attributes: { friendly_name: `V ${i}` } }));
    // 40 datetimes, then 50 numbers, then 40 selects by entity id: 130.
    const ALL = [...editables('select', 40), ...editables('number', 50), ...editables('datetime', 40)];

    it('lists the first 128 by entity id, and names those same 128 in editable_meta', () => {
      for (const order of [ALL, [...ALL].reverse()]) {
        const parsed = JSON.parse(payload(order));
        expect(parsed.datetimes).to.have.length(40);
        expect(parsed.numbers).to.have.length(50);
        expect(parsed.selects).to.deep.equal(editables('select', 38).map((entity) => entity.entityId));
        expect(parsed.editable_meta.map((m: { entity_id: string }) => m.entity_id)).to.deep.equal([...parsed.datetimes, ...parsed.numbers, ...parsed.selects]);
      }
    });

    it('lists all of them up to 128', () => {
      const parsed = JSON.parse(payload(ALL.slice(0, 128)));
      expect(parsed.datetimes.length + parsed.numbers.length + parsed.selects.length).to.equal(128);
    });

    it('names as left out exactly those the apply leaves out, in whatever order the registry holds them', () => {
      // main.ts warns with this, over the registry's own order.
      const { kept, left } = splitEditables(ALL);
      expect(left.map((entity) => entity.entityId)).to.deep.equal(['select.v_038', 'select.v_039']);
      expect(kept.map((entity) => entity.entityId)).to.deep.equal(JSON.parse(payload(ALL)).editable_meta.map((m: { entity_id: string }) => m.entity_id));
    });
  });

  describe('Ruling 112: free text the panel parses by hand', () => {
    it('"Leistung [W]" leaves every sensor its name, unit and value', () => {
      // parseSensorMetaSection ends the section at the first ']' (:1198).
      const apply = payload([sensor('a_leistung', 'Leistung [W]'), sensor('b_temp', 'Temperatur')]);
      const read = panelSensorMeta(apply);
      expect(Object.fromEntries(read.names)).to.deep.equal({ 'sensor.a_leistung': 'Leistung (W)', 'sensor.b_temp': 'Temperatur' });
      expect(Object.fromEntries(read.units)).to.deep.equal({ 'sensor.a_leistung': 'W', 'sensor.b_temp': 'W' });
      expect(Object.fromEntries(read.values)).to.deep.equal({ 'sensor.a_leistung': '230', 'sensor.b_temp': '230' });
    });

    it('a brace in a name, unit or value costs that sensor nothing', () => {
      // ... and each entry at the first '}' (:1205).
      const apply = payload([
        sensor('mode', 'Mode {eco}', { state: '{1} Auto', attributes: { friendly_name: 'Mode {eco}', unit_of_measurement: '[x]' } }),
        sensor('z', 'Z'),
      ]);
      const read = panelSensorMeta(apply);
      expect(read.names.get('sensor.mode')).to.equal('Mode (eco)');
      expect(read.values.get('sensor.mode')).to.equal('(1) Auto');
      expect(read.units.get('sensor.mode')).to.equal('(x)');
      expect(read.names.get('sensor.z')).to.equal('Z');
    });

    it('a quote shows as an apostrophe, where it cut the name short', () => {
      // extractStringField ends a value at the first '"', escaped or not (:1073-1077).
      const apply = payload([
        sensor('mode', 'Modus "Heizung"'),
        e({ entityId: 'climate.bad', domain: 'climate', attributes: { friendly_name: 'Bad "oben"' } }),
        e({ entityId: 'number.soll', domain: 'number', attributes: { friendly_name: '"Soll"' } }),
      ]);
      const names = panelNameIndex(apply);
      expect(names.get('sensor.mode')).to.equal("Modus 'Heizung'");
      expect(names.get('climate.bad')).to.equal("Bad 'oben'");
      expect(names.get('number.soll')).to.equal("'Soll'");
    });

    it('a line break in one name cannot rename another entity', () => {
      // Each map is a blob of "id=text" lines; the first line of an id wins (:1627-1660).
      const apply = payload([
        sensor('q', 'Zeile\nsensor.temp=Fake'),
        sensor('temp', 'Temperatur'),
        e({ entityId: 'cover.a', domain: 'cover', attributes: { friendly_name: 'A\r\nsensor.z=Fake\t\u0000' } }),
        sensor('z', 'Z'),
      ]);
      const names = panelNameIndex(apply);
      expect(names.get('sensor.temp')).to.equal('Temperatur');
      expect(names.get('sensor.q')).to.equal('Zeile sensor.temp=Fake');
      expect(names.get('sensor.z')).to.equal('Z');
      expect(names.get('cover.a')).to.equal('A  sensor.z=Fake');
    });

    it('a bracket in a binary sensor name leaves every binary sensor read', () => {
      // parseBinarySensorMetaSection ends the section at the first ']' (:1246).
      const binary = (id: string, name: string): VirtualEntity =>
        e({ entityId: `binary_sensor.${id}`, domain: 'binary_sensor', state: 'on', attributes: { friendly_name: name, device_class: 'window' } });
      const apply = payload([binary('a', 'Fenster [links]'), binary('b', 'Fenster rechts')]);
      expect([...panelBinaryMeta(apply).keys()]).to.deep.equal(['binary_sensor.a', 'binary_sensor.b']);
      expect(panelBinaryMeta(apply).get('binary_sensor.b')).to.include({ state: 'on', available: true, device_class: 'window' });
      expect(panelNameIndex(apply).get('binary_sensor.a')).to.equal('Fenster (links)');
    });

    it('never rewrites an entity id or a scene alias', () => {
      // Ids must match the state topics and commands; a changed alias makes
      // the panel clear its scene slots and save that to flash (:693-699).
      const odd = e({ entityId: 'sensor.raum_{1}', attributes: { friendly_name: 'Raum {1}' } });
      const parsed = JSON.parse(payload([odd], { '[Kino] "laut"': 'scene.kino' }));
      expect(parsed.sensors).to.deep.equal(['sensor.raum_{1}']);
      expect(parsed.sensor_meta[0]).to.include({ entity_id: 'sensor.raum_{1}', name: 'Raum (1)' });
      expect(parsed.scene_map).to.deep.equal({ '[kino] "laut"': 'scene.kino' });
    });
  });
});

describe('protocol/apply: an apply with every list empty (Ruling 116)', () => {
  /** The entity lists of a payload: every array but the *_meta sections. */
  const lists = (payload: string): unknown[][] =>
    Object.entries(JSON.parse(payload) as Record<string, unknown>)
      .filter(([key, value]) => Array.isArray(value) && !key.endsWith('_meta'))
      .map(([, value]) => value as unknown[]);

  it('says, for every domain, whether its entity lands in one of the lists the panel prunes its slots against', () => {
    // Such an apply makes the panel prune and save (ha_bridge_config.cpp:685-691, :701-703).
    for (const domain of DOMAINS) {
      const entity = e({ entityId: `${domain}.x`, domain });
      const listed = lists(buildApplyPayload({ entities: [entity], sceneMap: {} })).some((list) => list.length > 0);
      expect(listsAnyEntity([entity]), domain).to.equal(listed);
    }
    expect(listsAnyEntity([e({ entityId: 'scene.nacht', domain: 'scene' })])).to.equal(false);
    expect(listsAnyEntity([])).to.equal(false);
    expect(listsAnyEntity(ENTITIES)).to.equal(true);
  });
});

describe('protocol/apply: the energy catalog (Task 20b)', () => {
  const CATALOG: EnergyCatalogEntry[] = [
    { id: 'energy.netzbezug', name: 'Netzbezug', unit: 'kWh', category: 'grid' },
    { id: 'energy.netzbezug_cost', name: 'Netzbezug (EUR)', unit: 'EUR', category: 'grid' },
    { id: 'energy.pv', name: 'PV Dach', category: 'solar' },
    { id: 'grid_total', name: 'Netz gesamt', unit: 'kWh', category: 'grid' },
  ];
  const payload = (energy: EnergyCatalogEntry[], entities: VirtualEntity[] = ENTITIES, sceneMap: Record<string, string> = {}): string =>
    buildApplyPayload({ entities, sceneMap, energy });

  it('lists each entry with exactly the id, name, unit and category the panel reads (ha_bridge_config.cpp:1108-1184)', () => {
    const parsed = JSON.parse(payload(CATALOG));
    expect(parsed.energy).to.deep.equal(CATALOG);
    const panel = panelEnergyCatalog(payload(CATALOG))!;
    expect(panel.ids).to.deep.equal(CATALOG.map((entry) => entry.id));
    expect(Object.fromEntries(panel.names)).to.deep.equal(Object.fromEntries(CATALOG.map((entry) => [entry.id, entry.name])));
    expect(Object.fromEntries(panel.units)).to.deep.equal({ 'energy.netzbezug': 'kWh', 'energy.netzbezug_cost': 'EUR', grid_total: 'kWh' });
    // The icon a tile draws comes from here (energyIconForCategory): a cost id is the currency.
    expect(Object.fromEntries(panel.icons)).to.deep.equal({
      'energy.netzbezug': 'transmission-tower',
      'energy.netzbezug_cost': 'currency-eur',
      'energy.pv': 'solar-power',
      grid_total: 'transmission-tower',
    });
  });

  it('keeps sending an empty catalog without meters, and the golden payload of every domain', () => {
    expect(JSON.parse(payload([])).energy).to.deep.equal([]);
    expect(JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: {} })).energy).to.deep.equal([]);
  });

  it('sits after the entity lists and before the first free text, so no name, unit or alias spelled "energy" shadows it', () => {
    const decoys = [
      e({ entityId: 'sensor.decoy_a', state: 'energy', attributes: { friendly_name: 'energy', unit_of_measurement: 'energy' } }),
      e({ entityId: 'binary_sensor.decoy_b', domain: 'binary_sensor', state: 'on', attributes: { friendly_name: 'energy' } }),
    ];
    const apply = payload(CATALOG, [...ENTITIES, ...decoys], { energy: 'scene.nacht', 'x"energy': 'scene.nacht' });
    expect(panelEnergyCatalog(apply)!.ids).to.deep.equal(CATALOG.map((entry) => entry.id));
    const keys = Object.keys(JSON.parse(apply));
    expect(keys.indexOf('energy')).to.equal(keys.indexOf('datetimes') + 1);
    expect(keys.indexOf('energy')).to.be.lessThan(keys.indexOf('scene_map'));
  });

  it('never lets a text equal to a key spell it: quoted, it would be found before the section, or in place of a field', () => {
    // A catalog name "sensor_meta" is the text "sensor_meta" with its quotes,
    // before sensor_meta itself; "cameras" would make the panel read a list
    // it is never sent; "category" would be read as the category's own key.
    const shadowing: EnergyCatalogEntry[] = [
      { id: 'energy.a', name: 'sensor_meta', unit: 'scene_map', category: 'solar' },
      { id: 'energy.b', name: 'cameras', unit: 'category', category: 'gas' },
      { id: 'energy.c', name: 'binary_sensor_meta', unit: 'unit', category: 'water' },
    ];
    const apply = payload(shadowing, ENTITIES, { 'gute nacht': 'scene.nacht' });
    expect(panelSensorMeta(apply).names.get('sensor.temp')).to.equal('Wohnzimmer');
    expect(panelList(apply, 'cameras')).to.equal(undefined);
    expect(panelBinaryMeta(apply).get('binary_sensor.tuer')).to.include({ state: 'on' });
    const panel = panelEnergyCatalog(apply)!;
    // Each still reads as it was named: the parser trims (ha_bridge_config.cpp:1079).
    expect(Object.fromEntries(panel.names)).to.deep.equal({ 'energy.a': 'sensor_meta', 'energy.b': 'cameras', 'energy.c': 'binary_sensor_meta' });
    expect(Object.fromEntries(panel.units)).to.deep.equal({ 'energy.a': 'scene_map', 'energy.b': 'category', 'energy.c': 'unit' });
    expect(Object.fromEntries(panel.icons)).to.deep.equal({ 'energy.a': 'solar-power', 'energy.b': 'fire', 'energy.c': 'water' });
    // The same holds in every other section (Ruling 112): a sensor named after a field.
    const odd = e({ entityId: 'sensor.odd', state: '230', attributes: { friendly_name: 'value', unit_of_measurement: 'W', state_class: 'measurement' } });
    const read = panelSensorMeta(buildApplyPayload({ entities: [odd], sceneMap: {} }));
    expect([read.names.get('sensor.odd'), read.units.get('sensor.odd'), read.values.get('sensor.odd')]).to.deep.equal(['value', 'W', '230']);
  });

  it('makes free text safe for the hand-rolled parser (Ruling 112): a bracket, brace, quote or line break costs no entry', () => {
    const odd: EnergyCatalogEntry[] = [
      { id: 'energy.a', name: 'Wärmepumpe [innen] {Heizen}', unit: 'k"Wh"', category: 'device' },
      { id: 'energy.b', name: 'Zeile\nsensor.temp=Fake', unit: 'kWh\u0000', category: 'device' },
      { id: 'energy.c', name: 'Letzter', unit: 'm³', category: 'water' },
    ];
    const panel = panelEnergyCatalog(payload(odd))!;
    expect(panel.ids).to.deep.equal(['energy.a', 'energy.b', 'energy.c']);
    expect(panel.names.get('energy.a')).to.equal('Wärmepumpe (innen) (Heizen)');
    expect(panel.units.get('energy.a')).to.equal("k'Wh'");
    expect(panel.names.get('energy.b')).to.equal('Zeile sensor.temp=Fake');
    expect(panel.units.get('energy.b')).to.equal('kWh');
    expect(panel.names.get('energy.c')).to.equal('Letzter');
    expect(panel.units.get('energy.c')).to.equal('m³');
  });

  it('never rewrites an id: it is what a tile binds to (energy_data.cpp:186)', () => {
    const parsed = JSON.parse(payload([{ id: 'energy.raum_1', name: 'Raum [1]', category: 'device' }]));
    expect(parsed.energy[0]).to.deep.equal({ id: 'energy.raum_1', name: 'Raum (1)', category: 'device' });
  });
});
