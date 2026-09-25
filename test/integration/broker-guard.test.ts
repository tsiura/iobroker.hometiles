import { expect } from 'chai';
import { defaultBrokerPort } from './broker-guard';

describe("the integration suite's guard against the default broker (Ruling 145, I1)", () => {
  it('refuses a configuration the adapter reads as 1883 or 8883, an absent port among them', () => {
    // No port, or null: the adapter takes its default, 1883 (validateOptions).
    expect(defaultBrokerPort({})).to.equal(1883);
    expect(defaultBrokerPort({ brokerPort: null })).to.equal(1883);
    expect(defaultBrokerPort({ brokerPort: 1883 })).to.equal(1883);
    expect(defaultBrokerPort({ brokerPort: 8883 })).to.equal(8883);
    expect(defaultBrokerPort({ brokerPort: 41234 })).to.equal(undefined);
    // Text is no port to the adapter: validateOptions clamps it to the minimum, 1, which reaches no broker.
    expect(defaultBrokerPort({ brokerPort: '1883' })).to.equal(undefined);
  });
});
