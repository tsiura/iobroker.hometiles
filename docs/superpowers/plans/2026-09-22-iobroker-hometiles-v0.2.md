# ioBroker.hometiles v0.2 — Full Firmware Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the adapter from five domains to every domain the HomeTiles firmware supports except camera, and answer the history, weather and energy requests panels make.

**Architecture:** The v0.1 layering is unchanged and load-bearing. `src/protocol/` and `src/registry/synth/` stay free of ioBroker and MQTT imports, enforced by the existing eslint `no-restricted-imports` rule. Each new domain widens the `Domain` union, which produces a compile error at every site that must handle it because `payloadShape()` has no `default` case. History and energy add one genuinely new shape: a request/response cycle, which lives in `src/protocol/history.ts` and `src/protocol/energy.ts` for parsing and building, with the ioBroker query behind `src/runtime/history-provider.ts`.

**Tech Stack:** TypeScript strict with `noUncheckedIndexedAccess`, `@iobroker/adapter-core`, `@iobroker/type-detector` 6.0.1, `mqtt.js`, `aedes` for in-process broker tests, mocha + chai + ts-node.

**Spec:** `docs/gap-to-full-coverage.md` plus the four verified contract documents listed under Sources below. The v0.1 design spec at `docs/superpowers/specs/2026-09-04-hometiles-iobroker-adapter-design.md` still governs the layering.

## Sources — read before touching a domain

Every wire claim in this plan traces to one of these. They were extracted from
firmware v0.6.12 source with file:line citations, not from documentation.
**When this plan and a contract document disagree, the contract document
wins** and the disagreement is a ruling to record.

| Document | Covers |
| --- | --- |
| `docs/contract-climate-cover.md` | climate, cover |
| `docs/contract-media-weather.md` | media_player, weather |
| `docs/contract-editable.md` | number, select, datetime |
| `docs/contract-history-energy.md` | history and energy request/response |
| `docs/contract-iobroker-types.md` | type-detector channel names |
| `docs/contract-iobroker-history.md` | `getHistoryAsync` |
| `docs/protocol.md` | the v0.1 domains, already shipped |

## Global Constraints

### THE ABSENT-KEY RULE IS DIFFERENT IN EVERY DOMAIN FAMILY

This is the single highest-risk fact in the project. v0.1 shipped four
separate defects from exactly this confusion, and every one of them was
silent — no exception, no log, just wrong values on a wall panel. An
implementer who learns one family's rule and carries it to another WILL write
a silent bug.

| Family | What an omitted key means | What `null` means |
| --- | --- | --- |
| sensor, binary_sensor, switch, light | per-field, see `docs/protocol.md` | per-field |
| **climate, cover** | **snaps to a hardcoded default** — never "unchanged" | safe for cover; **unsafe for climate strings** |
| **history, energy responses** | preserves the cached value | **explicitly clears** the cached value |
| **editable `/control`** | a missing `state` key **rejects the whole message** | `state: null` is valid and renders `--` |

Concretely, for climate and cover you must publish the **complete set of
KNOWN attributes** on every publish, never a diff — a known value you leave
out gets reset.

**CORRECTED during execution (Ruling 13) — the original wording here was
wrong and produced a real defect.** An omitted key resets BOTH the stored
value AND a separate presence flag. The value snaps to a default (20.0 for
the target temperature), but the flag — e.g. `has_target_temperature`,
`climate/state.h:15` — goes FALSE, and the renderer checks the flag before
showing anything (`climate/renderer.cpp:85,151,993`,
`climate_popup.cpp:1166-1176`). So omission is the CORRECT way to say "this
device has no such value". Never fill an unknown with the firmware's default:
that sets the presence flag and fabricates a value the device does not have.
Concretely, always emitting `temperature` breaks dual-setpoint mode, which
activates only when `has_target_range && !has_target_temperature`
(`climate_popup.cpp:1169`).

Note the wire key: the firmware reads the target setpoint from the key
`temperature` (`tile_renderer.cpp:2234`), NOT `target_temperature`, which is
only the firmware's internal field name.

Never send `null` for a climate string field. The firmware's hand-rolled
string scanner can misparse it and take the next quoted token in the payload
— often the following key's own name — as the value. Omit the key instead.

### Other constraints, all verbatim from the contracts

- **Config-plane topics are hardcoded.** `tab5_lvgl/config/<deviceId>/…`
  for `bridge/apply`, `bridge/icons`, `bridge/request`, `history/request`,
  `history/response`, `weather/request`, `energy/request`, `energy/response`.
  These ignore `baseTopic` and `haPrefix` entirely. `CONFIG_TOPIC_ROOT` in
  `src/protocol/topics.ts` already encodes this correctly.
- **Weather's state leaf is the literal word `weather`**, not `state`:
  `<haPrefix>/weather/<object_id>/weather`.
- **Editable's state leaf is `control`**: `<haPrefix>/<domain>/<object_id>/control`.
- **`session` is exactly 32 characters and `revision` exactly 16.** A 36
  character UUID silently breaks every editable tile. These are opaque tokens
  the device echoes back; the adapter never interprets them.
- **Numeric history has no timestamps.** The array index is the time bucket,
  spaced `period_minutes` apart.
- **Discrete history `hours` is exactly 24 or 168** and must be echoed back
  verbatim or the entire response is dropped.
- **Correlation is by echoed `entity_id` plus `hours`/`period_minutes`**, not
  by a request id — except editable popups, which do carry `request_id`.
- **Truncation limits:** energy `values[]` cuts at 32; `activity[]` keeps the
  last 96 by array index and requires oldest-to-newest wire order.
- **All four history entry points share one `history/request` topic.**
  Dispatch on payload shape, never on topic.
- **Select `options` need `options_complete: true` and every option valid**
  (unique, 1-255 bytes, no `\n` or `\r`) or the entire list is dropped and the
  tile goes read-only. There is no partial acceptance.
- **A `/control` payload over 24576 bytes is dropped with no logging.**
- **Command acks:** `status` must be the literal string `"ok"`. Anything
  else, including absent, is a rejection.
- `state_kind` accepts only `"number"` or `"state"`. Never `"text"`.
- A command that writes nothing must not report success. This rule was
  learned three times in v0.1; it applies to every new domain.
- `MAX_ENTITY_ID_LENGTH` is 255 and applies to every domain.
- Camera is **out of scope** by explicit user decision. Do not publish
  `camera_meta` and do not add a `camera` domain.
- No physical panel has ever run this adapter. Nothing in this plan may
  claim hardware verification.

---

## File Structure

New files:

| File | Responsibility |
| --- | --- |
| `src/protocol/climate.ts` | build the complete climate attribute payload |
| `src/protocol/cover.ts` | build the complete cover attribute payload, infer `supported_features` |
| `src/protocol/media.ts` | build media state and `state_fast`, artwork keys |
| `src/protocol/weather.ts` | build current + forecast payload, pre-aggregate daily extrema |
| `src/protocol/editable.ts` | build the `/control` payload, validate session/revision/options |
| `src/protocol/history.ts` | parse the four request shapes, build numeric and discrete responses |
| `src/protocol/energy.ts` | parse the energy request, build the energy response |
| `src/registry/synth/climate.ts` | thermostat/airCondition channels to a virtual entity |
| `src/registry/synth/cover.ts` | blinds/blindButtons/gate channels to a virtual entity |
| `src/registry/synth/media_player.ts` | mediaPlayer/volume channels to a virtual entity |
| `src/registry/synth/weather.ts` | weatherCurrent/weatherForecast channels, day-indexed walk |
| `src/registry/synth/editable.ts` | levelSlider and enum-state channels for number/select/datetime |
| `src/runtime/history-provider.ts` | `getHistoryAsync` against the configured instance |
| `src/runtime/value-ack.ts` | publish `stat/value` acks |

