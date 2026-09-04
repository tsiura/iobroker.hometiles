import type { Logger } from './mqtt-client';

export interface ScenePanel {
  deviceId: string;
  sceneMap: Record<string, string>;
}

/**
 * Merges scene aliases across every connected panel.
 * EntityRegistry.setSceneAliases REPLACES its map wholesale, so calling it
 * once per panel in a loop would let the last panel silently discard every
 * earlier panel's aliases — a scene press from any panel but the last would
 * then fail with unknown_scene. Callers must merge every panel's map and call
 * setSceneAliases exactly once with the result.
 *
 * First-seen wins on a conflicting alias (same alias, different targets); the
 * collision is logged so a misconfigured panel is visible rather than one
 * definition silently shadowing the other.
 */
export function mergeSceneAliases(panels: readonly ScenePanel[], log: Logger): Record<string, string> {
  const merged: Record<string, string> = {};
  const owner: Record<string, string> = {};

  for (const panel of panels) {
    for (const [alias, target] of Object.entries(panel.sceneMap)) {
      const key = alias.toLowerCase();
      const existingOwner = owner[key];
      if (existingOwner === undefined) {
        merged[key] = target;
        owner[key] = panel.deviceId;
        continue;
      }
      if (merged[key] !== target) {
        log.warn(
          `[Scene] Alias "${alias}" is "${merged[key]}" on panel ${existingOwner} and "${target}" on panel ` +
            `${panel.deviceId}. Keeping panel ${existingOwner}'s definition.`,
        );
      }
    }
  }

  return merged;
}
