# Editable value (Number / Select / Date-Time) MQTT wire contract

Scope: HomeTiles tile types `TILE_NUMBER = 21`, `TILE_SELECT = 22`,
`TILE_DATETIME = 23` (`src/types/tile_type.h:28-30`). Every fact below was
read directly out of firmware source at commit `5d251671dce602c3a539cbb59769ef922bf12b2c`
(2026-09-11, `HomeTiles` repo) — nothing here is inferred from
`docs/protocol.md`, `PROJECT_CONTEXT.md`, or any other note, and where those
older docs use different topic names, trust this document for the editable
domains.

Files read: `src/types/value/value_control.h`, `src/types/value/value_control.cpp`
(929 lines — this one file owns essentially the entire runtime contract for
all three types), `src/types/value/value_editor_model.h`,
`src/network/mqtt/mqtt_handlers.cpp` (2749 lines), `src/network/mqtt/mqtt_topics.h/.cpp`,
`src/network/bridge/ha_bridge_config.cpp/.h`, `src/network/network_manager.cpp/.h`,
`src/network/bridge/control_contract.h` (misleadingly named — it only holds
`switch`/`scene` domain-matching helpers, nothing about sessions or control).

Domain-to-type matching, `editable_entity_matches` (`value_control.cpp:48-61`):
`number`/`input_number` → `TILE_NUMBER`; `select`/`input_select` → `TILE_SELECT`;
`date`/`time`/`datetime`/`input_datetime` → `TILE_DATETIME`.

---

## 1. Is `editable_meta` shared or per-domain? (definitive)

**One shared section for all three domains.** There is no `number_meta`,
`select_meta`, or `datetime_meta` — grepped for all three, zero matches
anywhere in the firmware.

Trace:

- `ha_bridge_config.cpp:661` — `parseEntityNameSection(json, "editable_meta", merged.sensor_names_map)`.
  One call, one key, feeding the **same** `sensor_names_map` that every other
  domain's meta section also feeds: `media_player_meta` (657), `climate_meta`
  (658), `cover_meta` (659), `camera_meta` (660), `editable_meta` (661) all
  merge into one map keyed only by `entity_id`.
- `parseEntityNameSection` itself (`ha_bridge_config.cpp:1323-1342`) reads
  exactly two fields per object — `entity_id` and `name` (line
  1338: `extractStringField(object, "entity_id", entity) && extractStringField(object, "name", name)`)
  — and has no idea whether the object came from `editable_meta` or
  `climate_meta`. It is a generic `(entity_id → name)` upsert reused verbatim.
- Icons follow the identical pattern: `parseEntityIconSection(body, "editable_meta", icons)`
  (`ha_bridge_config.cpp:1386`), one call among eleven domains (1384-1394),
  all writing into one shared `entity_icons_map`.
- Contrast this with **which entities exist**: that part is *not* shared.
  `applyJson` (starts `ha_bridge_config.cpp:543`) parses three separate
  top-level arrays — `"numbers"` (582), `"selects"` (584), `"datetimes"`
  (586-587) — into three separate text blobs `numbers_text` / `selects_text`
  / `datetimes_text` (`ha_bridge_config.h:71-73`).

So: **membership** (which entity is a number vs. select vs. datetime) is
three separate arrays; **display name and icon** are one shared map with no
domain tag at all. Nothing in `editable_meta` ever tells the firmware which
of the three kinds an entity is — see §2 and §3 for where that actually
comes from.

## 2. What `editable_meta` carries, and where min/max/step/unit/mode/options really live

`editable_meta` (delivered inside the config JSON published to
`tab5_lvgl/config/<deviceId>/bridge/apply` — **not** the `<device_base>`
root used by `cmnd/`/`stat/`/`tele/`/`sensor/` in §3-§5; this topic is built
from a separate, eFuse-MAC-derived device id (`buildDeviceId`,
`network_manager.cpp:583-587`) and consumed at
`mqtt_handlers.cpp:1728-1742` → `ha_bridge_config.cpp:543`) carries **only
`entity_id` and `name`** (plus, via the separate icon pass, `icon`). Grepped
`ha_bridge_config.cpp` for `min`/`max`/`step`/`unit`/`mode`/`options` in any
number/select/datetime/editable context: **zero matches**.

