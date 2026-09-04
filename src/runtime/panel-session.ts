import type { Announcement, LocalIoChannel } from '../protocol/announce';
import { buildApplyPayload, buildIconsPayload, configSignature } from '../protocol/apply';
import { CommandError, parseCommand } from '../protocol/commands';
import { buildStateClear, buildStatePublish } from '../protocol/state-payload';
import {
  applyTopic,
  bridgeRequestTopic,
  commandTopic,
  iconsTopic,
  stateTopic,
} from '../protocol/topics';
import type { VirtualEntity } from '../registry/types';
import type { Dispatcher } from './dispatcher';
import type { Logger, PublishRequest } from './mqtt-client';

export interface PanelTransport {
  publish(request: PublishRequest): void;
  subscribe(topic: string): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
}

/** Command leaves v0.1 implements. Everything else is deliberately not subscribed. */
const COMMAND_LEAVES = ['light', 'switch', 'scene'] as const;
type CommandLeaf = (typeof COMMAND_LEAVES)[number];

export class PanelSession {
  private lastSignature: string | null = null;
  private lastIconsPayload: string | null = null;
  private started = false;

  online = false;
  ip: string | null = null;

  constructor(
    private announcement: Announcement,
    private readonly transport: PanelTransport,
    private readonly dispatcher: Dispatcher,
    private readonly log: Logger,
  ) {}

  get deviceId(): string {
    return this.announcement.deviceId;
  }

  get baseTopic(): string {
    return this.announcement.baseTopic;
  }

  get haPrefix(): string {
    return this.announcement.haPrefix;
  }

  get localIo(): LocalIoChannel[] {
    return this.announcement.localIo;
  }

  get sceneMap(): Record<string, string> {
    return this.announcement.sceneMap;
  }

  commandTopics(): string[] {
    const topics = COMMAND_LEAVES.map((leaf) => commandTopic(this.baseTopic, leaf));
    topics.push(stateTopic(this.baseTopic, 'connected'));
    topics.push(stateTopic(this.baseTopic, 'ip'));
    topics.push(bridgeRequestTopic(this.deviceId));
    return topics;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const topic of this.commandTopics()) {
      await this.transport.subscribe(topic);
    }
    this.log.info(`[Panel ${this.deviceId}] Session started on base topic ${this.baseTopic}`);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const topic of this.commandTopics()) {
      await this.transport.unsubscribe(topic);
    }
  }

  /**
   * A base topic change means the panel now listens somewhere else, so the old
   * subscriptions have to go before the new ones are taken.
   */
  async updateAnnouncement(next: Announcement): Promise<void> {
    const rewired = next.baseTopic !== this.baseTopic || next.haPrefix !== this.haPrefix;
    if (!rewired) {
      this.announcement = next;
      return;
    }
    await this.stop();
    this.announcement = next;
    this.lastSignature = null;
    this.lastIconsPayload = null;
    await this.start();
  }

  pushConfig(entities: VirtualEntity[], force = false): boolean {
    const payload = buildApplyPayload({ entities, sceneMap: this.sceneMap });
    const signature = configSignature(payload);
    if (!force && signature === this.lastSignature) return false;

    this.lastSignature = signature;
    this.transport.publish({ topic: applyTopic(this.deviceId), payload, retain: true });

    const icons = buildIconsPayload(entities);
    if (icons !== this.lastIconsPayload) {
      this.lastIconsPayload = icons;
      this.transport.publish({ topic: iconsTopic(this.deviceId), payload: icons, retain: true });
    }

    this.log.info(`[Panel ${this.deviceId}] Configuration pushed, ${entities.length} entities`);
    return true;
  }

  pushEntityState(entity: VirtualEntity): void {
    const publish = buildStatePublish(this.haPrefix, entity);
    if (!publish) return;
    this.transport.publish(publish);
  }

  clearEntityState(entityId: string): void {
    this.transport.publish(buildStateClear(this.haPrefix, entityId));
  }

  publishPanelCommand(leaf: string, payload: string): void {
    this.transport.publish({ topic: commandTopic(this.baseTopic, leaf), payload, retain: false });
  }

  async handleMessage(topic: string, payload: string): Promise<void> {
    if (topic === bridgeRequestTopic(this.deviceId)) {
      // Signature reset makes the next pushConfig unconditional.
      this.lastSignature = null;
      this.lastIconsPayload = null;
      if (!this.onRefreshRequested) {
        // The session does not own the entity list — the manager does. Caching
        // the last pushed list here to republish it would risk replaying STALE
        // config on the one path where freshness matters most. So an unwired
        // handler is a wiring bug, and it must be loud, not a silent no-op.
        this.log.warn(`[Panel ${this.deviceId}] Refresh requested but no handler is wired`);
        return;
      }
      this.onRefreshRequested(payload.trim() === 'force');
      return;
    }

    if (topic === stateTopic(this.baseTopic, 'connected')) {
      const text = payload.trim().toLowerCase();
      this.online = text === 'online' || text === 'true' || text === '1' || text === 'on';
      return;
    }

    if (topic === stateTopic(this.baseTopic, 'ip')) {
      this.ip = payload.trim() || null;
      return;
    }

    const leaf = COMMAND_LEAVES.find((candidate) => topic === commandTopic(this.baseTopic, candidate));
    if (!leaf) return;

    await this.executeCommand(leaf, payload);
  }

  /** Set by the manager so a forced refresh can reach the entity registry. */
  onRefreshRequested?: (forced: boolean) => void;

  private async executeCommand(leaf: CommandLeaf, payload: string): Promise<void> {
    try {
      const call = parseCommand(leaf, payload);
      const result = await this.dispatcher.dispatch(call);
      if (!result.ok) {
        this.log.warn(`[Panel ${this.deviceId}] Command on ${leaf} rejected: ${result.reason}`);
      }
    } catch (error) {
      const code = error instanceof CommandError ? error.code : (error as Error).message;
      this.log.warn(`[Panel ${this.deviceId}] Invalid command on ${leaf}: ${code}`);
    }
  }
}
