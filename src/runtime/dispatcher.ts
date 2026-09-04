import type { ServiceCall } from '../protocol/commands';
import type { Domain, VirtualEntity } from '../registry/types';
import { STATE_ON } from '../registry/types';
import type { Logger } from './mqtt-client';

export type StateWriter = (objectId: string, value: unknown) => Promise<void>;

export interface EntityLookup {
  byId(entityId: string): VirtualEntity | undefined;
  bySceneAlias(alias: string): VirtualEntity | undefined;
}

export type DispatchResult = { ok: true; writes: number } | { ok: false; reason: string };

type CallKind = ServiceCall['kind'];

/**
 * The security boundary. A command may only reach a channel listed here, on an
 * entity already present in the registry. Nothing else is reachable from MQTT.
 */
const ALLOWED_CALLS: Record<Domain, ReadonlySet<CallKind>> = {
  switch: new Set<CallKind>(['turn_on', 'turn_off', 'toggle']),
  light: new Set<CallKind>(['turn_on', 'turn_off', 'toggle', 'set_light']),
  scene: new Set<CallKind>(['activate_scene']),
  sensor: new Set<CallKind>(),
  binary_sensor: new Set<CallKind>(),
};

export class Dispatcher {
  constructor(
    private readonly lookup: EntityLookup,
    private readonly write: StateWriter,
    private readonly log: Logger,
  ) {}

  async dispatch(call: ServiceCall): Promise<DispatchResult> {
    const entity =
      call.kind === 'activate_scene' ? this.lookup.bySceneAlias(call.alias) : this.lookup.byId(call.entityId);

    if (!entity) {
      const reason = call.kind === 'activate_scene' ? 'unknown_scene' : 'unknown_entity';
      this.log.warn(`[Command] Rejected ${call.kind}: ${reason}`);
      return { ok: false, reason };
    }

    if (!ALLOWED_CALLS[entity.domain].has(call.kind)) {
      this.log.warn(`[Command] Rejected ${call.kind} for ${entity.entityId}: not allowed for ${entity.domain}`);
      return { ok: false, reason: 'call_not_allowed_for_domain' };
    }

    const writes = this.plan(call, entity);
    if (!writes.length) return { ok: true, writes: 0 };

    try {
      for (const [objectId, value] of writes) {
        await this.write(objectId, value);
      }
    } catch (error) {
      this.log.error(`[Command] Write failed for ${entity.entityId}: ${(error as Error).message}`);
      return { ok: false, reason: 'write_failed' };
    }

    return { ok: true, writes: writes.length };
  }

  /** Resolves a call into concrete writes, skipping channels the device lacks. */
  private plan(call: ServiceCall, entity: VirtualEntity): Array<[string, unknown]> {
    const writes: Array<[string, unknown]> = [];
    const push = (channel: string, value: unknown): void => {
      const objectId = entity.source[channel];
      if (objectId) writes.push([objectId, value]);
    };

    switch (call.kind) {
      case 'turn_on':
        push('set', true);
        break;
      case 'turn_off':
        push('set', false);
        break;
      case 'toggle':
        // An unavailable or unknown entity toggles to on: that is what a user
        // pressing a dark tile means, and it is never a silent no-op.
        push('set', entity.state !== STATE_ON);
        break;
      case 'activate_scene':
        push('set', true);
        break;
      case 'set_light': {
        if (call.state !== undefined) push('set', call.state === 'on');
        if (call.brightnessPct !== undefined) push('dimmer', call.brightnessPct);
        if (call.rgb) {
          push('red', call.rgb[0]);
          push('green', call.rgb[1]);
          push('blue', call.rgb[2]);
        }
        if (call.kelvin !== undefined) push('temperature', call.kelvin);
        break;
      }
    }

    return writes;
  }
}