The `"numbers"`/`"selects"`/`"datetimes"` arrays themselves cannot carry more
than an ID either: they are parsed by `parseArraySection`
(`ha_bridge_config.cpp:426-450`), which walks the array text and pulls out
**every quoted string token** between `[` and the matching `]` — it does not
parse JSON objects. If the Bridge sent
`{"numbers":[{"entity_id":"number.x","min":0}]}`, this parser would still
just extract the substring `number.x` and discard the surrounding object
structure.

**min, max, step, unit, mode, and the select option list live entirely in
the live per-entity state payload** parsed by `parse_editable_value`
(`value_control.cpp:63-107`, see §3) — delivered on the per-entity
`.../control` topic, not in any configuration push. They are refreshed on
every state message; nothing about them is cached from `editable_meta` or
the bridge-apply JSON.

## 3. Inbound state topic and payload

**Topic** — one discrete topic per entity, not a wildcard subscription:

```
buildHaStatestreamTopic(entity_id, "control")   // mqtt_handlers.cpp:1254-1267
= <ha_prefix>/<entity_id with '.' replaced by '/'>/control
```

Example: `number.kitchen_target` → `ha/statestream/number/kitchen_target/control`.
`ha_prefix` defaults to `"ha/statestream"` (`mqtt_topics.h:66`,
`mqtt_topics.cpp:44-45`) and is configurable.

The panel builds this route for every entity listed in `numbers_text`/
`selects_text`/`datetimes_text` (`mqtt_handlers.cpp:1306-1315`, passing the
literal suffix `"control"`), and again for any number/select/datetime tile
actually placed on a folder grid (`mqtt_handlers.cpp:1330`) or the
screensaver grid (`mqtt_handlers.cpp:1373`) — always with suffix `"control"`
for editable types where a plain sensor would get `"state"` (the ternary
`tileTypeIsEditableValue(slot.type) ? "control" : "state"` at both sites).

**Routing**: any subscribed dynamic-route topic ending in `/control` is
handed whole to `queue_editable_value(entity_id, payload)`
(`mqtt_handlers.cpp:1456-1459`), bypassing the generic sensor path — but only
`if (payload_len <= EDITABLE_PAYLOAD_MAX)` (24576 bytes,
`value_control.h:8`). **An oversized `/control` message is silently
dropped** — no log is emitted here, unlike the binary_sensor oversize branch
a few lines below it which does log (`mqtt_handlers.cpp:1462-1474`).

**Payload**: a JSON object, never a bare string. `parse_editable_value`
(`value_control.cpp:63-107`) validates it field by field. Two different
failure modes exist and an implementer must not confuse them:

- **Hard reject** — the whole payload becomes `EditableValue{}` (default,
  `valid = false`, nothing is displayed/updated, the panel keeps showing
  whatever it had before).
- **Soft degrade** — the payload is still `valid = true` and gets displayed,
  but a specific capability (writability, unit, options) is stripped.

| Key | Type | Required? | Absent / wrong-type behavior | Cite |
| --- | --- | --- | --- | --- |
| `version` | int | required, must equal `1` | any other value (including absent, which defaults to `0`) → **hard reject** | `value_control.cpp:67` |
| `kind` | string | required, one of `"number"`, `"select"`, `"date"`, `"time"`, `"datetime"` | anything else (absent defaults to `""`) → **hard reject** | 68-70 |
| `state` | string or JSON `null` | **key must be present** | key **absent entirely** → **hard reject** (this is not "unchanged", it discards the whole message); present as JSON `null` → accepted, `has_state=false`; present as a non-string/non-null (number, bool, object) → **hard reject** | 71-73 |
| `last_changed` | uint64, epoch **seconds** | optional | absent or wrong type (a float, a negative number, a string) → defaults to `0` (not "unchanged"). Dates the popup's new activity entry when non-zero (`sensor_popup.cpp:3099`). The popup also hashes the whole raw payload, `last_changed` included, for its editable history cache (`editable_history_fingerprint`, `sensor_popup.cpp:2522-2531`), so any change to it invalidates that cache. The Bridge sends `int(changed.timestamp())` (`__init__.py:1534-1536`) | 74 |
| *(state length)* | — | — | `state` longer than 255 bytes, counted after ArduinoJson decodes it (see the lone-surrogate note below) → **hard reject**, regardless of everything else | 75 |
| `available` | bool | optional | absent → defaults to `false`. Also forced `false` when `state` is JSON `null` (`value.has_state`) and when the literal `state` string equals `"unavailable"`, no matter what this flag says (`value_control.cpp:76`). A null-state payload is therefore never writable | 76 |
| `writable` | bool | optional | absent → defaults to `false`. Effective `writable` is always `available && writable-flag`, then further narrowed per-kind below | 77 |
| `session` | string | **required, exactly 32 bytes** (`String::length()`, so 32 characters only when ASCII) | any other length (including absent → `""`) → **hard reject** | 78, 80 |
| `revision` | string | **required, exactly 16 bytes** | any other length (including absent → `""`) → **hard reject** | 79, 80 |

