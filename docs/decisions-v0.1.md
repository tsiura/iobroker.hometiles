# v0.1 decision record

Forty rulings made while executing
`docs/superpowers/plans/2026-09-04-iobroker-hometiles-v0.1.md`.

Each was a judgement call taken without the owner in the loop, so each is
recorded with what it costs if it is wrong. Most were defects in the plan
itself, caught by review before reaching code; several were mistakes I
introduced and then had to correct.

Nothing here substitutes for the hardware checks listed in the README.
No physical panel has ever run this adapter.

## Ruling 1 (FINDING 1, T14/T15 shared file): T15 legitimately extends `panel-session.ts`
rather than duplicating it, and T14's subscription tests use `.to.include(...)` plus a
negative assertion naming only `cmnd/climate|cover|media|camera` — none of which T15
adds. T15's Step 5 already re-runs T14's suite. Keep the split as written; T15's
reviewer must confirm T14's suite still passes. Cost if wrong: T14's tests fail during
T15 and the fix loop catches it in round 1.

## Ruling 2 (FINDING 2, T20 io-package news): T1 already writes the 0.1.0 news entry, so
T20's "modify io-package.json (news entry)" is a no-op. T20 keeps only the
`package.json` repository/bugs/homepage additions. Cost if wrong: none; a duplicate
news write is idempotent.

## Ruling 3 (FINDING 3, T17 startup test): verified against installed @iobroker/testing
5.3.0. `tests.unit` is deprecated — "Adapter startup unit tests are no longer
supported" — and its `defineAdditionalTests` takes no arguments; the `{ suite }` /
`getHarness` API the plan used belongs to `tests.integration`, which downloads and
runs a real js-controller (network-dependent, minutes-long here). Plan patched:
T17's always-on gate is now `tests.packageFiles`, and the real adapter startup moved
to an opt-in `tests.integration` suite behind `HOMETILES_INTEGRATION=1`. The wiring
main.ts performs is already proven end to end by T19 against a real broker.
Cost if wrong: adapter startup is not gated in CI by default; T19 plus the opt-in
suite cover it, and the hardware-verification list already requires a real panel run.

## Ruling 4 (T1 tsconfig rootDir): plan specified `"rootDir": "."`, which emits
`build/src/config/options.js` and would put the adapter entry at `build/src/main.js`
while `package.json` declares `"main": "build/main.js"`. Verified by inspecting the
build output. Changed to `"rootDir": "src"` in the plan and in the repo. Cost if wrong:
none identified — this is the layout `main` and the packageFiles test already assume.

## Ruling 5 (T1 type-detector pin): plan pinned `^4.1.1`, which resolved to 4.6.4. Verified
against the installed package that 4.6.4 lacks `contact`, `coAlarm` and `pressure` —
enum members Task 5's device_class tables and Task 12's DETECTOR_TYPE_TO_DOMAIN are
written against — and lacks `DetectOptions.limitTypesToOneOf`, which Task 12 uses to stop
one bulb being detected as three tiles. Bumped the pin to `^6.0.1`, the version whose API
was verified when the plan was written. Cost if wrong: if 6.x differs from what ioBroker
adapters commonly ship against, Task 12 needs adjustment — its Step 1 already re-verifies
the enum against the installed package, so the loop catches it there.

## Ruling 6 (T1 invented LICENSE/README): the brief listed both under Create without giving
content, so the implementer wrote its own. Accepted: Task 20 replaces README.md with the
specified content, and the MIT LICENSE text is standard. Cost if wrong: a README diff in
Task 20 that is larger than planned.

## Ruling 7 (ChannelDetector export shape — raised by the T1 implementer, verified by me):
`require('@iobroker/type-detector').ChannelDetector` is `undefined` in 6.0.1; the
constructor is the DEFAULT export. Module keys are roleOrEnum*, Types, StateType,
default. Task 12's `createIoBrokerDetector` destructured the named export and would have
thrown at `new`. Patched Task 12 to take `.default` with a named fallback and a typed
`DetectorCtor`, hoisted the inline `detect` options type into a named `DetectRequest`
interface, and added the export-shape check to Task 12's Step 1 verification. Caught
before Task 12 started, so no rework. Cost if wrong: none — the fallback covers a future
version that re-adds the named export, and the explicit throw makes a third shape loud.

## Ruling 8 (T2 entityStateTopic doc comment, Important): the comment I wrote in the plan
claimed the firmware "lowercases the entity id and replaces the domain separator".
Reviewer checked buildHaStatestreamTopic directly: it does NOT lowercase (only trims)
and replaces EVERY dot in a char loop, not just the first. The comment misdescribed its
own cited source in the module that is the sole source of truth for this wire contract.
Behaviour is unchanged and correct — entity-id.ts emits `<domain>.<slug>` where slugify
collapses every non-alphanumeric run to '_', so ids always carry exactly one dot and are
already lowercase. Ruling: keep the behaviour (lowercase + first-dot-only, which fails
loudly on a malformed id rather than silently addressing the wrong entity) and correct
the comment to describe the firmware accurately and say why the two differ. Patched in
the plan and brief 2 regenerated. Cost if wrong: none behaviourally; this is a comment.

