import { expect } from 'chai';
import { mergeSceneAliases } from '../../src/runtime/scene-aliases';

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

describe('runtime/scene-aliases', () => {
  it('merges aliases from every panel instead of only the last one', () => {
    const merged = mergeSceneAliases(
      [
        { deviceId: 'a1', sceneMap: { 'gute nacht': 'scene.nacht' } },
        { deviceId: 'a2', sceneMap: { kino: 'scene.kino' } },
      ],
      silentLog,
    );
    expect(merged).to.deep.equal({ 'gute nacht': 'scene.nacht', kino: 'scene.kino' });
  });

  it('lowercases every alias so two panels using different casing still merge into one key', () => {
    const merged = mergeSceneAliases(
      [
        { deviceId: 'a1', sceneMap: { 'Gute Nacht': 'scene.nacht' } },
        { deviceId: 'a2', sceneMap: { 'GUTE NACHT': 'scene.nacht' } },
      ],
      silentLog,
    );
    expect(merged).to.deep.equal({ 'gute nacht': 'scene.nacht' });
  });

  it('keeps the first panel on a conflicting alias and logs a warning naming both panels', () => {
    const warnings: string[] = [];
    const log = { ...silentLog, warn: (m: string) => void warnings.push(m) };
    const merged = mergeSceneAliases(
      [
        { deviceId: 'a1', sceneMap: { kino: 'scene.kino_wohnzimmer' } },
        { deviceId: 'a2', sceneMap: { kino: 'scene.kino_keller' } },
      ],
      log,
    );
    expect(merged.kino).to.equal('scene.kino_wohnzimmer');
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.include('a1');
    expect(warnings[0]).to.include('a2');
    expect(warnings[0]).to.include('kino');
  });

  it('does not warn when two panels agree on the same alias target', () => {
    const warnings: string[] = [];
    const log = { ...silentLog, warn: (m: string) => void warnings.push(m) };
    const merged = mergeSceneAliases(
      [
        { deviceId: 'a1', sceneMap: { kino: 'scene.kino' } },
        { deviceId: 'a2', sceneMap: { kino: 'scene.kino' } },
      ],
      log,
    );
    expect(merged.kino).to.equal('scene.kino');
    expect(warnings).to.have.length(0);
  });

  it('returns an empty map when no panel defines any alias', () => {
    expect(mergeSceneAliases([], silentLog)).to.deep.equal({});
  });
});
