import { expect } from 'chai';
import { AnnounceError, normaliseLocalIo, parseAnnouncement } from '../../src/protocol/announce';

const FULL = JSON.stringify({
  device_id: 'a1b2c3',
  base_topic: 'hometiles',
  ha_prefix: 'ha/statestream',
  device_name: 'Waveshare 8',
  manufacturer: 'HomeTiles',
  model: 'waveshare_touch_lcd_8',
  sensors: ['sensor.wohnzimmer_temperatur'],
  binary_sensors: ['binary_sensor.haustuer'],
  scene_map: { 'gute nacht': 'scene.gute_nacht' },
  local_io: [
    { id: 'relay_1', entity_id: 'switch.ws8_relay_1', legacy_entity_ids: ['switch.relay_1'], name: 'Relay 1', type: 'relay' },
    { id: 'temp_1', entity_id: 'sensor.ws8_temp_1', name: 'Aussen', type: 'temperature' },
  ],
});

describe('protocol/announce', () => {
  it('parses a full announcement', () => {
    const a = parseAnnouncement('a1b2c3', FULL);
    expect(a.deviceId).to.equal('a1b2c3');
    expect(a.baseTopic).to.equal('hometiles');
    expect(a.haPrefix).to.equal('ha/statestream');
    expect(a.model).to.equal('waveshare_touch_lcd_8');
    expect(a.sensors).to.deep.equal(['sensor.wohnzimmer_temperatur']);
    expect(a.sceneMap).to.deep.equal({ 'gute nacht': 'scene.gute_nacht' });
    expect(a.localIo).to.have.length(2);
    expect(a.localIo[0]!).to.deep.equal({
      id: 'relay_1',
      entityId: 'switch.ws8_relay_1',
      legacyEntityIds: ['switch.relay_1'],
      name: 'Relay 1',
      type: 'relay',
    });
    expect(a.localIo[1]!.legacyEntityIds).to.deep.equal([]);
  });

  it('prefers the topic device id over a mismatching payload field', () => {
    const a = parseAnnouncement('fromtopic', FULL);
    expect(a.deviceId).to.equal('fromtopic');
  });

  it('applies defaults when base topic or prefix are missing', () => {
    const a = parseAnnouncement('a1', JSON.stringify({ device_id: 'a1' }));
    expect(a.baseTopic).to.equal('hometiles');
    expect(a.haPrefix).to.equal('ha/statestream');
    expect(a.sensors).to.deep.equal([]);
    expect(a.localIo).to.deep.equal([]);
  });

  it('rejects a payload that is not a JSON object', () => {
    expect(() => parseAnnouncement('a1', '[]')).to.throw(AnnounceError);
    expect(() => parseAnnouncement('a1', 'not json')).to.throw(AnnounceError);
  });

  it('treats an empty local_io list as the intentional removal signal', () => {
    expect(normaliseLocalIo([])).to.deep.equal([]);
    expect(normaliseLocalIo(undefined)).to.deep.equal([]);
  });

  it('rejects a malformed local_io list atomically rather than partially applying it', () => {
    const raw = [
      { id: 'ok_1', entity_id: 'switch.a', name: 'A', type: 'relay' },
      { id: '', entity_id: 'switch.b', name: 'B', type: 'relay' },
    ];
    expect(() => normaliseLocalIo(raw)).to.throw(/invalid_local_io_item_1/);
  });

  it('rejects duplicate channel ids', () => {
    const raw = [
      { id: 'dup', entity_id: 'switch.a', name: 'A', type: 'relay' },
      { id: 'dup', entity_id: 'switch.b', name: 'B', type: 'relay' },
    ];
    expect(() => normaliseLocalIo(raw)).to.throw(/duplicate_local_io_id_dup/);
  });

  it('accepts the firmware type aliases', () => {
    const r1 = normaliseLocalIo([{ id: 'a', entity_id: 'switch.a', name: 'A', type: 'switch' }]);
    expect(r1[0]!.type).to.equal('relay');
    const r2 = normaliseLocalIo([{ id: 'b', entity_id: 'sensor.b', name: 'B', type: 'temp' }]);
    expect(r2[0]!.type).to.equal('temperature');
  });

  it('refuses more channels than the firmware can announce', () => {
    const raw = Array.from({ length: 65 }, (_, i) => ({ id: `c${i}`, entity_id: `switch.c${i}`, name: 'C', type: 'relay' }));
    expect(() => normaliseLocalIo(raw)).to.throw(/too_many_local_io_channels/);
  });

  it('accepts exactly the maximum number of channels', () => {
    const raw = Array.from({ length: 64 }, (_, i) => ({ id: `c${i}`, entity_id: `switch.c${i}`, name: 'C', type: 'relay' }));
    expect(normaliseLocalIo(raw)).to.have.length(64);
  });

  it('bounds the sensor and binary sensor lists', () => {
    const many = Array.from({ length: 513 }, (_, i) => `sensor.s${i}`);
    expect(() => parseAnnouncement('a1', JSON.stringify({ sensors: many }))).to.throw(/too_many_sensors/);
    expect(() => parseAnnouncement('a1', JSON.stringify({ binary_sensors: many }))).to.throw(
      /too_many_binary_sensors/,
    );
  });

  it('bounds the scene alias map', () => {
    const aliases: Record<string, string> = {};
    for (let i = 0; i < 257; i++) aliases[`alias ${i}`] = `scene.s${i}`;
    expect(() => parseAnnouncement('a1', JSON.stringify({ scene_map: aliases }))).to.throw(
      /too_many_scene_aliases/,
    );
  });

  it('bounds legacy entity ids per channel', () => {
    const raw = [
      {
        id: 'relay_1',
        entity_id: 'switch.a',
        name: 'A',
        type: 'relay',
        legacy_entity_ids: Array.from({ length: 9 }, (_, i) => `switch.old${i}`),
      },
    ];
    expect(() => normaliseLocalIo(raw)).to.throw(/too_many_legacy_entity_ids_relay_1/);
  });

  it('drops a malformed legacy entity id instead of failing the announcement', () => {
    const raw = [
      {
        id: 'relay_1',
        entity_id: 'switch.a',
        name: 'A',
        type: 'relay',
        legacy_entity_ids: ['switch.old_one', 'not an entity id', 'light.wrong_domain', 'SWITCH.OLD_TWO'],
      },
    ];
    // A legacy alias is a migration aid, not load-bearing state: a bad one is
    // dropped, and a differently-cased valid one is normalised and kept.
    expect(normaliseLocalIo(raw)[0]!.legacyEntityIds).to.deep.equal(['switch.old_one', 'switch.old_two']);
  });

  describe('the battery_soc capability (Task 25b)', () => {
    it('reads an explicit boolean capability as itself', () => {
      const withCap = (value: unknown): boolean =>
        parseAnnouncement('a1', JSON.stringify({ model: 'JC8012P4A1', capabilities: { battery_soc: value } })).batterySoc;
      expect(withCap(true)).to.equal(true);
      expect(withCap(false)).to.equal(false);
    });

    it('falls back to the model when there is no capabilities object or key', () => {
      expect(parseAnnouncement('a1', JSON.stringify({ model: 'Tab5' })).batterySoc).to.equal(true);
      expect(parseAnnouncement('a1', JSON.stringify({}))).to.include({ batterySoc: true });
      expect(parseAnnouncement('a1', JSON.stringify({ model: 'JC8012P4A1' })).batterySoc).to.equal(false);
    });

    it('treats a non-boolean value as false rather than falling back to the model', () => {
      // A truthy string is still not === true: an older Tab5 without this
      // field would otherwise be indistinguishable from a panel that sent one.
      expect(parseAnnouncement('a1', JSON.stringify({ model: 'Tab5', capabilities: { battery_soc: 'true' } })).batterySoc).to.equal(false);
    });

    it('falls back to the model when capabilities is not a plain object', () => {
      expect(parseAnnouncement('a1', JSON.stringify({ model: 'Tab5', capabilities: 'nope' })).batterySoc).to.equal(true);
      expect(parseAnnouncement('a1', JSON.stringify({ model: 'JC8012P4A1', capabilities: ['battery_soc'] })).batterySoc).to.equal(false);
    });
  });
});