Modified files:

| File | Change |
| --- | --- |
| `src/registry/types.ts:1` | widen `Domain` with the seven new domains |
| `src/protocol/topics.ts` | add a leaf parameter; add history/energy/weather-request topics |
| `src/protocol/state-payload.ts:25` | add a `payloadShape` case per new domain |
| `src/protocol/apply.ts` | add the five new `*_meta` sections |
| `src/protocol/commands.ts` | add the new command kinds |
| `src/registry/detector.ts` | map the new type-detector types and channel names |
| `src/runtime/dispatcher.ts` | handle the new command kinds |
| `src/runtime/panel-session.ts` | subscribe to the new request topics |
| `src/main.ts` | wire the history provider and value-ack |
| `admin/jsonConfig.json`, `io-package.json` | history instance, per-domain enables |
| `docs/protocol.md` | document every new domain |

---

## Task 1: Generalise the entity state topic leaf

`entityStateTopic()` hardcodes a `/state` suffix. Weather needs `/weather` and
editable needs `/control`. Every other domain keeps `/state`.

**Files:**
- Modify: `src/protocol/topics.ts:59-72`
- Test: `test/protocol/topics.test.ts`

**Interfaces:**
- Produces: `entityStateTopic(haPrefix: string, entityId: string, leaf?: 'state' | 'weather' | 'control'): string` — `leaf` defaults to `'state'` so every v0.1 call site is unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
it('defaults to the state leaf so v0.1 callers are unchanged', () => {
  expect(entityStateTopic('ha', 'sensor.kitchen')).to.equal('ha/sensor/kitchen/state');
});

it('uses the literal word weather for the weather domain, not state', () => {
  // firmware: <ha_prefix>/weather/<object_id>/weather — see
  // docs/contract-media-weather.md. Using /state here renders an empty tile
  // with no error anywhere.
  expect(entityStateTopic('ha', 'weather.home', 'weather'))
    .to.equal('ha/weather/home/weather');
});

it('uses the control leaf for editable domains', () => {
  expect(entityStateTopic('ha', 'number.setpoint', 'control'))
    .to.equal('ha/number/setpoint/control');
});

