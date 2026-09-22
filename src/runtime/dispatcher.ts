import type { ServiceCall } from '../protocol/commands';
import type { ChannelCodec, Domain, VirtualEntity } from '../registry/types';
import { STATE_OFF, STATE_ON } from '../registry/types';
import { encodeChannelValue } from '../registry/synth/common';
import type { Logger } from './mqtt-client';

export type StateWriter = (objectId: string, value: unknown) => Promise<void>;

export interface EntityLookup {
  byId(entityId: string): VirtualEntity | undefined;
  bySceneAlias(alias: string): VirtualEntity | undefined;
}

export type DispatchResult =
  | { ok: true; writes: number }
  /**
   * `applied` is how many writes already landed before the failure. A device
   * left half-configured — turned on but not dimmed — must be distinguishable
   * from one that was never touched, because those are different things to
   * debug and the panel's own display cannot tell them apart either.
   */
  | { ok: false; reason: string; applied: number };

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
  // v0.2 domains: no ServiceCall variant exists for any of these yet (see
  // protocol/commands.ts), so nothing can be allowed through. An empty set
  // routes a call for one of these domains into the existing, already-logged
  // "call_not_allowed_for_domain" rejection below rather than throwing out of
  // a static table — loud and explicit, not a silent fallthrough. Later tasks
  // add each domain's ServiceCall kind here as it gains real commands.
  climate: new Set<CallKind>([
    'set_temperature',
    'set_humidity',
    'set_hvac_mode',
    'set_fan_mode',
    'set_preset_mode',
    'set_swing_mode',
    'set_swing_horizontal_mode',
  ]),
  cover: new Set<CallKind>(),
  media_player: new Set<CallKind>(),
  weather: new Set<CallKind>(),
  number: new Set<CallKind>(),
  select: new Set<CallKind>(),
  datetime: new Set<CallKind>(),
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
      return { ok: false, reason, applied: 0 };
    }

    if (!ALLOWED_CALLS[entity.domain].has(call.kind)) {
      this.log.warn(`[Command] Rejected ${call.kind} for ${entity.entityId}: not allowed for ${entity.domain}`);
      return { ok: false, reason: 'call_not_allowed_for_domain', applied: 0 };
    }

    const writes = this.plan(call, entity);
    if (!writes.length) {
      // A call that resolves to zero writes must not report success: it is
      // indistinguishable from a command that did exactly what was asked. A
      // scene wired to a read-only control, or a slider whose only channel
      // the plan step could not find, would otherwise do nothing forever
      // while every caller believes it worked.
      this.log.warn(`[Command] Rejected ${call.kind} for ${entity.entityId}: no writable channel`);
      return { ok: false, reason: 'no_writable_channel', applied: 0 };
    }

    let applied = 0;
    for (const [channel, objectId, value] of writes) {
      try {
        await this.write(objectId, value);
        applied++;
      } catch (error) {
        // Name the channel and the count: "failed on dimmer after 1 applied"
        // tells an operator the lamp is on but not dimmed. "write_failed"
        // alone sends them looking for a problem that never happened.
        this.log.error(
          `[Command] Write failed for ${entity.entityId} on channel ${channel} ` +
            `after ${applied} of ${writes.length} writes: ${(error as Error).message}`,
        );
        return { ok: false, reason: 'write_failed', applied };
      }
    }

    return { ok: true, writes: applied };
  }

  /** Resolves a call into concrete writes, skipping channels the device lacks. */
  private plan(call: ServiceCall, entity: VirtualEntity): Array<[string, string, unknown]> {
    // [channelName, objectId, value] — the channel name is carried so a failure
    // can say which capability did not apply.
    const writes: Array<[string, string, unknown]> = [];
    const push = (channel: string, value: unknown): void => {
      const objectId = entity.source[channel];
      if (objectId) writes.push([channel, objectId, value]);
    };

    // Climate-only: a role (e.g. "setpoint") is writable per entity.writable
    // — set by the registry, never re-derived here — but is not pinned to one
    // fixed channel name. A single setpoint is ordinarily SET, but a
    // dual-setpoint device exposing only one side of SET_HEATING/SET_COOLING
    // can also be "the" setpoint writer for that role (see synth/climate.ts).
    // Candidates are tried in order; the first one the entity actually has
    // wins. Same mechanism also covers fan_mode's SPEED/SPEED_LEVEL fallback.
    const resolveChannel = (role: string, channels: readonly string[]): string | undefined => {
      if (entity.writable?.[role] !== true) return undefined;
      return channels.find((name) => entity.source[name]);
    };
    const pushRole = (role: string, channels: readonly string[], value: unknown): void => {
      const channel = resolveChannel(role, channels);
      if (channel) push(channel, value);
    };

    /**
     * For the five climate commands that carry a decoded display LABEL
     * (hvac_mode, fan_mode, swing_mode, swing_horizontal_mode, preset_mode):
     * reverses that label back into the raw value the channel actually needs
     * via encodeChannelValue (registry/synth/common.ts), the exact inverse of
     * the decoder that produced it (readEnum/toBoolState). Writing the label
     * verbatim -- e.g. "heat" into a MODE state that expects 1, or "on" into
     * a boolean SWING_TOGGLE that expects `true` -- is this project's
     * defining bug class: success reported for a write that lands on
     * nothing, or on the wrong thing.
     *
     * `fallbackType` supplies a default when the registry captured no
     * type/states for this channel at all: fan_mode's SPEED/SPEED_LEVEL and
     * swing_mode's SWING are always Number-typed by construction
     * (@iobroker/type-detector's FanPatterns.speed/speedLevel/swing, fixed
     * pattern declarations, not per-device data -- verified fix-round 1/2),
     * so an untyped fixture or device still gets safe numeric coercion
     * instead of a bare string passthrough. hvac_mode and preset_mode have
     * no such structural guarantee (MODE is genuinely Number-or-String
     * depending on the device) and take no fallback, defaulting to
     * passthrough -- exactly what every climate command already did before
     * this field existed, so an untyped channel never regresses.
     */
    const pushEncoded = (
      role: string,
      channels: readonly string[],
      label: string,
      fallbackType?: ChannelCodec['type'],
    ): void => {
      const channel = resolveChannel(role, channels);
      if (!channel) return;
      const codec = entity.channelMeta?.[channel];
      const effective = codec?.type === undefined && fallbackType ? { type: fallbackType, states: codec?.states } : codec;
      const value = encodeChannelValue(effective, label);
      if (value === undefined) {
        this.log.warn(`[Command] Cannot encode "${label}" for ${entity.entityId} on channel ${channel}`);
        return;
      }
      push(channel, value);
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
        // A colour or CT bulb carries its level on DIMMER or BRIGHTNESS,
        // never both (see registry/synth/light.ts). Writing unconditionally
        // to 'dimmer' left a BRIGHTNESS-only bulb's slider with no channel to
        // write to at all.
        if (call.brightnessPct !== undefined) {
          push(entity.source.dimmer ? 'dimmer' : 'brightness', call.brightnessPct);
        }
        if (call.rgb) {
          push('red', call.rgb[0]);
          push('green', call.rgb[1]);
          push('blue', call.rgb[2]);
        }
        if (call.kelvin !== undefined) push('temperature', call.kelvin);
        break;
      }
      case 'set_temperature':
        // Do not hardcode 'set': whatever channel the registry recorded as
        // the setpoint writer is the one to write (see pushRole above).
        if (call.value !== undefined) pushRole('setpoint', ['set', 'set_heating', 'set_cooling'], call.value);
        if (call.low !== undefined) pushRole('target_temp_low', ['set_heating'], call.low);
        if (call.high !== undefined) pushRole('target_temp_high', ['set_cooling'], call.high);
        break;
      case 'set_humidity':
        pushRole('target_humidity', ['humidity'], call.value);
        break;
      case 'set_hvac_mode':
        // No structural type guarantee (MODE can be Number- or String-typed
        // depending on the device) -- passthrough default when untyped.
        pushEncoded('hvac_mode', ['mode'], call.mode);
        break;
      case 'set_fan_mode':
        // SPEED (named steps) and SPEED_LEVEL (a percentage) are alternates
        // for the same role, same as light's dimmer/brightness pair.
        pushEncoded('fan_mode', ['speed', 'speed_level'], call.mode, 'number');
        break;
      case 'set_preset_mode':
        pushEncoded('preset_mode', ['preset'], call.mode);
        break;
      case 'set_swing_mode':
        pushEncoded('swing_mode', ['swing'], call.mode, 'number');
        break;
      case 'set_swing_horizontal_mode':
        // requireOnOff (commands.ts) already proved this is a strict on/off
        // choice; convert to the exact label toBoolState emits for a boolean
        // channel before encoding, defaulting to boolean when untyped
        // (SWING_TOGGLE's fixed Boolean declaration) instead of the generic
        // string passthrough every other label command falls back to -- that
        // passthrough would regress a boolean write that already worked
        // before this fix into a wrongly-typed string write.
        pushEncoded('swing_horizontal_mode', ['swing_toggle'], call.on ? STATE_ON : STATE_OFF, 'boolean');
        break;
    }

    return writes;
  }
}