No other key is read. The Bridge also sends `time_zone` for a date, time or
datetime (`editable_helpers.py:83`); the firmware never reads it (no match
for `time_zone` anywhere under `src/`). Numbers are JSON numbers: an integer
`min` such as `15` passes `finite_json`, since ArduinoJson 7.4.3's
`is<double>()` is true for every numeric type (`VariantData::isFloat`, the
`NumberBit` of `VariantContent.hpp`). `\uXXXX` escapes are decoded
(`ARDUINOJSON_DECODE_UNICODE` defaults to 1), and the
`DynamicJsonDocument doc(32768)` at `:66` is elastic in ArduinoJson 7, so
the 24576 bytes of the raw payload, escapes counted as sent, are the only
size limit.

A lone UTF-16 surrogate escape (`\udXXX`, which `JSON.stringify` writes for
one) is not decoded as U+FFFD, the 3 bytes Node counts. ArduinoJson keeps one
`Utf16::Codepoint` per string (`JsonDeserializer.hpp:398`): it drops a lone
high surrogate and turns a lone low one into a 4-byte sequence
(`Utf16.hpp:36-50`). The 255-byte state, the 255-byte option and the 128-byte
unit limits are measured after this decoding, so a text of 255 bytes by
Node's count can be 256 on the panel, and a state that long drops the whole
message. This adapter treats a lone surrogate like a line break (Task 14
review m1).

Kind-specific fields, read **only** when `kind == "number"`:

| Key | Type | Absent / invalid behavior | Cite |
| --- | --- | --- | --- |
| `min`, `max`, `step` | JSON numbers (not string, not bool, not null) | if any is missing/wrong-typed, or `min>=max`, or `step<=0`, or `max-min` isn't finite → **`writable` forced `false`** (payload stays otherwise valid/displayable) | 82-86 |
| `mode` | string | absent → defaults `"auto"` | 87 |
| `unit` | string | absent → defaults `""`; longer than 128 bytes → silently reset to `""` (not rejected) | 88-89 |

Kind-specific fields, read **only** when `kind == "select"` (see §6 for full
detail):

| Key | Type | Absent / invalid behavior | Cite |
| --- | --- | --- | --- |
| `options` | JSON array of strings | `options_complete` must independently be `true`, array must be non-null with 1-64 entries, every entry a unique non-empty string ≤255 bytes with no `\n`/`\r` — **any single violation clears the entire list** and forces `writable=false` | 90-104 |
| `options_complete` | bool | absent → defaults `false` → options always cleared | 92 |

For `kind` `"date"` / `"time"` / `"datetime"`, **no extra fields are read at
all** — no server-supplied min/max date range exists in this payload; the
day/month/hour/minute/second limits used by the on-device roller/spinbox
come from fixed calendar arithmetic (`value_editor_model.h:22-23`), not from
the wire.

`value_editor::parseCalendar` (`value_editor_model.h:28-52`) runs:

- each time a new /control payload is applied while the user is not
  editing, to pre-fill the draft (`value_control.cpp:858-859`);
- for every pending command, in `command_value_confirmed`
  (`value_control.cpp:330-334`).

A malformed string is still shown verbatim (`editable_display_value`), but
the editor starts blank. The formats are:

- date: `sscanf("%d-%d-%d")`, with nothing after it;
- time: `%d:%d`, optionally followed by `:%d`;
- datetime: the date, exactly one `' '` or `'T'`, then the time.

