import { expect } from 'chai';
import { DEFAULTS, normaliseTopic, validateOptions, type AdapterOptions } from '../../src/config/options';

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
    } as unknown as Partial<AdapterOptions>;
    const { options, warnings } = validateOptions(raw);
    expect(options).to.deep.equal(DEFAULTS);
    for (const key of ['brokerHost', 'clientId', 'baseTopic', 'haPrefix', 'brokerUser', 'brokerPassword', 'deviceOverrides']) {
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
});
