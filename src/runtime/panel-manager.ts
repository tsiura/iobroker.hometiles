import { AnnounceError, parseAnnouncement } from '../protocol/announce';
import type { EnergyCatalogEntry } from '../protocol/energy';
import type { VirtualEntity } from '../registry/types';
import type { Dispatcher } from './dispatcher';
import type { Logger } from './mqtt-client';
import { PanelSession, type PanelRequests, type PanelTransport } from './panel-session';

export interface PanelManagerDeps {
  transport: PanelTransport;
  dispatcher: Dispatcher;
  log: Logger;
  /**
   * Current registry contents, used for the initial push to a new panel, or
   * null until a discovery has succeeded in this run: then nothing is pushed
   * and the panel keeps its last configuration (Ruling 56).
   */
  entities(): VirtualEntity[] | null;
  /**
   * Entities the panels were given in an earlier run and are not given now.
   * One the user un-picked left with the restart that saving the choice
   * causes, so no rebuild of this run names it (Task 21b). A new panel's
   * initial push clears their retained states, after its configuration.
   */
  unpublished?(): readonly string[];
  /** The energy meters' catalog for every apply (Task 20b); none without. */
  energy?(): readonly EnergyCatalogEntry[];
  /** What each panel's history and energy requests are answered from (Task 22); none are without. */
  requests?: PanelRequests;
  /** Called after a session is created, updated or removed. */
  onSessionsChanged(): void | Promise<void>;
  /**
   * Called after a panel's session has been stopped and removed, so its
   * `panels.<deviceId>.*` object tree can be cleaned up. Without this a
   * withdrawn panel's objects stay behind forever, and later writes to the
   * orphaned control.* states hit the `if (!session) return` guard in main
   * and vanish silently.
   */
  onPanelRemoved(deviceId: string): void | Promise<void>;
}

export class PanelManager {
  private readonly panels = new Map<string, PanelSession>();

  constructor(private readonly deps: PanelManagerDeps) {}

  sessions(): PanelSession[] {
    return [...this.panels.values()];
  }

  get(deviceId: string): PanelSession | undefined {
    return this.panels.get(deviceId);
  }

  async handleAnnouncement(deviceId: string, payload: string): Promise<void> {
    if (!payload.trim()) {
      // An empty retained announcement is how a panel withdraws itself.
      await this.remove(deviceId);
      return;
    }

    let announcement;
    try {
      announcement = parseAnnouncement(deviceId, payload);
    } catch (error) {
      const code = error instanceof AnnounceError ? error.code : (error as Error).message;
      this.deps.log.warn(`[Panel ${deviceId}] Rejected announcement: ${code}`);
      return;
    }

    const existing = this.panels.get(deviceId);
    if (existing) {
      await existing.updateAnnouncement(announcement);
      existing.pushConfig(this.deps.entities(), true);
      await this.deps.onSessionsChanged();
      return;
    }

    const clash = [...this.panels.values()].find((other) => other.baseTopic === announcement.baseTopic);
    if (clash) {
      // The firmware requires a unique device topic base per panel. Sharing one
      // means these panels share command AND status topics, so presses and
      // presence get attributed to whichever session matches first.
      this.deps.log.warn(
        `[Panel ${deviceId}] Base topic "${announcement.baseTopic}" is already used by panel ` +
          `${clash.deviceId}. Give each panel its own device topic base.`,
      );
    }

    const session = new PanelSession(
      announcement,
      this.deps.transport,
      this.deps.dispatcher,
      this.deps.log,
      Date.now,
      () => this.deps.energy?.() ?? [],
      this.deps.requests,
    );
    session.onRefreshRequested = (): void => {
      session.pushConfig(this.deps.entities(), true);
      for (const entity of this.deps.entities() ?? []) session.pushEntityState(entity);
    };

    this.panels.set(deviceId, session);
    await session.start();
    const entities = this.deps.entities();
    session.pushConfig(entities, true);
    for (const entity of entities ?? []) session.pushEntityState(entity);
    if (entities) for (const entityId of this.deps.unpublished?.() ?? []) session.clearEntityState(entityId);
    await this.deps.onSessionsChanged();
  }

  /**
   * `retain`: the broker replayed it on a new subscription. The session
   * ignores a command then, and reads everything else (Ruling 101); an
   * announcement never comes here.
   */
  async handleMessage(topic: string, payload: string, retain: boolean): Promise<void> {
    // First match wins. A command carries the entity and the desired state, so
    // it does not matter which panel sent it — but executing it once per
    // session would turn one tap into N writes.
    for (const session of this.panels.values()) {
      if (await session.handleMessage(topic, payload, retain)) return;
    }
  }

  async remove(deviceId: string): Promise<void> {
    const session = this.panels.get(deviceId);
    if (!session) return;
    await session.stop();
    await this.deps.onPanelRemoved(deviceId);
    this.panels.delete(deviceId);
    this.deps.log.info(`[Panel ${deviceId}] Session removed`);
    await this.deps.onSessionsChanged();
  }

  async stopAll(): Promise<void> {
    for (const session of this.panels.values()) await session.stop();
    this.panels.clear();
  }
}
