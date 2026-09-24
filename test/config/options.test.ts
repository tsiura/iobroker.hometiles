import { expect } from 'chai';
import { DEFAULTS, normaliseTopic, PICKER_VERSION, validateOptions, type AdapterOptions } from '../../src/config/options';

describe('config/options', () => {
  it('strips leading and trailing slashes and collapses doubles', () => {
    expect(normaliseTopic('/hometiles//panel/', 'hometiles')).to.equal('hometiles/panel');
  });

  it('falls back when the value is empty or whitespace', () => {
    expect(normaliseTopic('   ', 'ha/statestream')).to.equal('ha/statestream');
  });

  it('rejects MQTT wildcards in a topic', () => {
    const { errors } = validateOptions({ ...DEFAULTS, baseTopic: 'home/+/tiles' });
    expect(errors).to.include('baseTopic must not contain MQTT wildcards');
  });

  it('clamps the coalesce window into 0..5000 ms', () => {
    expect(validateOptions({ ...DEFAULTS, coalesceMs: 99999 }).options.coalesceMs).to.equal(5000);
    expect(validateOptions({ ...DEFAULTS, coalesceMs: -5 }).options.coalesceMs).to.equal(0);
  });

  it('rejects an out-of-range broker port', () => {
    const { errors } = validateOptions({ ...DEFAULTS, brokerPort: 70000 });
    expect(errors).to.include('brokerPort must be between 1 and 65535');
  });

  it('applies every default for an empty input', () => {
    expect(validateOptions({}).options).to.deep.equal(DEFAULTS);
  });

  it('falls back to the default, with a warning, for an option of the wrong type (Ruling 58 A)', () => {
    // Only a hand-edited instance config can do it, but .trim() on a number
    // threw in onReady on every restart: a crash loop.
    const raw = {
      brokerHost: 5,
      clientId: {},
      baseTopic: 7,
      haPrefix: ['ha'],
      brokerUser: 1,
      brokerPassword: true,
      deviceOverrides: 'none',
      manualEntities: { stateId: '0_userdata.0.a', domain: 'sensor' },
    } as unknown as Partial<AdapterOptions>;
    const { options, warnings } = validateOptions(raw);
    expect(options).to.deep.equal(DEFAULTS);
    const keys = ['brokerHost', 'clientId', 'baseTopic', 'haPrefix', 'brokerUser', 'brokerPassword', 'deviceOverrides', 'manualEntities'];
    for (const key of keys) {
      expect(warnings.some((warning) => warning.startsWith(`${key} `)), `${key}: ${warnings.join(' | ')}`).to.equal(true);
    }
  });

  it('keeps only well-formed device overrides, with a warning for the rest (Ruling 58 A)', () => {
    // applyOverrides trims a name: one that is no text failed every discovery.
    const raw = {
      deviceOverrides: [
        { objectId: 'hue.0.a', include: false },
        null,
        { objectId: 5, include: true },
        { objectId: 'hue.0.b', include: true, name: 3 },
      ],
    } as unknown as Partial<AdapterOptions>;
    const { options, warnings } = validateOptions(raw);
    expect(options.deviceOverrides).to.deep.equal([
      { objectId: 'hue.0.a', include: false },
      { objectId: 'hue.0.b', include: true },
    ]);
    expect(warnings).to.have.length(3);
  });

  it("keeps a picker row whole, what detection found included, so a saved table refreshes as it was shown (Task 21b)", () => {
    const row = { objectId: 'hue.0.a', include: true, name: '', forcedDomain: '', detectedName: 'Decke', detectedDomain: 'light', room: 'Wohnzimmer' };
    const { options, warnings } = validateOptions({ deviceOverrides: [row] });
    expect(options.deviceOverrides).to.deep.equal([row]);
    expect(warnings).to.deep.equal([]);
  });

  it('drops a detected name, domain or room that is not text, with a warning, and keeps the row (Ruling 119, M5)', () => {
    // A hand edit: the refresh called .endsWith on such a name and failed every time.
    const raw = {
      deviceOverrides: [{ objectId: 'x.0.n', include: true, name: 'N', detectedName: 5, detectedDomain: { a: 1 }, room: ['Flur'] }],
    } as unknown as Partial<AdapterOptions>;
    const { options, warnings } = validateOptions(raw);
    expect(options.deviceOverrides).to.deep.equal([{ objectId: 'x.0.n', include: true, name: 'N' }]);
    expect(warnings).to.deep.equal([
      'deviceOverrides entry 1 (x.0.n) has a detectedName that is not text; ignoring it',
      'deviceOverrides entry 1 (x.0.n) has a detectedDomain that is not text; ignoring it',
      'deviceOverrides entry 1 (x.0.n) has a room that is not text; ignoring it',
    ]);
  });

  it("arms opt-in publishing only when this picker set its marker: exactly its version, not 4cbb6d3's true (Rulings 118, 120)", () => {
    expect(PICKER_VERSION).to.equal(2);
    const raw = { pickerArmed: PICKER_VERSION } as unknown as Partial<AdapterOptions>;
    expect(validateOptions(raw).options.pickerArmed).to.equal(true);
    for (const pickerArmed of [undefined, null, false, true, 'true', 1, '2', 3, {}]) {
      const { options } = validateOptions({ pickerArmed } as unknown as Partial<AdapterOptions>);
      expect(options.pickerArmed, String(pickerArmed)).to.equal(false);
    }
  });

  it("keeps the history instance the admin picked, '' for none, and drops one that names no instance, with a warning (Task 19)", () => {
    expect(DEFAULTS.historyInstance).to.equal('');
    for (const historyInstance of ['history.0', 'sql.1', 'influxdb.0', 'my-history_2.10']) {
      const { options, warnings } = validateOptions({ historyInstance });
      expect(options.historyInstance).to.equal(historyInstance);
      expect(warnings).to.deep.equal([]);
    }
    // No select leaves spaces around it; a hand edit can.
    expect(validateOptions({ historyInstance: ' sql.0 ' }).options.historyInstance).to.equal('sql.0');
    for (const historyInstance of ['', null, undefined]) {
      const { options, warnings } = validateOptions({ historyInstance } as unknown as Partial<AdapterOptions>);
      expect(options.historyInstance, String(historyInstance)).to.equal('');
      expect(warnings, String(historyInstance)).to.deep.equal([]);
    }
    for (const historyInstance of ['history', 'system.adapter.history.0', 'History.0', 'sql.0; x', 5, {}, true]) {
      const { options, warnings } = validateOptions({ historyInstance } as unknown as Partial<AdapterOptions>);
      expect(options.historyInstance, String(historyInstance)).to.equal('');
      expect(warnings, String(historyInstance)).to.deep.equal([
        "historyInstance names no instance like history.0; using the system's default history instance",
      ]);
    }
  });

  it('keeps only well-formed manual entities, with a warning naming each one dropped (Task 13b)', () => {
    // The shape only: whether the domain suits the state is manualDevices'
    // to judge, against the object itself.
    const raw = {
      manualEntities: [
        { stateId: '0_userdata.0.Heizung.Solltemperatur', domain: 'number', name: 'Soll' },
        null,
        'sensor',
        { domain: 'sensor' },
        { stateId: '   ', domain: 'sensor' },
        { stateId: 5, domain: 'sensor' },
        { stateId: ' 0_userdata.0.Haus.Notiz', domain: 7 },
        { stateId: '0_userdata.0.Wecker.Aktiv', domain: 'switch', name: 3 },
        { stateId: '0_userdata.0.Haus.Anwesend', domain: 'binary_sensor', name: null, extra: true },
        { stateId: '0_userdata.0.Haus.Licht', domain: 'light' },
        // No picker leaves spaces around an id; a hand edit can (m5).
        { stateId: '  0_userdata.0.Haus.Relais \t', domain: 'switch' },
      ],
    } as unknown as Partial<AdapterOptions>;
    const { options, warnings } = validateOptions(raw);
    expect(options.manualEntities).to.deep.equal([
      { stateId: '0_userdata.0.Heizung.Solltemperatur', domain: 'number', name: 'Soll' },
      { stateId: '0_userdata.0.Wecker.Aktiv', domain: 'switch' },
      { stateId: '0_userdata.0.Haus.Anwesend', domain: 'binary_sensor' },
      { stateId: '0_userdata.0.Haus.Licht', domain: 'light' },
      { stateId: '0_userdata.0.Haus.Relais', domain: 'switch' },
    ]);
    expect(warnings).to.deep.equal([
      'manualEntities entry 2 names no state id; ignoring it',
      'manualEntities entry 3 names no state id; ignoring it',
      'manualEntities entry 4 names no state id; ignoring it',
      'manualEntities entry 5 names no state id; ignoring it',
      'manualEntities entry 6 names no state id; ignoring it',
      'manualEntities entry 7 (0_userdata.0.Haus.Notiz) names no domain; ignoring it',
      'manualEntities entry 8 (0_userdata.0.Wecker.Aktiv) has a name that is not text; ignoring the name',
    ]);
  });

  it("keeps a datetime entry's kind when it is date, time or datetime, and drops any other with a warning, never the entry (Ruling 92)", () => {
    const raw = {
      manualEntities: [
        { stateId: '0_userdata.0.Wecker.Alarm', domain: 'datetime', kind: 'time' },
        { stateId: '0_userdata.0.Wecker.Tag', domain: 'datetime', kind: 'day' },
        { stateId: '0_userdata.0.Wecker.Termin', domain: 'datetime', kind: 3 },
        // An admin select's empty choice, or a cleared hand edit: no kind.
        { stateId: '0_userdata.0.Wecker.Zuletzt', domain: 'datetime', kind: '' },
        { stateId: '0_userdata.0.Wecker.Naechster', domain: 'datetime', kind: null },
      ],
    } as unknown as Partial<AdapterOptions>;
    const { options, warnings } = validateOptions(raw);
    expect(options.manualEntities).to.deep.equal([
      { stateId: '0_userdata.0.Wecker.Alarm', domain: 'datetime', kind: 'time' },
      { stateId: '0_userdata.0.Wecker.Tag', domain: 'datetime' },
      { stateId: '0_userdata.0.Wecker.Termin', domain: 'datetime' },
      { stateId: '0_userdata.0.Wecker.Zuletzt', domain: 'datetime' },
      { stateId: '0_userdata.0.Wecker.Naechster', domain: 'datetime' },
    ]);
    expect(warnings).to.deep.equal([
      'manualEntities entry 2 (0_userdata.0.Wecker.Tag) has a kind that is not date, time or datetime; ignoring the kind',
      'manualEntities entry 3 (0_userdata.0.Wecker.Termin) has a kind that is not date, time or datetime; ignoring the kind',
    ]);
  });
});
