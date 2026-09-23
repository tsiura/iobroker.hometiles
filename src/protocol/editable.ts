import { createHash, randomBytes } from 'node:crypto';
import { UNSHOWABLE } from '../registry/synth/editable';
import type { VirtualEntity } from '../registry/types';
import { STATE_UNKNOWN } from '../registry/types';
import { unixSeconds } from './apply';

/**
 * The /control payload of number, select and datetime
 * (docs/contract-editable.md §3, §5, §6, §8), retained on
 * <haPrefix>/<domain>/<object_id>/control. The panel's parse_editable_value
 * (HomeTiles src/types/value/value_control.cpp:63-107) is the judge: it
 * rejects the whole message, or strips a capability, on any single mistake,
 * and never logs why. The Bridge's build_editable_payload
 * (editable_helpers.py:48-97) is the reference sender; where the two differ,
 * this follows the panel.
 *
 * The state is always a string. An unknown value is "unknown", available and
 * writable by its constraints; a bad-quality one "unavailable" (the synth's
 * state and `available`, Rulings 88 and 91). A JSON null would make the
 * panel show "--" and refuse every edit (:72, :76), so a fresh helper could
 * never be set.
 */

/** value_control.h:8. A longer payload is dropped without a log (mqtt_handlers.cpp:1459). */
export const MAX_CONTROL_BYTES = 24576;

/**
 * One token per process, as the Bridge keeps one per Home Assistant run
 * (__init__.py:1077). A new one tells the panel its constraints changed
 * (value_control.cpp:816), and lets a command from before a restart be told
 * apart (Task 15).
 */
export const CONTROL_SESSION = randomBytes(16).toString('hex');

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * A state over 255 bytes rejects the whole message (:75), and so does one
 * with a lone surrogate the panel counts longer than Node (UNSHOWABLE, the
 * synth's rule for options). A select state that is no option becomes one
 * placeholder row above the options (:844-845); a line break makes that two
 * rows while the offset stays one, so every tap would submit the option
 * below the one tapped (:497-498). NUL ends the panel's copy (:73).
 */
const showable = (state: string): string => (bytes(state) <= 255 && !UNSHOWABLE.test(state) ? state : STATE_UNKNOWN);

/** The list complete by the panel's rules, or none: 1-64 unique options of 1-255 bytes (§6; :92-98). */
function completeOptions(options: unknown): string[] | undefined {
  if (!Array.isArray(options) || options.length < 1 || options.length > 64) return undefined;
  const valid = options.every((option) => typeof option === 'string' && option !== '' && bytes(option) <= 255 && !UNSHOWABLE.test(option));
  return valid && new Set(options).size === options.length ? (options as string[]) : undefined;
}

/**
 * Every field but state, last_changed and revision: what the revision covers.
 * min, max, step, mode and unit are read for a number only, options for a
 * select only (:81-104); a date, time or datetime reads none. Without
 * `withOptions` a select's list is left out (Ruling 98).
 */
function constraints(entity: VirtualEntity, session: string, withOptions: boolean): Record<string, unknown> {
  const { attributes } = entity;
  const fields: Record<string, unknown> = {
    version: 1,
    kind: entity.domain,
    available: entity.available,
    writable: entity.available && entity.writable?.value === true,
    session,
  };
  if (entity.domain === 'number') {
    for (const key of ['min', 'max', 'step']) {
      const bound = attributes[key];
      if (typeof bound === 'number' && Number.isFinite(bound)) fields[key] = bound;
    }
    // ioBroker has no number mode: the panel's own default (:87).
    fields.mode = 'auto';
    // The panel blanks a unit over 128 bytes (:89).
    const unit = attributes.unit_of_measurement;
    if (typeof unit === 'string' && unit !== '' && bytes(unit) <= 128) fields.unit = unit;
  } else if (entity.domain === 'select') {
    // Without the list the panel makes the select read-only (:102-103).
    const options = withOptions ? completeOptions(attributes.options) : undefined;
    if (options) Object.assign(fields, { options_complete: true, options });
    else fields.writable = false;
  } else if (entity.domain === 'datetime') {
    // Home Assistant's input_datetime flags name the kind. Without either
    // (a text in no calendar shape, read-only) the domain's own.
    const date = attributes.has_date === true;
    const time = attributes.has_time === true;
    fields.kind = date && !time ? 'date' : time && !date ? 'time' : 'datetime';
  }
  return fields;
}

/** The first 16 hex of sha256 over the sort-keyed JSON: the Bridge's rule (editable_helpers.py:94-96). */
function digest(fields: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(fields, Object.keys(fields).sort())).digest('hex').slice(0, 16);
}

/** The payload for these fields, and its revision. */
function render(entity: VirtualEntity, fields: Record<string, unknown>): { text: string; revision: string } {
  const revision = digest(fields);
  if (revision.length !== 16) throw new Error(`control revision must be 16 characters, not ${revision.length}`);
  const payload: Record<string, unknown> = { ...fields, state: showable(entity.state), revision };
  // Epoch seconds (__init__.py:1534-1536); 0 is "never observed", not 1970.
  if (entity.lastChanged > 0) payload.last_changed = unixSeconds(entity.lastChanged);
  return { text: JSON.stringify(payload), revision };
}

/**
 * The payload the panel gets. Over its limit, the same without the option
 * list (Ruling 98): the select turns read-only and still shows its current
 * state. Skipping it instead would leave the last payload up, writable, with
 * every command against its revision refused. Throws on a session of the
 * wrong length, this adapter's own mistake: the panel rejects the whole
 * message unless session is 32 bytes and revision 16 (:80).
 */
function build(entity: VirtualEntity, session: string): { text: string; revision: string; degraded: boolean } {
  if (bytes(session) !== 32) throw new Error(`control session must be 32 bytes, not ${bytes(session)}`);
  const whole = render(entity, constraints(entity, session, true));
  if (bytes(whole.text) <= MAX_CONTROL_BYTES) return { ...whole, degraded: false };
  return { ...render(entity, constraints(entity, session, false)), degraded: true };
}

/**
 * The revision of this entity's /control payload, as published, for Task 15
 * to compare a command's with. It covers the constraints alone, never the
 * value: the panel abandons a drag and closes its dropdown on any revision or
 * session change (value_control.cpp:816-817), so a revision bumped per value
 * would abort every edit.
 */
export function controlRevision(entity: VirtualEntity, session: string): string {
  return build(entity, session).revision;
}

/** A /control payload, and whether its option list was left out to fit (Ruling 98). */
export interface ControlPayload {
  payload: string;
  degraded: boolean;
}

export function buildControlPayload(entity: VirtualEntity, session: string): ControlPayload | null {
  const { text, degraded } = build(entity, session);
  // Cannot happen: the option list is the only unbounded part, and without
  // it a payload stays under 3 kB -- a state of at most 255 bytes, 1530 on
  // the wire as control characters, a unit of at most 128 (768), and fixed
  // fields. Null is only there so that a payload the panel would drop is
  // never sent.
  return bytes(text) > MAX_CONTROL_BYTES ? null : { payload: text, degraded };
}