Each `%d` skips leading whitespace and accepts a sign and any number of
digits. So `26-9-3` is year 26, and `2026- 9- 3` parses. The ranges are then
year 1-9999, month 1-12, a day valid for the month (Gregorian leap years,
`value_editor_model.h:17-20`), hour 0-23, and minute and second 0-59
(`value_editor_model.h:46-49`). A command is confirmed only when the state
read back parses to the same six fields as the value sent. Seconds count,
and missing seconds read as 0. A source that cannot store seconds never
confirms a command with non-zero seconds.

## 4. Outbound command topic and payload

Confirmed: **`<device_base>/cmnd/value`** (`value_control.cpp:311`) — a
single shared topic for all three domains, disambiguated only by the
`entity_id` field inside the JSON body. This is the opposite fan-out shape
from the inbound side (§3), which is one topic per entity: many entities →
one command topic in, one topic per entity out.

Built and published by `submit()` (`value_control.cpp:293-316`). Guard
conditions checked **before anything is published** (if any fails, nothing
is sent — no error is published either):

- control must be active, not mid-sync, `value.writable` must be `true`, and
  MQTT must be connected (`value_control.cpp:294`)
- the device clock must already read a plausible real time,
  `time(nullptr) >= 1700000000`, or the attempt is refused locally
  (`value_control.cpp:296`) — i.e. **no command can be sent before NTP sync**
- for `kind=="number"`: the locally-typed/dragged value must parse, lie
  within `[minimum, maximum]`, and land on the step grid within `1e-6`
  tolerance, or the attempt is refused locally without publishing
  (`value_control.cpp:301-305`)

Payload (`StaticJsonDocument<1024>`, `value_control.cpp:297-310`):

```json
{
  "entity_id": "number.kitchen_target",
  "session":   "<32-char token, echoed verbatim from the last /control message>",
  "revision":  "<16-char token, echoed verbatim from the last /control message>",
  "value":     21.5,
  "id":        "1a2b3c4d-0002b1c8-00000007",
  "deadline":  1758547200
}
```

- `value` is a **JSON number** for `kind=="number"` (`value_control.cpp:306`),
  a **JSON string** for `select`/`date`/`time`/`datetime`
  (`value_control.cpp:307`, formatted `HH:MM:SS` / `YYYY-MM-DD` /
  `YYYY-MM-DD HH:MM:SS` by `submit_draft`, `value_control.cpp:398-406`).
- `id` is generated by `request_id()` (`value_control.cpp:36-42`):
  `"%08lx-%08lx-%08lx"` from `esp_random()`, `millis()`, and a
  monotonically-increasing in-process counter — three hyphen-separated
  8-hex-digit groups, 26 characters total. This is a **command/ack
  correlation id**, unrelated to `session`/`revision`.
- `deadline` is `now + 10` as a Unix-epoch **uint64 in seconds**
  (`value_control.cpp:309`).
- Published with **`retain=false`** (`value_control.cpp:312`,
  `mqttEnqueuePublish(topic, payload, false)`).
- A queued `cmnd/value` publish is silently discarded (freed, never sent —
  not even after reconnecting) if the MQTT connection has cycled since it
  was enqueued: every outbound command is stamped with a generation counter
  (`network_manager.cpp:135,253`) that is bumped on reconnect
  (`network_manager.cpp:935`), and the publish worker drops any `cmnd/value`
  item whose stamp doesn't match the current generation
  (`network_manager.cpp:1225-1230`). No log, no ack, nothing — the sender
  just never sees a response.

## 5. The `/control` path — sessions, revisions, deadlines (definitive)

**Yes, editable values are exactly what `/control` is for** — but the name
is easy to misread as a request/ack exchange. It is not one. Precisely:

- `/control` is the **suffix of the per-entity inbound state topic** from
  §3, not a standalone topic and not a command channel. It exists purely so
  the router can send number/select/datetime traffic to
  `queue_editable_value` instead of the generic sensor-value updater that
  plain `.../state` traffic gets (`mqtt_handlers.cpp:1330,1373`:
  `tileTypeIsEditableValue(slot.type) ? "control" : "state"`). This matches
  `PROJECT_CONTEXT.md`'s "Additive `/control` preserves legacy clients" —
  it is additive in the sense that it is a new suffix alongside the
  pre-existing `/state` suffix, not a replacement.
