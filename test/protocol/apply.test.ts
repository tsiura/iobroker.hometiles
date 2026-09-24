import { expect } from 'chai';
import { buildApplyPayload, buildIconsPayload, configSignature } from '../../src/protocol/apply';
import type { VirtualEntity } from '../../src/registry/types';
import { panelIcons, panelList, panelNames } from './panel-scan';

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

  it('builds sensor_meta with the exact keys the firmware parser reads', () => {
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: {} }));
    expect(parsed.sensor_meta[0]).to.deep.equal({
      entity_id: 'sensor.temp',
      name: 'Wohnzimmer',
      unit: '°C',
      state: '21.5',
      value: '21.5',
      state_kind: 'number',
      number: true,
      icon: 'mdi:thermometer',
    });
  });

  it('marks a textual sensor with state_kind state and number false', () => {
    const text = e({ entityId: 'sensor.mode', state: 'heating', attributes: { friendly_name: 'Modus' } });
    const parsed = JSON.parse(buildApplyPayload({ entities: [text], sceneMap: {} }));
    expect(parsed.sensor_meta[0].state_kind).to.equal('state');
    expect(parsed.sensor_meta[0].number).to.equal(false);
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
    expect(parsed.sensor_meta[0].number).to.equal(true);
  });

  it('does not read a numeric-looking transient string as state_kind number without a declared measurement type', () => {
    // isNumericState(entity.state) used to accept anything Number() parsed,
    // including "0x10". state_kind must come from the declared type only.
    const notDeclared = e({ entityId: 'sensor.raw', state: '0x10', attributes: { friendly_name: 'Raw' } });
    const parsed = JSON.parse(buildApplyPayload({ entities: [notDeclared], sceneMap: {} }));
    expect(parsed.sensor_meta[0].state_kind).to.equal('state');
    expect(parsed.sensor_meta[0].number).to.equal(false);
  });

  it('builds binary_sensor_meta with availability and the localisable state labels', () => {
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: {} }));
    const meta = parsed.binary_sensor_meta[0];
    expect(meta.entity_id).to.equal('binary_sensor.tuer');
    expect(meta.device_class).to.equal('door');
    expect(meta.state).to.equal('on');
    expect(meta.available).to.equal(true);
    expect(meta.last_changed).to.equal(1_757_000_000);
    expect(meta.icon).to.equal('mdi:door');
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

  it('builds an icons-only payload keyed by entity id', () => {
    const parsed = JSON.parse(buildIconsPayload(ENTITIES));
    expect(parsed.icons).to.deep.equal({
      'sensor.temp': 'mdi:thermometer',
      'binary_sensor.tuer': 'mdi:door',
    });
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

  // buildApplyPayload at 526ef5b for V01 and V01_SCENES, byte for byte.
  const GOLDEN_526EF5B = String.raw`{"sensors":["sensor.mode","sensor.temp"],"binary_sensors":["binary_sensor.never","binary_sensor.tuer"],"lights":["light.decke"],"switches":["switch.kaffee"],"media_players":[],"climates":[],"covers":[],"cameras":[],"weathers":[],"energy":[],"scene_map":{"gute nacht":"scene.nacht"},"sensor_meta":[{"entity_id":"sensor.mode","name":"Modus \"Heizung\"","unit":"","state":"heating","value":"heating","state_kind":"state","number":false},{"entity_id":"sensor.temp","name":"Wohnzimmer","unit":"°C","state":"21.5","value":"21.5","state_kind":"number","number":true,"icon":"mdi:thermometer"}],"binary_sensor_meta":[{"entity_id":"binary_sensor.never","name":"Nie","device_class":"","state":"unavailable","on":"on","off":"off","unknown":"unknown","unavailable":"unavailable","available":false},{"entity_id":"binary_sensor.tuer","name":"Haustür","device_class":"door","state":"on","on":"on","off":"off","unknown":"unknown","unavailable":"unavailable","available":true,"last_changed":1757000000,"icon":"mdi:door"}],"light_meta":[{"entity_id":"light.decke","name":"Decke","state":"on","available":true,"icon":"mdi:ceiling-light"}],"switch_meta":[{"entity_id":"switch.kaffee","name":"Kaffee","state":"off","available":true}],"scene_meta":[{"entity_id":"scene.nacht","name":"Gute Nacht","state":"unknown","available":true}]}`;
  const V01: VirtualEntity[] = [
    e({ entityId: 'sensor.temp', state: '21.5', attributes: { friendly_name: 'Wohnzimmer', unit_of_measurement: '°C', icon: 'mdi:thermometer', state_class: 'measurement' } }),
    e({ entityId: 'sensor.mode', state: 'heating', attributes: { friendly_name: 'Modus "Heizung"' } }),
    e({ entityId: 'binary_sensor.tuer', domain: 'binary_sensor', state: 'on', attributes: { friendly_name: 'Haustür', device_class: 'door', icon: 'mdi:door' } }),
    e({ entityId: 'binary_sensor.never', domain: 'binary_sensor', state: 'unavailable', available: false, lastChanged: 0, attributes: { friendly_name: 'Nie' } }),
    e({ entityId: 'switch.kaffee', domain: 'switch', state: 'off', attributes: { friendly_name: 'Kaffee' } }),
    e({ entityId: 'light.decke', domain: 'light', state: 'on', attributes: { friendly_name: 'Decke', brightness_pct: 60, icon: 'mdi:ceiling-light' } }),
    e({ entityId: 'scene.nacht', domain: 'scene', state: 'unknown', attributes: { friendly_name: 'Gute Nacht' } }),
  ];
  const V01_SCENES = { 'Gute Nacht': 'scene.nacht', Leer: '' };

  it('leaves every v0.1 section byte-identical to 526ef5b', () => {
    // The only differences: cameras is gone (Ruling 107), the three editable
    // lists follow weathers, and the five new meta sections close the payload.
    const expected = GOLDEN_526EF5B.replace('"cameras":[],', '')
      .replace('"weathers":[],', '"weathers":[],"numbers":[],"selects":[],"datetimes":[],')
      .replace(/}$/, ',"media_player_meta":[],"climate_meta":[],"cover_meta":[],"weather_meta":[],"editable_meta":[]}');
    expect(payload(V01, V01_SCENES)).to.equal(expected);
  });
});
