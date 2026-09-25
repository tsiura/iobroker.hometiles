import { expect } from 'chai';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  declaresEncryptedPassword,
  DEFAULTS,
  normaliseTopic,
  outdatedAdmins,
  PICKER_VERSION,
  storedInPlainText,
  storedPassword,
  validateOptions,
  type AdapterOptions,
} from '../../src/config/options';

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

  describe('energy meters (Task 20b)', () => {
    it('keeps each well-formed meter, trimmed, and drops the rest with a warning naming each one', () => {
      // The shape only: whether the state is a counter is energyMeters' to
      // judge, against the object itself.
      const raw = {
        energyMeters: [
          { stateId: 'shelly.0.em.total', category: 'grid', sign: 1, name: ' Netzbezug ', price: 0.32 },
          // No picker leaves spaces around an id; a hand edit can.
          { stateId: ' shelly.0.em.returned ', category: 'grid', sign: -1, price: 0.08 },
          // The admin stores a cleared number as '', a cleared name as ''; a hand edit may write the sign as text.
          { stateId: 'modbus.0.pv.total', category: 'solar', sign: '1', name: '', price: '' },
          { stateId: 'x.0.free', category: 'battery', sign: '-1', price: 0 },
          null,
          'shelly.0.em.total',
          { category: 'grid', sign: 1 },
          { stateId: '  ', category: 'grid', sign: 1 },
          { stateId: 'x.0.heat', category: 'heat', sign: 1 },
          { stateId: 'x.0.nosign', category: 'grid' },
          { stateId: 'x.0.zero', category: 'grid', sign: 0 },
          { stateId: 'x.0.yes', category: 'grid', sign: true },
          { stateId: 'shelly.0.em.total', category: 'solar', sign: 1 },
          { stateId: 'x.0.water', category: 'water', sign: 1, name: 4, price: -1 },
          { stateId: 'x.0.gas', category: 'gas', sign: -1, price: 'teuer' },
          { stateId: 'x.0.pump', category: 'device_water', sign: 1, price: null, name: null },
          { stateId: 'x.0.nan', category: 'battery', sign: 1, price: Number.POSITIVE_INFINITY },
        ],
      } as unknown as Partial<AdapterOptions>;
      const { options, warnings } = validateOptions(raw);
      expect(options.energyMeters).to.deep.equal([
        { stateId: 'shelly.0.em.total', category: 'grid', sign: 1, name: 'Netzbezug', price: 0.32 },
        { stateId: 'shelly.0.em.returned', category: 'grid', sign: -1, price: 0.08 },
        { stateId: 'modbus.0.pv.total', category: 'solar', sign: 1 },
        { stateId: 'x.0.free', category: 'battery', sign: -1, price: 0 },
        { stateId: 'x.0.water', category: 'water', sign: 1 },
        { stateId: 'x.0.gas', category: 'gas', sign: -1 },
        { stateId: 'x.0.pump', category: 'device_water', sign: 1 },
        { stateId: 'x.0.nan', category: 'battery', sign: 1 },
      ]);
      expect(warnings).to.deep.equal([
        'energyMeters entry 5 names no state id; ignoring it',
        'energyMeters entry 6 names no state id; ignoring it',
        'energyMeters entry 7 names no state id; ignoring it',
        'energyMeters entry 8 names no state id; ignoring it',
        'energyMeters entry 9 (x.0.heat) has no category of grid, solar, battery, gas, water, device, device_water; ignoring it',
        'energyMeters entry 10 (x.0.nosign) has a sign that is neither 1 (import) nor -1 (export); ignoring it',
        'energyMeters entry 11 (x.0.zero) has a sign that is neither 1 (import) nor -1 (export); ignoring it',
        'energyMeters entry 12 (x.0.yes) has a sign that is neither 1 (import) nor -1 (export); ignoring it',
        'energyMeters entry 13 (shelly.0.em.total) is listed more than once; the first entry is used',
        'energyMeters entry 14 (x.0.water) has a name that is not text; ignoring the name',
        'energyMeters entry 14 (x.0.water) has a price that is no number of 0 or more; ignoring the price',
        'energyMeters entry 15 (x.0.gas) has a price that is no number of 0 or more; ignoring the price',
        'energyMeters entry 17 (x.0.nan) has a price that is no number of 0 or more; ignoring the price',
      ]);
    });

    it("takes a device only as consumption, as the Bridge's devices are: a sign of -1 on device or device_water becomes 1, with one warning naming the row (review N1, Task 23)", () => {
      const raw = {
        energyMeters: [
          { stateId: 'x.0.wash', category: 'device', sign: -1, name: 'Waschmaschine', price: 0.3 },
          { stateId: 'x.0.pump', category: 'device_water', sign: '-1' },
          { stateId: 'x.0.fridge', category: 'device', sign: 1 },
          { stateId: 'x.0.garden', category: 'device_water', sign: '1' },
          // Kept, the first row of a state is the meter: a later row of it is not.
          { stateId: 'x.0.wash', category: 'device', sign: 1 },
          // Export stays what it says on every other category.
          { stateId: 'x.0.feed', category: 'grid', sign: -1 },
        ],
      } as unknown as Partial<AdapterOptions>;
      const { options, warnings } = validateOptions(raw);
      expect(options.energyMeters).to.deep.equal([
        { stateId: 'x.0.wash', category: 'device', sign: 1, name: 'Waschmaschine', price: 0.3 },
        { stateId: 'x.0.pump', category: 'device_water', sign: 1 },
        { stateId: 'x.0.fridge', category: 'device', sign: 1 },
        { stateId: 'x.0.garden', category: 'device_water', sign: 1 },
        { stateId: 'x.0.feed', category: 'grid', sign: -1 },
      ]);
      expect(warnings).to.deep.equal([
        'energyMeters entry 1 (x.0.wash) is a device, which only consumes: its sign must be 1 (import); using 1',
        'energyMeters entry 2 (x.0.pump) is a device, which only consumes: its sign must be 1 (import); using 1',
        'energyMeters entry 5 (x.0.wash) is listed more than once; the first entry is used',
      ]);
    });

    it('ignores every meter, with one warning, when the list is no list', () => {
      const { options, warnings } = validateOptions({ energyMeters: { stateId: 'x.0.a' } } as unknown as Partial<AdapterOptions>);
      expect(options.energyMeters).to.deep.equal([]);
      expect(warnings).to.deep.equal(['energyMeters is not a list; ignoring every energy meter']);
      expect(DEFAULTS.energyMeters).to.deep.equal([]);
    });

    it('keeps the currency trimmed, EUR when there is none, and warns when it is no text', () => {
      expect(DEFAULTS.currency).to.equal('EUR');
      expect(validateOptions({ currency: ' CHF ' }).options.currency).to.equal('CHF');
      for (const currency of ['', '   ', undefined, null]) {
        const { options, warnings } = validateOptions({ currency } as unknown as Partial<AdapterOptions>);
        expect([options.currency, warnings], String(currency)).to.deep.equal(['EUR', []]);
      }
      const { options, warnings } = validateOptions({ currency: 5 } as unknown as Partial<AdapterOptions>);
      expect([options.currency, warnings]).to.deep.equal(['EUR', ['currency is not text but a number; using the default']]);
    });

    it('cuts a currency of more than 8 characters, with a warning: it goes into every cost name and unit (review m4)', () => {
      expect(validateOptions({ currency: 'Rappen €€' }).options.currency).to.equal('Rappen €');
      const { options, warnings } = validateOptions({ currency: 'x'.repeat(4096) });
      expect(options.currency).to.equal('xxxxxxxx');
      expect(warnings).to.deep.equal(['currency has more than 8 characters; using its first 8']);
      // Counted in characters, so no emoji is cut in half.
      expect(validateOptions({ currency: '🪙'.repeat(9) }).options.currency).to.equal('🪙'.repeat(8));
      expect(validateOptions({ currency: '12345678' }).warnings).to.deep.equal([]);
    });
  });

  describe('climate modes (Ruling 141)', () => {
    const NAMES = 'off, heat, cool, heat_cool, auto, dry, fan_only';

    it('keeps each well-formed row trimmed, a device mode typed as a number as its text, and drops the rest with a warning naming each one, an unknown panel mode among them', () => {
      const { options, warnings } = validateOptions({
        climateModes: [
          { device: ' hm-rpc.0.A.1 ', deviceMode: ' MANU-MODE ', panelMode: 'heat' },
          { device: 'hm-rpc.0.A.1', deviceMode: 0, panelMode: 'auto' },
          null,
          { deviceMode: 'AUTO', panelMode: 'auto' },
          { device: '  ', deviceMode: 'AUTO', panelMode: 'auto' },
          { device: 'hm-rpc.0.B.1', deviceMode: '  ', panelMode: 'heat' },
          { device: 'hm-rpc.0.B.1', deviceMode: 'BOOST', panelMode: 'boost' },
          { device: 'hm-rpc.0.B.1', deviceMode: 'BOOST', panelMode: 'Heat' },
          { device: 'hm-rpc.0.B.1', deviceMode: 'BOOST' },
        ],
      } as unknown as Partial<AdapterOptions>);
      expect(options.climateModes).to.deep.equal([
        { device: 'hm-rpc.0.A.1', deviceMode: 'MANU-MODE', panelMode: 'heat' },
        { device: 'hm-rpc.0.A.1', deviceMode: '0', panelMode: 'auto' },
      ]);
      expect(warnings).to.deep.equal([
        'climateModes entry 3 names no device; ignoring it',
        'climateModes entry 4 names no device; ignoring it',
        'climateModes entry 5 names no device; ignoring it',
        'climateModes entry 6 (hm-rpc.0.B.1) names no device mode; ignoring it',
        `climateModes entry 7 (hm-rpc.0.B.1) has no panel mode of ${NAMES}; ignoring it`,
        `climateModes entry 8 (hm-rpc.0.B.1) has no panel mode of ${NAMES}; ignoring it`,
        `climateModes entry 9 (hm-rpc.0.B.1) has no panel mode of ${NAMES}; ignoring it`,
      ]);
    });

    it('ignores every row, with one warning, when the list is no list, and has none by default', () => {
      const { options, warnings } = validateOptions({ climateModes: { device: 'x' } } as unknown as Partial<AdapterOptions>);
      expect(options.climateModes).to.deep.equal([]);
      expect(warnings).to.deep.equal(['climateModes is not a list; ignoring every climate mode']);
      expect(DEFAULTS.climateModes).to.deep.equal([]);
    });
  });

  describe('the broker password as stored (Ruling 144)', () => {
    /**
     * js-controller's tools.encrypt (js-controller-common-db tools.js:1733-1755), which cannot be
     * loaded without a js-controller installed: AES-192-CBC under a 48-digit hex secret, marked by
     * its prefix; under any other secret an XOR, marked by nothing. tools.decrypt is the inverse,
     * and takes a value without the prefix for an XOR one (:1756-1766).
     */
    const AES = '$/aes-192-cbc:';
    const xor = (key: string, value: string): string => {
      let result = '';
      for (let i = 0; i < value.length; i++) result += String.fromCharCode(key.charCodeAt(i % key.length) ^ value.charCodeAt(i));
      return result;
    };
    const encrypt = (key: string, value: string): string => {
      if (!/^[0-9a-f]{48}$/.test(key)) return xor(key, value);
      const iv = randomBytes(16);
      const cipher = createCipheriv('aes-192-cbc', Buffer.from(key, 'hex'), iv);
      return `${AES}${iv.toString('hex')}:${Buffer.concat([cipher.update(value), cipher.final()]).toString('hex')}`;
    };
    /** The secret js-controller's setup makes (setupSetup.js:261-267), and the one an adapter falls back to without one (constants.js:37). */
    const SECRET = '3f0a9c1b7d2e4f6a8b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e';
    const LEGACY = 'Zgfr56gFe87jJOM';
    const PASSWORD = 'geheim';

    it("uses what js-controller decrypted from a value admin encrypted, and stores nothing", () => {
      expect(storedPassword(encrypt(SECRET, PASSWORD), PASSWORD, (value) => encrypt(SECRET, value))).to.deep.equal({ password: PASSWORD });
      // Under a secret AES does not take, admin encrypts by XOR: that decrypts as well.
      expect(storedPassword(encrypt(LEGACY, PASSWORD), PASSWORD, (value) => encrypt(LEGACY, value))).to.deep.equal({ password: PASSWORD });
    });

    it('takes a value 0.1 stored plain as it stands, not as its XOR, and hands back its encryption to store, once', () => {
      // js-controller decrypts a value without the prefix by XOR: garbage, never an error.
      const upgraded = storedPassword(PASSWORD, xor(SECRET, PASSWORD), (value) => encrypt(SECRET, value));
      expect(upgraded).to.include({ password: PASSWORD });
      const store = upgraded!.store!;
      expect(store.startsWith(AES)).to.equal(true);
      // The value stored is one js-controller decrypts, and is not stored again: its prefix marks it.
      const [, iv, text] = store.split(':');
      const decipher = createDecipheriv('aes-192-cbc', Buffer.from(SECRET, 'hex'), Buffer.from(iv!, 'hex'));
      expect(Buffer.concat([decipher.update(Buffer.from(text!, 'hex')), decipher.final()]).toString()).to.equal(PASSWORD);
      expect(storedPassword(store, PASSWORD, (value) => encrypt(SECRET, value))).to.deep.equal({ password: PASSWORD });
    });

    it('refuses a value js-controller could not decrypt, which it leaves as stored, and a decryption holding a control character, which no typed password has', () => {
      // Encrypted under another system's secret: js-controller logs that it cannot decrypt it and leaves it (adapter.js).
      const foreign = encrypt('0'.repeat(48), PASSWORD);
      expect(storedPassword(foreign, foreign, (value) => encrypt(SECRET, value))).to.equal(undefined);
      // Under a secret AES does not take, a 0.1 value cannot be told from an encrypted one: its XOR is garbage.
      expect([...xor(LEGACY, PASSWORD)].some((char) => char.charCodeAt(0) < 0x20)).to.equal(true);
      expect(storedPassword(PASSWORD, xor(LEGACY, PASSWORD), (value) => encrypt(LEGACY, value))).to.equal(undefined);
    });

    it('has nothing to do while no password is stored', () => {
      const never = (): string => {
        throw new Error('nothing to encrypt');
      };
      expect(storedPassword('', '', never)).to.deep.equal({ password: '' });
      expect(storedPassword(undefined, '', never)).to.deep.equal({ password: '' });
      // Not text: validateOptions warned and uses none.
      expect(storedPassword(5, '', never)).to.deep.equal({ password: '' });
    });

    describe('beside an admin older than 6.2.3 (Ruling 149)', () => {
      it('names each admin instance whose version is below 6.2.3, compared by number, and none whose version it cannot read', () => {
        const admins = {
          'system.adapter.admin.0': { common: { version: '6.2.2' } },
          'system.adapter.admin.1': { common: { version: '6.10.0' } },
          'system.adapter.admin.2': { common: { version: '6.2.3' } },
          'system.adapter.admin.3': { common: { version: '5.4.9' } },
          'system.adapter.admin.4': { common: { version: '7.6.17-beta.1' } },
          'system.adapter.admin.5': { common: {} },
          'system.adapter.admin.6': { common: { version: 'latest' } },
          'system.adapter.admin.7': null,
        };
        expect(outdatedAdmins(admins)).to.deep.equal(['admin.0 6.2.2', 'admin.3 5.4.9']);
        expect(outdatedAdmins({})).to.deep.equal([]);
      });

      it("uses what js-controller decrypted from a value such an admin encrypted, by XOR with no prefix, and stores nothing, where the migration would take the XOR for 0.1's plain text", () => {
        // Admin up to 6.2.2 encrypts by XOR under any secret, so its value carries no prefix; js-controller
        // decrypts a value without one by XOR (tools.js:1756-1766), back to the password.
        const byOldAdmin = xor(SECRET, PASSWORD);
        const enc = (value: string): string => encrypt(SECRET, value);
        expect(storedPassword(byOldAdmin, PASSWORD, enc, false)).to.deep.equal({ password: PASSWORD });
        // The hazard the guard exists for: taken for plain text, the XOR itself would be used and stored encrypted.
        expect(storedPassword(byOldAdmin, PASSWORD, enc)).to.include({ password: byOldAdmin });
        expect(storedInPlainText(byOldAdmin, enc)).to.equal(true);
        // An AES value, or nothing stored, is no migration to skip.
        expect(storedInPlainText(encrypt(SECRET, PASSWORD), enc)).to.equal(false);
        expect(storedInPlainText('', enc)).to.equal(false);
        // Not migrated, a value whose decryption is garbage is refused as before.
        expect(storedPassword(PASSWORD, xor(LEGACY, PASSWORD), enc, false)).to.equal(undefined);
      });
    });

    it('allows the migration only where the instance lists the password in encryptedNative: js-controller decrypts nothing else (final review I-5)', () => {
      expect(declaresEncryptedPassword({ encryptedNative: ['brokerPassword'], native: {} })).to.equal(true);
      // What a manual npm install leaves without `iobroker upload`: 0.1's instance had no such list.
      expect(declaresEncryptedPassword({ encryptedNative: [], native: {} })).to.equal(false);
      expect(declaresEncryptedPassword({ native: {} })).to.equal(false);
      expect(declaresEncryptedPassword(null)).to.equal(false);
    });
  });
});