- **`session`** and **`revision`** are two opaque tokens carried inside the
  `/control` payload (`value_control.cpp:78-80`), constrained only by exact
  length (32 and 16 bytes respectively — any other length hard-rejects
  the whole message, see §3 table). The firmware never interprets their
  contents. It only ever compares them for equality against the
  previously-accepted pair, to decide `constraints_changed`
  (`value_control.cpp:816`: `next.revision != c->value.revision || next.session != c->value.session || !next.writable`) — and when constraints changed, it abandons any in-flight edit/drag and closes the
  dropdown (`value_control.cpp:817`).
- The device is a **pure echo**: whatever `session`/`revision` pair it most
  recently accepted from `/control` for that entity is copied verbatim into
  the next `cmnd/value` command (`value_control.cpp:298`). The
  accept/reject decision based on that echoed pair — i.e. detecting that a
  command was issued against state the Bridge already knows is stale — is
  **not implemented in this firmware**. The receiver makes it: see "How the
  receiver checks a command" below.
- **`deadline`** appears **only** in the outbound `cmnd/value` command
  (§4) — it is never present in the inbound `EditableValue` (the struct has
  no such field at all, `value_control.h:9-15`) and is never echoed back.
  The device computes it, sends it, and forgets it. The receiver enforces
  it (below).
- The device's own staleness handling of its own outstanding command is a
  **separate, local 30-second timeout**, independent of the `deadline` it
  sent: if no ack/matching state arrives within 30 s
  (`millis() - c->command_ms >= 30000`), the panel gives up locally and
  shows an error (`value_control.cpp:801-802`).
- **How the tokens are made** (read from the Bridge, 2026-09-23). `session`
  is `secrets.token_hex(16)`, once per Home Assistant run
  (`__init__.py:1077`). `revision` is the first 16 hex characters of a
  sha256 over the sort-keyed JSON of every payload field except `state`
  (`editable_helpers.py:94-96`); `last_changed` is added after it
  (`__init__.py:1534-1536`), so neither the value nor its time moves the
  revision. Because the panel abandons an edit on any change (`:816-817`),
  a revision must change with the constraints (range, unit, options, kind,
  availability, writability, session) and never with the value. This
  adapter follows the same rule with `CONTROL_SESSION` once per process and
  `controlRevision` (`src/protocol/editable.ts`, Task 14), though not to the
  same bytes: Python's `json.dumps` puts a space after `,` and `:`, and the
  Bridge's `time_zone` and null keys are hashed too. Harmless, since the
  token is opaque and each sender compares only its own.

### The acknowledgement (a third topic, not `/control` or `cmnd/value`)

- Topic: **`<device_base>/stat/value`** (`value_control.cpp:914`), which the
  device explicitly subscribes to at boot (`mqtt_handlers.cpp:1892`).
- The device ignores (returns "handled, no-op") any ack where: the topic
  doesn't match exactly (914); payload is null or `>1024` bytes (916); JSON
  fails to parse (918); or `entity_id`/`id` don't match the **currently
  open** control's entity and in-flight `command_id` exactly
  (`value_control.cpp:919`) — there is no queue of multiple in-flight
  commands, only one at a time, tied to whichever popup is open.
- **Sender must echo back exactly**: `entity_id` (the same string sent in
  the command) and `id` (the same `id` the device generated for that
  command). No other fields are read from the ack.
- **What a rejection looks like**: read `status` as a string
  (`doc["status"] | ""`, `value_control.cpp:922`). If it is **exactly**
  `"ok"`, the device treats the service call as accepted but *not yet
  confirmed* — it keeps waiting for the real state to arrive on `/control`
  matching the requested value (`command_value_confirmed`,
  `value_control.cpp:320-335`) or for the 30-second timeout above; it does
  **not** immediately clear the pending indicator on `"ok"` alone
  (`value_control.cpp:922-924`). **Any other value of `status` — including
  it being absent — is treated as an outright rejection**: the pending
  command is cleared immediately and an error status is shown
  (`value_control.cpp:926-927`). The firmware defines no specific rejection
  string/enum; it only checks "is this literally `\"ok\"`".

### How the receiver checks a command (Bridge, and this adapter: Task 15)

Read from the Bridge, `_async_handle_value_command` (`__init__.py:1549-1590`)
and `build_editable_service_call` (`editable_helpers.py:100-152`); this
adapter follows it (Ruling 99; `src/runtime/panel-session.ts`,
`src/protocol/editable.ts` `valueWrite`). In this order:

