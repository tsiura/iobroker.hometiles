import type { ServiceCall } from '../protocol/commands';
import { valueWrite } from '../protocol/editable';
import type { Domain, VirtualEntity } from '../registry/types';
import { STATE_OFF, STATE_ON } from '../registry/types';
import {
  colorTempFromKelvin,
  colorTempScale,
  encodeChannelValue,
  fromPercent,
  percentScale,
  roleCodec,
  withinDeclaredRange,
} from '../registry/synth/common';
import { mediaStateValue } from '../registry/synth/media_player';
import type { Logger } from './mqtt-client';

export type StateWriter = (objectId: string, value: unknown) => Promise<void>;

/**
 * Both lookups return the entity as of the newest values received: a lookup
 * that batches recomputes (EntityRegistry) applies a pending one first. A
 * command reads the channel's current value from the entity (Ruling 41), and
 * one taken from before the batch landed wrote a stale value with ok:true
 * (Task 8 round 1, M2).
 */
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
   * `cause`: what the writer threw, when a write failed.
   */
  | { ok: false; reason: string; applied: number; cause?: string };

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
  // v0.2 domains without commands yet keep an empty set: a call for one of
  // them goes into the existing, already-logged "call_not_allowed_for_domain"
  // rejection below rather than throwing out of a static table — loud and
  // explicit, not a silent fallthrough. Each task adds its domain's
  // ServiceCall kinds here as it gains real commands.
  climate: new Set<CallKind>([
    'set_temperature',
    'set_humidity',
    'set_hvac_mode',
    'set_fan_mode',
    'set_preset_mode',
    'set_swing_mode',
    'set_swing_horizontal_mode',
  ]),
  // The firmware's ten allow-listed cover commands (mqtt_handlers.cpp:2268-2271).
  cover: new Set<CallKind>([
    'open_cover',
    'close_cover',
    'stop_cover',
    'set_cover_position',
    'open_cover_tilt',
    'close_cover_tilt',
    'stop_cover_tilt',
    'set_cover_tilt_position',
    'toggle_cover',
    'toggle_cover_tilt',
  ]),
  // What the panel's media controls send (protocol/commands.ts parseMediaCommand).
  media_player: new Set<CallKind>(['media_previous', 'media_play_pause', 'media_next', 'media_set_volume', 'media_seek']),
  weather: new Set<CallKind>(),
  // One command for all three, cmnd/value (Task 15).
  number: new Set<CallKind>(['set_value']),
  select: new Set<CallKind>(['set_value']),
  datetime: new Set<CallKind>(['set_value']),
};

export class Dispatcher {
  constructor(
    private readonly lookup: EntityLookup,
    private readonly write: StateWriter,
    private readonly log: Logger,
  ) {}

  async dispatch(call: ServiceCall): Promise<DispatchResult> {
    // A value command is answered with its reason on stat/value, and its
    // panel session logs a failure, rate-limited (Task 15): a flood of them
    // must not fill the log. Every other command has no answer, so the log
    // is the only place its refusal is seen.
    const answered = call.kind === 'set_value';
    const refuse = (message: string): void => (answered ? this.log.debug(message) : this.log.warn(message));
    const entity =
      call.kind === 'activate_scene' ? this.lookup.bySceneAlias(call.alias) : this.lookup.byId(call.entityId);

    if (!entity) {
      const reason = call.kind === 'activate_scene' ? 'unknown_scene' : 'unknown_entity';
      refuse(`[Command] Rejected ${call.kind}: ${reason}`);
      return { ok: false, reason, applied: 0 };
    }

    if (!ALLOWED_CALLS[entity.domain].has(call.kind)) {
      refuse(`[Command] Rejected ${call.kind} for ${entity.entityId}: not allowed for ${entity.domain}`);
      return { ok: false, reason: 'call_not_allowed_for_domain', applied: 0 };
    }

    const { writes, failureReason } = this.plan(call, entity);
    if (!writes.length) {
      // A call that resolves to zero writes must not report success: it is
      // indistinguishable from a command that did exactly what was asked. A
      // scene wired to a read-only control, or a slider whose only channel
      // the plan step could not find, would otherwise do nothing forever
      // while every caller believes it worked.
      //
      // failureReason distinguishes "no channel to write to" from "a channel
      // exists and is writable, but the value could not be encoded for it"
      // (fix-round 3, fold-in 2) -- the two are different problems to debug,
      // and collapsing them into one reason claimed a channel was missing
      // when it was really the value that didn't fit it. A cover toggle adds
      // a third: its direction depends on a state nobody knows.
      const reason = failureReason ?? 'no_writable_channel';
      refuse(`[Command] Rejected ${call.kind} for ${entity.entityId}: ${reason}`);
      return { ok: false, reason, applied: 0 };
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
        const cause = (error as Error).message;
        const line = `[Command] Write failed for ${entity.entityId} on channel ${channel} after ${applied} of ${writes.length} writes: ${cause}`;
        if (answered) this.log.debug(line);
        else this.log.error(line);
        return { ok: false, reason: 'write_failed', applied, cause };
      }
    }