## Ruling 9 (T3 unbounded lists outside local_io, Important, plan-mandated): real and worth
fixing. I capped local_io at 64 but left `sensors`, `binary_sensors`, `scene_map` and
per-channel `legacy_entity_ids` unbounded, and never validated legacy ids at all. The
announcement is a RETAINED MQTT payload, so anything that can publish to the config topic
hands us a blob we hold until the panel is removed — one capped half and one uncapped
half is incoherent for a module whose whole purpose is defensive validation. Decisive
point: the Python bridge I ported from has MAX_LOCAL_IO_LEGACY_ENTITY_IDS = 8, so
dropping that cap was a regression against the reference implementation, not a
simplification. Ruling: add MAX_ENTITY_LIST 512, MAX_SCENE_ALIASES 256,
MAX_LEGACY_ENTITY_IDS 8 (bridge parity), and filter legacy ids through ENTITY_ID_RE.
Legacy aliases are dropped rather than throwing, matching the Python bridge's own
suppress-ambiguous-alias behaviour, because an alias is a migration aid and not
load-bearing; the count cap still throws, since an absurd list is a malformed payload.
Cost if wrong: a panel legitimately announcing >512 entities or >8 legacy aliases per
channel is rejected. Real firmware tops out at 8 hardware channels and tens of tiles, so
the headroom is roughly an order of magnitude.

## Ruling 10 (T4 orphaned-id test gap, Important, plan-mandated): real. None of the eight
specified tests covered a persisted id whose device is ABSENT from `devices` colliding
with a present newcomer — the exact scenario the reserve-then-assign two-pass design
exists for. Code was correct; the guarantee was simply unverified. Added that test plus a
reclaim-on-return assertion. Cost if wrong: none, this is added coverage.

## Ruling 11 (T4 display names split on dots, upgraded from Minor to a fix): `sourceSlug`
takes the text after the LAST dot, which is right for an object id like `hue.0.decke` but
wrong for the display name `resolveEntityIds` also fed it — a device named "Sensor v1.2"
became the entity id `sensor.2`. Entity ids are user-visible AND persisted, so a bad one
outlives the bug. Upgraded because the cost of fixing rises sharply once ids exist in the
wild: extracted a `uniqueId` helper, slugify a non-empty name whole, fall back to the
object id tail only when unnamed. `buildEntityId`'s signature and behaviour unchanged, so
existing tests still pin it. Cost if wrong: an id derived from a name now differs from
one derived from the object id for the same device — only affects ids not yet assigned.

## Ruling 12 (T5 numberToState swallows a blank as zero, Important): real and exactly the
failure this module exists to prevent. `Number('')` and `Number('   ')` are both 0 in
JavaScript, so a present-but-empty reading rendered as state "0" with available:true —
a confident zero on a wall panel for a sensor that reported nothing. Reviewer reproduced
it directly. Fixed: reject a blank string before coercion and return `unknown`. The
helper is shared, so Task 6's brightness and colour-temperature paths inherit the fix.
Cost if wrong: a source that legitimately encodes zero as an empty string now reads
unknown instead of 0 — no such encoding exists in ioBroker.

## Ruling 13 (T5 baseEntity fabricates lastChanged, Important): `lastChanged || Date.now()`
substituted wall-clock now whenever no channel had ever produced a value, and it
re-evaluates on every synthesis — so a permanently dead entity looked freshly changed on
every pass. Fixed: keep 0 to mean "never observed". Knock-on handled in Task 8, which
consumed this field: buildApplyPayload now OMITS `last_changed` when lastChanged is 0
rather than publishing unixSeconds(0), which would have told the panel the entity last
changed in 1970. Both Task 5 and Task 8 briefs regenerated. Cost if wrong: a consumer
expecting last_changed to always be present must handle its absence — only the firmware
reads it, and its parser simply does not find the key.

## Ruling 14 (T6 readNumber carried the same blank-to-zero trap — fixed BEFORE dispatch):
the Task 5 reviewer warned the coercion defect would propagate to Task 6's light.ts,
and it would have: readNumber did `Number(String(val))`, so a blank dimmer reading became
brightness 0 and would render a lamp as on at 0% instead of admitting the level is
unknown. Patched Task 6's readNumber with the same blank guard and added a covering test
before dispatching, rather than letting the review loop rediscover it. Kept the guard
local to light.ts instead of editing Task 5's committed common.ts, so the fix does not
reach across a completed task's files. Cost if wrong: none identified.
Task 6: dispatched (haiku) — BASE a999605. Returned DONE, commit 87c85fc (verified),
  11 new tests, 64 total passing, lint+build+test green. No deviations reported.
