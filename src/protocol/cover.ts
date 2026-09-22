import type { VirtualEntity } from '../registry/types';

/**
 * Cover shares climate's full-overwrite cache (docs/contract-climate-cover.md,
 * "The overwrite problem (cover)"; firmware `apply_state`,
 * src/types/cover/renderer.cpp:267-291): a valid payload fully replaces the
 * cached `CoverState`, so a known value must go out on every publish, and an
 * unknown one must be omitted rather than defaulted -- position/tilt revert
 * to 0 (with their has_* flags cleared) the moment a payload omits them.
 *
 * The one rule task 7 exists to enforce: `parse_cover_payload`
 * (renderer.cpp:124-137) is an if/else on whether `supported_features` is
 * present in the SAME message, not a merge:
 *   - present  -> used exactly as given, clamped 0-255, no inference at all.
 *   - absent   -> synthesized as OPEN|CLOSE|STOP, PLUS SET_POSITION if
 *                 `current_position` appeared in that message, PLUS the four
 *                 tilt bits if `current_tilt_position` appeared -- from mere
 *                 key presence, regardless of whether that value came from a
 *                 writable channel.
 * synthCover (src/registry/synth/cover.ts, Ruling 27) deliberately keeps a
 * gate's numeric ACTUAL as `current_position` even though the gate's SET can
 * only open/close -- real telemetry Home Assistant reports independently of
 * being able to command a position. Omitting `supported_features` here would
 * let the firmware infer SET_POSITION from that telemetry alone and draw a
 * slider the gate can never obey. So this module always emits an explicit
 * `supported_features`, computed from `writable` (what can actually be
 * commanded), never from which attributes merely appeared.
 */

/**
 * Non-cover attributes this module knows are safe to forward verbatim: the
 * only two plain-metadata keys synthCover's baseEntity ever sets (see
 * synth/common.ts). An explicit allow-list, not an exclude-list, for the
 * same reason as climate.ts's PASSTHROUGH_KEYS: an open-ended pass-through
 * would also forward things like a spoofed `supported_features` attribute,
 * defeating the computed mask above.
 */
const PASSTHROUGH_KEYS = ['friendly_name', 'icon'] as const;

/**
 * CoverFeature bit values, verified directly against the firmware header
 * (read-only reference repo) `src/types/cover/state.h:7-14`:
 *   COVER_FEATURE_OPEN = 1U << 0, COVER_FEATURE_CLOSE = 1U << 1,
 *   COVER_FEATURE_SET_POSITION = 1U << 2, COVER_FEATURE_STOP = 1U << 3,
 *   COVER_FEATURE_OPEN_TILT = 1U << 4, COVER_FEATURE_CLOSE_TILT = 1U << 5,
 *   COVER_FEATURE_STOP_TILT = 1U << 6, COVER_FEATURE_SET_TILT_POSITION = 1U << 7.
 * Cross-checked against docs/contract-climate-cover.md's own table (same
 * file, same line range) and against every `has_feature(ctx, COVER_FEATURE_*)`
 * call site in src/ui/popups/cover/cover_popup.cpp. Reproduced as plain
 * numbers because state.h is C++ and cannot be imported here.
 */
const COVER_FEATURE_OPEN = 1 << 0; // 1
const COVER_FEATURE_CLOSE = 1 << 1; // 2
const COVER_FEATURE_SET_POSITION = 1 << 2; // 4
const COVER_FEATURE_STOP = 1 << 3; // 8
const COVER_FEATURE_OPEN_TILT = 1 << 4; // 16
const COVER_FEATURE_CLOSE_TILT = 1 << 5; // 32
const COVER_FEATURE_STOP_TILT = 1 << 6; // 64
const COVER_FEATURE_SET_TILT_POSITION = 1 << 7; // 128

/**
 * `writable` role name (src/registry/synth/cover.ts's setWritable calls) to
 * the CoverFeature bit it authorises. The sum of all eight bits is exactly
 * 255, so the mask this builds can never need the firmware's own 0-255 clamp
 * (renderer.cpp:125-127) to stay in range.
 */
const FEATURE_BY_ROLE: ReadonlyArray<readonly [role: string, bit: number]> = [
  ['open', COVER_FEATURE_OPEN],
  ['close', COVER_FEATURE_CLOSE],
  ['position', COVER_FEATURE_SET_POSITION],
  ['stop', COVER_FEATURE_STOP],
  ['tilt_open', COVER_FEATURE_OPEN_TILT],
  ['tilt_close', COVER_FEATURE_CLOSE_TILT],
  ['tilt_stop', COVER_FEATURE_STOP_TILT],
  ['tilt_position', COVER_FEATURE_SET_TILT_POSITION],
];

function supportedFeatures(writable: Record<string, boolean> | undefined): number {
  if (!writable) return 0;
  let mask = 0;
  for (const [role, bit] of FEATURE_BY_ROLE) {
    if (writable[role] === true) mask |= bit;
  }
  return mask;
}

/**
 * Number('') and Number('   ') are both 0 and finite, so a blank reading
 * must resolve to "no value", never a confident zero-percent (fully closed)
 * position -- identical guard to climate.ts's usableNumber and
 * synth/cover.ts's own readNumber.
 */
function usableNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return undefined;
    const numeric = Number(text);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  return undefined;
}

/**
 * Builds the complete cover MQTT state payload for one entity. Pure
 * formatting: no ioBroker or MQTT imports (enforced by eslint for
 * src/protocol/**).
 */
export function buildCoverPayload(entity: VirtualEntity): string {
  const attrs = entity.attributes;
  const body: Record<string, unknown> = {};

  // Explicit allow-list forward -- see PASSTHROUGH_KEYS above.
  for (const key of PASSTHROUGH_KEYS) {
    const value = attrs[key];
    if (typeof value === 'string' && value.length > 0) body[key] = value;
  }

  // state/available: always known for a VirtualEntity (never null/undefined
  // -- registry/types.ts), and read by the firmware as the cover's real
  // open/closed/opening/closing state, not a fallback name for something
  // else the way climate's "state" key is -- so, unlike climate.ts, forwarding
  // it verbatim here is correct and required on every publish.
  body.state = entity.state;
  body.available = entity.available;

  // current_position/current_tilt_position: emit the real value when known,
  // omit otherwise -- never fabricate one, and never let a blank/non-finite/
  // null reading through as a confident zero. 0 is kept as a real value.
  const currentPosition = usableNumber(attrs.current_position);
  if (currentPosition !== undefined) body.current_position = currentPosition;

  const currentTilt = usableNumber(attrs.current_tilt_position);
  if (currentTilt !== undefined) body.current_tilt_position = currentTilt;

  // The central rule: always explicit, computed from what can actually be
  // commanded (`writable`), never omitted and never inferred from which
  // attributes happen to be present above.
  body.supported_features = supportedFeatures(entity.writable);

  return JSON.stringify(body);
}