    return { ok: true, writes: applied };
  }

  /** Resolves a call into concrete writes, skipping channels the device lacks. */
  private plan(
    call: ServiceCall,
    entity: VirtualEntity,
  ): { writes: Array<[string, string, unknown]>; failureReason?: string } {
    // [channelName, objectId, value] — the channel name is carried so a failure
    // can say which capability did not apply.
    const writes: Array<[string, string, unknown]> = [];
    // Set only by pushEncoded, the two cover toggles, media play_pause,
    // media seek and set_value, and only consulted by dispatch() when `writes` ends up
    // empty — every command below sets it at most once per plan(), so there
    // is no ordering ambiguity between an earlier success and a later failure
    // to worry about.
    let failureReason: string | undefined;
    const push = (channel: string, value: unknown): void => {
      const objectId = entity.source[channel];
      if (!objectId) return;
      // Ruling 38: every write passes here, so this one guard covers every
      // domain -- v0.1's switch, light and scene wrote read-only objects
      // (e.g. a KNX status with common.write false) and reported success.
      // Only an explicit false refuses: undefined means the object and its
      // pattern are both silent, and stays writable as before.
      if (entity.channelMeta?.[channel]?.write === false) {
        this.log.warn(`[Command] Not writing ${channel} of ${entity.entityId}: ${objectId} is read-only`);
        return;
      }
      writes.push([channel, objectId, value]);
    };

    // Climate and cover: a role (e.g. "setpoint") is writable per entity.writable
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
     * Ruling 49: every numeric command -- setpoint, humidity, cover position
     * and tilt, light brightness -- goes through here. (Not colour
     * temperature: one the light cannot take is skipped out loud in set_light
     * below, Ruling 59.) A panel percentage (position, tilt, brightness) must be 0..100 and
     * is scaled into the channel's range, the same map the synth publishes
     * with; an absolute value must lie inside the channel's declared bounds
     * (Ruling 55's declaredBounds). Anything else refuses the WHOLE call
     * below, never clamped: clamping would write something other than what
     * was asked and still report success.
     */
    let outOfRange = false;
    const pushNumber = (channel: string | undefined, value: number, percent: boolean): void => {
      if (!channel) return;
      const codec = entity.channelMeta?.[channel];
      if (percent ? value < 0 || value > 100 : !withinDeclaredRange(value, codec)) {
        this.log.warn(`[Command] ${value} is outside the range of ${channel} on ${entity.entityId}`);
        outOfRange = true;
        return;
      }
      // A percentage channel whose bounds cannot be scaled is never
      // advertised (Ruling 55), so nothing lands on it.
      const raw = percent ? fromPercent(value, codec) : value;
      if (raw !== undefined) push(channel, raw);
    };
    const pushRoleNumber = (role: string, channels: readonly string[], value: number, percent: boolean): void =>
      pushNumber(resolveChannel(role, channels), value, percent);

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
     * roleCodec (common.ts) supplies the role's fixed pattern type when the
     * registry captured none -- the same function synthClimate advertises
     * with, so what the panel is offered and what lands here cannot differ
     * (Ruling 36).
     *
     * The role's attribute is its current decoded value, what the panel
     * shows: re-selecting it writes the channel's current raw value, which
     * the codec carries (Ruling 41).
     */
    const pushEncoded = (role: string, channels: readonly string[], label: string): void => {
      const channel = resolveChannel(role, channels);
      if (!channel) return;
      const value = encodeChannelValue(roleCodec(role, entity.channelMeta?.[channel]), label, entity.attributes[role]);
      if (value === undefined) {
        this.log.warn(`[Command] Cannot encode "${label}" for ${entity.entityId} on channel ${channel}`);
        failureReason = 'cannot_encode_value';
        return;
      }
      push(channel, value);
    };

    // Cover (synth/cover.ts): a boolean SET is a gate-style toggle, itself the
    // open/close command -- true opens, false closes. The synth records that
    // type even for an untyped SET, and grants the open/close roles from SET
    // in exactly that case; every other cover opens and closes by pressing its
    // OPEN/CLOSE buttons. Position and tilt never share a channel.
    const openClose = (open: boolean): void => {
      const role = open ? 'open' : 'close';
      if (entity.channelMeta?.set?.type === 'boolean') pushRole(role, ['set'], open);
      else pushRole(role, [role], true);
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
        //
        // Ruling 54: a light whose level cannot take a brightness -- none,
        // read-only, or bounds a percentage cannot scale over -- still takes
        // "on", colour and CT. The panel draws a brightness slider for every
        // colour mode, and both that slider and the power button send the
        // brightness together with "on" (light_popup.cpp:1167-1180, and
        // :1021-1038 via :1664-1684), so refusing the call would stop them
        // switching the light on at all. v0.1's partial success instead: the
        // brightness alone is skipped, out loud -- M3's defect was the silence.
        if (call.brightnessPct !== undefined) {
          const level = entity.source.dimmer ? 'dimmer' : entity.source.brightness ? 'brightness' : undefined;
          const codec = level === undefined ? undefined : entity.channelMeta?.[level];
          const skip = (why: string): void => this.log.warn(`[Command] Skipping the brightness of ${entity.entityId}: ${why}`);
          if (level === undefined) skip('the light has no level channel');
          else if (codec?.write === false) skip(`${level} is read-only`);
          else if (!percentScale(codec)) skip(`${level} declares no usable range`);
          else pushNumber(level, call.brightnessPct, true);
        }
        if (call.rgb) {
          push('red', call.rgb[0]);
          push('green', call.rgb[1]);
          push('blue', call.rgb[2]);
        }
        // Ruling 59: Ruling 54 extends to colour temperature. A light with CT
        // but no colour is always in CT mode (light_popup.cpp:1616-1618), so
        // its power button always carries a CT; one the light cannot take is
        // skipped, out loud, and never refuses the call. What lands is what
        // was published: a whole kelvin inside the range the panel clamps to,
        // written in the channel's own unit (mireds, on zigbee2mqtt's default).
        const skipCt = (why: string): void => this.log.warn(`[Command] Skipping the colour temperature of ${entity.entityId}: ${why}`);
        if (call.skippedKelvin !== undefined) skipCt(call.skippedKelvin);
        if (call.kelvin !== undefined) {
          const codec = entity.channelMeta?.temperature;
          // No entry at all (an entity built without channelMeta) declares
          // nothing, exactly like an entry with no unit or bounds: kelvin,
          // over the firmware's default range -- what the synth publishes.
          const scale = colorTempScale(codec ?? {});
          if (!entity.source.temperature) skipCt('the light has no colour-temperature channel');
          else if (codec?.write === false) skipCt('temperature is read-only');
          else if (!scale) skipCt('its unit or range cannot be read as kelvin');
          else if (call.kelvin < scale.minKelvin || call.kelvin > scale.maxKelvin) {
            skipCt(`${call.kelvin} K is outside ${scale.minKelvin}..${scale.maxKelvin} K`);
          } else push('temperature', colorTempFromKelvin(call.kelvin, scale, codec));
        }
        break;
      }
      case 'set_temperature':
        // Do not hardcode 'set': whatever channel the registry recorded as
        // the setpoint writer is the one to write (see pushRole above).
        if (call.value !== undefined) pushRoleNumber('setpoint', ['set', 'set_heating', 'set_cooling'], call.value, false);
        if (call.low !== undefined) pushRoleNumber('target_temp_low', ['set_heating'], call.low, false);
        if (call.high !== undefined) pushRoleNumber('target_temp_high', ['set_cooling'], call.high, false);
        break;
      case 'set_humidity':
        pushRoleNumber('target_humidity', ['humidity'], call.value, false);
        break;
      case 'set_hvac_mode':
        // No structural type guarantee (MODE can be Number- or String-typed
        // depending on the device), so no fallback type: an untyped MODE
        // takes a label only through its states map (Ruling 33).
        pushEncoded('hvac_mode', ['mode'], call.mode);
        break;
      case 'set_fan_mode':
        // SPEED (named steps) and SPEED_LEVEL (a percentage) are alternates
        // for the same role, same as light's dimmer/brightness pair.
        pushEncoded('fan_mode', ['speed', 'speed_level'], call.mode);
        break;
      case 'set_preset_mode':
        pushEncoded('preset_mode', ['preset'], call.mode);
        break;
      case 'set_swing_mode':
        pushEncoded('swing_mode', ['swing'], call.mode);
        break;
      case 'set_swing_horizontal_mode':
        // requireOnOff (commands.ts) already proved this is a strict on/off
        // choice; convert to the exact label toBoolState emits for a boolean
        // channel before encoding (an untyped toggle encodes as boolean, its
        // fixed pattern type -- roleCodec).
        pushEncoded('swing_horizontal_mode', ['swing_toggle'], call.on ? STATE_ON : STATE_OFF);
        break;
      // Each cover command writes only through the `writable` role its
      // supported_features bit is derived from (protocol/cover.ts), so a bit
      // is set exactly when its command can land.
      case 'open_cover':
        openClose(true);
        break;
      case 'close_cover':
        openClose(false);
        break;
      case 'stop_cover':
        pushRole('stop', ['stop'], true);
        break;
      case 'set_cover_position':
        pushRoleNumber('position', ['set'], call.value, true);
        break;
      case 'open_cover_tilt':
        pushRole('tilt_open', ['tilt_open'], true);
        break;
      case 'close_cover_tilt':
        pushRole('tilt_close', ['tilt_close'], true);
        break;
      case 'stop_cover_tilt':
        pushRole('tilt_stop', ['tilt_stop'], true);
        break;
      case 'set_cover_tilt_position':
        pushRoleNumber('tilt_position', ['tilt_set'], call.value, true);
        break;
      // toggle_cover and toggle_cover_tilt have no caller anywhere in the
      // firmware (allow-list only, mqtt_handlers.cpp:2270-2271), so there is
      // no UI to go looking for. A closed cover opens and an open one closes;
      // a tilt at 0 opens and any other closes (Home Assistant's rule from
      // general knowledge, UNVERIFIED against its source). With the state
      // unknown there is no right direction to move a gate or a blind in, so
      // that is refused rather than guessed.
      case 'toggle_cover':
        if (entity.state === 'closed' || entity.state === 'open') openClose(entity.state === 'closed');
        else failureReason = 'state_unknown';
        break;
      case 'toggle_cover_tilt': {
        const tilt = entity.attributes.current_tilt_position;
        if (typeof tilt !== 'number') failureReason = 'state_unknown';
        else if (tilt === 0) pushRole('tilt_open', ['tilt_open'], true);
        else pushRole('tilt_close', ['tilt_close'], true);
        break;
      }
      // Media (docs/contract-media-weather.md, media_player "Outbound
      // commands"). The panel draws previous, play/pause and next whatever
      // the player has (media_popup.cpp:774-794), so a button with no
      // writable channel is refused here, never hidden (synth/media_player.ts).
      case 'media_previous':
        pushRole('prev', ['prev'], true);
        break;
      case 'media_next':
        pushRole('next', ['next'], true);
        break;
      case 'media_play_pause': {
        // The panel's own rule (media_icon_for_state, tile_renderer.cpp:
        // 2954-2960): pause while playing, play for anything else, unknown and
        // unavailable included -- the icon the user pressed. Its button is
        // pressed; without one, a writable STATE takes the state itself.
        const target = entity.state === 'playing' ? 'paused' : 'playing';
        const button = target === 'paused' ? 'pause' : 'play';
        if (entity.writable?.[button]) pushRole(button, [button], true);
        else if (entity.writable?.state) {
          const raw = mediaStateValue(entity.channelMeta?.state, target);
          if (raw === undefined) {
            this.log.warn(`[Command] Cannot encode "${target}" for ${entity.entityId} on channel state`);
            failureReason = 'cannot_encode_value';
          } else push('state', raw);
        }
        break;
      }
      case 'media_set_volume': {
        // The mute icon sends volume_set too, never volume_mute: 0 to mute,
        // the last level it showed to unmute, with or without a slider
        // (on_volume_mute_click, media_popup.cpp:517-530). A slider released
        // at 0 sends the identical bytes (:488-490), and the panel's own model
        // counts a slider at 0 as muted (set_volume_widgets, :228-233), so it
        // is treated as a mute too: 0 mutes a player with a writable MUTE and
        // keeps the user's level. Any other level is set and ends a mute: the
        // panel shows it unmuted from then on. What cannot land is skipped out
        // loud, the rest still lands (Ruling 54's precedent): refusing the
        // whole call would leave the icon unable to unmute at all.
        //
        // With no settable volume there is no slider (disabled, :483), so the
        // icon sent this. The popup draws the absent volume as 0%
        // (tile_renderer.cpp:4327), its muted look, so the icon nearly always
        // sends its unmute level: it toggles the mute the player reports
        // instead. Only an unknown mute takes the value as said.
        if (!entity.writable?.volume && entity.writable?.mute) {
          const muted = entity.attributes.is_volume_muted;
          push('mute', typeof muted === 'boolean' ? !muted : call.value === 0);
          break;
        }
        if (call.value === 0 && entity.writable?.mute) {
          push('mute', true);
          break;
        }
        if (entity.writable?.volume) pushRoleNumber('volume', ['volume'], call.value, true);
        else {
          const why = entity.source.volume ? 'volume takes no write or declares no usable range' : 'the player has no volume channel';
          this.log.warn(`[Command] Skipping the volume of ${entity.entityId}: ${why}`);
        }
        if (call.value > 0 && entity.source.mute && entity.attributes.is_volume_muted !== false) {
          if (entity.writable?.mute) push('mute', false);
          else this.log.warn(`[Command] Not unmuting ${entity.entityId}: mute takes no write`);
        }
        break;
      }
      case 'set_value': {
        // Checked against the /control the entity has now (Ruling 99); the
        // refusal is the Bridge's status, which the panel is answered with.
        const written = valueWrite(entity, call.revision, call.value);
        if ('refusal' in written) failureReason = written.refusal;
        else push(written.channel, written.raw);
        break;
      }
      case 'media_seek': {
        // The panel sends seconds (mqttPublishMediaSeek); ioBroker's
        // media.seek is a percentage of the track. The duration the panel
        // was shown converts it -- published only while SEEK is writable --
        // and with none there is nothing to convert with, so nothing is
        // guessed.
        if (!entity.writable?.seek) break;
        const duration = entity.attributes.media_duration;
        if (typeof duration !== 'number' || duration <= 0) {
          failureReason = 'duration_unknown';
          break;
        }
        // The bar ends at the duration, and %.1f (mqtt_handlers.cpp:
        // 2058-2062) can print that end a fraction of a step past it.
        const seconds = call.position > duration && call.position - duration <= 0.1 ? duration : call.position;
        pushRoleNumber('seek', ['seek'], (seconds / duration) * 100, true);
        break;
      }
    }

    // Nothing lands when any requested value was out of range: a range with
    // one bound written would report success for a command that did not
    // happen as asked. (A brightness or colour temperature the light cannot
    // take is a different case, skipped out loud above -- Rulings 54 and 59.)
    if (outOfRange) return { writes: [], failureReason: 'value_out_of_range' };
    return { writes, failureReason };
  }
}
