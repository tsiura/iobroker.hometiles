# v0.2 execution rulings (ioBroker.hometiles)

Every decision the controller took on the maintainer's behalf while
executing `2026-09-22-iobroker-hometiles-v0.2.md`, copied verbatim from the
execution ledger (which is deleted once the branch is finished). Each entry
states what was decided, why, and, where recorded, what it costs if the
decision was wrong. Later rulings can supersede earlier ones; the entry says
so where it happens. Review these and rework whatever is wrong.

- Ruling 1 (CONFLICT 1, T12 dangling name): T12's tests reference
- Ruling 2 (CONFLICT 2, T12/T22 subscription ownership): T22 owns ALL request
- Ruling 3 (CONFLICT 3, T19/T23 config overlap): T19 owns the `historyInstance`
- Ruling 4 (CONFLICT 4, sample value type): `HistoryProvider.query` returns
- Ruling 5 (CONFLICT 5, buildValueAck signature): the ack topic is
- Ruling 6 (T8 dead commands, pre-emptive): `toggle` and `toggle_cover_tilt`
- Ruling 7 (T2 deviation ACCEPTED, verified by me): the brief said to add a
- Ruling 8 (T2 out-of-brief test edit ACCEPTED): test/registry/overrides.test.ts
- Ruling 9 (my plan defect, found by the T2 reviewer): Task 2's Step 1 test
- Ruling 10 (T3 duplicate SWING axis — UNVERIFIABLE, shipping a default):
- Ruling 11 (T3 MODE vs WORKING_MODE split ACCEPTED): the implementer mapped
- Ruling 12 (MY process error, caught before damage): I dispatched Task 3's
- Ruling 13 (MY plan defect, TWO parts — found by the implementer and by me):
- Ruling 14 (I2 — where a lone setpoint belongs): a device with exactly ONE of
- Ruling 15 (M4, M5, M6, M7 folded into the open round): Minors never OPEN a
- Ruling 16 (MY plan gap, surfaced by the Task 5 implementer): the plan never
- Ruling 17 (Task 5 setpoint model — two encodings accepted, pinned by test):
- Ruling 18 (M6 generalisation ACCEPTED): I ruled that synthClimate mirror the
- Ruling 19 (MY error, attribution): I instructed a Sonnet 5 subagent to sign
- Ruling 20 (N2 — REVISES my own Ruling 14): Ruling 14 said a device with SET
- Ruling 21 (CRITICAL, found by me while adjudicating Task 5's fan_mode note —
- Ruling 22 (re-review batching): round 1's scoped re-review was not yet
- Ruling 23 (channelMeta must be threaded by every synth — CARRY FORWARD):
- Ruling 24 (Task 5 round-2 judgement calls — ACCEPTED, re-review to probe):
- Ruling 25 (Task 5 round 3 scope): both new Importants are mandatory. Fold in
- Ruling 26 (NEW TASK 5b — climate controls are unreachable; production gap):
- Ruling 27 (the "Critical" is resolved in Task 7, not by discarding data):
- Ruling 28 (root cause of the Important — decide by channel TYPE, not
- Ruling 29: commit history left as-is — a cosmetic count is not worth a
    history rewrite on a shared index; the report is the record. Cost if
    wrong: a slightly wrong number in a message.
- Ruling 30 (round-4 scope — cover EVERY documented states format): I checked
- Ruling 31 (the implementer DECLINED my literal Ruling 30 for arrays —
- Ruling 32 (Task 6's deferred string/mixed SET Minor is now LOAD-BEARING —
- Ruling 33 (C1 — Ruling 30's premise was WRONG; fix at the encoder): Ruling 30
- Ruling 34 (C2 — CRITICAL, CROSS-CUTTING, PRE-EXISTING SINCE v0.1 — verified
- Ruling 35 (C3 — PRE-EXISTING since v0.1, verified by the same probe): in
- Ruling 36 (Task 5b round-1 scope — make "advertised" and "commandable" the
- Ruling 37 (SEVERITY OF RULING 34, VERIFIED BY ME against the real ioBroker
- Ruling 38 ((a) — one guard, in the shared write path, for EVERY domain):
- Ruling 39 (NEW TASK 5d — detection orchestration): (b), (c), (d) and (f) all
- Ruling 40 (REVISES my Ruling 39's prescribed mechanism): Ruling 39 said
- Ruling 41 (CORRECTS my own Ruling 36 — a validation loosening at a trust
- Ruling 42 (product decisions, made and surfaced — the user may reverse):
- Ruling 43 (I1 — MOOT, with proof): I1 says v0.1 ran device roots first, so
- Ruling 44 (I3 — REVISES my Ruling 42(a)): 42(a) kept secondary buttons on
- Ruling 45 (I2 + M1 — an entity id, once assigned, stays with its physical
- Ruling 46 (M2 — composites survive): drop an ancestor-root detection as a
- Ruling 47 (Task 8's out-of-brief changes ACCEPTED — both were necessary):
- Ruling 48 (CORRECTS my Ruling 47(d) — I misread the implementer's report,
- Ruling 49 (Task 8 round-1 scope — numeric values at the command boundary):
    1. ONE shared linear scaling helper between a channel's declared min/max
       and the panel's 0..100, used in BOTH directions (publish and write), with
       min/max carried in channelMeta. Applied to cover position, cover tilt
       AND the v0.1 light dimmer — the same bug in three places is fixed once,
       not patched per caller. 0..100 channels are the identity by construction,
       so nothing correct changes. Not the reviewer's stopgap (withholding
       control from non-0..100 devices): scaling is the actual fix.
    2. M1: extend Ruling 41 to UNMAPPED channels for the label commands — with
       no list published, the panel can only ever send the current value, so
       anything else is refused. For the NUMERIC commands (setpoint, humidity,
       position, tilt, brightness), refuse a value outside the channel's
       declared range after scaling. Refuse rather than clamp: clamping would
       silently write something other than what was asked and report success.
       The real panel already constrains itself to the ranges it is sent.
    3. M2: before dispatching a command, flush any pending recompute for the
       target entity, so the current value Ruling 41 relies on is never stale.
    4. M3: a light advertises brightness, colour and colour temperature only
       when that channel's write is not false — "advertised = commandable"
       (Ruling 36) for v0.1 lights.
- Ruling 50 (M4's test wording — my wording was SELF-CONTRADICTORY, the
- Ruling 51 (the Critical has TWO roots; fix both): a persisted value the
- Ruling 52 (Ruling 46 refined — `info` is a catch-all, not a composite):
- Ruling 53 (the implementer's two out-of-brief changes — one accepted, one
- Ruling 54 (Ruling 53(b)'s reversal — partial success, never silent): the
- Ruling 55 (degenerate bounds — treat percentage and absolute channels
- Ruling 56 (CORRECTS my Ruling 51(b) — containment must not publish an empty
- Ruling 57 (CORRECTS my Ruling 52(2) — over-precise, the fourth time): Ruling
- Ruling 58 (fold startup robustness into round 3 — ONE theme: the adapter
- Ruling 59 (colour temperature — make the panel and the adapter agree, and
- Ruling 60 (5d round-3 concerns):
- Ruling 61 (prevention, structural rather than a guess at the culprit):
    (a) every dispatch from here states that the shell starts in the
        read-only HomeTiles repo, requires absolute paths into the adapter
        repo, requires temp files in the session scratchpad, and forbids
        setting TMPDIR (or any cache dir) inside HomeTiles;
    (b) the final fix wave pins the integration harness to an absolute,
        git-ignored directory inside the adapter repo, independent of the
        caller's TMPDIR and cwd;
    (c) I check `git -C HomeTiles status --short` after every subagent that
        runs code, not only at the end.
- Ruling 62 (Task 5d round 4 — scope, and escalation per the skill):
- Ruling 63 (ROOT CAUSE OF THE HOMETILES POLLUTION — VERIFIED by me): the Task 8
- Ruling 64 (MY plan defect, the implementer's correction ACCEPTED): my Task 9
- Ruling 65 (Task 9 round 1 — the payload must reflect real change, and no
- Ruling 66 (the refresh is TICK-DRIVEN, not a timer — the implementer's
- Ruling 67 (I1 — withhold, do not convert): grant writable.seek only when
- Ruling 68 (out-of-order dispatch, to keep the writer slot busy): Task 12
- Ruling 69 (Task 11 round 1): fix I1 NOW, before Task 12 builds on it — keep
- Ruling 70: a malformed range (zero/negative/non-finite hours or
    period_minutes, or more than 288 buckets) yields NO response — the builder
    returns null and the Task 22 caller skips the publish — instead of
    values: [] — why: the firmware never sends such a range (popup 24/5/288 or
    168/60/168, tile graph 24/5/288), so only a foreign client can, and because
    the tile graph applies any response with a matching entity_id and no range
    gate, values: [] would wipe that entity's tile graph on the requesting
    panel; silence costs nothing since no firmware UI waits on a malformed
    request. The 288 cap is exact for the unchanged firmware — cost if wrong:
    a client that expects an empty answer to a bad request gets none (none
    known). Goes into Task 17 fix round 1 with the reviewer's findings.
- Ruling 71: accept omitting unit/current from numeric history responses —
    why: optional keys; the popup keeps its own unit and live-value label —
    cost if wrong: a history view opened before any state arrives shows no
    unit until the state lands.
- Ruling 72: Task 12 builds NO hourly-to-daily aggregation — why: ioBroker's
    weather patterns carry no hourly data (Task 11 finding), and each forecast
    day comes from the provider's own daily TEMP_MAX/TEMP_MIN, already daily
    extrema; the brief's hourly test is replaced by: day-0 temperature/templow
    are the provider's day-0 max/min and an absent one stays absent (never
    filled from the current reading) — cost if wrong: a future hourly-only
    source would need the aggregation added then.
- Ruling 73: the provider-to-canonical condition mapping (HA's 15 values) is in
    Task 12 — why: the firmware derives the icon and the localized label only
    from a canonical condition; provider icons (URLs, codes) are never sent as
    `icon` (the Bridge sends mdi icons derived from the condition); unmapped
    text is sent as-is so the panel still shows it — cost if wrong: weather
    tiles show raw provider text with no icon.
- Ruling 74: forecast dates go out as date_local (host-local YYYY-MM-DD, like
    the Bridge's _forecast_entry_local_date) for an entry whose date parses
    unambiguously; if any entry of a payload has no usable date, none carries
    one (the firmware's arrival-order fallback misorders mixed sets) — cost if
    wrong: an undated source whose first day is tomorrow shows it under today.
- Ruling 75: I-1 option A — every empty period carries the reading in effect
    (the last numeric sample before it, the pre-window reading included); null
    only while no reading exists yet — why: ioBroker history adapters commonly
    log on change only, the firmware draws no mid-series gap anyway (it copies
    the previous element), so a null there can only ever show a stale mean;
    Bridge parity is not a reason to keep a Bridge defect; worst case payload
    is unchanged (~7.8 KB, 288 numbers) — cost if wrong: none visible; a few
    hundred bytes more per response.
- Ruling 76: accept the "" placeholders (firmware wins over Ruling-4 wording)
    — why: first-match scanner verified; omission shows day 0's values as
    current — cost if wrong: a reader that renders "" as text instead of "--";
    the reviewer verifies every reader. Contract fix waits for that check.
- Ruling 77: accept C2/C3 as implemented — why: firmware is the authority;
    the condition gaps degrade to text without icon — cost if wrong: a clear
    night shows a sun icon on text-only providers.
- Ruling 78: a non-numeric sample does not end the carry (hold last numeric
    value), as implemented — why: matches Ruling 75's wording and the standard
    hold-last-value convention; the firmware cannot draw a gap mid-series
    anyway — cost if wrong: a window that opens mid-outage shows the
    pre-outage value across the outage instead of a back-filled later one.
- Ruling 79: M5 split — (a) FIX: OWM publishes a numeric epoch-ms `date`
    beside the weekday strings `day`/`day_short`, all role date.forecast.N
    (io-package.json instanceObjects); the synth must prefer the numeric
    epoch and Task 12's normaliser must accept an epoch-ms number as an
    instant — why: we hold an exact date and throw it away, so every late
    evening OWM's tomorrow shows as today; (b) NO FIX: day 0's partial-day
    extrema are the provider's own definition (its VIS widgets show the same);
    document as a known limitation — cost if wrong: OWM users see today's high
    fall through the afternoon; revisit with Task 19 observed extrema if asked.
- Ruling 80: Task 12 fix round 1 = M1, M2, M4, Ruling 79(a), and apply
    CC1-CC12 plus the M3 note to docs/contract-media-weather.md — why: each is
    cheap and removes a real hazard; M3/M5(b) also go to Task 25's README —
    queued behind Task 13 (one writer); resume a742566363e57049c.
- Ruling 81: absent common.step -> Home Assistant NumberEntity's derivation
    (step 1, divided by 10 while max - min <= step) — why: the panel makes a
    tile without step read-only (value_control.cpp:82-86) and HA always sends
    a step computed this way, so this is parity, not fabrication — cost if
    wrong: a slider coarser than the device allows; common.step overrides it.
- Ruling 82: map type-detector `percentage` to number under the same
    one-control-per-root guard as slider; absent min/max -> 0/100 (HA's
    NumberEntity defaults and the unit's own range) — why: every percent level
    is otherwise invisible — cost if wrong: phantom percent numbers on roots
    the guard does not cover.
- Ruling 83: add Task 13b, manual entities (state id + domain + optional name
    in adapter config, single-state domains only) — why: 0_userdata helper
    states (ioBroker's input_* helpers), states beside another control and
    second loose states are unreachable, which leaves select/datetime nearly
    unusable and blocks any 0_userdata sensor — cost if wrong: extra config
    surface. Admin table goes to Task 23. Plan now 29 tasks.
- Ruling 84: datetime also reads/writes epoch-ms numbers via the host zone
    (numbers below 1e11 are not dates -> read-only); ISO-with-zone and
    localised strings stay read-only text — why: epoch ms is ioBroker's date
    convention — cost if wrong: an epoch-seconds state shows read-only.
- Ruling 85: keep the broad slider guard (C4), accept C6 (forced domain on a
    multi-channel device edits set/actual) and C7 (trimmed, case-insensitive
    option uniqueness) — why: the manual entities of Task 13b are the escape
    hatch for each — cost if wrong: a fan's speed level next to its power
    switch needs a manual entity.
- Ruling 86: fix I1 as the review proposes — count the root's slider (and,
    with Ruling 82, percentage) candidates; more than one -> drop before it
    can take the root id — why: arbitrary, writable, id-unstable parameter —
    cost if wrong: a root with two genuine levels publishes neither (manual
    entities cover it).
- Ruling 87: M2 option (i) — accept, pin probes A and C, document that a lone
    level in its own channel is a number (override include=false hides it) —
    why: option (ii) applied consistently drops the deliberate alias.0 room
    setpoint (real-detector.test.ts:1799-1818); a phantom here is picker
    clutter, never a panel change, since tiles appear only when placed —
    cost if wrong: one extra number per such adapter device in the picker.
- Ruling 88: M5 — for number/select/datetime, availability follows quality,
    not presence: val null/absent -> state unknown, available (the panel
    drafts from min or a blank calendar, value_control.cpp:416-417,
    :852-860); q != 0 -> unavailable; sensor rule unchanged — why: HA parity,
    and Task 13b helpers start null — cost if wrong: a dead state looks
    editable until its quality flag says otherwise.
- Ruling 85 CORRECTED (M6): the fan case is the reverse — the level becomes a
    number and the absorbed switch is unpublished; a manual entity exposes
    it. FINAL-REVIEW list: consider publishing a slider's absorbed ON as its
    own switch.
- Ruling 89: m1 option (b) — the editable synths treat `write !== false` as
    writable (Ruling 38) — root fix in the shared synths, sent as an addendum
    to Task 13's fix round, which owns editable.ts now — cost if wrong: a
    state that silently rejects writes shows as editable; its command then
    fails with an ack.
- Ruling 90: Task 13b fix round 1 = m2 (one English line per rebuild naming
    what is missing), m3 (reject scene AND switch on write === false; the
    switch reason points to binary_sensor), m4 (cap the slug in entity-id
    pass 2 so <domain>.<slug>_<n> <= 255; persisted ids untouched), m5, m6
    (Set + first 20 ids "and N more"), m7 — queued behind Task 13's round
    (resume abebaa0547f89d2be).
- Ruling 91 (Task 14 prep, from C1): an unknown editable value goes out as the
    STRING "unknown" with available true and writable by its constraints; a
    q != 0 value as "unavailable" with available false; NEVER state null —
    the firmware makes a null state unavailable and unwritable
    (value_control.cpp:73-77), and the Bridge sends "unknown" exactly so
    (editable_helpers.py:55-58). Task 14's brief test "null for unknown" is
    WRONG — cost if wrong: none known; this is the reference sender.
- Ruling 92 (C2): ManualEntity gains optional kind: 'date' | 'time' |
    'datetime' for datetime entries; it applies only when the value gives no
    kind (null or empty); a value whose shape conflicts stays read-only with
    the m2 explanation — why: ioBroker has no has_date/has_time, so a fresh
    text helper would stay read-only until written elsewhere — cost if wrong:
    one more optional config field. Task 23 adds the select. Goes into Task
    13b's fix round.
- Ruling 93: confirm the round's own decisions — a present non-number step
    stays read-only (null counts as absent, detector.ts:504 verified); percent
    defaults key on unit % only; a root holding a percentage AND a slider
    publishes neither; C3 accepted (Ruling 86 also drops a device's own
    parameter when a sub-channel holds several; manual entities reach it).
- Ruling 94: Task 13 fix round 2 = N1 (`if (info.write === false ||
    (info.write !== true && role !== 'level')) return false;`, tests in both
    sort orders) + N2 (scan only the root's descendants — binary search over
    sorted state ids like getObjectsBelowId, or a parent index built once;
    re-measure the reviewer's two synthetic sizes) — why: N1 hides a real
    writable level; N2 is a measured 2 s event-loop block on big installs —
    queued behind Task 13b's round 1 (resume a9dc62a3c94b08fe1).
- Ruling 95 (Task 14 interface): the builder computes revision itself — first
    16 hex of sha256 over the sort-keyed JSON of every payload field except
    state, last_changed and revision (the Bridge's rule, editable_helpers.py:
    95 with last_changed added after, __init__.py:1534-1536) — and exports the
    same function for Task 15's comparison; session is one 32-hex token per
    process (crypto.randomBytes(16)), injectable for tests — why: a revision
    passed in by callers invites a per-value bump, which aborts every drag
    (value_control.cpp:816-817) — cost if wrong: an interface change for
    Task 15 only.
- Ruling 96 (Task 14 limits): payload over 24576 UTF-8 bytes -> null + one
    English warning per entity, the caller skips (Bridge skips silently);
    throws only for the adapter's own session/revision lengths; state over 255
    bytes rejects the WHOLE message on the panel (value_control.cpp:75), so
    never send one; unit over 128 bytes is blanked by the panel — omit it.
- Ruling 97 (Task 14 wiring): number/select/datetime get a `control` shape in
    state-payload.ts — retained publish on entityStateTopic(prefix, id,
    'control'), and buildStateClear clears that leaf for them (as weather's
    leaf) — other domains byte-identical; the 13b `readOnly` reason is never
    published — why: Task 13 left these domains publishing nothing "until
    Task 14", and both callers (main.ts:524, panel-session.ts:161) already
    route through buildStatePublish.
- Ruling 98 (supersedes Ruling 96's oversize clause): an oversize /control
    payload DEGRADES — rebuild without options (the select goes read-only,
    its current state still shown, revision covers the degraded payload),
    one English warning per episode — and null remains only as an assertion
    that cannot fire (options are the only unbounded part: state <= 255,
    unit <= 128) — why: a skip leaves a stale, writable tile whose every
    command fails as "changed" — cost if wrong: none known; strictly more
    accurate than the Bridge's silent skip.
- Ruling 99 (Task 15): validate value commands like the Bridge
    (__init__.py:1549-1590), overriding the brief's "opaque, never validate":
    ignore retained or > 2048-byte commands; entity must be a number/select/
    datetime pushed to THAT panel; id a string of 1-48 chars; deadline a
    non-bool number with 0 < deadline - now <= 15 s and session ==
    CONTROL_SESSION, else "expired"; per-session seen-id map with expiry
    (duplicate or >= 128 entries -> silent drop); revision !=
    controlRevision(entity, session) -> "changed"; refuse unless writable AND
    available (Task 14 O3); number within min/max and on the step with the
    panel's 9-decimal rounding tolerated (O4), validated against
    attributes.min/max/step (T81-4); select an exact option ->
    encodeChannelValue; datetime per T84-4 (epoch: new Date(local parts),
    refuse a nonexistent local time by round trip, document the ambiguous
    autumn hour; text: keep the source's shape); status strings exactly the
    Bridge's; ack {entity_id,id,status} on <base>/stat/value, not retained,
    <= 1024 bytes; then re-publish the entity's current /control as the
    Bridge does — why: reference sender + the firmware's stale-command
    design (PROJECT_CONTEXT) — cost if wrong: a panel whose clock is > 15 s
    off gets "expired" for every command (Bridge parity; noted in docs).
- Ruling 100: writes use ack=false (command semantics, as every ioBroker UI
    does); a 0_userdata helper, which no adapter acks, is confirmed on the
    panel by its own ack=false change reaching the entity (main.ts:277 passes
    ack=false changes to the registry) — Task 15 must prove it end to end;
    a device state shows the commanded value until the device acks —
    accepted, standard ioBroker UI behaviour — cost if wrong: a device that
    clamps a value shows the requested one briefly.
- Ruling 101 (C2): ignore retained commands on EVERY command leaf — why: a
    retained command re-fires on every reconnect/restart (a switch toggles by
    itself); Bridge parity — cost if wrong: none; the panel never retains
    commands. Goes into Task 15's fix round.
- Ruling 102 (C4): when a command expires because |deadline - now| is far
    outside the window, log one English WARNING per panel per hour naming
    the apparent clock offset and pointing to the panel's time sync — why:
    otherwise every command silently fails — cost if wrong: one log line an
    hour. Goes into Task 15's fix round.
- Ruling 103 (C6): accept the autumn-hour first instant (the panel cannot tell
    the two apart; refusing would block that hour entirely) and the rest of
    C6/C1 — cost if wrong: a write lands an hour off once a year.
- Ruling 99 cost CORRECTED (m3): the clock window is ~5 s ahead / ~10 s behind,
    not 15 s; the Task 25 README carry and Ruling 102's warning text use the
    real window.
- Ruling 104: Task 15 fix round 1 = Rulings 101 and 102 with traps T1-T13;
    m1 documented in the contract (+ a pinning test), m2 isfinite guard, m3
    corrections (contract, panel-session.ts comment), m4 commit the probe
    source and a generated golden fixture the unit tests consume (the probe
    needs g++ + ArduinoJson and is not run in CI; document regeneration),
    m5 tests (concurrent duplicate, m1, m2), m6 sanitise/truncate the logged
    entity_id. Resume a18488883566453dd, BASE 45f02d3.
- Ruling 105: the clock warning fires (<= once per hour per panel) when a
    command expires and the estimated offset (deadline - now - the panel's
    lead) lies >= 2 s beyond the window edge; every expired command's debug
    line carries the estimated offset — why: Ruling 102 exists for exactly
    the 6-29 s case; latency only shifts the estimate toward "behind", and a
    2 s margin keeps single borderline expiries quiet — cost if wrong: one
    extra warning line an hour. Task 15 fix round 2 = Ruling 105 only
    (resume a18488883566453dd); then ONE re-review over 45f02d3..round 2.
- Ruling 106 (Task 21): every *_meta entry carries entity_id, name and — when
    the entity has one — icon, as sensor_meta does (apply.ts:33-34); the
    brief's "only entity_id and name" test is WRONG: parseIconMetaSections
    reads icons from every *_meta (ha_bridge_config.cpp:1382-1394). Names are
    read only from media_player/climate/cover/camera/editable_meta
    (:657-661); weather_meta is icon-only on the panel (weather names come
    from the payload) — still emit entity_id + name + icon. light_meta /
    switch_meta / scene_meta only if those domains' entities can carry an
    icon (check the synths) — otherwise skip.
- Ruling 107: never emit `cameras` or `camera_meta` — an absent section keeps
    the panel's own (`if (idx >= 0)`, ha_bridge_config.cpp:582-587), an empty
    one would clear it; the adapter does not own cameras.
- Ruling 108: apply size guard — find the panel's REAL maximum bridge/apply
    size (PubSubClient receive growth up to 65,535 per PROJECT_CONTEXT;
    network_manager.cpp:598-606 callback + the queue's bounds; normal buffer
    16 KB, media 24 KB, large 32 KB at :34-41) with file:line; never publish
    a retained apply whose packet exceeds it; one English error per rebuild
    naming the byte count and the largest sections and suggesting excluding
    devices; the broker keeps the last good retained apply — why: a retained
    apply the panel cannot take is dropped on every reconnect, so the panel
    never gets its config (issue #37 class) — cost if wrong: an installation
    just over the limit publishes nothing new until trimmed.
- Ruling 107 CORRECTED (C4): omitting `cameras` equals sending it empty on
    v0.6.12 (both clear); keep omitting it.
- Ruling 109 (C2): drop the fields v0.6.12 never reads from the existing
    sections — the reviewer must confirm each "never read" claim first — why:
    ~23% of the apply for nothing, against a 32767-byte ceiling — cost if
    wrong: a field some panel reads goes missing (the firmware is fixed at
    v0.6.12 for this port).
- Ruling 110 (C3): send `icon` only when it is an MDI name ("mdi:" prefix, as
    the Bridge's _extract_mdi_icon) — why: the panel shows nothing else and
    data URIs blow the limit.
- Ruling 111 (C5): cap numbers + selects + datetimes at the panel's 128
    (deterministic by entity id), one English warning per rebuild naming how
    many were left out — cost if wrong: the 129th editable is not on the
    panel (it would not have been anyway).
- Ruling 112 (C6): sanitise free text for the panel's hand-rolled parsers in
    EVERY apply section — map [ ] to ( ), " to ', drop control characters —
    and check each parser's delimiters (object sections: braces too) — why:
    names like "Leistung [W]" are common in ioBroker and cut the section —
    cost if wrong: a bracket shows as a parenthesis.
- Ruling 113: Task 21 fix round 1 = R109; R110 (exact "mdi:" names only, in
    every *_meta AND the bridge/icons topic) + m1 (bridge/icons as the flat
    map the Bridge sends) + the zero-icons trap (find whether an explicit
    empty map clears the panel's map; else document "reboot once after
    upgrading"); R111; R112 refined ([ ] { } -> ( ), " -> ', control
    characters -> space, in free text only — NEVER entity ids or scene_map
    aliases) with faithful parser ports in the tests (m5); m3 byte count in
    the success log. m2/m4 skipped. Resume aed4c4b1c3f4cf72e, BASE d062687.
- Ruling 114: Task 21 fix round 2 = a bridge/icons size guard at the same
    32767-byte limit: over it, drop the "" clearing entries first (keep the
    MDI ones); if still over, publish nothing and log one English error per
    rebuild naming the byte count; recover when it fits; document that a
    degraded map leaves stale icons until a panel reboot — why: one clean
    package for the live test; cost if wrong: none. Resume
    aed4c4b1c3f4cf72e, BASE ec8c88f; then a small re-review, then build
    the live-test package from the final commit (snapshot build) and PAUSE.
- Ruling 115: add Task 21b (brief task-21b-brief.md; plan commit below) —
    selection = deviceOverrides rows with include:true; no row = not
    published; manual entities always published; a Refresh sendTo fills the
    table (new rows unticked, choices kept, missing rows kept); the manual
    entities table moves here from Task 23 (+ native.manualEntities default);
    empty-selection hint; ids never change with selection. Plan now 30 tasks
    (22 complete = 73%).
- Ruling 116 (C1): never publish an apply in which EVERY list is empty (nothing
    picked, no manual entity) — hold it back, keep the broker's retained apply
    and the panel's layout, log the hint; publish normally once one entity is
    selected — why: Ruling 62's principle, a panel is never wiped by the
    adapter's own empty world — cost if wrong: un-picking EVERYTHING leaves
    the last layout on the panel (stale tiles) until something is picked.
- Ruling 117 (C7): allow deleting rows (drop noDelete even though it also
    allows adding; validateOptions ignores unknown ids) and mark rows of
    devices no longer detected "(not detected)" in the read-only name column.
- Ruling 118 (I1): opt-in publishing is ARMED only after the user has used the
    NEW Devices tab (e.g. Refresh detected devices, or a save carrying a
    marker only the new form writes — implementer verifies the mechanism in
    js-controller / json-config sources); until armed NOTHING is published
    (hold back + hint), whatever legacy rows or hand-edited manual entities
    exist; a device row counts as a pick only if the picker wrote it (the
    reviewer's detectedDomain marker); legacy rows show unticked — why:
    never wipe a panel on upgrade — cost if wrong: a fresh user must press
    Refresh once before anything publishes (the hint says so).
- Ruling 119: M2 + M3 — the refresh must never shift rows relative to what the
    admin shows; never drop rows in the merge (blank/duplicate rows stay,
    validateOptions ignores them); if column sort cannot be made safe with an
    index-keyed table, disable sorting; no displayed value may be saved onto
    another device. M4 strip every language's mark before re-marking; M5
    coerce non-text names; M6 the Devices tab warns that picking + save
    prunes unpicked tiles on the panels (export the layout first); M7 a
    held-back run reports nothing as published. M1 parked (FINAL-REVIEW).
- Ruling 120: Task 21b fix round 3 = N1 (the review's one-line fix), N2 (bump
    the picker marker so rows from a 44d1111 Refresh count as legacy and
    show unticked), N3 (tab wording: Refresh + Save publishes manual
    entities), N4 (keep a row whose object id is not text; never shift), and
    tests for arming-by-flag and N1 — queued now (resume ad2f4cab2abff1938);
    package 4 afterwards is optional for the user.
- Ruling 121 (Task 18 scope): no task builds the EDITABLE history response
    (contract-history-energy.md §4.4: the firmware always runs the state
    history path for an editable popup, adds the numeric values path for
    number, and gates on request_id AND hours echo) — Task 18 builds it
    beside binary/state, reusing Task 17's numeric builder for `values` —
    why: without it every number/select/datetime popup shows no history.
- Ruling 122 (Task 18): the discrete request carries max_transitions
    (mqtt_handlers.cpp mqttPublishDiscreteHistoryRequest:
    {"version":1,"kind","entity_id","hours","max_transitions"}) — extend the
    Task 16 parser to read it and honour min(max_transitions, 96) for
    segments/activity, keeping the NEWEST part of the window (the firmware
    keeps the first 96 valid segments in wire order); malformed -> null (no
    response), as Ruling 70.
- Ruling 123 (Task 19 prep): numeric (and energy) history uses RAW samples
    (aggregate 'none') with a bounded count plus the reading in effect BEFORE
    the window (Ruling 75's carry needs the last sample, which server-side
    'average' loses; aggregate timestamp placement also varies by adapter) —
    verify count / returnNewestEntries / pre-window semantics per adapter
    (history, sql, influxdb) from their sources; drop q != 0; take `now`
    after the query returns; default instance = system.config
    common.defaultHistory when historyInstance is empty; categorical 'none'
    with ignoreNull false (brief).
- Ruling 124: add Task 20b, energy meters (brief task-20b-brief.md): config
    rows {stateId, category, sign, name?, price?} + currency; Bridge-mirrored
    periods (day hourly since midnight, week 7 daily, month daily since the
    1st, host TZ); consumption = counter increase per bucket (positive deltas
    only, reading in effect at each boundary); Bridge-shaped entries incl.
    cost and category totals; the `energy` catalog in the apply; only while
    armed — why: no task sourced energy data, so energy tiles would stay
    empty. Plan now 31 tasks. Order: 18 -> 19 -> 20 -> 20b -> 22 -> 23 -> 24
    -> 25.
- Ruling 125 (C1): for EDITABLE Number only, a non-numeric sample ends the
    carry (null until the next numeric sample) — why: editable graphs are not
    gap-filled, so the gap is shown truthfully, as the Bridge does; Ruling 78
    stays for the sensor path, where the firmware fills gaps anyway.
- Ruling 126 (C4): the discrete and editable builders take a
    historyAvailable flag; Task 22 passes false when no history instance is
    configured or the query failed, so the popup says "History unavailable".
- Ruling 127 (M1, supersedes Ruling 121's "reuse Task 17's means" for the
    editable NUMBER graph only): each bucket carries the reading in effect
    at its END (the latest sample at or before the bucket end); null when
    that reading is non-numeric (Ruling 125 falls out of this) or none
    exists yet — why: Bridge parity and no fabricated values; the sensor
    graph (Task 17) keeps means + carry.
- Ruling 128 (Tasks 20/20b, verified by me in energy_data.cpp:218-262): the
    brief's "null clears a cached total, absent preserves it" is WRONG —
    `total.isNull() ? 0.0f : apply_energy_sign(...)` treats null and absent
    alike (0.0; the whole period cache is replaced by the parsed entries);
    there is no NaN in JSON, so an unknown total shows 0.000 — omit it and
    document. cost: present (even 0) -> has_cost; null/absent -> none. sign:
    raw < 0 -> -1; apply_energy_sign flips only a POSITIVE value negative, so
    an already-signed total is never double-flipped. name/unit fall back to
    findSensorName/findSensorUnit (the apply's name/unit maps, fed by the
    `energy` catalog) then the unit cache. values: <= 32, null elements
    handled. Icons: is_cost -> currency-eur; solar/grid/battery/gas(fire)/
    water|device_water/else lightning-bolt.
- Ruling 129: Tasks 20 and 20b go to ONE implementer with ONE review (same
    area, one data flow: request -> meters -> history boundary readings ->
    entries -> response + catalog) — after Task 18's fix round commits.
- Ruling 130: Task 19 fix round 1 = I-1 (coerce q numerically, a non-numeric
    q is bad quality; one English line when a query's rows were all dropped
    for quality), I-2 (close() called on unload: cancel queued, clear timers,
    settle pending as unavailable, no calls after close), all nine minors
    (the timeout keeps the slot until the call settles, with a hard cap;
    queue fairness for shared queries; tests for the three uncovered
    mutants; skip the real suite offline; bound the InfluxDB 2.x
    reading-in-effect lookback), C3 as the review recommends. QUEUED behind
    Tasks 20+20b and MUST also cover their provider additions (readingAt,
    boundary cache) — resume afc61c1d730481e8f.
- Ruling 131 (C6): energy meters count as content for Ruling 116 — an ARMED
    config with meters publishes the apply with its catalog (like manual
    entities, an explicit pick).
- Ruling 132 (C7): build the Bridge's consumption total entries
    (__init__.py:2882-2944) with translated names — Bridge parity for the
    house-consumption tile.
- Ruling 133 (C5): the energy answer runs meters concurrently within the
    provider's caps under one per-request budget (~7 s); a meter that misses
    it gets null values in that response.
- Ruling 134: energy fix round 1 (queued behind Task 19's round; resume
    ac07821d32a6cce35) = I1 (telescoping total), I2, m1-m5 (m5: make the
    text require cumulative counters, or prove daily resets are handled
    by the positive-delta rule and say so), Rulings 131, 132, 133 with the
    review's traps.
- Ruling 135: carry N1, N2, N3 into Task 22, which must touch the provider
    anyway to add query()'s deadline (covering the queue wait) — cheap fixes
    there, pinned by tests.
- Ruling 136: energy fix round 2 (after Task 22; resume ac07821d32a6cce35):
    N1 (device and device_water rows accept sign +1 only, validated with a
    reason), N2 (a derived consumption slot/total is known only when every
    electric member has a value in it; else null), N3 (one sentence in en
    and de), N4 (two tests), N5 (fix the comment or the case). N6 FORWARDED
    to Task 22 now (same file, same fix as N3).
- Ruling 137: tests must not use fixed ports (concurrent runs collide) — Task
    24 moves every harness/broker port to an ephemeral one; until then
    reviewers run only individual socket-free test files, never the full
    suite.
- Ruling 138: park Task 22 m1-m3 for the final review's fix wave (minor;
    tests + one deadline accounting fix).
- Ruling 139 (C1): keep the pinned null entity, ADD one English warning per
    rebuild naming each override whose forced type produced no entity and
    what the device lacks.
- Ruling 140 (C2): fix both v0.1 admin buttons — Test broker uses the TYPED
    form values and shows the real result (success or the error text);
    Pair-by-address gets a host field and shows the real result — both
    verified against json-config sources like the Preview button.
- Ruling 141 (m7): build it now — a "Climate modes" admin table (device,
    device mode value, panel mode among the firmware's hvac names; presets
    too if the climate synth has the same name-match gap), used by the
    climate synth to list modes and by the command path to encode them back
    (lossless, duplicates rejected with reasons); unmapped labels behave as
    before (exact firmware names only) — why: Homematic-style MANU/AUTO
    thermostats otherwise get no mode buttons — cost if wrong: one more
    admin table.
- Ruling 142: m1, m2, m3, m5, m6 fixed; m4 accepted with the energy_info
    clause ("after changing a row's category, save and reopen if Direction
    does not offer export").
- Ruling 143 (C3, C5): declare the broker password (and any other secret the
    implementer finds, e.g. pairing credentials) in io-package.json
    `encryptedNative` AND `protectedNative`; verify with the installed
    adapter-core/js-controller that this.config arrives decrypted and that
    admin encrypts on save; document for Task 25 that an upgraded install
    must re-enter the password once (a stored plain value does not decrypt).
    Add a wall-clock guard (~12 s) around Test broker.
- Ruling 144: Task 23 fix round 3 (after Task 24; resume a311463904cc800cc):
    I1 — never use or push an undecryptable password: verify js-controller's
    encrypt format in the installed sources; if the stored RAW value reliably
    shows plain versus encrypted (e.g. a format prefix), migrate a plain v0.1
    value automatically (encrypt, write back, marker, no user action);
    otherwise log ONE clear English error asking to re-enter it on the
    Connection tab, skip connecting with it, and make Pair refuse with a
    translated error — tests for both; n1 — for a MODE state without a
    states map, reject the mapping row with a reason (nothing to validate
    against) or write the typed value only by exact case-sensitive match, and
    catch the clash with a device's own label; n2 — fix the text in every
    language.
- Ruling 145: Task 24 fix round 1 (after Task 25; resume aab995152761d1294)
    = I1 (every suite on a taken-then-released ephemeral broker port), I2
    (split history-dependent tests into their own suite; skip ONLY on a
    network error, throw on anything else), C1 (exact pin 5.3.0 + load-time
    version/typeof guard), m1 (retry the DB start on EADDRINUSE with a fresh
    port; report a corrupt iobroker.json as corrupt), m2 (test timeouts above
    waitFor deadlines; a deadline for settled()), m3 (record every write),
    m4 (a CI job running the integration suite, HOMETILES_INTEGRATION=1),
    m5 (document separate TMPDIRs in the contributor docs), m6 (pin the
    harness js-controller version).
- Ruling 146: R3-m1 and R3-m3 go to Task 25 NOW as an addendum (io-package
    globalDependencies admin >= 6.2.3; README: start the adapter once after
    upgrading BEFORE opening its settings, and re-enter the password if the
    log reports it unreadable); R3-m2 goes to the final review's fix wave
    (one condition + test).
- Ruling 147: repository/homepage/bugs/extIcon/readme URLs -> the configured
    remote https://github.com/tsiura/iobroker.hometiles (the user's own
    instruction named that remote for the port); keep author as is.
- Ruling 148: add Task 25b, PANEL TELEMETRY (HomeSnapshot): subscribe each
    panel's <base>/sensor/{inside_c,outside_c,soc_pct} and expose them as
    panels.<id> states (value.temperature °C, value.battery %; "" or
    "unavailable" -> null, never 0); Discovery and DynamicSlotsReload need
    nothing (document). Plan now 32 tasks.
- Ruling 149: Task 25 fix round (after Task 24's round; resume
    a323d40263606c50c) = I1 (correct README + test comment; declared minimums
    js-controller >= 6.0.11 and admin >= 7.6.17; PLUS a runtime guard: when
    any system.adapter.admin.* instance reports a version below 6.2.3, skip
    the plain-password migration and log one English error), I2 (correct the
    README + news; CODE: Pair requires a LIVE broker connection of the
    adapter itself — never hand a panel credentials the adapter cannot use;
    one rate-limited English hint on repeated auth refusal naming the
    upgrade/early-save case), m1-m17, Ruling 147 URLs, the two stale lines
    (contract-v0.2-notes.md:116-119, history.ts header), and the repochecker
    errors (## Changelog with ### 0.2.0 and ### 0.1.0; news en + REAL de for
    0.1.0 and 0.2.0; common.tier; License copyright + link; licenseInformation
    if js-controller >= 6.0.11 accepts it; titleLang only; a real 256x256
    PNG icon generated by a small script, no new dependency).
- Ruling 150 (D1, CRITICAL, before anything else): (a) bound EVERY await on
    a js-controller call that can go unanswered during startup (subscribe
    first — per-call deadline; on expiry: one English warning naming the
    ids, carry on without them, never hang); (b) check alias targets before
    subscribing (common.alias.id as a string or {read, write}; a missing or
    invalid target -> the alias is left out with one English warning naming
    it and its target); (c) the two "one bad object" tests pass on 7.2.2 AND
    8.0.0-alpha; a unit test with a subscribe that never answers. Production
    change inside Task 24 (it surfaced there) — Task 24 fix round 2, resume
    aab995152761d1294; then ONE re-review over Task 24 rounds 1 + 2.
- Ruling 151: park n1-n4 + both nits for the final review's fix wave.
- Ruling 152: Task 25b narrows Ruling 148 to the BATTERY CHARGE only.
    Controller read the firmware (HomeTiles 5d25167): outside_c/inside_c are
    placeholders — g_outside_c/g_inside_c start at 21.7/22.4
    (mqtt_handlers.cpp:45-46), are set only by messages on those same topics
    (:865-871) and echoed back retained; no sensor feeds them and the HA
    Bridge ignores them. Exposing them = false data. soc_pct is real (PMIC,
    readBatterySocPercent; "unavailable" / "" when not measurable), published
    ONCE per broker connection (mqttServicePostConnect :2706), gated by the
    announcement's capabilities.battery_soc (ha_bridge_config.cpp:332-334);
    the Bridge mirrors that gate with a legacy Tab5 fallback
    (capabilities.py supports()). Cost if wrong: a user who publishes a real
    temperature to a panel's sensor topic does not see it in ioBroker (they
    published it themselves, so they already have it).
- Ruling 153: C1 is load-bearing -> final fix wave: set
    reconnectOnConnackError: true in the mqtt connect options, move the
    dependency floor + lockfile to mqtt ^5.16.0 so unit tests run what users
    get, and add a test that a refused-then-accepted CONNACK reconnects
    (red without the option on 5.16) — cost if wrong: a retry per reconnect
    period against a broker that keeps refusing (the hint log is already
    rate-limited).
- Ruling 154: C2 -> final fix wave: io-package common.nogit: true (repochecker
    5.22.5 M1000:1726-1741 accepts a build/ main with nogit; GitHub installs
    cannot work anyway because build/ is git-ignored); do not commit build/ —
    cost if wrong: admin hides "install from GitHub", which never worked.
- Ruling 155: C3 keep admin >= 7.6.17 (E1057 satisfied; W1056 is advice,
    lower floor = wider reach); C4 keep en + de only (warnings; other
    languages are mechanical later) — cost if wrong: warnings in a future
    ioBroker repository submission.
- Ruling 156: the final review's FIX LIST (§4, items 1-16) is the one fix
    wave's brief, with controller amendments: (a) FIX 9 — grep the firmware
    first; if a climate or light parser reads friendly_name, skip that half
    and report; (b) FIX 5 — include the optional hardening (decrypt an
    AES-prefixed value when the instance does not declare encryptedNative);
    (c) FIX 3 accepted — the per-connection snapshot equals the burst the
    first announce already sends; the panel's reaction stays a hardware
    check; (d) Ruling 153's cost note was wrong (only the hint was
    rate-limited) — FIX 2(b) throttles the error line; (e) npm install is
    allowed for exactly mqtt@^5.16.0 and @iobroker/type-detector@~6.0.1 —
    cost if wrong: one more fix dispatch after the re-review.
- Ruling 157: adopt the reviewer's ACCEPT/DROP triage as written. T8
    inverted CT: withholding supersedes Ruling 55's swap ask (a lamp keeps
    on/off/brightness; a guessed swap could send wrong kelvin). T20 cold
    start: omitting cannot keep the old value (energy caches are replaced
    wholesale, global constraints) — so ACCEPT is right. Cost if wrong: a
    documented limitation turns out to matter to a user; each has a README
    line (FIX 16) or a stated reason.
- Ruling 158: fix-wave C1 stands — a hand-edited string port already logs
    "[Config] brokerPort must be between 1 and 65535" and fails to connect;
    converting strings is scope creep this late — cost if wrong: a user who
    hand-edits the port as text sees a config error instead of a working
    connection.
- Ruling 159: park both residual minors — (1) the FIX 4 stop-before-ready
    integration test can pass vacuously on a runner ~3x slower (it fails
    loudly when the stop lands too late, never falsely red); (2) the
    "installation is incomplete" error repeats at every start of an
    undeclared instance even without a stored password — correct signal for
    a broken install, wording only. Cost if wrong: a later regression of the
    onReady guard slips past a slow CI runner; one extra error line per
    start on a mis-installed instance.
- Ruling 160: controller adds two README hardware-check items (21 reconnect
    snapshot from FIX 3, 22 Tab5 battery charge from Task 25b) — the
    re-reviewer's out-of-scope observation and the final review's
    unverifiable list; doc-only, unreviewed. Cost if wrong: a checklist line
    worded imperfectly.

## Appendix: final whole-branch review triage (adopted by Ruling 157)

Verdicts on every item parked for the final review. FIX items were fixed in
the fix wave (f83b404..b46d274); ACCEPT items are known limitations; DROP
items were already fixed or not real. "Ledger :N" refers to the deleted
execution ledger; file:line refers to f83b404.

### A. `final-review-parked.md` items and the controller-decided items

| id | verdict | location | instruction or reason |
| --- | --- | --- | --- |
| T5d-catchall-swap | FIX | detector.ts:714-745, :404-405 | Reproduced live. FIX 1 |
| T24-R151-n1-alias-strict | FIX | sources.ts:54; README:367-373 | FIX 6 |
| T23-R146-r3m2-encryptedNative | FIX | main.ts:163-179 | FIX 5 |
| T8-CT-inverted | ACCEPT | common.ts:452-461 | Withholding is the safe reading of a device-object bug (Ruling 26: fewer buttons, never a wrong command). README line in FIX 16 |
| T12-preferEpochDates-guard | DROP | detector.ts:785, :793 | Not real: the lookup key includes the channel's own role, and only `date.forecast.N` roles enter `epochs`, so only forecast dates can be re-pointed whatever a future pattern names DATE |
| T9-chromecast-guard | FIX | detector.ts:337; overrides.ts:57-66; main.ts:551-557 | FIX 8 |
| T6-cover-fixtures | ACCEPT | test/registry/synth/cover.test.ts:33, :79 | No doc needed. The typed primary path is covered by `real-detector.test.ts:301-326`, `:1057`, `:1073` (real blind and gate, typed SET) and the integration cover round trip `main.integration.test.ts:2970` |
| T4-vacuous-chai | FIX | state-payload.test.ts:104 (and :127) | FIX 13 |
| T5-climate-key-shadow | FIX | protocol/climate.ts:44; state-payload.ts:124-131 | FIX 9 (light too) |
| T13-slider-absorbed-switch | ACCEPT | detector.ts:295 | A manual `switch` entity exposes it (Ruling 85). README line in FIX 16 |
| T13b-wallclock-test | FIX | manual.test.ts:368-379 | FIX 13 |
| T20-energy-coldstart | ACCEPT | energy-source.ts:430-432, :251 | Transient: at most one request interval (60 s), only at a cold start with a slow instance. Omitting the entry changes the popup cache and the house totals (energy_data.cpp:274, :279). README line in FIX 16 |
| T22-stopped-instance | ACCEPT | panel-session.ts:122 | No doc needed: already documented in docs/protocol.md:774-777 and pinned by panel-session.test.ts:1206 |
| T22-R138-m1 | FIX | history-provider.ts:438-459 (callers :342-371, :423-435) | FIX 7 |
| T22-R138-m2 | DROP | test/runtime/panel-manager.test.ts:158-167, :258-266 | Done: the request topics are pinned as unsubscribed on withdraw and on stopAll |
| T22-R138-m3 | DROP | main.integration.test.ts:1630-1648 | Done: a graph request answered while unarmed fails `expect(answers).to.deep.equal([])` (review m3, Ruling 138) |
| T23-brokerhost-format | ACCEPT | options.ts:425 | No doc needed. A malformed host fails only the adapter's own connection, which Test broker shows. README:275-277 already says what Pair needs |
| T24-R151-n2-stale-comment | FIX | sources.ts:20-26 | FIX 6 |
| T11-several-entities-per-source | ACCEPT | detector.ts:821-835 | Already documented at README:49-56 |
| Plan-deferred-Task25b | DROP | f83b404 | Done: battery `soc_pct` implemented; the placeholders excluded and documented (README:62-73, protocol.md:925-955). The controller's final report must list the deferred items (HomeSnapshot outside/inside, Discovery, DynamicSlotsReload, camera) |
| common-NaN-toBoolState | ACCEPT | common.ts:30 | No doc needed. Unreachable: state values reach the adapter JSON-decoded, and JSON has no NaN; Ruling 28 removed the in-process path |
| T24-R151-n3-untested | FIX | sources.test.ts; main.ts:257-262 | Confirmed by reading. FIX 12 |
| T24-R151-n4-ci-node | FIX | test-and-release.yml:13-17, :32-45 | Confirmed `[20.x, 22.x]`, no timeout. FIX 11 |
| T24-R151-nit-compile | FIX | sources.ts:62; sources.test.ts:9, :82 | Reproduced TS2503. FIX 12 |
| T24-R151-nit-1883default | FIX | main.integration.test.ts:276-277 | Confirmed: `Number(undefined)` is NaN, which passes the guard. FIX 12 |
| T21-testport-nits | DROP | none | The ledger gives no content ("no practical trigger"), so there is nothing to act on |
| T3-valve-window-party | DROP | detector.ts:248-250 | Resolved |
| CC-b-supported-features | DROP | protocol/climate.ts:239 | Resolved |
| CC-a-available-flag | DROP | synth/climate.ts:38, :142 | Resolved |
| T2-domain-throws | DROP | synth/index.ts:24-51 | Resolved: every domain has a case |
| T5b-R33-string-mode-closed | DROP | common.ts:173-175 | Resolved |
| T5b-R41-fan-swing-reprobe | DROP | common.ts:262-271 | Resolved |
| T5d-R60-3-transactional-rebuild | DROP | main.ts:324-343; entity-registry.ts:115-131 | Resolved in 5d round 4 |
| T5d-R60-2-nonstring-role | DROP | detector.ts:631-636 | Resolved |
| FR-npm-audit | DROP | none | Resolved: `--omit=dev` finds 0 vulnerabilities |
| T24-C1-testing-pin-fragility | DROP | package.json (`@iobroker/testing` 5.3.0); main.integration.test.ts:137-189 | Resolved |
| Ruling 153 | FIX | mqtt-client.ts:85-93, :125-129; package.json:21; lockfile | FIX 2, plus the missing log throttle |
| Ruling 154 | FIX | io-package.json:21 (common) | FIX 10 |

### B. Ledger `minor (deferred)` lines and the other deferred or FINAL-REVIEW mentions not covered in A

These rows are covered by A and omitted here: :173 (T3), :415 (T4 chai), :784
(T6), :2149 (T8 CT), :2427 (T9), :2550 (T11) and :3083 (T12).

| ledger line | verdict | location | instruction or reason |
| --- | --- | --- | --- |
| :125 T2 synthesise throw untested | DROP | synth/index.ts:24-51 | No throw remains |
| :129 T2 no end-to-end dispatch for a new domain | DROP | main.integration.test.ts:2947-3060 | A round trip per domain now exists |
| :411 T4 M7 one-sided low/high | ACCEPT | protocol/climate.ts:198-203 | No doc needed. `usableNumber` guards each side; this is test polish |
| :421 T4 N3 M6 exclusions and acceptances untested | ACCEPT | synth/climate.ts:38 | No doc needed. Test polish; the gate matches the firmware line by line (re-reviewed) |
| :892 T7 state-payload.test.ts:126 does not discriminate | FIX | state-payload.test.ts:127 | FIX 13 (delete it; `:128` pins the state) |
| :895 T7 'opening'/'closing' fixtures | ACCEPT | cover.test.ts | No doc needed (test wording) |
| :899 T7 redundant writable-false test | DROP | cover.test.ts | Harmless redundancy |
| :1141 T5c pins at test:292 / :455 | DROP | real-detector.test.ts:994 | Superseded: ACTUAL-aliases-SET fixed (synth/climate.ts:201-205), and the fixed behaviour is pinned |
| :1144 T5c fixture realism gaps | ACCEPT | real-detector.test.ts | No doc needed (test realism) |
| :1228 T5b FAN/SWING fallback refused | DROP | common.ts:262-271 | Ruling 41's current-value branch closes it |
| :1235 T5b lone writable value.temperature | ACCEPT | synth/climate.ts:196-205 | No doc needed; by design (a writable temperature is a setpoint) |
| :1239 T5b untyped MODE with a states map | ACCEPT | synth/climate.ts:119-123 | No doc needed; unreachable through detection |
| :1517 T5d Ruling 45 limits (a control moving roots) | ACCEPT | detector.ts:599-605 | No doc needed; inherent to anchoring, and rare |
| :1521 T5d id of a device absent at save | ACCEPT | entity-id.ts:166-172 | Documented in code: a device detected no more loses its id |
| :1626 T8 max-only position | DROP | common.ts:343-347 | Resolved: a missing min is 0 |
| :1630 T8 rgb/kelvin clamped | DROP | commands.ts:162-181; dispatcher.ts:325-337 | Resolved: refused or skipped, never clamped |
| :1862 T8 1..254 dimmer at raw 1 is 0% | ACCEPT | synth/light.ts:99-105 | No doc needed; inherent to percent scaling (the state is right) |
| :1864 T8 "clamps kelvin" title | FIX | commands.test.ts:163 | FIX 13 |
| :2097 T8 unitless 0..1000 non-mired | ACCEPT | common.ts:398-421 | The heuristic is documented in code |
| :2099 T8 max below 2000 K | ACCEPT | common.ts:452-461 | No doc needed; honest refusal |
| :2142 T8 the heuristic's known wrong cases | ACCEPT | common.ts:398-421 | Documented in code |
| :2183 T5d dead clear loop | ACCEPT | main.ts:626-632 | Keep as a defence for a future mid-run rebuild; no doc needed |
| :2217 T5d a surviving catch-all re-keyed | ACCEPT | detector.ts:742-745 | Not silent (the id changes); rare. No doc needed |
| :2221 T5d malformed alias "until it changes" | DROP | sources.ts:100-105 | Resolved: the pre-check message says a restart is needed |
| :2226 T5d a repeat takes the parent's optional state | ACCEPT | detector.ts:718-755 | Rare; no doc needed |
| :2229 T5d onReady ignores `unloading` | FIX | main.ts:180-266, :324-336 | FIX 4 |
| :2283 T9 relative cover paths and data: URIs | ACCEPT | protocol/media.ts:85-88 | Documented at README:89-91 |
| :2285 T9 a text-only media.state player is a sensor | ACCEPT | typePatterns.js:453 | README line in FIX 16 |
| :2436 T9 a pushed position lags up to one report | ACCEPT | entity-registry.ts:244-257 | No doc needed; the panel extrapolates, bounded by the 30 s refresh |
| :2444 T9 media.ts:67 comment lost its escape | FIX | media.ts:66-69 | FIX 14 |
| :2727 T11 R9 guard untested | ACCEPT | detector.ts:827 | The guard was verified correct by the reviewer; low regression risk |
| :2732 T11 multi-location current | ACCEPT | detector.ts:832-834 | Hand-built multi-city devices only |
| :4877 T25 encrypt() called 3 times | ACCEPT | options.ts:373, :379 | Cosmetic |
| :4896 T25b soc spot-check test | ACCEPT | panel-session.test.ts:718 | Test polish |
| :4898 T25b mixed chai styles | ACCEPT | test | Cosmetic |
| :751 POWER/BOOST number-typed on/off | DROP | README:74-76 | No command writes them |
| :774 T6 string or mixed SET | DROP | synth/cover.ts:72-84 | Resolved (Ruling 32: "neither") |
| :1134 T5c hand copy of main.ts | DROP | detector.ts:609 | discoverDevices was extracted and is shared |
| :1139 T5c stale thermostat comment | DROP | detector.ts:132-138 | Corrected |
| :1294 BidCoS channel 0 junk `info` | DROP | overrides.ts:32-49 | Opt-in: it publishes only if ticked |
| :2002 Ruling 61(b) absolute harness dir | DROP | README:472-479 | Superseded by per-run TMPDIR and ephemeral ports (Task 24) |
| :2469 T10 mute-only first press refused | DROP | dispatcher.ts:463-467 | Resolved: the reported mute toggles |
| :2587 T10 mute-only drift | ACCEPT | dispatcher.ts:463-467 | Inherent to state-based toggles |
| :2679 T16 numeric branch carry | DROP | history.ts:176-219 | Done in Task 17 |
| :2738 T11 view slots hold current objects | ACCEPT | detector.ts:821-835 | Pre-existing; rare |
| :3699 T21 degraded icons log nothing | DROP | panel-session.ts:329-338 | Resolved (f980f33) |
| :3830 T21b M1 a clear lost across a restart | ACCEPT | main.ts:621-634 | No doc needed. The leftover retained state belongs to an entity the apply no longer lists, which the panel ignores |
| :4318 T22 C4 unload guard untested | ACCEPT | main.ts:400 | Covered in spirit by the stop-flood suite (:1449); no doc needed |
| :4319 T22 C5 history domains | DROP | panel-session.ts:100-115 | Resolved: "NO GAP" per the Task 22 review |

**Counts, deduplicated (A: 38 rows, B: 49 rows):** FIX 19, ACCEPT 35, DROP 33.