1. **Dropped, no answer**: a retained command (it would run again at every
   subscription; a broker marks retained only what it replays on a new one);
   one over 2048 bytes (the Bridge counts characters, this adapter bytes);
   no JSON object; an `entity_id` that is no number, select or datetime of
   this panel (compared exactly); an `id` that is no string of 1-48
   characters (code points).
2. **`"expired"`**: `deadline` not a number (a boolean is none), or not
   `0 < deadline - now <= 15` in epoch seconds, or a `session` other than
   the receiver's own. **A panel whose clock is more than 15 s off gets
   `"expired"` for every command.**
3. **Dropped, no answer**: an `id` seen before whose deadline has not
   passed, or any command while 128 such ids are held. Each accepted id is
   held until its deadline.
4. **`"changed"`**: `revision` other than the one the entity's `/control`
   has now.
5. **`"unavailable"`**: the `/control` says `writable: false` — which
   includes an unavailable value (`writable` is `available && …`).
6. The value: a number must be a JSON number within `min`..`max`
   (`"invalid_value"`) and on the step grid anchored at `min`, within 1e-6
   of a step (`"invalid_step"`); a select option must be one of `options`
   exactly (`"invalid_option"`); a date, time or date-time must be text in
   the kind's shape — `YYYY-MM-DD`, `HH:MM[:SS]`, the date, `' '` or `'T'`,
   the time — and a real calendar value (`"invalid_value"`).
7. A write or service call that throws: **`"failed"`**, logged.
8. The answer, `{entity_id, id, status}`, on `<device_base>/stat/value`, not
   retained; then the entity's current `/control` is published again.

Where this adapter differs, the firmware decides:

- **The panel's numbers are not the published ones.** ArduinoJson 7.4.3
  parses a decimal whose digits fit 23 bits (at most 8388607) as a *float*
  (`parseNumber.hpp:217-229`) and prints a float with 6 decimals, a double
  with 9, fewer as the integral part grows (`TextFormatter.hpp:67-104`,
  `FloatParts.hpp:56-93`); `finite_json` reads `min`, `max` and `step` back
  through that print (`value_control.cpp:28-34`). A step of `0.08197082`
  is `0.081971` on the panel, and its grid drifts from ours by 2.2e-6 of a
  step per step. The command's value, a double, is printed the same way
  (`:306`), and a double a float holds exactly is kept as a float
  (`VariantImpl.hpp:73-98`): `1234567.5` goes out as `1234568`. This adapter
  checks the value on the panel's own numbers (`src/protocol/arduinojson.ts`,
  checked against the library on 180,000 numbers) and writes the panel's own
  draft for that step, printed `%.15g` as the panel prints it (`:317-318`),
  within the object's range. The Bridge checks on its own grid and refuses
  such a panel's commands.
- **The repeated autumn hour** is written as its first instant, summer
  time; the Bridge refuses it (`ambiguous_time`, which becomes
  `"invalid_value"`). Both instants read back as the same text, and the
  panel cannot tell them apart either. A time the zone skips is refused by
  both.
- An epoch date is written in the adapter host's zone (Ruling 84).

## 6. Select options — delivery, limits, encoding

Options are **not** a separate channel or a separate metadata section —
they ride inside the same `/control` JSON payload as everything else in
§3, as a plain JSON array of JSON strings, gated by a companion boolean:

```json
{"version":1,"kind":"select","state":"eco","available":true,"writable":true,
 "session":"32-char-token...................","revision":"16-char-token...",
 "options_complete": true,
 "options": ["eco", "comfort", "boost, silent", "über-cool"]}
```

- **Limit**: 1 to 64 options (`options.size() > 0 && options.size() <= 64`,
  `value_control.cpp:92`); each option 1 to 255 **bytes**
  (`value_control.cpp:97`).
- **All-or-nothing**: `options_complete` must be `true` *and* every single
  option must pass validation, or the entire list is discarded
  (`value.options.clear()`, `value_control.cpp:102`) and the select becomes
  read-only for that update (`writable = writable && complete`, line 103).
  A partially-valid list is never partially accepted.
- **Duplicates are rejected** — the whole list is cleared if any option
  string repeats (`std::find(...) != end()`, `value_control.cpp:98`). The
  comparison is exact, byte for byte, so `High` and `HIGH` are two options
  to the firmware. This adapter refuses both, trimmed and case-insensitive,
  because its encoder matches that way (Ruling 85).