it('still rejects an entity id with no dot', () => {
  expect(() => entityStateTopic('ha', 'bogus', 'state')).to.throw('invalid entity id');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --grep "topics"`
Expected: FAIL — `entityStateTopic` takes two arguments.

- [ ] **Step 3: Implement**

Add the third parameter with a `'state'` default. Keep the existing
single-dot replacement and the existing doc comment: the reasoning about
multi-dot ids is still correct and still load-bearing.

- [ ] **Step 4: Verify pass, then confirm nothing regressed**

Run: `npm test`
Expected: all existing tests still pass — the default keeps v0.1 call sites valid.

- [ ] **Step 5: Commit**

```bash
git add src/protocol/topics.ts test/protocol/topics.test.ts
git commit -m "feat(protocol): parameterise the entity state topic leaf"
```

---

## Task 2: Widen the Domain union and let the compiler find the work

Widening `Domain` breaks every exhaustive switch. That is the point: the
compiler enumerates the sites the rest of this plan must fill.

**Files:**
- Modify: `src/registry/types.ts:1`, `src/protocol/state-payload.ts:25`
- Test: `test/protocol/state-payload.test.ts`

**Interfaces:**
- Produces: `Domain = 'sensor' | 'binary_sensor' | 'switch' | 'light' | 'scene' | 'climate' | 'cover' | 'media_player' | 'weather' | 'number' | 'select' | 'datetime'`

**Payload shape per domain** — from the contracts, not guessed:

| Domain | Shape | Source |
| --- | --- | --- |
| climate | `json` | `docs/contract-climate-cover.md` |
| cover | `json` | `docs/contract-climate-cover.md` |
| media_player | `json` | `docs/contract-media-weather.md` |
| weather | `json` | `docs/contract-media-weather.md` |
| number, select, datetime | `json` | `docs/contract-editable.md` (the `/control` payload) |

- [ ] **Step 1: Write the failing test**

```ts
it('assigns a payload shape to every domain', () => {
  const all: Domain[] = ['sensor','binary_sensor','switch','light','scene',
    'climate','cover','media_player','weather','number','select','datetime'];
  for (const d of all) expect(() => payloadShapeFor(d)).to.not.throw();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build`
Expected: FAIL — `payloadShape` is not exhaustive; TypeScript reports the missing cases. Record the full list of files the compiler flags; those are the sites later tasks fill.

- [ ] **Step 3: Implement**

Widen the union. Add the seven cases to `payloadShape`. **Do not add a
`default` case** — its absence is the mechanism that makes this plan safe.

For every other site the compiler flags, add an explicit case that throws
`not implemented: <domain>` rather than silently falling through. Later tasks
replace each throw. A throw is loud; a fallthrough is the silent-bug pattern
this project keeps getting bitten by.

- [ ] **Step 4: Verify**

Run: `npm run build && npm test`
Expected: build clean, all v0.1 tests still pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(registry): widen Domain to every supported firmware domain"
```

---

## Task 3: Climate registry — detection and synthesis

**Read first:** `docs/contract-iobroker-types.md` (the thermostat section) and
`docs/contract-climate-cover.md`.

**Files:**
- Create: `src/registry/synth/climate.ts`
- Modify: `src/registry/detector.ts`, `src/registry/synth/index.ts`
- Test: `test/registry/synth/climate.test.ts`

**Interfaces:**
- Consumes: the `VirtualEntity` shape and `isUsable` from `src/registry/synth/common.ts`
- Produces: `synthClimate(source: DetectedDevice): VirtualEntity | null`

**The trap:** `thermostat` has **no required channel**. A device can be
detected as a thermostat while exposing neither `SET` nor `ACTUAL`.
`airCondition` requires only `MODE`. So a detected climate device may have
nothing writable at all.

Channel roles to map (names from type-detector, see the contract):

| Role | thermostat | airCondition |
| --- | --- | --- |
| setpoint | `SET` | `SET` |
| dual setpoint | `SET_HEATING`, `SET_COOLING` | `SET_HEATING`, `SET_COOLING` |
| current temperature | `ACTUAL` | `ACTUAL` |
| humidity | `HUMIDITY` | `HUMIDITY` |
| mode | `MODE`, `WORKING_MODE` | `MODE`, `WORKING_MODE` |
| fan speed | — | `SPEED`, `SPEED_LEVEL` |
| swing | — | `SWING` (listed twice — resolve by role, not name) |
| power | `POWER` | `POWER` |
| boost | `BOOST` | `BOOST` |

- [ ] **Step 1: Write the failing tests**

```ts
it('returns null for a thermostat with no readable or writable channel', () => {
  // thermostat has NO required channels, so this is reachable, not theoretical
  expect(synthClimate(deviceWith({}))).to.equal(null);
});

it('marks a thermostat with ACTUAL but no SET as read-only', () => {
  const e = synthClimate(deviceWith({ ACTUAL: numState(21.5) }));
  expect(e?.attributes.current_temperature).to.equal(21.5);
  expect(e?.writable.setpoint).to.equal(undefined);
});

it('carries SET_HEATING and SET_COOLING as a dual setpoint, not as SET', () => {
  const e = synthClimate(deviceWith({ SET_HEATING: numState(18), SET_COOLING: numState(24) }));
  expect(e?.attributes.target_temp_low).to.equal(18);
  expect(e?.attributes.target_temp_high).to.equal(24);
  expect(e?.attributes.target_temperature).to.equal(undefined);
});

it('resolves the two SWING channels deterministically', () => {
  // airCondition lists SWING twice; pin which is vertical and which horizontal
  const e = synthClimate(airConditionWithBothSwings());
  expect(e?.attributes.swing_mode).to.not.equal(e?.attributes.swing_horizontal_mode);
});

it('does not fabricate a setpoint from the current temperature', () => {
  const e = synthClimate(deviceWith({ ACTUAL: numState(21.5) }));
  expect(e?.attributes.target_temperature).to.equal(undefined);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- --grep "synth/climate"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `synthClimate`**

Return `null` when the device has no usable channel at all. Populate only
attributes backed by a real channel. Record writability per role, so Task 5
can refuse a command that has nowhere to write.

- [ ] **Step 4: Verify**

Run: `npm test -- --grep "synth/climate"`

- [ ] **Step 5: Commit**

```bash
git add src/registry/synth/climate.ts src/registry/detector.ts test/registry/synth/climate.test.ts
git commit -m "feat(registry): detect and synthesise climate entities"
```

---

## Task 4: Climate state payload — the complete attribute set

**Read first:** `docs/contract-climate-cover.md`, especially the overwrite
semantics and the null-parsing hazard.

**Files:**
- Create: `src/protocol/climate.ts`
- Modify: `src/protocol/state-payload.ts`
- Test: `test/protocol/climate.test.ts`

**Interfaces:**
- Produces: `buildClimatePayload(entity: VirtualEntity): string`

**Two rules that make this task different from every v0.1 domain:**

1. The firmware **overwrites its whole cache** on each message, so every
   KNOWN attribute goes out on every publish, including ones that did not
   change. **An UNKNOWN attribute is omitted — never filled with the
   firmware's default.** (CORRECTED in execution, Rulings 13-14: the original
   text said to publish every attribute "every time", which produced a real
   defect.) An omitted key resets a separate presence flag such as
   `has_target_temperature`, and the climate UI gates on that flag; filling
   20.0 fabricates an interactive setpoint on a read-only thermostat and
   permanently disables dual-setpoint range mode
   (`climate_popup.cpp:1169`). The wire key for the target is `temperature`
   (`tile_renderer.cpp:2234`), not `target_temperature`.
2. **Never emit `null` for a string field.** The firmware's hand-rolled
   scanner can misparse it and take the next quoted token in the payload as
   the value. Omit the key instead.

- [ ] **Step 1: Write the failing tests**

```ts
it('omits the target temperature when it is unknown, never filling 20.0', () => {
  // CORRECTED (Ruling 13): presence of `temperature` sets has_target_temperature,
  // which fabricates a setpoint and disables dual-setpoint mode
  const p = JSON.parse(buildClimatePayload(entityWithOnly({ current_temperature: 21 })));
  expect(p).to.not.have.property('temperature');
});

it('emits the target under the wire key temperature when it is known', () => {
  const p = JSON.parse(buildClimatePayload(entityWithOnly({ target_temperature: 21.5 })));
  expect(p.temperature).to.equal(21.5);
  expect(p).to.not.have.property('target_temperature');
});

it('never emits null for a string field', () => {
  const raw = buildClimatePayload(entityWithNoHvacMode());
  expect(raw).to.not.match(/"hvac_mode"\s*:\s*null/);
  expect(JSON.parse(raw)).to.not.have.property('hvac_mode');
});

it('emits the dual setpoint pair only when BOTH ends are known', () => {
  // target_temp_low and target_temp_high share ONE presence flag. Filling the
  // unknown end with 18.0/24.0 fabricates a displayed, interactive value.
  // (CORRECTED, Ruling 14: a lone end is collapsed to a single setpoint in the
  // synth layer, so it never reaches here as half a pair.)
  const p = JSON.parse(buildClimatePayload(entityWithOnly({ target_temp_low: 18 })));
  expect(p).to.not.have.property('target_temp_low');
  expect(p).to.not.have.property('target_temp_high');
});

it('drops a custom preset rather than sending a name the firmware discards', () => {
  // only 8 hardcoded HA-core preset names are recognised
  const p = JSON.parse(buildClimatePayload(entityWithPreset('my_custom_mode')));
  expect(p.preset_mode).to.equal(undefined);
});
```

- [ ] **Step 2–4: red, implement, green**

Run: `npm test -- --grep "protocol/climate"`

- [ ] **Step 5: Commit**

```bash
git add src/protocol/climate.ts src/protocol/state-payload.ts test/protocol/climate.test.ts
git commit -m "feat(protocol): build the complete climate attribute payload"
```

---

## Task 5: Climate commands

**Read first:** the command section of `docs/contract-climate-cover.md` for
the exact service names and parameter keys.

**Files:**
- Modify: `src/protocol/commands.ts`, `src/runtime/dispatcher.ts`
- Test: `test/protocol/commands.test.ts`, `test/runtime/dispatcher.test.ts`

**Interfaces:**
- Produces: command kinds `set_temperature`, `set_humidity`, `set_hvac_mode`, `set_fan_mode`, `set_preset_mode`, `set_swing_mode`, `set_swing_horizontal_mode`

- [ ] **Step 1: Write the failing tests**

```ts
it('rejects a setpoint command when the thermostat has no writable SET', () => {
  // the v0.1 rule, applied to a new domain: writing nothing is not success
  const r = dispatch({ kind: 'set_temperature', entityId: 'climate.hall', value: 21 }, readOnlyThermostat());
  expect(r).to.deep.equal({ ok: false, reason: 'no_writable_channel', applied: 0 });
});

it('routes swing and horizontal swing to different channels', () => {
  const r = dispatch({ kind: 'set_swing_horizontal_mode', entityId: 'climate.ac', value: 'auto' }, acWithBothSwings());
  expect(r.writes[0].channel).to.equal('swing_horizontal');
});

it('throws on an out-of-union command kind rather than returning undefined', () => {
  expect(() => parseCommand('cmnd/climate', '{"bogus":1}')).to.throw();
});
```

- [ ] **Step 2–4: red, implement, green**

Extend the `never`-bound `default` in `parseCommand` so a new kind cannot be
silently dropped.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(runtime): dispatch climate commands"
```

---

## Task 5b: Make climate controls reachable (added in execution, Ruling 26)

Full brief: `.superpowers/sdd/2026-09-22-iobroker-hometiles-v0.2/task-5b-brief.md`.
The adapter publishes none of the `*_modes` arrays, and the firmware renders
a climate control's buttons only from them, so every climate control is
unreachable on real hardware. Derive each list from the channel's states
map, keep only labels in the firmware's fixed name tables, emit only when
non-empty, and resolve the `supported_features` bits that gate setpoint
interactivity.

---

## Task 5c: Make detection match the real type-detector (added in execution, Rulings 34-35)

Full brief: `.superpowers/sdd/2026-09-22-iobroker-hometiles-v0.2/task-5c-brief.md`.
The real ChannelDetector returns every state of a matched pattern, including
unmatched ones with no id, and mapControlToDevice turned each into a channel
with an undefined objectId; it also let the pattern's write flag override the
object's own common.write. Both date from v0.1 and were invisible because
every test hand-built the detector output. Fix both, and add a suite that
drives the REAL detector end to end for every implemented domain.

---

## Task 6: Cover registry — detection and synthesis

**Read first:** `docs/contract-iobroker-types.md` (blinds, blindButtons, gate).

**Files:**
- Create: `src/registry/synth/cover.ts`
- Modify: `src/registry/detector.ts`, `src/registry/synth/index.ts`
- Test: `test/registry/synth/cover.test.ts`

**Interfaces:**
- Produces: `synthCover(source: DetectedDevice): VirtualEntity | null`

Three type-detector types land in this one domain, and they differ in what is
required: `blinds` requires `SET` (position), `blindButtons` requires
`STOP`/`OPEN`/`CLOSE` and has **no position at all**, `gate` requires `SET`.

- [ ] **Step 1: Write the failing tests**

```ts
it('synthesises a blindButtons device with no position channel', () => {
  // blindButtons has no SET; a position-shaped assumption drops the device
  const e = synthCover(blindButtonsDevice());
  expect(e).to.not.equal(null);
  expect(e?.attributes.current_position).to.equal(undefined);
  expect(e?.writable.open).to.not.equal(undefined);
});

it('keeps tilt independent of position', () => {
  const e = synthCover(deviceWith({ SET: numState(40), TILT_SET: numState(90) }));
  expect(e?.attributes.current_position).to.equal(40);
  expect(e?.attributes.current_tilt_position).to.equal(90);
});

it('does not report position 0 for a device that has no position channel', () => {
  // 0 is a legitimate closed position; absent must stay absent
  const e = synthCover(blindButtonsDevice());
  expect('current_position' in (e?.attributes ?? {})).to.equal(false);
});
```

- [ ] **Step 2–4: red, implement, green**
- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(registry): detect and synthesise cover entities"
```

---

## Task 7: Cover state payload and supported_features inference

**Read first:** the `supported_features` section of `docs/contract-climate-cover.md`.

**Files:**
- Create: `src/protocol/cover.ts`
- Test: `test/protocol/cover.test.ts`

**Interfaces:**
- Produces: `buildCoverPayload(entity: VirtualEntity): string`

**The trap:** an absent `supported_features` does **not** mean zero. The
firmware infers `OPEN|CLOSE|STOP` unconditionally, and adds the position and
tilt bits purely from whether `current_position` and `current_tilt_position`
appeared **in that same message**. So presence of a value silently grants a
capability. Publishing a position for a device that cannot be positioned
would advertise a control that does nothing.

Cover shares climate's full-overwrite rule: position and tilt default to 0
when omitted. `null` is safe here — ArduinoJson treats it as absent — but
prefer omission for consistency with climate.

- [ ] **Step 1: Write the failing tests**

```ts
it('omits current_position for a device with no position channel', () => {
  // presence alone grants SET_POSITION on the panel
  const p = JSON.parse(buildCoverPayload(blindButtonsEntity()));
  expect(p).to.not.have.property('current_position');
});

it('emits an explicit supported_features rather than relying on inference', () => {
  const p = JSON.parse(buildCoverPayload(fullCoverEntity()));
  expect(p.supported_features).to.be.a('number');
});

it('emits position 0 as a real value, distinct from absent', () => {
  const p = JSON.parse(buildCoverPayload(entityWithPosition(0)));
  expect(p.current_position).to.equal(0);
});
```

- [ ] **Step 2–5: red, implement, green, commit**

```bash
git add -A && git commit -m "feat(protocol): build cover payload with explicit supported_features"
```

---

## Task 8: Cover commands

**Read first:** the cover command allow-list in `docs/contract-climate-cover.md`.

**Files:**
- Modify: `src/protocol/commands.ts`, `src/runtime/dispatcher.ts`, `src/runtime/panel-session.ts`
- Test: `test/runtime/dispatcher.test.ts`

Ten commands are allow-listed by the firmware. Two of them — `toggle` and
`toggle_cover_tilt` — have **no caller anywhere in the firmware**. Implement
all ten anyway: they are part of the accepted contract, they cost a line
each, and a future firmware release may wire them up. Note the two dead ones
in a comment so a later reader does not go hunting for the UI that sends them.

**Command subscription (added in execution, Ruling 16).** Parsing and
dispatching a command is useless unless the panel session subscribes to its
topic. Add `'cover'` to `COMMAND_LEAVES` in `src/runtime/panel-session.ts`
so `<baseTopic>/cmnd/cover` is actually received, and add a test that the
session's subscription list includes it. The leaf is `cover` — taken from
the contract document, and NOT necessarily the same string as the
`cover` domain name.

- [ ] **Step 1: Write the failing tests**

```ts
it('refuses set_cover_position on a device with no position channel', () => {
  const r = dispatch({ kind: 'set_cover_position', entityId: 'cover.blind', value: 50 }, blindButtonsEntity());
  expect(r).to.deep.equal({ ok: false, reason: 'no_writable_channel', applied: 0 });
});

it('treats tilt commands as independent of position commands', () => {
  const r = dispatch({ kind: 'set_cover_tilt_position', entityId: 'cover.b', value: 90 }, tiltOnlyEntity());
  expect(r.ok).to.equal(true);
});
```

- [ ] **Step 2–5: red, implement, green, commit**

```bash
git add -A && git commit -m "feat(runtime): dispatch cover commands"
```

---

## Task 9: Media player registry and payload

**Read first:** `docs/contract-media-weather.md` (media sections) and the
`mediaPlayer` row of `docs/contract-iobroker-types.md`.

**Files:**
- Create: `src/registry/synth/media_player.ts`, `src/protocol/media.ts`
- Test: `test/registry/synth/media_player.test.ts`, `test/protocol/media.test.ts`

**Interfaces:**
- Produces: `synthMediaPlayer(source): VirtualEntity | null`, `buildMediaPayload(entity): string`, `buildMediaFastPayload(entity): string`

`mediaPlayer` requires only `STATE`. It lists `COVER` twice — resolve by role
and pin the choice with a test, as with climate's `SWING`.

Artwork has its own path: `entity_picture`, `entity_picture_data` and the
`state_fast` variant interact, and `state_fast` is URL-only and precedes the
full state. Follow the contract exactly here; this is the part most likely to
be got wrong by analogy with the other domains.

- [ ] **Step 1: Write the failing tests**

```ts
it('synthesises a media player that exposes only STATE', () => {
  expect(synthMediaPlayer(deviceWith({ STATE: strState('playing') }))).to.not.equal(null);
});

it('resolves the two COVER channels deterministically', () => {
  const e = synthMediaPlayer(deviceWithBothCovers());
  expect(e?.attributes.entity_picture).to.not.equal(e?.attributes.entity_picture_data);
});

it('emits state_fast with the URL only', () => {
  const p = JSON.parse(buildMediaFastPayload(entityWithArtwork()));
  expect(p).to.have.property('entity_picture');
  expect(p).to.not.have.property('media_title');
});
```

- [ ] **Step 2–5: red, implement, green, commit**

```bash
git add -A && git commit -m "feat: media player detection, synthesis and payload"
```

---

## Task 10: Media player commands

**Read first:** the media command section of `docs/contract-media-weather.md`.

**Files:**
- Modify: `src/protocol/commands.ts`, `src/runtime/dispatcher.ts`, `src/runtime/panel-session.ts`
- Test: `test/runtime/dispatcher.test.ts`

**Only three transport commands exist in this firmware:** `previous`,
`play_pause`, `next`. There is **no media stop command from any UI control**,
despite `STOP` existing as a type-detector channel. Do not invent one. Volume,
mute and seek are separate commands with their own payloads.

**Command subscription (added in execution, Ruling 16).** Parsing and
dispatching a command is useless unless the panel session subscribes to its
topic. Add `'media'` to `COMMAND_LEAVES` in `src/runtime/panel-session.ts`
so `<baseTopic>/cmnd/media` is actually received, and add a test that the
session's subscription list includes it. The leaf is `media` — taken from
the contract document, and NOT necessarily the same string as the
`media_player` domain name.

- [ ] **Step 1: Write the failing tests**

```ts
it('maps play_pause to the single toggle channel', () => {
  expect(dispatch({ kind: 'media_play_pause', entityId: 'media_player.tv' }, mediaEntity()).ok).to.equal(true);
});

it('refuses a volume command on a player with no volume channel', () => {
  const r = dispatch({ kind: 'media_set_volume', entityId: 'media_player.tv', value: 0.5 }, playerWithoutVolume());
  expect(r).to.deep.equal({ ok: false, reason: 'no_writable_channel', applied: 0 });
});
```

- [ ] **Step 2–5: red, implement, green, commit**

```bash
git add -A && git commit -m "feat(runtime): dispatch media player commands"
```

---

## Task 11: Weather registry — the day-indexed forecast walk

**Read first:** the weather sections of `docs/contract-media-weather.md` and
`docs/contract-iobroker-types.md`.

**Files:**
- Create: `src/registry/synth/weather.ts`
- Test: `test/registry/synth/weather.test.ts`

**Interfaces:**
- Produces: `synthWeather(source: DetectedDevice): VirtualEntity | null`

ioBroker's `weatherForecast` exposes a `%d`-suffixed channel family —
`ICON%d`, `TEMP_MIN%d`, `TEMP_MAX%d`, `DATE%d`, and so on — where `%d` is a
day offset. The number of days is whatever the source adapter publishes, so
**walk the index and stop at the first missing day**. Do not assume a fixed
count; different weather adapters publish different depths.

- [ ] **Step 1: Write the failing tests**

```ts
it('walks the day-indexed channels and stops at the first gap', () => {
  const e = synthWeather(forecastWithDays(0, 1, 2));   // no day 3
  expect(e?.attributes.forecast).to.have.lengthOf(3);
});

it('does not assume a fixed forecast depth', () => {
  expect(synthWeather(forecastWithDays(0))?.attributes.forecast).to.have.lengthOf(1);
  expect(synthWeather(forecastWithDays(0,1,2,3,4,5,6))?.attributes.forecast).to.have.lengthOf(7);
});

it('combines weatherCurrent and weatherForecast into one entity', () => {
  const e = synthWeather(currentPlusForecastDevice());
  expect(e?.attributes.temperature).to.be.a('number');
  expect(e?.attributes.forecast).to.be.an('array');
});
```

- [ ] **Step 2–5: red, implement, green, commit**

```bash
git add -A && git commit -m "feat(registry): synthesise weather from day-indexed channels"
```

---

## Task 12: Weather payload, pre-aggregation, and the request nudge

**Read first:** the weather request/response trace in `docs/contract-media-weather.md`.

**Files:**
- Create: `src/protocol/weather.ts`
- Modify: `src/runtime/panel-session.ts`
- Test: `test/protocol/weather.test.ts`

**Interfaces:**
- Produces: `buildWeatherPayload(entity: VirtualEntity): string`

**Three facts that make weather unlike every other domain:**

1. It publishes to `<haPrefix>/weather/<object_id>/weather` — the trailing
   segment is the literal word `weather`, not `state`. Task 1 added the leaf
   parameter for this.
2. There is **no `weather/response` topic**. `weather/request` is a
   fire-and-forget nudge the panel sends only when its local cache is empty.
   The adapter answers by publishing the ordinary retained weather state, not
   by replying on a response topic. Subscribe to the request so the nudge can
   trigger a re-publish; do not build a reply topic.
3. **The firmware performs no aggregation.** Daily extrema must already be
   aggregated by the sender. Publishing raw hourly values yields a visibly
   wrong daily high.

- [ ] **Step 1: Write the failing tests**

```ts
it('aggregates hourly values into daily extrema before publishing', () => {
  // firmware does zero aggregation: raw hourly data renders a wrong daily high
  const p = JSON.parse(buildWeatherPayload(hourlyEntity([11, 18, 24, 19])));
  expect(p.forecast[0].temperature).to.equal(24);
  expect(p.forecast[0].templow).to.equal(11);
});

it('publishes on the weather leaf, not the state leaf', () => {
  expect(weatherStateTopic('ha', 'weather.home')).to.equal('ha/weather/home/weather');
});

it('re-publishes retained state on a request nudge rather than replying', () => {
  const out = handleWeatherRequest(session, 'weather.home');
  expect(out.topic).to.equal('ha/weather/home/weather');
});
```

- [ ] **Step 2–5: red, implement, green, commit**

```bash
git add -A && git commit -m "feat(protocol): weather payload with daily pre-aggregation"
```

---

## Task 13: Editable registry — number, select and datetime

**Read first:** `docs/contract-editable.md` in full. It is the strictest
contract in the project.

**Files:**
- Create: `src/registry/synth/editable.ts`
- Test: `test/registry/synth/editable.test.ts`

**Interfaces:**
- Produces: `synthNumber(source): VirtualEntity | null`, `synthSelect(source): VirtualEntity | null`, `synthDatetime(source): VirtualEntity | null`

`levelSlider` (`Types.slider`) backs `number`. `select` comes from a state
with an enum `states` map — type-detector has no select type, so this is an
override-driven path. `datetime` has no type-detector equivalent at all and
is **override-only**: never infer it.

`editable_meta` carries only `entity_id` and `name`. Min, max, step, unit and
the option list travel in the `/control` state payload, not in the meta
section. Do not try to put them in `bridge/apply`.

- [ ] **Step 1: Write the failing tests**

```ts
it('derives number bounds from the ioBroker object common min/max', () => {
  const e = synthNumber(sliderWith({ min: 5, max: 30, step: 0.5, unit: '°C' }));
  expect(e?.attributes).to.include({ min: 5, max: 30, step: 0.5 });
});

it('never infers a datetime entity from detection alone', () => {
  expect(synthDatetime(anyDetectedDevice())).to.equal(null);
});

it('drops the whole option list when one option is invalid', () => {
  // no partial acceptance: an invalid option makes the tile read-only
  const e = synthSelect(selectWithStates({ a: 'Alpha', b: 'Bad\nName' }));
  expect(e?.attributes.options).to.equal(undefined);
});

it('rejects an option list with a duplicate label', () => {
  expect(synthSelect(selectWithStates({ a: 'Same', b: 'Same' }))?.attributes.options).to.equal(undefined);
});
```

- [ ] **Step 2–5: red, implement, green, commit**

```bash
git add -A && git commit -m "feat(registry): synthesise number, select and datetime entities"
```

---

## Task 14: The /control payload

**Read first:** the `/control` schema and validation rules in `docs/contract-editable.md`.

**Files:**
- Create: `src/protocol/editable.ts`
- Test: `test/protocol/editable.test.ts`

**Interfaces:**
- Produces: `buildControlPayload(entity: VirtualEntity, session: string, revision: string): string`

**Every one of these rejects the message silently and completely:**

- a missing `state` key rejects the **entire** message; `state: null` is valid and renders `--`
- `session` must be exactly 32 characters, `revision` exactly 16 — a 36-character UUID breaks every editable tile
- `options` require `options_complete: true` and every option valid (unique, 1–255 bytes, no `\n` or `\r`)
- a payload over 24576 bytes is dropped **with no logging at all**

- [ ] **Step 1: Write the failing tests**

```ts
it('always includes a state key, using null for unknown', () => {
  const p = JSON.parse(buildControlPayload(entityWithUnknownValue(), sess32(), rev16()));
  expect('state' in p).to.equal(true);
  expect(p.state).to.equal(null);
});

it('throws on a session that is not exactly 32 characters', () => {
  // a UUID is 36 and would silently break every editable tile
  expect(() => buildControlPayload(e, '123e4567-e89b-12d3-a456-426614174000', rev16()))
    .to.throw(/session/);
});

it('throws on a revision that is not exactly 16 characters', () => {
  expect(() => buildControlPayload(e, sess32(), 'short')).to.throw(/revision/);
});

it('refuses to emit a payload over the 24576 byte limit', () => {
  // the firmware drops these with zero logging, so failing loudly here is
  // the only place this can ever be noticed
  expect(() => buildControlPayload(entityWithHugeOptionList(), sess32(), rev16()))
    .to.throw(/24576/);
});

it('omits options entirely rather than sending an incomplete list', () => {
  const p = JSON.parse(buildControlPayload(entityWithOneBadOption(), sess32(), rev16()));
  expect(p).to.not.have.property('options');
  expect(p).to.not.have.property('options_complete');
});
```

- [ ] **Step 2–5: red, implement, green, commit**

```bash
git add -A && git commit -m "feat(protocol): build and validate the editable control payload"
```

---

## Task 15: cmnd/value handling and the stat/value ack

**Read first:** the command and ack sections of `docs/contract-editable.md`.

**Files:**
- Create: `src/runtime/value-ack.ts`
- Modify: `src/protocol/commands.ts`, `src/runtime/dispatcher.ts`, `src/runtime/panel-session.ts`
- Test: `test/runtime/value-ack.test.ts`

**Interfaces:**
- Produces: `buildValueAck(entityId: string, id: string, ok: boolean, reason?: string): { topic: string; payload: string }`

All three editable domains share one command topic, `<baseTopic>/cmnd/value`,
disambiguated only by `entity_id` in the body. The ack goes to a **third**
topic, `<baseTopic>/stat/value`, correlated by `entity_id` **and** `id`.
`status` must be the literal string `"ok"`; anything else, including absent,
is read as a rejection.

The device echoes `session`, `revision` and its own `deadline` in the
command. The adapter treats all three as **opaque** — echo them back, never
parse or validate them.

**Command subscription (added in execution, Ruling 16).** Parsing and
dispatching a command is useless unless the panel session subscribes to its
topic. Add `'value'` to `COMMAND_LEAVES` in `src/runtime/panel-session.ts`
so `<baseTopic>/cmnd/value` is actually received, and add a test that the
session's subscription list includes it. The leaf is `value` — taken from
the contract document, and NOT necessarily the same string as the
`number/select/datetime` domain name.

- [ ] **Step 1: Write the failing tests**

```ts
it('acks with the literal string ok, not a boolean', () => {
  const a = JSON.parse(buildValueAck('number.x', 'abc', true).payload);
  expect(a.status).to.equal('ok');
});

it('sends a rejection ack rather than staying silent on failure', () => {
  const a = JSON.parse(buildValueAck('number.x', 'abc', false, 'no_writable_channel').payload);
  expect(a.status).to.not.equal('ok');
});

it('echoes both entity_id and id so the panel can correlate', () => {
  const a = JSON.parse(buildValueAck('number.x', 'abc', true).payload);
  expect(a).to.include({ entity_id: 'number.x', id: 'abc' });
});

it('acks on stat/value, not on the command topic', () => {
  expect(buildValueAck('number.x', 'abc', true).topic).to.match(/\/stat\/value$/);
});
```

- [ ] **Step 2–5: red, implement, green, commit**

```bash
git add -A && git commit -m "feat(runtime): handle cmnd/value and publish stat/value acks"
```

---

## Task 16: Parse the four history request shapes off one topic

**Read first:** `docs/contract-history-energy.md`, the request sections.

**Files:**
- Create: `src/protocol/history.ts`
- Test: `test/protocol/history.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type HistoryRequest =
    | { kind: 'numeric'; entityId: string; hours: number; periodMinutes: number }
    | { kind: 'state'; entityId: string; hours: 24 | 168 }
    | { kind: 'binary'; entityId: string; hours: 24 | 168 }
    | { kind: 'editable'; entityId: string; hours: number; requestId: string };
  export function parseHistoryRequest(payload: string): HistoryRequest | null;
  ```

**Four** entry points publish to the same `history/request` topic — the three
named ones plus an undocumented fourth from the editable popups
(`value_control.cpp:179`). **Dispatch on payload shape, never on topic.**
Only the editable variant carries `request_id`.

- [ ] **Step 1: Write the failing tests**

```ts
it('distinguishes the four request shapes on one topic', () => {
  expect(parseHistoryRequest(numericReq()).kind).to.equal('numeric');
  expect(parseHistoryRequest(stateReq()).kind).to.equal('state');
  expect(parseHistoryRequest(binaryReq()).kind).to.equal('binary');
  expect(parseHistoryRequest(editableReq()).kind).to.equal('editable');
});

it('carries request_id only for the editable shape', () => {
  const e = parseHistoryRequest(editableReq());
  expect(e.kind === 'editable' && e.requestId).to.be.a('string');
});

it('returns null for a malformed request instead of throwing into the handler', () => {
  expect(parseHistoryRequest('{')).to.equal(null);
});
```

- [ ] **Step 2–5: red, implement, green, commit**

```bash
git add -A && git commit -m "feat(protocol): parse the four history request shapes"
```

---

## Task 17: Build the numeric history response

**Read first:** the numeric response section of `docs/contract-history-energy.md`.

**Files:**
- Modify: `src/protocol/history.ts`
- Test: `test/protocol/history.test.ts`

**Interfaces:**
- Produces: `buildNumericHistoryResponse(req, samples: Array<{ ts: number; val: number | null }>): string`

**The single most counter-intuitive fact in this plan: numeric history
carries no timestamps.** The array index *is* the time bucket, spaced
`period_minutes` apart. Sending epoch timestamps produces a silently wrong
graph, not an error.

The response must echo `entity_id` and `period_minutes`/`hours` verbatim, or
the firmware drops it. There is no request id on this path.

- [ ] **Step 1: Write the failing tests**

```ts
it('emits bare values with no timestamps', () => {
  const r = JSON.parse(buildNumericHistoryResponse(req, samples));
  expect(r.values.every((v: unknown) => typeof v === 'number' || v === null)).to.equal(true);
});

it('buckets samples by index at period_minutes spacing', () => {
  // two samples 30 minutes apart with period_minutes 15 land two slots apart
  const r = JSON.parse(buildNumericHistoryResponse(
    { kind: 'numeric', entityId: 'sensor.t', hours: 24, periodMinutes: 15 },
    [{ ts: t0, val: 1 }, { ts: t0 + 30 * 60_000, val: 2 }]));
  expect(r.values[0]).to.equal(1);
  expect(r.values[2]).to.equal(2);
});

it('echoes entity_id and period_minutes or the response is dropped', () => {
  const r = JSON.parse(buildNumericHistoryResponse(req, samples));
  expect(r).to.include({ entity_id: req.entityId, period_minutes: req.periodMinutes });
});

it('represents a gap as null rather than closing it up', () => {
  const r = JSON.parse(buildNumericHistoryResponse(reqWithGap, samplesWithGap));
  expect(r.values).to.include(null);
});
```

- [ ] **Step 2–5: red, implement, green, commit**

```bash
git add -A && git commit -m "feat(protocol): build index-bucketed numeric history responses"
```

---

## Task 18: Build the discrete history response

**Read first:** the discrete response section of `docs/contract-history-energy.md`.

**Files:**
- Modify: `src/protocol/history.ts`
- Test: `test/protocol/history.test.ts`

**Interfaces:**
- Produces: `buildDiscreteHistoryResponse(req, samples): string`

Three rules, each of which silently discards the whole response when broken:

1. `hours` is **exactly** 24 or 168, snapped by the firmware before it sends.
   Echo the requested value verbatim; do not recompute it.
2. `activity[]` keeps only the last **96** entries **by array index** and
   requires **oldest-to-newest** wire order. Newest-first keeps the wrong
   entries — and looks plausible on screen, which is worse.
3. `segments` are re-sorted by the firmware, so their wire order does not
   matter. Do not "fix" activity ordering by sorting segments.

- [ ] **Step 1: Write the failing tests**

```ts
it('echoes hours verbatim rather than recomputing it', () => {
  const r = JSON.parse(buildDiscreteHistoryResponse({ kind: 'state', entityId: 'x', hours: 168 }, s));
  expect(r.hours).to.equal(168);
});

it('emits activity oldest-to-newest', () => {
  const r = JSON.parse(buildDiscreteHistoryResponse(req, unorderedSamples));
  const ts = r.activity.map((a: any) => a.ts);
  expect(ts).to.deep.equal([...ts].sort((a, b) => a - b));
});

it('keeps the NEWEST 96 entries when truncating', () => {
  // truncation is by array index, so the oldest-to-newest array must be
  // trimmed from the front; trimming the back silently shows ancient data
  const r = JSON.parse(buildDiscreteHistoryResponse(req, sample(200)));
  expect(r.activity).to.have.lengthOf(96);
  expect(r.activity[95].ts).to.equal(newestTs);
});
```

- [ ] **Step 2–5: red, implement, green, commit**

```bash
git add -A && git commit -m "feat(protocol): build discrete history responses"
```

---

## Task 19: The ioBroker history provider

**Read first:** `docs/contract-iobroker-history.md`.

**Files:**
- Create: `src/runtime/history-provider.ts`
- Modify: `admin/jsonConfig.json`, `io-package.json`, `src/config/options.ts`
- Test: `test/runtime/history-provider.test.ts`

**Interfaces:**
- Produces: `class HistoryProvider { query(id: string, opts: { start: number; end: number; step?: number; aggregate: 'average' | 'none' }): Promise<Array<{ ts: number; val: unknown }>> }`

Use `adapter.getHistoryAsync(id, { instance, start, end, step, aggregate })`.
Do **not** hand-roll `sendTo(instance, 'getHistory', …)` — one call site
serves `history.0`, `sql.0` and `influxdb.0` alike.

Timestamps from ioBroker are **milliseconds**. Convert at the boundary if the
firmware wants seconds; the contract document states which.

Pick `aggregate` from the entity's declared kind, never from the values:
numeric graphs use `'average'`, categorical timelines use `'none'` with
`ignoreNull: false`. Averaging a categorical state is silently wrong rather
than an error.

Add a `historyInstance` config field. Populate the admin dropdown by
enumerating adapter instances whose `common.getHistory` is true.

- [ ] **Step 1: Write the failing tests**

```ts
it('queries the configured instance', async () => {
  await provider.query('sensor.t', opts);
  expect(fakeAdapter.lastCall.options.instance).to.equal('sql.0');
});

it('uses aggregate none for a categorical entity', async () => {
  await provider.query('sensor.mode', { ...opts, aggregate: 'none' });
  expect(fakeAdapter.lastCall.options.aggregate).to.equal('none');
});

it('returns an empty array when no history adapter is configured', async () => {
  // must not throw into the MQTT handler
  expect(await providerWithNoInstance.query('sensor.t', opts)).to.deep.equal([]);
});

it('does not throw when the history adapter is not running', async () => {
  fakeAdapter.rejectNext(new Error('not running'));
  expect(await provider.query('sensor.t', opts)).to.deep.equal([]);
});
```

- [ ] **Step 2–5: red, implement, green, commit**

```bash
git add -A && git commit -m "feat(runtime): query ioBroker history via getHistoryAsync"
```

---

## Task 20: Energy request and response

**Read first:** the energy sections of `docs/contract-history-energy.md`.
Note that `parseEnergySection` in the firmware is **not** the energy response
handler — it parses an entity catalog inside `bridge/apply`. Conflating the
two misroutes the implementation.

**Files:**
- Create: `src/protocol/energy.ts`
- Test: `test/protocol/energy.test.ts`

**Interfaces:**
- Produces: `parseEnergyRequest(payload: string): { period: 'day' | 'week' | 'month' } | null`, `buildEnergyResponse(period, entries): string`

Correlation is by **`period`**, held in three independent single-slot
buffers. `values[]` silently truncates past **32** entries. `null` clears a
cached `total` or `cost`, while an absent key preserves it. `"fire"` is not a
key or a category — it is the icon name returned for the category `"gas"`.

- [ ] **Step 1: Write the failing tests**

```ts
it('echoes the period so the panel routes it to the right buffer', () => {
  expect(JSON.parse(buildEnergyResponse('week', e)).period).to.equal('week');
});

it('truncates values to 32 entries rather than letting the panel drop them', () => {
  expect(JSON.parse(buildEnergyResponse('day', entries(50))).values).to.have.lengthOf(32);
});

it('omits total rather than sending null when the value is merely unknown', () => {
  // null CLEARS the cached total; absent preserves it
  const r = JSON.parse(buildEnergyResponse('day', entriesWithUnknownTotal()));
  expect(r.entries[0]).to.not.have.property('total');
});

it('sends null for total only when explicitly clearing it', () => {
  const r = JSON.parse(buildEnergyResponse('day', entriesClearingTotal()));
  expect(r.entries[0].total).to.equal(null);
});
```

- [ ] **Step 2–5: red, implement, green, commit**

```bash
git add -A && git commit -m "feat(protocol): energy request parsing and response building"
```

---

## Task 21: Extend bridge/apply with the new entity arrays and meta sections

**Read first:** the `applyJson` section of `docs/contract-v0.2-notes.md`.

**Files:**
- Modify: `src/protocol/apply.ts`
- Test: `test/protocol/apply.test.ts`

Entities are invisible to the panel until they appear in the right array.
`applyJson` reads these with `parseArraySection`:

    sensors  configured_sensors  numbers  selects  datetimes
    binary_sensors  weathers  lights  switches  media_players
    climates  covers  cameras

**Do not emit `cameras`** — camera is out of scope, and an empty array is not
the same as an absent one for a section the adapter does not support.

The five new `*_meta` sections — `climate_meta`, `cover_meta`,
`media_player_meta`, `weather_meta`, `editable_meta` — each carry only
`entity_id` and `name`, and all merge into **one shared name map** on the
firmware side. `editable_meta` covers number, select **and** datetime
together; there is no `number_meta`.

Remember the v0.1 lesson that `bridge/apply` is scanned by substring, not
parsed as JSON: key spelling and present-but-empty sections both matter.

- [ ] **Step 1: Write the failing tests**

```ts
it('lists a climate entity in the climates array', () => {
  expect(buildApply([climateEntity()])).to.match(/"climates"\s*:/);
});

it('puts number, select and datetime all in editable_meta', () => {
  const a = buildApply([numberEntity(), selectEntity(), datetimeEntity()]);
  expect(a).to.match(/"editable_meta"/);
  expect(a).to.not.match(/"number_meta"|"select_meta"|"datetime_meta"/);
});

it('never emits a cameras section', () => {
  expect(buildApply(allEntityKinds())).to.not.match(/"cameras"/);
});

it('emits only entity_id and name in a meta entry', () => {
  const meta = firstMetaEntry(buildApply([climateEntity()]), 'climate_meta');
  expect(Object.keys(meta).sort()).to.deep.equal(['entity_id', 'name']);
});
```

- [ ] **Step 2–5: red, implement, green, commit**

```bash
git add -A && git commit -m "feat(protocol): publish the new entity arrays and meta sections"
```

---

## Task 22: Wire the request topics into the panel session

**Files:**
- Modify: `src/runtime/panel-session.ts`, `src/runtime/dispatcher.ts`, `src/main.ts`
- Test: `test/runtime/panel-session.test.ts`

Subscribe each panel to its own config-plane request topics — all under the
hardcoded `tab5_lvgl/config/<deviceId>/` root, never under `baseTopic`:

    history/request    weather/request    energy/request

and publish answers to `history/response` and `energy/response`. Weather has
no response topic: answer by re-publishing the retained weather state.

Carry forward the v0.1 fix for cross-panel double dispatch: when two panels
share a base topic, one tap must still produce one write.

- [ ] **Step 1: Write the failing tests**

```ts
it('subscribes request topics under the config root, not the base topic', () => {
  expect(session.subscriptions()).to.include('tab5_lvgl/config/abc123/history/request');
  expect(session.subscriptions().join()).to.not.match(/myhome\/history\/request/);
});

it('answers a history request on history/response', async () => {
  const out = await session.handle('tab5_lvgl/config/abc123/history/request', numericReq());
  expect(out.topic).to.equal('tab5_lvgl/config/abc123/history/response');
});

it('does not double-dispatch when two panels share a base topic', async () => {
  expect((await twoPanelSetup().tap()).writes).to.equal(1);
});
```

- [ ] **Step 2–5: red, implement, green, commit**

```bash
git add -A && git commit -m "feat(runtime): serve history, weather and energy requests"
```

---

## Task 23: Admin configuration for the new domains

**Files:**
- Modify: `admin/jsonConfig.json`, `io-package.json`, `src/config/options.ts`
- Test: `test/config/options.test.ts`, `test/i18n.test.ts`

Add `historyInstance` (dropdown over instances with `common.getHistory`), and
extend `deviceOverrides` so an entity can be forced to `number`, `select` or
`datetime` — `datetime` has no type-detector equivalent and is reachable
**only** through an override.

Every new label needs all translations. The v0.1 i18n test walks
referenced-versus-defined in both directions; keep it passing.

- [ ] **Step 1: Write the failing tests**

```ts
it('accepts datetime as an override target', () => {
  expect(parseOptions({ deviceOverrides: [{ id: 'x', domain: 'datetime' }] }).ok).to.equal(true);
});

it('defaults historyInstance to empty rather than guessing history.0', () => {
  // guessing an instance that does not exist produces confusing empty graphs
  expect(parseOptions({}).historyInstance).to.equal('');
});

it('defines every referenced translation key in every language', () => { /* existing walk */ });
```

- [ ] **Step 2–5: red, implement, green, commit**

```bash
git add -A && git commit -m "feat(admin): configure history instance and new override targets"
```

---

## Task 24: End-to-end round trips per domain

**Files:**
- Modify: `test/integration/round-trip.test.ts`
- Test: the same file

Against the in-process `aedes` broker, for **each** of climate, cover,
media_player, weather, number, select and datetime: announce a panel, let the
adapter publish `bridge/apply` and the entity state, send a command from the
fake panel, and assert the ioBroker write actually happened.

Then the two request cycles: a history request answered on
`history/response`, and an energy request answered on `energy/response`.

No fixed sleeps. The v0.1 suite removed every one of them; do not reintroduce
any.

- [ ] **Step 1: Write the failing tests**

```ts
for (const domain of ['climate','cover','media_player','weather','number','select','datetime'] as const) {
  it(`completes an announce → apply → state → command round trip for ${domain}`, async () => {
    const h = await harness(domain);
    expect(h.applyPayload).to.match(new RegExp(pluralSection(domain)));
    expect(h.statePayload).to.not.equal(undefined);
    expect((await h.sendCommand()).writes).to.be.greaterThan(0);
  });
}

it('answers a numeric history request end to end', async () => {
  const r = await harness('sensor').requestHistory({ hours: 24, periodMinutes: 15 });
  expect(r.values).to.have.lengthOf(96);
});
```

- [ ] **Step 2–5: red, implement, green, commit**

```bash
git add -A && git commit -m "test: end-to-end round trips for every v0.2 domain"
```

---

## Task 25: Documentation and release metadata

**Files:**
- Modify: `docs/protocol.md`, `README.md`, `package.json`, `io-package.json`

Document every new domain in `docs/protocol.md` with the same rigour as the
v0.1 domains, and give the absent-key table from this plan's Global
Constraints a permanent home there — it is the most reusable thing this
work produced.

README must state plainly what is and is not covered: camera is deliberately
absent, and **no physical panel has ever run this adapter**. Keep the
existing hardware-check list and extend it with one check per new domain.

Bump to 0.2.0 with a news entry naming the new domains.

- [ ] **Step 1: Write the failing test**

```ts
it('documents every domain in the Domain union', () => {
  const doc = fs.readFileSync('docs/protocol.md', 'utf8');
  for (const d of ALL_DOMAINS) expect(doc).to.include(d);
});

it('keeps the no-hardware disclosure in the README', () => {
  expect(fs.readFileSync('README.md', 'utf8')).to.include('No physical panel has ever run this adapter');
});
```

- [ ] **Step 2–5: red, implement, green, commit**

```bash
git add -A && git commit -m "docs: document the v0.2 domains and release 0.2.0"
```

---

## Self-review notes

**Coverage against the gap document.** Every missing `bridge/apply` section
from `docs/gap-to-full-coverage.md` has a task: `climate_meta` (21),
`cover_meta` (21), `media_player_meta` (21), `weather_meta` (21),
`editable_meta` (21), with the domains themselves in 3–15. `camera_meta` is
deliberately absent. Of the 21 unhandled command entry points, climate's
seven are Task 5, media's four are Task 10, cover's one is Task 8, the five
request/response entry points are Tasks 16–20, and camera's one is out of
scope. `HomeSnapshot`, `Discovery` and `DynamicSlotsReload` are **not**
covered by this plan — see Deferred below.

**Type consistency.** `VirtualEntity`, `DetectedDevice` and the
`{ ok, reason, applied }` dispatch result keep their v0.1 shapes. Every new
`synth*` returns `VirtualEntity | null`. Every new `build*Payload` takes a
`VirtualEntity` and returns a `string`.

**Deferred, with reasons.** `mqttPublishHomeSnapshot`,
`mqttPublishDiscovery` and `mqttRequestDynamicSlotsReload` are panel-side
view and discovery concerns rather than entity domains; v0.1 already answers
discovery through `bridge/request`. They need their own contract extraction
before anything is written, and folding unverified work into this plan is how
silent bugs get in. Camera is excluded by explicit user decision.
