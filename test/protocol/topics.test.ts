import { expect } from 'chai';
import {
  ANNOUNCE_TOPIC_PATTERN,
  applyTopic,
  bridgeRequestTopic,
  commandTopic,
  deviceIdFromAnnounceTopic,
  entityStateTopic,
  iconsTopic,
  ioCommandTopic,
  ioStateTopic,
  stateTopic,
} from '../../src/protocol/topics';

describe('protocol/topics', () => {
  it('subscribes to every panel announcement with one wildcard', () => {
    expect(ANNOUNCE_TOPIC_PATTERN).to.equal('tab5_lvgl/config/+/bridge');
  });

  it('extracts the device id from an announcement topic', () => {
    expect(deviceIdFromAnnounceTopic('tab5_lvgl/config/a1b2c3/bridge')).to.equal('a1b2c3');
  });

  it('returns null for a topic that is not an announcement', () => {
    expect(deviceIdFromAnnounceTopic('tab5_lvgl/config/a1b2c3/bridge/apply')).to.equal(null);
    expect(deviceIdFromAnnounceTopic('something/else')).to.equal(null);
  });

  it('builds the per-device config topics', () => {
    expect(applyTopic('a1')).to.equal('tab5_lvgl/config/a1/bridge/apply');
    expect(iconsTopic('a1')).to.equal('tab5_lvgl/config/a1/bridge/icons');
    expect(bridgeRequestTopic('a1')).to.equal('tab5_lvgl/config/a1/bridge/request');
  });

  it('builds command and state topics under the panel base', () => {
    expect(commandTopic('hometiles', 'light')).to.equal('hometiles/cmnd/light');
    expect(stateTopic('hometiles', 'connected')).to.equal('hometiles/stat/connected');
    expect(ioCommandTopic('hometiles', 'relay_1')).to.equal('hometiles/cmnd/io/relay_1');
    expect(ioStateTopic('hometiles', 'relay_1')).to.equal('hometiles/stat/io/relay_1');
  });

  it('maps an entity id onto the statestream topic by replacing the domain dot', () => {
    expect(entityStateTopic('ha/statestream', 'light.Kueche_Decke'))
      .to.equal('ha/statestream/light/kueche_decke/state');
  });

  it('rejects an entity id without a domain separator', () => {
    expect(() => entityStateTopic('ha/statestream', 'kueche')).to.throw('invalid entity id');
  });
});