- **Comma**: no special handling exists or is needed. Each option is an
  ordinary JSON string element; a literal comma inside it (e.g.
  `"boost, silent"` above) is stored and later displayed byte-for-byte. The
  wire format is a JSON array, never a delimited single string, so commas
  never require escaping.
- **Quote**: standard JSON string escaping (`\"`) is all that's required —
  `ArduinoJson`'s `deserializeJson` unescapes it transparently. No
  HomeTiles-specific quoting rule exists.
- **Newline / carriage return**: explicitly **banned** inside an option
  (`option.indexOf('\n') >= 0 || option.indexOf('\r') >= 0` invalidates the
  whole list, `value_control.cpp:97`), because the panel later rejoins the
  accepted list with `"\n"` as an internal separator for the LVGL dropdown
  widget (`value_control.cpp:841`, `lv_dropdown_set_options`) — an embedded
  newline would silently corrupt that internal join. This is the one
  character class the Bridge must actively strip/reject before sending.
- **Non-ASCII / UTF-8**: not filtered. Only the 255-**byte** cap and the
  newline/CR/duplicate/empty checks apply. Because the cap is on bytes, not
  code points, a Bridge that truncates a UTF-8 string to fit could split a
  multi-byte character; the firmware does not fix this — it simply
  invalidates the whole option (and thus the whole list) once
  `length() > 255`. Each option is copied with `String option =
  item.as<const char*>()` (`value_control.cpp:96`), which stops at the first
  U+0000. An option containing NUL therefore reaches the dropdown truncated,
  and two options that are equal up to their NUL count as duplicates. Treat
  U+0000 like `\n` and `\r`.
- **Rendering-only behavior, not visible on the wire**: if the current
  `state` doesn't match any string in `options`, the panel locally
  *prepends* one synthetic placeholder entry to the dropdown and shifts
  real option indices by +1 (`c->option_offset`, `value_control.cpp:844-845`).
  A packet capture will never show this extra entry — it exists only in the
  rendered widget, and is stripped back off (`index - c->option_offset`,
  `value_control.cpp:497-498`) before the real option text is put in a
  `cmnd/value` command.
- **A line break in a select `state` makes the panel write the wrong
  option.** The placeholder is the display text of the state, joined to the
  options with `"\n"` (`:845`). LVGL 9.5.0 (pinned, `firmware.yml:99`)
  counts dropdown options only at `\n` (`lv_dropdown.c:201-207`) and maps
  a tap to an index by line height (`get_id_on_point`, `:1246-1264`), while
  a label line also ends at `\r` (`lv_text.c:396-405`). A state holding
  `\n` or `\r` therefore takes two placeholder rows while `option_offset`
  stays 1, and `:497-498` submits `options[index - 1]`: each tap on an
  option submits the option **below** it (the next one), a tap on the last
  option submits nothing, and a tap on the second placeholder row submits
  the first option. With options `A, B, C` and the state `X\nY`, the rows
  are `X, Y, A, B, C`, and a tap on A writes B. No other character breaks a
  row. The firmware checks options for `\n`/`\r` (`:97`) but never the
  state. A sender must not send such a state; this adapter sends
  `"unknown"` for a state with `\n`, `\r`, NUL or a lone surrogate, as for
  one over 255 bytes (Task 14).

## 7. Values treated specially