Task 6: dispatching task review — package over a999605..87c85fc.
Task 6: review — spec ✅, quality approved, no Critical/Important. Reviewer traced all 5
  capability combinations by hand and confirmed brightness scaling (0->0, 50->128,
  100->255) and the blank-guard empirically against build/registry/synth/*.js.
Task 6: minor (deferred): readNumber in light.ts duplicates the blank-string guard that
  common.ts numberToState also has — two places to keep in sync. This was my deliberate
  choice (Ruling 14): sharing one primitive would have meant editing Task 5's already
  committed common.ts. Worth revisiting at the final review: extracting a single
  toFiniteNumber helper is the tidier end state now that both tasks are closed.
Task 6: minor (deferred): on the unavailable early return in light.ts, color_mode is
  simply never set rather than explicitly omitted with a comment.
Task 6: complete (commits a999605..87c85fc, review clean)
Task 7: dispatched (haiku) — BASE 87c85fc. Returned DONE, commit f175aaa (verified),
  10 new tests, 74 total passing, lint+build+test green.
Task 7: dispatching task review — package over 87c85fc..f175aaa.
Task 7: review — spec ✅, quality approved. Reviewer independently confirmed the wire
  format against firmware (mqtt_handlers.cpp sync_external_temp_entity /
  sync_local_device_entities, tab_tiles_unified.cpp TILE_SWITCH/TILE_BINARY_SENSOR).
  One Important finding (plan-mandated), no Minor.

## Ruling 15 (T7 silent JSON fallthrough, Important, plan-mandated): the reviewer fed a
`cover` entity through the compiled module and got a silent JSON payload. Today nothing
is mishandled — Domain is closed to five members and all route correctly — but the
structure decides nothing for a domain added later, and v0.2 adds climate, cover and
media. As it happens JSON is the right shape for those three, so the default is not
wrong today; the objection is that silence is the wrong failure mode for a wire contract
whose errors show up as literal JSON text on a wall panel. Ruling: fix now rather than
defer. Replaced the two-set-plus-fallthrough with an exhaustive `payloadShape` switch
over Domain with no `default`, so adding a domain without deciding its shape fails to
COMPILE. This also matches Task 6's index.ts, which already uses exhaustive dispatch —
two modules dispatching over the same union should not disagree on how strictly they do
it. Added a runtime test pinning all five shapes. Cost if wrong: none identified; the
change is structural and behaviour-preserving for every current domain.

## Ruling 16 (T8 state_kind 'text' is not a firmware value, Important, plan-mandated): real
contract violation, and I verified it in the firmware myself rather than taking the
report. ha_bridge_config.cpp parseSensorMetaSection stores state_kind ONLY when it equals
"number" or "state"; src/types/sensor/renderer.cpp then branches on exactly those two to
choose graph vs history mode. My 'text' was silently dropped for every textual sensor, so
findSensorStateKind returned empty and the panel fell back to the unit-based heuristic in
sensor_popup_should_use_state_history — which guesses correctly only when the textual
sensor has no unit, and picks graph mode when it does. Ruling: 'text' -> 'state'. Also
corrected the Verified Firmware Contract section of the plan, which had recorded the key
without recording its permitted values — that omission is what let the wrong value in.
Cost if wrong: none; 'state' is what the firmware's own regression test asserts.

## Ruling 17 (T9 parseCommand can return undefined, Important, plan-mandated): real, and
subtle. The switch is exhaustive over its literal union so TypeScript is satisfied, but
the function is TYPED to return a ServiceCall and at runtime a caller passing a wider
string gets undefined. Reviewer reproduced it. Fixed with a `default` branch binding
`leaf` to `never` — this keeps compile-time exhaustiveness intact (adding a leaf still
fails to compile) while making the runtime fail loudly. Cost if wrong: none; the branch
is unreachable from correctly typed callers.

## Ruling 18 (T9 entity_id unbounded, Important, plan-mandated): real inconsistency. I
capped the scene alias at 128 for exactly the "hostile payload cannot allocate freely"
reason, then left entity_id — an identically-shaped untrusted string field on the same
boundary — unbounded; a 100,000-char id passed straight into a ServiceCall. Added
MAX_ENTITY_ID_LENGTH 255 with a distinct `entity_id_too_long` code. Cost if wrong: an
entity id over 255 chars is rejected; Home Assistant ids are far shorter.

## Ruling 19 (proactive audit of unimplemented tasks, made while Task 10 ran): four defect
classes have now recurred in my own plan text — blank-to-zero coercion, unbounded
untrusted fields, non-exhaustive dispatch over a union, and a wrong firmware constant.
Rather than let reviewers rediscover each one task by task, I grepped the remaining
unimplemented tasks for all four. Result: Task 15 (panel-objects, not yet dispatched)
carried the blank-to-zero defect in THREE places, because `Number('')` is 0 and 0 is
finite, so its `Number.isFinite` guards did not catch a blank payload:
  - applyPanelStat would write 0 % display brightness for a blank retained stat;
  - applyIoStat would write 0 °C for a DS18B20 channel that reported nothing — the exact
    "dead sensor reads zero on a wall panel" failure this project keeps guarding against;
  - handleControlWrite would clamp a blank write to the channel minimum.
Fixed with a shared `parseFiniteNumber` helper local to panel-objects plus three covering
tests, before dispatch. (Correction: the helper landed in commit 2b8073d but my test edit
silently failed on a bad anchor in that same step, and this ledger entry briefly claimed
the tests were in. Added in the following commit; noting it because a ledger that
overstates what landed is worse than one that says nothing.) The other three classes came back clean for tasks 11-20: the
dispatcher and admin-message switches are either exhaustive over a closed union or carry
a throwing default, and no remaining loop iterates unbounded untrusted input.
Cost if wrong: none identified; the change only narrows blank input, which had no
legitimate meaning.
Task 10: dispatched (sonnet) — BASE 66e41e2. Returned DONE_WITH_CONCERNS (b3c373d), then
  a pre-review fix round for its own flakiness concern (b505c8c). 112 total passing,
  4 consecutive runs identical, suite time fell ~705ms -> ~117ms once the fixed sleeps
  became polls.

## Ruling 20 (T10 aedes typing — implementer deviation ACCEPTED): the brief specified
`ReturnType<typeof Aedes>`, which does not compile against aedes 0.51.3 (TS2344) because
that package ships Aedes as a class, not a callable factory. The implementer deviated
correctly and reported it. Adopted into the plan with a comment, AND applied to Task 19's
integration test, which carried the identical declaration and would have failed the same
way once dispatched. Cost if wrong: none; same instance type, no behaviour change.

## Ruling 21 (T10 fixed 300ms sleeps — acted on BEFORE review): the implementer flagged two
tests that slept a fixed 300ms before asserting a loopback round trip, measured at
325-346ms locally. That margin is thin, and a fixed sleep encodes an assumption about
round-trip speed which is exactly what degrades on a loaded CI runner. Per the
DONE_WITH_CONCERNS route I addressed it before review rather than sending known-flaky
tests into one. Replaced with a `waitUntil` poll carrying a 3s deadline. Confirmed: 4
identical runs and the suite got ~6x faster because it no longer waits out the full sleep.
Cost if wrong: a genuinely slow environment now fails at 3s with a clear timeout message
instead of an assertion mismatch.

## Ruling 22 (T10 unguarded handler dispatch, Important): real, and sharper than it looks.
mqtt.js emits synchronously, so a throw from a caller-supplied message or connection
handler escapes into the library's emit() and takes down the adapter process. The reason
this matters here specifically: the protocol parsers those handlers feed — parseAnnouncement
and parseCommand — THROW BY DESIGN on malformed input, and that input arrives from the
network. Today the panel session and manager happen to catch, so nothing escapes, but the
isolation belongs at the emitter boundary rather than depending on every future consumer
remembering. Fixed: try/catch around the message dispatch and a notifyConnection helper
doing the same for the three connection-change call sites, both logging via log.error.
Added a test that throws from a handler and asserts the client stays connected and keeps
delivering. Cost if wrong: a handler bug is now logged rather than crashing, which could
mask a defect — mitigated by logging at error level with the topic.

## Ruling 23 (T11 silent partial application, Important, plan-mandated): real. A set_light
planning several writes where the second throws leaves the first applied on the real
device, yet returned {ok:false, reason:'write_failed'} — indistinguishable from "nothing
happened". Not load-bearing for v0.1 correctness: the only caller logs the reason, and
the panel self-corrects because actual state flows back through the registry. Fixed
anyway because it is precisely the information an operator needs when a user reports
"the light came on but did not dim", and a wall-panel product gets exactly that class of
vague report. DispatchResult failures now carry `applied`, plan() carries the channel
name alongside each write, and the error log names the failing channel and the count.
Also closes the reviewer's second Minor (log did not say which channel failed).
Cost if wrong: DispatchResult's failure shape changed, so any future consumer
destructuring it must account for `applied` — there is exactly one consumer today.

## Ruling 24 (T12 bare ON power channel, graded Important as plan-mandated but CRITICAL in
effect): I verified the library patterns myself. Only `light` uses SET(w) for power and
only `dimmer` uses ON_SET(w); hue, ct, cie, rgb, rgbSingle and rgbwSingle all carry power
on a bare ON(w). My channelName special-cased ON_SET but not ON, so those six types
produced a device with no `set` channel at all. Consequence traced end to end: synthLight
finds no on/off channel, and dispatcher.plan() pushes to `set`, finds nothing in
entity.source, writes nothing, and returns {ok:true, writes:0} — pressing a colour bulb
tile does nothing and reports SUCCESS, with no error anywhere in the chain. That is most
real Zigbee colour bulbs. Fixed: ON_SET and bare ON both map to `set`, with the pattern
evidence recorded in the comment; dimmer-specific SET/ACTUAL renaming narrowed to the
`dimmer` type, which is the only one that has that shape. Added a test covering all six
types plus one pinning the dimmer shape. Cost if wrong: none identified — the mapping now
matches the library's own patterns exactly.

## Ruling 25 (T6 synthLight advertised colour it cannot write — same defect class, found by
following Ruling 24): rgbSingle, rgbwSingle and cie carry colour on ONE combined channel,
but the dispatcher only writes red/green/blue. hasRgb accepted `channels.rgb`, so such a
bulb would advertise rgb, the panel would render a colour picker, and every colour write
would silently no-op exactly like the power bug. Fixed by requiring the three component
channels, so the capability is only advertised when it can actually be executed — which
is the project's own rule about never enabling a control whose backing is absent. Such
bulbs still work for on/off, brightness and colour temperature. This edits Task 6's file
after its completion; justified because the alternative is a dead control on real
hardware, and the finding only became visible from Task 12. Single-channel colour support
is deferred, recorded below. Cost if wrong: a single-channel colour bulb shows no colour
control rather than a broken one.

## Ruling 26 (T12 telemetry channels, raised by me from an end-to-end probe): not a
correctness bug — tiles rendered correctly — but every channel surviving mapping becomes
a foreign-state subscription AND a recompute trigger in the entity registry. A realistic
CT bulb mapped to 15 channels of which 4 are ever read; a power-metering bulb reports
ELECTRIC_POWER every few seconds, so each report would wake a recompute for an entity
whose rendered state cannot have changed. Fixed now rather than later specifically
because Task 13 builds the registry on this map and the cost would be baked in. Dropped
RSSI, BATTERY, ELECTRIC_POWER, CURRENT, VOLTAGE, CONSUMPTION, FREQUENCY, EFFECT,
TRANSITION_TIME, ON_TIME with a comment saying to add one back when a tile renders it.
Cost if wrong: a future battery or power tile needs its name removed from the ignore list
— a one-line change, and the comment says so.
Task 12: fix round 2/5 re-review — ADDRESSED. Reviewer cross-checked the ignore list
  against every channel the dispatcher writes and synth reads and confirmed no overlap;
  no device class can now map to zero channels; round 1 undisturbed. 148/148.
Task 12: complete (commits 8f0cc53..533780b, review clean)
Task 13: dispatched (sonnet) — BASE 533780b. Returned DONE, commit 4318a16 (verified),
  12 new tests, 160 total. Implementer verified its transcription byte-for-byte against
  the brief's code blocks programmatically, which is the right instinct.

## Ruling 27 (test isolation, raised by the T13 implementer): confirmed. `.mocharc.json`
sets `spec` to the whole test tree and mocha MERGES a file argument with it rather than
replacing it, so `npx mocha <file>` runs everything and prints the full-suite total;
`--spec` behaves the same. Only `--grep '<describe name>'` isolates (12 vs 160, verified).
Every task's "Expected: PASS, N passing" is therefore the count for that task's own
describe block, not the printed total — which is why several agents reported a number
that did not match my instruction. Added a "Running the tests" section to the plan
explaining this and giving the --grep form, so tasks 14-20 get accurate guidance.
Cost if wrong: none; the runs were always stricter than intended, never looser.

## Ruling 28 (T15 panel settings contract was wrong on THREE controls — caught by audit
BEFORE dispatch): this is the state_kind failure mode repeating, and it is my fault the
same way: the Verified Firmware Contract recorded these topics but not what the firmware
does with their payloads. I copied SLEEP_OPTIONS out of the Python bridge's const.py,
which is that bridge's UI select list, not the wire format. Read mqtt_handlers.cpp:
  - display_rotate is parseBoolPayload -> setRotationFlipped(). BOOLEAN, meaning rotated
    180 degrees. My plan declared number 0..3; writing "2" fails the parse and the
    firmware silently ignores it.
  - display_sleep is ALSO parseBoolPayload, meaning sleep now / wake. My plan declared a
    duration enum. The stat topic reports powerManager.isInSleep().
  - sleep_mains / sleep_battery use parseSleepPayload, which accepts nie/never/off/0, one
    of eight labels, OR free-form ("30s", "15min", bare seconds 1..3600). My plan allowed
    only the label list, and included "Nie" as a label when it is actually a disable word.
Every one of these would have produced a control that looks right in ioBroker and does
nothing on the panel, with no error anywhere. Fixed before dispatch: PanelSettingDef now
carries a `kind` of percent | bool | duration; object types, stat parsing and command
writing all branch on it; added a parseBoolPayload mirroring the firmware's own
vocabulary. Corrected the contract table too, since its omission is what let this in.
Cost if wrong: a duration form the firmware accepts but a user cannot discover — mitigated
by passing the text through rather than validating against a list.
Task 14: dispatched (sonnet) — BASE eed1cb4. Brief task-14-brief.md.
Task 14: dispatched (sonnet). Returned DONE_WITH_CONCERNS (4769dc4) having found that my
  reference implementation FAILS one of its own 15 tests: the forced bridge/request path
  worked only with a PanelManager attached, and that test constructs a bare session. Real
  defect in my brief, correctly diagnosed.

## Ruling 29 (T14 forced refresh — implementer's fix REVERSED): the implementer cached the
last pushed entity list and replayed it when no manager callback was wired. That makes the
test pass but is wrong in a way worth naming: lastEntities is whatever was last handed to
pushConfig, so it can be stale relative to the live registry — and a forced bridge/request
is the ONE path where freshness matters most, because the panel is asking precisely
because it believes it is out of date. Serving a cached list there is the worst available
answer. In production PanelManager always wires onRefreshRequested, so the fallback was
unreachable code whose only purpose was to satisfy a test that exercised a configuration
production never has. The test was wrong, not the design. Ruling: remove the cache, keep
the delegation, and make an unwired handler WARN rather than silently do nothing — the
silent-no-op class this project has hit repeatedly. Rewrote the test to wire a handler and
assert the republished config carries the handler's current list, plus a second test
pinning the warning. Cost if wrong: a bare PanelSession cannot self-refresh, which is
correct — it does not own the data to refresh from.

## Ruling 30 (T14 cross-panel double dispatch, Important): real defect in delivered code.
PanelManager broadcast every message to every session, and command topics are keyed by
BASE TOPIC, not device id, with base_topic defaulting to the literal 'hometiles'. Two
panels that were never given a custom device topic therefore both matched one cmnd/switch
and both dispatched — reviewer captured [["shelly.0.on",true],["shelly.0.on",true]] from
a single press. Nasty because it is invisible with one panel and, on a TOGGLE, the two
writes cancel so the tile looks completely dead. Fixed: handleMessage returns whether the
session owns the topic, the manager stops at the first match, and a duplicate base topic
warns naming both panels. I verified the fix on the reviewer's exact scenario: one write,
clash warned. Cost if wrong: if two panels legitimately shared a topic and wanted
independent status tracking, only the first would update — the firmware requires unique
base topics, and we now warn when they are not.

## Ruling 31 (T14 PanelManager had no tests, Important, plan-mandated): my plan specified
only a session test file, so the manager's entire lifecycle — announcement handling,
rejection, withdrawal, update-vs-duplicate, stopAll — was verified by reading alone. That
is how Ruling 30's defect survived to review. Added test/runtime/panel-manager.test.ts
with six cases, including one that pins the single-write behaviour so the bug cannot
return silently. Cost if wrong: none, this is added coverage.

## Ruling 32 (T15 non-finite numeric write, Important — MY regression): the reviewer found
that handleControlWrite's already-a-number branch skips the finite check, so NaN publishes
the literal string "NaN" and Infinity silently clamps to the maximum. I reproduced both.
This is a regression I introduced myself: my earlier blank-to-zero patch had
`if (numeric === undefined || !Number.isFinite(numeric)) return;`, and when I later rewrote
the function for the percent/bool/duration branching I dropped the isFinite half. Exactly
the kind of thing a rewrite loses and only a reviewer reading the final state catches.
Fixed and covered by a test. Cost if wrong: none — no legitimate caller sends NaN.
Task 15: fix round 1/5 dispatched — finding: non-finite numeric write.
Task 15: fix round 1/5 (1 addressed, 0 open — finite guard restored; commit d724eaf
  verified). 25 isolated, 47 panel-suite, 207 total.
Task 15: implementer noticed an unexpected commit (c8ccdcf) already on the branch and
  inspected it with git show rather than assuming — correct instinct. It was my plan-doc
  regeneration; the source still had the bug, which it then fixed. Worth noting that my
  habit of committing plan edits mid-task is visible to implementers and could confuse
  one that assumed a fix had already landed.
Task 15: dispatching scoped re-review — package over 25f752d..d724eaf.
Task 15: re-review — ADDRESSED. Guard on both paths, bool/duration branches byte-identical,
  legitimate writes verified empirically (0 -> "1" clamped, 42 -> "42", 900 -> "100"),
  non-finite all rejected. Task 14 suite unaffected. 207/207.
Task 15: complete (commits 602fb4f..d724eaf, review clean)
Task 16: dispatched (haiku) — BASE d724eaf. Returned DONE, commit d56b7f2 (verified),
  8 new tests, 215 total, lint+build+test green.
Task 16: dispatching task review — package over d724eaf..d56b7f2.
Task 16: review — spec ✅, quality NEEDS FIXES. Reviewer re-verified the provisioning
  contract against firmware source itself (web_admin.cpp routes, the six field names in
  web_admin_handlers.cpp, the 303 on save, and network_manager.cpp:599 confirming
  mqtt_enabled really is latched at boot), and proved credential-leak safety and timer
  cleanup empirically. One Important, one Minor.

## Ruling 33 (T16 host confusion — SECURITY, and worse than the reviewer scoped it): the
reviewer found normaliseHost only strips scheme and trailing slash, so
`trusted-panel.lan@attacker.example` resolves under URL rules to attacker.example with the
first half discarded as userinfo — credentials POSTed to the wrong host. It judged this
"not currently attacker-reachable" because v0.1's host is admin-typed. That is true of ONE
caller. The other is the control.pair button, which passes `session.ip` — and that value
comes from the panel's retained stat/ip MQTT message, stored verbatim with no validation
(panel-session.ts:182). So the full chain is: publish to <base>/stat/ip, wait for the user
to press pair, and the adapter POSTs its broker credentials off-network. I confirmed the
URL parse resolves to attacker.example. Ruling: fix BOTH layers rather than only the one
flagged — a strict host[:port] validator refusing @, paths, queries, fragments and
whitespace, applied in pushCredentials AND when storing stat/ip, so neither a typo nor a
hostile retained message can redirect credentials. Cost if wrong: an IPv6 literal or an
unusual hostname is refused; the firmware reports IPv4, and the refusal is logged.

## Ruling 34 (T17 packageFiles gate landed before its own prerequisites — MY sequencing
defect): the implementer left 5 failures arguing the metadata belongs to Tasks 18 and 20.
The ownership reading was fair, but I introduced the tests.packageFiles gate in Task 17
and scheduled `repository` for Task 20 while never scheduling common.icon/extIcon at all,
so the branch went red the moment the gate landed. A gate must be satisfiable by the task
that introduces it, and a red suite between tasks is worse than a scope smudge because the
next implementer can no longer tell what they broke. Moved the metadata into Task 17,
removed it from Task 20, and added a placeholder admin/hometiles.png so common.icon does
not point at a missing file. Cost if wrong: the placeholder icon and the assumed GitHub
URL both need replacing before publishing; both are flagged in the plan and the report.

## Ruling 35 (T17 .mocharc.cjs — implementer deviation ACCEPTED): Node 22.6+ strips types
natively and, with no `type` field in package.json, sniffs import/export syntax to decide
a file is ESM. Mocha tries dynamic import() before falling back to require(), so a
CommonJS-authored .ts spec using __dirname — which the @iobroker/testing callers do — is
misloaded as ESM and crashes. The implementer converted .mocharc.json to .mocharc.cjs and
disables native type stripping, guarded by process.allowedNodeEnvironmentFlags rather than
a version comparison, so it is a no-op on the supported Node 20 line. Correct diagnosis
and the right shape of guard. Folded into the plan (Task 1) so it stops being an
undocumented deviation. Cost if wrong: none identified; CI covers 20.x and 22.x.

## Ruling 36 (T18 i18n test checks the wrong direction, Important, plan-mandated): my test
asserts en.json and de.json have matching key sets, which says nothing about whether they
cover what jsonConfig.json actually references. A label added to the config and omitted
from BOTH files leaves the two in perfect agreement while the UI renders a raw key id —
the silent-failure shape this whole project keeps hitting, now in the test rather than the
code. The artifacts are correct today (reviewer verified 37/37 by hand); the coverage hole
is what gets fixed. Added a walk collecting label/title/text/help values from the config
and asserting each exists in both files, with a floor so the walk cannot pass by finding
nothing. Cost if wrong: a literal non-key string used as a label would now fail the test —
none exists, and the project rule is that all user-facing strings are translation keys.

## Ruling 37 (T19 leaked client hangs the suite on the failure it exists to catch,
Important): the `late` mqtt client is closed on the test's LAST line, which runs only on
the success path. When the assertion throws, the connection stays open and aedes'
server.close() waits for it forever, so afterEach hangs. The reviewer reproduced this
live during its mutation check: mocha hit its 20s hook timeout and the node process
survived until kill -9. So the test guarding retained state HANGS instead of failing
exactly when a retained-state regression trips it — a failure mode worse than having no
test, because a hang reads as infrastructure trouble rather than a caught defect. Fixed by
tracking the client in the describe scope and closing it in afterEach, with a comment at
the old close site explaining why it is deliberately absent. Cost if wrong: none.

## Ruling 38 (T19 fixed 400ms sleep, Minor but fixed properly): the malformed-announcement
test slept a fixed 400ms, against this project's own convention — fixed sleeps were
replaced with bounded polls in Task 10 and the suite got ~6x faster. You cannot poll for
something NOT happening, so the fix inverts it: publish the malformed announcement, then a
VALID one, and wait for the valid session to appear. MQTT preserves order on a single
connection, so once the good announcement has been handled the bad one certainly has been
too. Deterministic, and no magic number to tune.
Task 19: fix round 1/5 dispatched.
Task 20: dispatched (sonnet) — docs only. Returned DONE, commit 9a352bd (verified),
  279 total passing, zero failures, src/ and test/ untouched (git show --stat confirms).
  docs/protocol.md verified byte-identical to the plan's Verified Firmware Contract.
  README carries the two release blockers (placeholder icon, unverified GitHub URLs) and
  the single-channel-colour scope note, verified against synth/light.ts.
Task 20: the implementer correctly ignored the concurrent Task 19 fix commit rather than
  reacting to it, and confirmed it never touched its own scope. Running an implementer and
  a review concurrently on disjoint files worked, but only because both were told to expect
  it — worth doing deliberately rather than by accident.
Task 19: fix round 1/5 (2 addressed, 0 open; commit a8012a3 verified, test file only).
  5 isolated, 279 total, 4 runs with no variance. Suite time fell ~900ms -> ~550ms because
  the fixed 400ms sleep became a ~40ms deterministic wait.
Task 19: the implementer verified the actual property that mattered — with the assertion
  deliberately broken the suite FAILS AND EXITS (exit code 1, 2.19s) instead of hanging.
  I repeated that check myself independently with a 60s timeout to be certain it was not
  merely faster but genuinely non-hanging.
Task 19: dispatching scoped re-review — package over e1b0637..a8012a3.
Task 19: re-review — both ADDRESSED. lateMqtt is nulled before closing so a throw during
  teardown cannot leak into the next test; the replaced-device-id announcement is genuinely
  valid JSON so the new malformed test is not vacuous; other four tests unchanged; malformed
  case went from 401ms to ~40ms. 279/279.
Task 19: complete (commits cb02d2e..a8012a3, review clean)
Task 20: review — spec ✅, quality NEEDS FIXES on one Important omission. Reviewer verified
  EVERY factual claim in protocol.md and README against adapter and firmware source and
  found them all true, then flagged what was missing rather than what was wrong.

## Ruling 39 (T20 docs never disclosed zero hardware testing, Important): the scope table
marks eight rows "supported", all verified against the firmware's parser rules and an
in-process broker and nothing else. My plan's "Hardware Verification Still Required" list
lived only in the internal plan and never reached shipped docs, so a reader would
reasonably conclude these tile types work on a real panel. An omission rather than a
falsehood, but the one this project's own rules single out: a compile and a green suite
are not evidence of runtime behaviour on a device. Fixed by adding a "What supported means
here" section immediately after the scope table carrying the five outstanding hardware
checks and the line that v0.1 is ready to test rather than ready to rely on. Worth
recording that I had been stating this honestly in my updates to the user while the
shipped artifact did not say it anywhere — the internal record was honest and the
deliverable was not, which is the gap that matters.

## Ruling 40 (final fix wave, ONE dispatch per the skill): applied all nine fixes —
  1 no_writable_channel guard + buttonSensor unmapped (its pattern is PRESS(r)/PRESS_LONG(r),
    so it could never produce a writable channel; every Zigbee wall remote was a dead scene
    tile reporting success). Verified: now {ok:false,reason:'no_writable_channel'}.
  2 state_kind derived from the declared type rather than a transient state string. Verified:
    a numeric sensor unavailable at startup now reports state_kind number, so the panel
    renders a graph instead of a permanent categorical timeline.
  3 dimmer ?? brightness on both read and write.
  4 scene aliases merged across panels instead of last-panel-wins.
  5 a withdrawn panel's objects removed via a new onPanelRemoved dep.
  6 absent-value fallbacks aligned with switch.ts across light/sensor/binary_sensor.
  7 blank relay stat no longer reads as OFF.
  8 energy: [] added so a migrated panel does not keep stale sources. Verified present.
  9 dispose() clears slots/watchers/values.
  Commit 6ce6b69, 301 passing, zero failures (279 + 22 new tests).
  The implementer reported two justified scope extensions: fixing apply.ts alone would NOT
  have fixed defect 2, because synthSensor only set state_class on the available path — it
  found that by writing the test first and watching it fail. And the scene-alias merge lives
  in its own module because main.ts's module.exports guard makes its named exports
  untestable. Both are better calls than what I specified.
