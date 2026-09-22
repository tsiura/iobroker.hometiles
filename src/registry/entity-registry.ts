import { resolveEntityIds } from './entity-id';
import { synthesise } from './synth/index';
import type { DeviceInput, SourceValue, VirtualEntity } from './types';

export interface RegistryEvents {
  onEntityChanged(entity: VirtualEntity): void;
  onMembershipChanged(): void;
}

export interface RebuildResult {
  entityIds: Record<string, string>;
  removed: string[];
  subscribe: string[];
  unsubscribe: string[];
}

interface Slot {
  device: DeviceInput;
  entity: VirtualEntity;
}

export class EntityRegistry {
  /** entityId -> slot */
  private slots = new Map<string, Slot>();
  /** ioBroker object id -> entity ids that read it */
  private watchers = new Map<string, Set<string>>();
  /** ioBroker object id -> newest value */
  private values = new Map<string, SourceValue | null>();
  /** entityId -> pending coalesce timer */
  private timers = new Map<string, NodeJS.Timeout>();
  private sceneAliases = new Map<string, string>();
  private disposed = false;

  constructor(
    private readonly events: RegistryEvents,
    private readonly coalesceMs: number,
  ) {}

  rebuild(devices: DeviceInput[], persistedIds: Record<string, string>): RebuildResult {
    const entityIds = resolveEntityIds(devices, persistedIds);
    const previousEntityIds = new Set(this.slots.keys());
    const previousObjectIds = new Set(this.watchers.keys());

    const nextSlots = new Map<string, Slot>();
    const nextWatchers = new Map<string, Set<string>>();

    for (const device of devices) {
      const entityId = entityIds[device.objectId];
      if (!entityId) continue;

      // climate can detect a device with nothing usable behind it at all
      // (see synthClimate); synthesise returns null rather than a hollow
      // entity, and that device gets no slot and no channel subscriptions.
      const entity = synthesise(device, entityId, this.valuesFor(device));
      if (!entity) continue;
      nextSlots.set(entityId, { device, entity });

      for (const channel of Object.values(device.channels)) {
        let watchers = nextWatchers.get(channel.objectId);
        if (!watchers) {
          watchers = new Set();
          nextWatchers.set(channel.objectId, watchers);
        }
        watchers.add(entityId);
      }
    }

    const removed = [...previousEntityIds].filter((id) => !nextSlots.has(id)).sort();
    const subscribe = [...nextWatchers.keys()].filter((id) => !previousObjectIds.has(id)).sort();
    const unsubscribe = [...previousObjectIds].filter((id) => !nextWatchers.has(id)).sort();

    for (const entityId of removed) this.cancelTimer(entityId);
    for (const objectId of unsubscribe) this.values.delete(objectId);

    this.slots = nextSlots;
    this.watchers = nextWatchers;

    const membershipChanged =
      removed.length > 0 ||
      subscribe.length > 0 ||
      unsubscribe.length > 0 ||
      [...nextSlots.keys()].some((id) => !previousEntityIds.has(id));
    if (membershipChanged) this.events.onMembershipChanged();

    return { entityIds, removed, subscribe, unsubscribe };
  }

  applyStateChange(objectId: string, value: SourceValue | null): void {
    if (this.disposed) return;
    const watchers = this.watchers.get(objectId);
    if (!watchers) return;

    this.values.set(objectId, value);
    for (const entityId of watchers) this.schedule(entityId);
  }

  /** Fires every pending coalesce timer immediately. Used at shutdown and in tests. */
  flush(): void {
    if (this.disposed) return;
    for (const entityId of [...this.timers.keys()]) {
      this.cancelTimer(entityId);
      this.recompute(entityId);
    }
  }

  all(): VirtualEntity[] {
    return [...this.slots.values()].map((slot) => slot.entity);
  }

  byId(entityId: string): VirtualEntity | undefined {
    return this.slots.get(entityId)?.entity;
  }

  setSceneAliases(aliases: Record<string, string>): void {
    this.sceneAliases = new Map(Object.entries(aliases).map(([alias, target]) => [alias.toLowerCase(), target]));
  }

  bySceneAlias(alias: string): VirtualEntity | undefined {
    const target = this.sceneAliases.get(alias.toLowerCase());
    return target ? this.byId(target) : undefined;
  }

  dispose(): void {
    this.disposed = true;
    for (const entityId of [...this.timers.keys()]) this.cancelTimer(entityId);
    // Cancelling timers alone left slots, watchers and values populated, so
    // all() and byId() kept returning entities after disposal.
    this.slots.clear();
    this.watchers.clear();
    this.values.clear();
  }

  private valuesFor(device: DeviceInput): Record<string, SourceValue | null> {
    const values: Record<string, SourceValue | null> = {};
    for (const channel of Object.values(device.channels)) {
      values[channel.objectId] = this.values.get(channel.objectId) ?? null;
    }
    return values;
  }

  private schedule(entityId: string): void {
    if (this.coalesceMs <= 0) {
      this.recompute(entityId);
      return;
    }
    // One timer per entity. A burst restarts nothing: the existing timer fires
    // with whatever the newest value is by then, so the trailing edge always
    // wins and the last value is never lost.
    if (this.timers.has(entityId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(entityId);
      this.recompute(entityId);
    }, this.coalesceMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(entityId, timer);
  }

  private cancelTimer(entityId: string): void {
    const timer = this.timers.get(entityId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(entityId);
  }

  private recompute(entityId: string): void {
    const slot = this.slots.get(entityId);
    if (!slot) return;

    const next = synthesise(slot.device, entityId, this.valuesFor(slot.device));
    // Not reachable in practice: a slot only exists because synthesise once
    // returned non-null for this exact device, and a climate device's null
    // vs. non-null outcome depends only on which channels are configured,
    // which does not change between rebuilds. Guarded anyway for the type
    // checker, and because "no change" is the safe reading if it ever did.
    if (!next) return;
    if (sameEntity(slot.entity, next)) return;

    slot.entity = next;
    this.events.onEntityChanged(next);
  }
}

/** lastChanged deliberately excluded: a repeated identical value is not a change. */
function sameEntity(a: VirtualEntity, b: VirtualEntity): boolean {
  return (
    a.state === b.state &&
    a.available === b.available &&
    JSON.stringify(a.attributes) === JSON.stringify(b.attributes)
  );
}