| Wire value | Where | Effect | Cite |
| --- | --- | --- | --- |
| `"state"` key absent entirely | any kind | **whole message hard-rejected** (not "unchanged", not "unknown") | `value_control.cpp:71` |
| `"state": null` | any kind | accepted, `has_state=false`, displayed as literal `"--"` regardless of `available` | 72, 110 |
| `"state": ""` (empty string) | any kind | accepted as a normal (non-null) state; for `number` it fails to parse as a float and displays the localized "unknown" label (110-118); for `select`/date/time it is returned and displayed **as an empty string** — i.e. blank, not a placeholder | 124 |
| `"state": "unavailable"` | any kind | forces `available=false` **unconditionally**, regardless of the `available` flag's own value; displays the localized "unavailable" label | 76, 112-113 |
| `"state": "unknown"` | any kind | does **not** by itself force `available=false`; if `available` is otherwise `true`, displays the localized "unknown" label; if `available` is `false`, the "unavailable" label wins instead | 112-113 |
| number `state` outside `[min,max]` | number | displayed as-is (formatted, with unit) — **not** clamped or flagged; only the slider's visual position is clamped to `[0,1]`; the draft is still pre-filled from it (`:832-833`), and any submit outside `[min, max]` is refused locally (`:304`) | 353-354 |
| malformed date/time text in `state` | date/time/datetime | still displayed verbatim (raw passthrough, line 124); only the *edit draft* silently fails to seed (`draft_valid=false`), so stepping starts from a blank calendar instead of the shown value | 858-859 |
| payload `> 24576` bytes | any kind, inbound `/control` | silently dropped, no log | `mqtt_handlers.cpp:1459`, `value_control.h:8` |
| payload `> 24576` bytes | any kind, cache write | rejected by `updateEditableValue`, cache entry untouched | `ha_bridge_config.cpp:1782` |
| 129th distinct entity | config | silently ignored — the on-device cache caps at 128 distinct editable entities; a new (not-yet-cached) entity beyond that count is dropped, existing ones keep updating | `ha_bridge_config.cpp:1784` |
| ack payload `> 1024` bytes, or JSON-invalid, or entity/id mismatch | ack | ignored (treated as handled, no state change) | `value_control.cpp:916-919` |
| `status` anything other than the exact string `"ok"` (including absent) | ack | treated as rejection | `value_control.cpp:922,926-927` |

## 8. Size and count limits (quick reference)

| Limit | Value | Cite |
| --- | --- | --- |
| `/control` payload (and cache entry) | ≤ 24576 bytes | `value_control.h:8`; `ha_bridge_config.cpp:1782`; `mqtt_handlers.cpp:1459` |
| Distinct cached editable entities on-device | ≤ 128 | `ha_bridge_config.cpp:1784` |
| `stat/value` ack payload | ≤ 1024 bytes | `value_control.cpp:916` |
| `state` string | ≤ 255 bytes | `value_control.cpp:75` |
| `unit` string | ≤ 128 bytes (else silently blanked, not rejected) | `value_control.cpp:89` |
| `session` string | exactly 32 bytes | `value_control.cpp:80` |
| `revision` string | exactly 16 bytes | `value_control.cpp:80` |
| `options` array | 1–64 entries | `value_control.cpp:92` |
| each option string | 1–255 bytes, no `\n`/`\r`, unique | `value_control.cpp:97-98` |
| local command timeout (device-side, independent of `deadline`) | 30 s from publish | `value_control.cpp:801` |
| `deadline` the device requests | `now + 10` s | `value_control.cpp:309` |
| `deadline` the receiver accepts | `0 < deadline - now <= 15` s | `__init__.py:1562-1566` |
| `cmnd/value` payload the receiver reads | ≤ 2048 (Bridge: characters; this adapter: bytes) | `__init__.py:1550` |
| command `id` | 1–48 characters | `__init__.py:1557-1559` |
| command ids held against replay | 128, each until its deadline | `__init__.py:1567-1570` |

Cached editable state is pruned whenever an entity drops out of the current
`numbers_text`/`selects_text`/`datetimes_text` lists, which also bumps the
generation counter so every visible tile re-renders
(`ha_bridge_config.cpp:1788-1798`).

---

## UNVERIFIED

- ~~What `status` string(s) the Bridge sends on rejection~~ — resolved from
  the Bridge source: see "How the receiver checks a command" in §5.
- ~~How `session` and `revision` are generated~~ — resolved from the Bridge
  source: see "How the tokens are made" in §5.
- ~~Whether/how the Bridge enforces the `deadline`~~ — resolved: see "How
  the receiver checks a command" in §5.
- ~~Exact `ArduinoJson` float serialization precision~~ — resolved from the
  library (7.4.3, `firmware.yml:96`, no override in the firmware): see
  "Where this adapter differs" in §5.
- **MQTT QoS level** used for any of these topics. The publish/subscribe
  wrapper signatures seen (`mqttEnqueuePublish(topic, payload, retain)`,
  `network_manager.h:55-56`) expose no QoS parameter; not chased further as
  it falls outside the seven questions this document answers.
- **Localized text of `status_text()` indices 7/8/9** (local-validation
  rejection / "sent" / generic error shown in the popup). Their trigger
  conditions are fully traced in §4/§5 by index; the actual per-language
  strings in `src/core/i18n/` were not resolved, since they carry no wire
  meaning.
