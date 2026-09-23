import { createHash, randomBytes } from 'node:crypto';
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
 * Line breaks and NUL, in a state or an option. The panel drops an option
 * list holding \n or \r (:97) and ends its copy of a text at NUL (:96). A
 * select state that is no option becomes one placeholder row above the
 * options (:844-845), and a \n makes that two rows while the offset stays
 * one: every tap would then submit the option next to the one tapped
 * (:497-498).
 */
const BREAK = /[\r\n\0]/;

/** A state over 255 bytes rejects the whole message (:75). */
const showable = (state: string): string => (bytes(state) <= 255 && !BREAK.test(state) ? state : STATE_UNKNOWN);

/** The list complete by the panel's rules, or none: 1-64 unique options of 1-255 bytes (§6; :92-98). */
function completeOptions(options: unknown): string[] | undefined {
  if (!Array.isArray(options) || options.length < 1 || options.length > 64) return undefined;
  const valid = options.every((option) => typeof option === 'string' && option !== '' && bytes(option) <= 255 && !BREAK.test(option));
  return valid && new Set(options).size === options.length ? (options as string[]) : undefined;
}

/**
 * Every field but state, last_changed and revision: what the revision covers.
 * min, max, step, mode and unit are read for a number only, options for a
 * select only (:81-104); a date, time or datetime reads none.
 */
function constraints(entity: VirtualEntity, session: string): Record<string, unknown> {
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
    const options = completeOptions(attributes.options);
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

/**
 * The revision of this entity's /control payload, for Task 15 to compare a
 * command's with. It covers the constraints alone, never the value: the panel
 * abandons a drag and closes its dropdown on any revision or session change
 * (value_control.cpp:816-817), so a revision bumped per value would abort
 * every edit.
 */
export function controlRevision(entity: VirtualEntity, session: string): string {
  return digest(constraints(entity, session));
}

/**
 * The /control payload, or null when it is over the panel's 24576 bytes: the
 * caller skips the publish and warns (Ruling 96). Throws on a token of the
 * wrong length, which is this adapter's own mistake: the panel rejects the
 * whole message unless session is 32 bytes and revision 16 (:80).
 */
export function buildControlPayload(entity: VirtualEntity, session: string): string | null {
  if (bytes(session) !== 32) throw new Error(`control session must be 32 bytes, not ${bytes(session)}`);
  const fields = constraints(entity, session);
  const revision = digest(fields);
  if (revision.length !== 16) throw new Error(`control revision must be 16 characters, not ${revision.length}`);
  const payload: Record<string, unknown> = { ...fields, state: showable(entity.state), revision };
  // Epoch seconds (__init__.py:1534-1536); 0 is "never observed", not 1970.
  if (entity.lastChanged > 0) payload.last_changed = unixSeconds(entity.lastChanged);
  const text = JSON.stringify(payload);
  return bytes(text) > MAX_CONTROL_BYTES ? null : text;
}
