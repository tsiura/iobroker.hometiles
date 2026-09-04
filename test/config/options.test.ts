import { expect } from 'chai';
import { DEFAULTS, normaliseTopic, validateOptions } from '../../src/config/options';

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
});
