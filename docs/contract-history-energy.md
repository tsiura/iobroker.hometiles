# HomeTiles history and energy MQTT wire contract

Firmware reference: HomeTiles v0.6.12, commit `5d25167` (`version.txt`, `git log`).
Every claim below has a `file.cpp:LINE` citation into
`/home/user/webapp/zigbee/HomeTiles` (read-only reference checkout). Paths are
current for this commit; note that `docs/protocol.md` in this repo cites an
older tree layout (`src/network/mqtt_handlers.cpp`, `src/network/ha_bridge_config.cpp`)
— the files have since moved to `src/network/mqtt/mqtt_handlers.cpp` and
`src/network/bridge/ha_bridge_config.cpp`.

Where the firmware source did not settle a question, this document says
**UNVERIFIED** and names exactly what was checked. Nothing below is guessed.

## 1. Topic map

Built once at startup from the device's eFuse MAC (`network_manager.cpp:576-594`):

| Purpose | Topic |
| --- | --- |
| Numeric / binary / state history request | `<base>/history/request` (`network_manager.cpp:589`) |
| Numeric / binary / state history response | `<base>/history/response` (`network_manager.cpp:590`) |
| Energy request | `<base>/energy/request` (`network_manager.cpp:592`) |
| Energy response | `<base>/energy/response` (`network_manager.cpp:593`) |

`<base>` is `tab5_lvgl/config/<deviceId>` (`network_manager.cpp:584-586`).

All four are one shared pair of topics — **every** history request (numeric,
binary, state, or the editable-value variant described in §3.4) is published
to the single `history/request` topic and answered on the single
`history/response` topic. There is no per-kind sub-topic. The firmware
dispatches purely on payload content (§3, §5).

Do not confuse this with the **Bridge config-sync** payload published to
`<base>/bridge/apply` (`ha_bridge_config.cpp:543` `HaBridgeConfig::applyJson`,
topic check at `mqtt_handlers.cpp:1727-1728`). That payload also contains a
top-level `"energy"` array, parsed by `parseEnergySection`
(`ha_bridge_config.cpp:1108-1184`, called from `applyJson` at
`ha_bridge_config.cpp:669-675`). **That `"energy"` array is an entity catalog
(id/name/unit/category), not the runtime energy response** — see §6.4. Getting
these two confused will make an implementer build the wrong handler.

## 2. The three (four) history request entry points

The task names three C++ entry points. A fourth, undocumented-by-name producer
of `history/request` traffic exists and matters for §5 (correlation), so it is
included as §3.4.

### 2.1 Declaration

`src/network/mqtt/mqtt_handlers.h:47-56`:
```cpp
void mqttPublishHistoryRequest(const char* entity_id, uint16_t hours = 24,
                                uint16_t period_minutes = 5, uint16_t points = 288);
void mqttPublishBinaryHistoryRequest(const char* entity_id, uint16_t hours = 24,
                                      uint16_t max_transitions = 48);
void mqttPublishStateHistoryRequest(const char* entity_id, uint16_t hours = 24,
                                     uint16_t max_transitions = 48);
```
Callers: `sensor_popup.cpp:2549` (binary), `:2552` (state), `:2557` (numeric,
the active range's `cfg.hours`/`period_minutes`/`points`: 24/5/288 or
168/60/168), `tile_renderer.cpp:4673` (numeric, the header defaults 24/5/288
from `mqtt_handlers.h:47`, for grid tile graphs).

### 3.1 `mqttPublishHistoryRequest` — numeric graph history

Implementation: `mqtt_handlers.cpp:2381-2447`.

- If `hardwareIo.isLocalEntityId(entity_id)` is true, the function returns
  **without publishing anything** (`mqtt_handlers.cpp:2388`) — no MQTT traffic
  is ever generated for those IDs. (The exact member list of
  `isLocalEntityId` is in `src/io/hardware_io.cpp`, not read for this task —
  UNVERIFIED which entity IDs this covers beyond what §3.2 shows for a
  related, but distinct, local-entity check.)
- Defaults applied before publish (`mqtt_handlers.cpp:2390-2395`): `hours=0→24`,
  `period_minutes=0→5`, `points=0→ hours*60/period_minutes` (→288 for
  defaults), and `points=0→1` as a final floor.
- Any previous pending bookkeeping for the same `entity_id` is discarded first
  (`clear_pending_history_request`, `mqtt_handlers.cpp:2403`, defined
  `:376-389`) — this only resets local timeout bookkeeping, it does **not**
  cancel an in-flight MQTT request.
- Wire payload published to `history/request` (`mqtt_handlers.cpp:2411-2419`):
  ```json
  {"entity_id":"sensor.x","hours":24,"period_minutes":5,"points":288,"stat":"mean"}
  ```
  All of `hours`, `period_minutes`, `points` are JSON integers. `stat` is
  always the literal string `"mean"` — the firmware never sends any other
  value and does not appear to read this field back.
- Only sent if MQTT is connected and a request topic exists
  (`mqtt_handlers.cpp:2397-2399`); if not, or if the outbound queue is full,
  a **local fallback** is synthesized instead of a real request — see §3.5
  and §7.
- On successful queueing, local bookkeeping is recorded via
  `mark_pending_history_request` (`mqtt_handlers.cpp:2429`, defined
  `:430-468`) into one of **8** global slots (`kHistoryPendingSlots = 8`,
  `mqtt_handlers.cpp:67`; array `g_pending_history[8]`, `:84`). If all 8 slots
  are full and this entity has none, the **oldest** pending slot is evicted
  (`:450-459`) — that older entity's timeout bookkeeping is silently lost (its
  real HA response, if one ever arrives, will still be applied by entity_id
  match at the UI layer — see §5 — but the local 2 s fallback timer for it is
  gone).

### 3.2 `mqttPublishBinaryHistoryRequest` / `mqttPublishStateHistoryRequest` — discrete/categorical history

Both call a shared static helper, `mqttPublishDiscreteHistoryRequest(entity_id, kind, log_tag, hours, max_transitions)`
(`mqtt_handlers.cpp:2449-2499`), with `kind = "binary"` (`:2501-2506`) or
`kind = "state"` (`:2508-2513`).

- `hours` is **snapped to exactly 24 or 168** — any other input value
  (including 0) becomes 24 (`mqtt_handlers.cpp:2456`:
  `hours = hours == 168 ? 168 : 24;`). There is no arbitrary hour range for
  discrete history, unlike numeric history.
- `max_transitions` clamped to `[2, 96]`, default 48 if 0
  (`mqtt_handlers.cpp:2457-2459`).
- Only **one** discrete history request can be outstanding at a time,
  globally, not per-entity: `g_pending_discrete_history` is a single struct,
  not an array (`mqtt_handlers.cpp:86-94`), and every new discrete request
  unconditionally resets it first (`:2463`: `g_pending_discrete_history = {};`)
  — a second in-flight binary/state request supersedes the first's local
  bookkeeping. This matches the code comment: "Only one popup can be visible."
  (`:2461-2462`).
- Wire payload (`mqtt_handlers.cpp:2476-2486`):
  ```json
  {"version":1,"kind":"binary","entity_id":"binary_sensor.x","hours":24,"max_transitions":48}
  ```
  (or `"kind":"state"` for `mqttPublishStateHistoryRequest`). `version` is
  always integer `1`.
- If MQTT is offline or no request topic is configured, the firmware does
  **not** wait for a timeout — it immediately synthesizes a local
  `history_available:false` response (`mqtt_handlers.cpp:2466-2474`, payload
  shape in §7).
- On successful publish, bookkeeping is `mark_pending_discrete_history_request`
  (`:2493`, defined `:409-418`).

### 3.3 Range/period vocabulary — do not conflate

Neither the numeric nor the discrete history request payload contains a
`"range"`, `"day"`, or `"week"` string key. The UI's two selectable ranges are
a **local enum**, `SensorHistoryRange::Day24` / `::Day7`
(`sensor_popup.cpp:99-102`), mapped to concrete numbers by
`get_history_range_config` (`sensor_popup.cpp:249-257`):

| Range | hours | period_minutes | points |
| --- | --- | --- | --- |
| `Day24` (24 h) | `kHistoryHours24h=24` (`:50`) | `kHistoryPeriodMinutes24h=5` (`:51`) | `kHistoryPoints24h=288` (`:52`) |
| `Day7` (7 d / "Week") | `kHistoryHours7d=168` (`:53`) | `kHistoryPeriodMinutes7d=60` (`:54`) | `kHistoryPoints7d=168` (`:55`) |

Only the **energy** request (§6) carries a literal string field, and its name
is `"period"`, with values `"day"` / `"week"` / `"month"` — three values, not
two (`mqtt_handlers.cpp:2531-2535`, see §6.1). If an earlier grep only saw
`day`/`week`, it likely missed the `"month"` check on `mqtt_handlers.cpp:2533`.

### 3.4 The undocumented fourth producer: editable-value history requests

`editable_request_history(entity, hours)` (`src/types/value/value_control.cpp:179-189`)
also publishes directly to `history/request`, for Number/Select/DateTime tile
popups (called from `sensor_popup.cpp:2540`):
```json
{"entity_id":"number.x","kind":"editable","version":1,"hours":24,"max_transitions":96,"request_id":"1a2b3c4d-005f31a0-00000001"}
```
`request_id` is generated by `request_id()` (`value_control.cpp:36-42`):
three 8-hex-digit groups joined by `-`: `esp_random()`-`millis()`-`sequence`
(monotonic counter). This is the **only** one of the four request producers
that puts a request id on the wire, and it is the **only** correlation
mechanism in this whole contract that is not a bare entity-id/field match —
see §5.

## 4. Response payload — how the firmware tells kinds apart

On `history/response` (`mqtt_handlers.cpp:1832-1874`), the firmware first
peeks only two fields with substring scanning (not full JSON parsing) to
decide bookkeeping and logging: `entity_id` and `kind`
(`mqtt_handlers.cpp:1839-1847`). `kind == "binary"` or `"state"` ⇒ "discrete";
anything else (absent, `"editable"`, unrecognized) ⇒ treated as the numeric
path for this dispatch step. The raw payload is then hand'ed, **unfiltered
and unconditionally**, to two consumer queues:
- `queue_sensor_popup_history(nullptr, payload, len)` — always
  (`mqtt_handlers.cpp:1869`)
- `queue_tile_graph_history(nullptr, payload, len)` — only if **not** discrete
  (`:1870-1871`)

The real per-kind parsing, validation and drop/accept decisions happen inside
those two consumers, each with its own JSON parser. This is why §5
(correlation) has two independent, slightly different answers depending on
which consumer you mean.

### 4.1 Numeric response (sensor-popup consumer: `apply_history_payload`, `sensor_popup.cpp:2263-2408+`)

Parsed with `DynamicJsonDocument doc(24576)` (`sensor_popup.cpp:2269`), but
ArduinoJson 7.4.3 (the CI pin, `.github/workflows/firmware.yml:96`) ignores
that capacity: `DynamicJsonDocument(size_t)` only stores the number and the
document is elastic. The real ceiling is the handler's copy into
`LARGE_BUF = 32768` (`mqtt_handlers.cpp:1496`), truncated at 32767 bytes
(`mqtt_handlers.cpp:1836`); a longer payload is cut and then fails to parse.
A `deserializeJson` error aborts silently after a log line (`:2271-2273`).

Required/used top-level keys for the plain-numeric path (i.e. `doc["kind"]`
is not `"binary"`/`"state"`, checked at `:2303-2313`):
- `entity_id` (string) — see §5.
- `unit` (string, optional) — only applied if not `ctx->lock_unit`
  (`:2316-2322`).
- `hours`, `period_minutes` (ints, optional, default to the currently active
  range) — **both must exactly equal** the popup's current range config or
  the entire response is dropped (`:2324-2329`).
- `current` (string, optional) — displayed value label (`:2331-2334`).
- `values` (JSON array, **required** — `null`/absent ⇒ response dropped,
  `:2336-2339`). Empty array ⇒ chart cleared to zero points (`:2343-2347`).

Each element of `values` is parsed by `extract_numeric`
(`sensor_popup.cpp:383-402`): accepts a JSON number of any numeric subtype, or
a numeric string parsed with `strtof` (must start with a digit/sign, else
rejected); accepts `null` (`v.isNull()` ⇒ false ⇒ treated as gap). Anything
else (bool, object, non-numeric string) also becomes a gap. **There is no
timestamp field anywhere in the numeric payload.** Each array index is an
implicit, evenly-spaced time bucket, `period_minutes` apart, ending "now" and
extending back `hours`. Position = time; there is no epoch value to interpret
as seconds or milliseconds for this path.

Gap handling (non-editable popups; `:2360-2381`, identical logic duplicated
for the tile-graph consumer at `tile_renderer.cpp:4573-4594`): the first valid
(finite) sample is back-filled into every leading gap, then every interior gap
is forward-filled from the last valid sample ("carry the last value forward,
as HA does" — code comment `sensor_popup.cpp:4573`/`:2360`). Editable-number
popups explicitly skip this fill (`:2369`: `if (!ctx->editable && ...)`) and
render the gaps as-is.

Overflow: editable-number popups additionally hard-cap at 288 points and
**drop the entire response** if exceeded (`:2342`: `if (ctx->editable && count > 288) return;`).
Non-editable popups and tile graphs have no explicit array-length cap in this
path (chart control is simply sized to `values.size()`), other than the
32767-byte `LARGE_BUF` truncation of the whole payload (`mqtt_handlers.cpp:1836`).

### 4.2 Binary (`"kind":"binary"`) response — `apply_binary_history_payload`, `sensor_popup.cpp:1838-1985`

Only processed if the popup is in binary mode (`ctx->binary_mode`,
gated at `sensor_popup.cpp:2304-2307`). Keys:

| Key | Type | Meaning |
| --- | --- | --- |
| `hours` | int | Must equal the active range's hours or the whole response is dropped (`:1843-1844`) |
| `device_class` | string, nullable | HA device class; explicit JSON `null` clears the cached one, absent key keeps it (`:1846-1851`, see §7) |
| `current` | string, nullable | Live state string; same explicit-null-vs-absent rule (`:1852-1856`) |
| `available` | bool, nullable | Same explicit-null-vs-absent rule; null ⇒ treated as unavailable (`:1857-1861`) |
| `last_changed` | epoch **seconds** | via `extract_epoch` (`:836-852`, accepts uint64/long/numeric string, rejects negative); explicit null clears it to 0, absent keeps the old value (`:1862-1870`) |
| `error` | any | If present at all (any value), forces `history_available=false` (`:1873-1874`) |
| `history_available` | bool | Default `true` if absent and no `error` key (`:1873-1874`) |
| `range_start`, `range_end` | epoch seconds | If `range_end` absent, uses device's current time; if `range_start` absent, computed as `range_end - hours*3600` (`:1877-1885`) — **confirms epoch is in seconds**, not milliseconds (3600 s/hour arithmetic) |
| `timeline_points` | uint16 | Point count for the compact timeline strip, max `kBinaryMaxTimelineBins=768` (`:1779`, const at `:60`) |
| `timeline_encoding` | string | Must be literally `"2bit-hex"` or the timeline is rejected (`:1780`) |
| `timeline_data` | hex string | 2 bits/point, 4 points/byte, 2 hex chars/byte, case-insensitive hex (`decode_binary_timeline`, `:1767-1801`; nibble decode `:1760-1765`). Length must equal `ceil(points/4)*2` exactly or the whole timeline is rejected (not truncated) (`:1783-1785`) |
| `segments` | array of `{start, end, state}` | Explicit on/off/unknown/unavailable runs; capped at `kBinaryMaxSegments=96` (`:59`) — **extra segments beyond 96 are silently truncated** (`:1897-1899`: `if (...) break;`), and any segment with `end <= start` or a zero epoch is dropped (`:1906-1908`). Firmware re-sorts by `start` ascending after loading (`:1911-1915`) — **wire order of segments does not matter** |
| `activity` | array of `{timestamp, state}` | Individual state-change log entries, capped at `kBinaryMaxActivityEntries=96` (`:61`). The firmware reads from the **end of the array backward** (`:1923-1926`) and keeps only the last (highest-index) 96 entries, storing them newest-first. **This means the wire array must be ordered oldest→newest** for the truncation to keep the most recent events; sending newest-first would cause the oldest events to be kept instead. Entries with a zero/unparseable `timestamp` are dropped (`:1930`) |

`state` strings inside `segments`/`activity` are mapped by `binary_state_code`
(`:854-865`): `"on"→1`, `"off"→0`, `"unavailable"` string or `available=false`→3,
empty/anything else→2 (unknown). Trim + lowercase before matching.

### 4.3 State/categorical (`"kind":"state"`) response — `apply_state_history_payload`, `sensor_popup.cpp:2089-2250`

Only processed for non-editable, non-binary popups (`:2309-2313`), or, for
editable Number/Select/DateTime popups, unconditionally as the shared
"Activity" data source (`:2290-2291`, see §4.4). Same `hours`-must-match gate
(`:2094-2095`), same `history_available`/`error`/`range_start`/`range_end`
rules as §4.2 (`:2121-2140`). Differences from binary:

| Key | Type | Meaning |
| --- | --- | --- |
| `palette_complete` | bool, default true | If `false`, the Bridge hit its own palette-size limit server-side; firmware logs this and shows overflow states as "unknown" (`:2126-2131`) |
| `palette` | array of strings | Up to `kStateHistoryMaxPaletteEntries=16` (`:62`) distinct state labels; if the array is non-string or exceeds 16, the **entire palette is discarded** (`:2142-2154`, `:2147-2150`: any non-string element clears the whole vector) |
| `timeline_encoding` | string | Must be literally `"palette4-hex"` (`:1818`) — one hex **nibble** per point (not packed 4-per-byte like binary), each nibble is an index into `palette`; index ≥ palette size ⇒ whole timeline rejected (`decode_state_timeline`, `:1803-1836`) |
| `segments[].state` | string | Raw label text (not a 0-3 code), passed through `normalize_state_history_value` (`:2172-2173`) |
| `activity[].state` | string | Same, raw label text (`:2200-2201`) |

Same truncation/ordering caveats for `segments` (sorted after load, order
doesn't matter) and `activity` (last-96-by-index, wire order must be
oldest→newest) as §4.2.

### 4.4 Editable-value popups (Number / Select / DateTime)

Gated by `ctx->editable` at the very top of `apply_history_payload`
(`sensor_popup.cpp:2282-2302`), **checked before** the `doc["kind"]` switch —
i.e. for an editable popup the firmware does not care what `kind` the
response claims; it always runs `apply_state_history_payload` for the shared
Activity/segments/palette/timeline data, then, only if
`ctx->editable_kind == "number"`, additionally falls through into the numeric
`values` path of §4.1 for the graph. Two extra gates apply only here:
- `accept_editable_history_range` (`sensor_popup.cpp:2252-2261`) requires
  `doc["request_id"]` to equal the locally stored `ctx->editable_history_id`
  **and** `doc["hours"]` to equal the requested range's hours, or the response
  is dropped outright (`:2290`). This is the one place in the whole contract
  where a request id is load-bearing — see §5.
- For the numeric graph sub-path: `values` must be a JSON array, its size
  must be ≤ `kHistoryPoints24h=288`, and `period_minutes` must match, else the
  response is dropped (`:2287-2289`) before the range-id check even runs.

## 5. Correlation — definitive answer

> **Correction (found in Task 17):** the tile graph applies any numeric
> response whose `entity_id` matches; it has no hours/period gate
> (`tile_renderer.cpp:4498-4514`). A popup's 7-day response therefore also
> overwrites a 24-hour tile graph of the same entity until that graph's next
> refresh — firmware behaviour the adapter cannot change. It also means a
> response the adapter should not send (for example an empty `values` array
> answering a malformed request) clears that entity's tile graph whatever its
> range.

**There is no MQTT-level request/sequence id used anywhere except the
editable-value range-switch guard in §4.4.** Every other consumer correlates
a `history/response` message to "which tile/popup does this belong to" purely
by matching the `entity_id` field inside the response JSON against the
entity_id of whatever UI element is asking, case-insensitively
(`String::equalsIgnoreCase`):

- **Sensor popup** (`queue_sensor_popup_history`, `sensor_popup.cpp:3032-3053`):
  drops the message if the popup is closed/closing (`:3034-3035`), extracts
  `entity_id` from the payload if not passed explicitly
  (`extract_history_entity_id`, `:3016-3028`, itself a substring scan, not a
  JSON parse), and drops it if it doesn't case-insensitively match
  `ctx->entity_id` (`:3045-3048`). `apply_history_payload` then does its own,
  second `entity_id` check via full JSON parse (`:2277-2280`) before doing
  anything else. Both checks must pass.
- **Tile graph** (`apply_tile_graph_history`, `tile_renderer.cpp:4498-4514`):
  no popup-open gate; it iterates **every** tile in the active grid that is
  `TILE_SENSOR` with `sensor_display_mode == 2` (graph mode) and applies the
  response to **every one** whose `sensor_entity` matches the response's
  `entity_id` case-insensitively (`:4510-4514`) — one response can legitimately
  update several tiles at once if they share an entity.
- **Energy** (`queue_energy_response`, `energy_data.cpp:288-297`): correlates
  by the `"period"` field only (`response_period`, `:65-76`, substring scan
  for `"period"` before the full JSON parse), normalized to exactly one of
  `"day"`/`"week"`/`"month"` (`normalize_period`, `:49-52`); unrecognized/
  missing period defaults to `"day"`. Three independent single-slot pending
  buffers exist, one per period (`g_pending_day/week/month`,
  `energy_data.cpp:26-28`), so a day/week/month response can never overwrite
  another period's data, but there is still no per-request id — a stale
  response for a period the UI is no longer waiting on will still overwrite
  that period's cache the next time it's read.
- **Numeric-history timeout bookkeeping only** (not the UI apply-path): also
  keys off `entity_id`, matched against up to 8 slots
  (`clear_pending_history_request`, `mqtt_handlers.cpp:376-389`).
- **Discrete-history timeout bookkeeping only**: keys off `entity_id`
  **and** `kind` (`"binary"`/`"state"`) **and**, if the response supplies a
  non-zero `hours`, that too (`clear_pending_discrete_history_request`,
  `:391-407`).
- **The one exception**: editable Number/Select/DateTime range switches
  additionally require `request_id` echo-match (§4.4,
  `sensor_popup.cpp:2252-2261`). This exists specifically so a slow/stale
  Recorder reply for a range the user has already switched away from cannot
  clobber the newer selection — it is a staleness guard, not a general
  request/response correlation mechanism, and it does not apply to plain
  Sensor popups, Binary/State popups, or tile graphs.

**Practical consequence for a responder implementation:** always echo the
request's `entity_id` verbatim (case doesn't matter, but do not omit it) and
the request's `hours`/`period_minutes` (numeric) or `hours` (discrete) back in
the response. If you also received a `request_id` (editable requests only),
echo it back verbatim too — it costs nothing and is required for that one
path. Do not rely on topic, MQTT message order, or arrival timing for
correlation; only payload field matching decides where a response lands.

## 6. Energy request/response

### 6.1 Request — `mqttPublishEnergyRequest`, `mqtt_handlers.cpp:2531-2562`

```json
{"period":"day"}
```
`period` must be exactly `"week"` or `"month"`; **any other value, including
absent/empty, becomes `"day"`** (`:2532-2535`). No entity_id, no request id —
a single energy request implicitly asks for every configured energy entity
for that period.

Callers/throttling live in `energy_data.cpp`:
- `energy_request_period(period, force)` (`:322-346`) — throttles non-forced
  calls to once per `kEnergyRequestThrottleMs=10000` ms (`:45`) per period.
- `energy_service_periodic()` (`:352-364`) — auto-refreshes the `"day"` period
  every 60 s while connected (`:358`: `60UL * 1000UL`), plus services retry
  backoff for all three periods every call (`:355-357`).

### 6.2 Response — `parse_energy_response`, `energy_data.cpp:201-284`

Parsed with `DynamicJsonDocument doc(32768)` (`:202`); invalid JSON is logged
and dropped (`:204-206`).

Top level:
```json
{"period":"day","start":"...","entries":[ { ... }, { ... } ]}
```
- `period` (string, optional, default `"day"`) — normalized via
  `normalize_period` (`:210`); this is what §5 correlates on.
- `start` (string, optional, default `""`) — stored verbatim per entry
  (`:211`, `:228`); **not** parsed as a timestamp anywhere in this function —
  UNVERIFIED what format the UI expects here beyond "opaque string it stores
  and later displays" (rendering call sites in `energy_popup.cpp` were not
  read for this task).
- `entries` (array, **required** — `null`/absent ⇒ whole response dropped
  with a log line, `:212-216`).

Each entry object (`EnergyEntryData`, `energy_data.h:9-25`):

| Key | Type | Meaning |
| --- | --- | --- |
| `id` | string, **required** | Entries without `id` (absent/empty) are silently skipped, not an error (`:222-223`) |
| `category` | string, optional, default `""` | One of `"grid"`, `"solar"`, `"battery"`, `"gas"`, `"water"`, `"device_water"` (case-insensitive) drives icon selection only (`icon_for_energy`, `:161-171`); any other/absent value falls back to a generic "lightning-bolt" icon. `category` is otherwise inert — not used for math or correlation |
| `name` | string, optional | Falls back to the Bridge's cached sensor name via `haBridgeConfig.findSensorName(id)` if empty (`:237-239`) |
| `unit` | string, optional | Falls back to the Bridge's cached sensor unit, then to a unit cached from a **previous** Energy response for the same id, if empty (`:240-247`) |
| `is_cost` | bool, optional, default `false` | If true, forces the currency icon (`currency-eur`) regardless of `category` (`:162`, `:232`) |
| `is_total` | bool, optional, default `false` | Stored on the entry (`:233`); this task's source reading did not trace further UI consumption beyond storage — UNVERIFIED exact display-semantics difference from a non-total entry |
| `sign` | int, optional, default `1` | Any negative value normalizes to exactly `-1`, anything else to `+1` (`:234-235`). Applied via `apply_energy_sign` (`:156-159`): **only flips an already-positive value negative when sign is -1; a value that is already negative is left unchanged.** Applied to `total` and every element of `values`, but **not** to `cost` |
| `total` | number, nullable | `null`/absent ⇒ `0.0`; otherwise sign-adjusted float (`:249-250`) |
| `cost` | number, nullable | `null`/absent ⇒ `has_cost` stays `false` and `cost` stays `0.0`; present (even `0`) ⇒ `has_cost=true` (`:251-255`). **Not** sign-adjusted |
| `values` | array, optional | Per-bucket breakdown, hard-capped at `ENERGY_VALUES_MAX=32` (`energy_data.h:7`) — **elements beyond the 32nd are silently ignored**, no error, no log (`:260`: `if (entry.value_count >= ENERGY_VALUES_MAX) break;`). Each element: JSON `null` ⇒ `value_valid[i]=false`, `values[i]=0.0` (explicit "no data" marker, distinct from a real zero); a number ⇒ sign-adjusted, and `value_valid[i] = isfinite(f)` (`:262-269`) |

Only `"day"`-period entries are pushed live onto `TILE_ENERGY` grid tiles
(`:273-274`, `queue_energy_tile_update_for_entry`, `:173-199`, which matches
tiles by `tile.sensor_entity.equalsIgnoreCase(entry.id)` — same entity-id
matching pattern as history). Week/month entries are cached
(`cache_for_period(period) = parsed`, `:279`) and only surfaced through the
Energy popup refresh (`queue_energy_popup_refresh`, `:280`) — **not** written
to any tile.

Tile display value: `format_energy_total(total, is_cost)` (`:151-154`) — 3
decimal places normally, 2 for cost entries, or the literal string `"--"` if
the value is not finite.

### 6.3 What "overflow" means for energy

- More than 32 `values` per entry: silently truncated, no error (see table
  above).
- More entries than fit in the 32768-byte `DynamicJsonDocument`: the whole
  `deserializeJson` call fails and the **entire response is dropped**
  (`:203-207`) — this is a hard failure, not a partial-apply. There is no
  explicit entry-count cap separate from the buffer size; UNVERIFIED exact
  maximum entry count (depends on per-entry JSON size; not computed here).

### 6.4 The unrelated `"energy"` catalog in `bridge/apply` — do not confuse with §6.2

`parseEnergySection` (`ha_bridge_config.cpp:1108-1184`) parses a **different**
message: the Bridge's full config-sync payload on `<base>/bridge/apply`
(topic check `mqtt_handlers.cpp:1727-1728`; the "energy" section is located by
substring search for `"\"energy\""` inside that larger `body`,
`ha_bridge_config.cpp:1114`). This is an **entity catalog**, not a
period/entries response. Each object in its `"energy"` array is read with
`extractStringField` (substring scan, `:1066-1081`, not a JSON parser) for
exactly three keys:

| Key | Meaning here |
| --- | --- |
| `id` | Required; entities missing it are skipped (`:1149`) |
| `name` | Optional; feeds the shared `sensor_names_map` used across all entity types (`:1153-1156`) |
| `unit` | Optional; feeds the shared `sensor_units_map` (`:1158-1161`) |
| `category` | Optional; used **only** to pick an icon via `energyIconForCategory` (`:1083-1099`, near-duplicate of `icon_for_energy` in §6.2's table but a separate function in a separate file) — same category vocabulary (`grid`/`solar`/`battery`/`gas`/`water`/`device_water`), same `"_cost"`-id-suffix-or-`eur`/`euro`-unit ⇒ currency icon rule (`:1092`) |

None of `total`, `cost`, `values`, `is_cost`, `is_total`, `sign`, or `period`
exist in this message. If you are implementing the responder for
`energy/request`/`energy/response`, use §6.1/§6.2, not this section — this
section only matters if you also need to advertise which energy entities
exist for the Web Admin entity picker.

Regarding "`fire`" from the task's key list: it is not a wire key or a
category value. It is the **icon name** (`"fire"`, a Material-Design-style
icon identifier string) that both `icon_for_energy` (`energy_data.cpp:168`)
and `energyIconForCategory` (`ha_bridge_config.cpp:1096`) return when
`category == "gas"`.

## 7. Timeouts, retries, and what renders while waiting

All three history/energy request families are **fire-and-forget over MQTT** —
none retry the actual MQTT publish on a timer; "retry" below means
re-publishing a fresh request after giving up on the old one, not resending
the same message. UNVERIFIED: exact MQTT QoS level used (the publish calls
only expose a `retain` boolean, always `false` for these requests; QoS is not
a parameter in any call site read for this task).

| Path | Wait time | Constant | On expiry |
| --- | --- | --- | --- |
| Numeric history | 2000 ms | `kHistoryHaResponseTimeoutMs`, `mqtt_handlers.cpp:65` | `service_pending_history_fallback()` (`:510-555`, polled every loop from `mqttServiceLocalSensors`, `:1959-1960`) fires `queue_history_fallback_for_entity` (`:470-508`): for the one hardcoded external-temperature entity, synthesizes a local mean-aggregated payload from an internal ring buffer (`build_external_temp_history_payload`, `:204-283`) if local time is valid, else an empty-`values` payload (`build_empty_history_payload`, `:285-308`); for the four internal Tab5 settings entities (brightness/rotate/sleep), also an empty payload; for **any other entity** (i.e. any real HA sensor), nothing is synthesized — it just logs `"HA timeout for %s (no local fallback)"` (`:536-537`) and the popup/tile keeps whatever it last had (no explicit "loading" or "error" state is pushed) |
| Discrete (binary/state) history | 8000 ms | `kDiscreteHistoryHaResponseTimeoutMs`, `:66` | Synthesizes `{"version":1,"kind":"<kind>","entity_id":"...","hours":N,"history_available":false,"error":"ha_timeout"}` (`build_discrete_history_unavailable_payload`, `:310-325`) and queues it as if it were a real response (`:549-550`) |
| Discrete history, MQTT unavailable at request time | immediate, no wait | — | Same unavailable payload, `error` = `"missing_topic"` or `"mqtt_offline"` (`:2466-2474`) |
| Discrete history, publish queue full | immediate, no wait | — | Same unavailable payload, `error` = `"publish_failed"` (`:2497-2498`) |
| Energy | 15000 ms | `kEnergyResponseTimeoutMs`, `energy_data.cpp:47` | `awaiting_response` cleared, `retry_requested` set (`:328-332`); next call to `energy_request_period` re-publishes after a further 2000 ms backoff (`kEnergyRetryBackoffMs`, `:46`, checked `:335-338`) |
| Energy, non-forced repeat request | throttled | `kEnergyRequestThrottleMs=10000`, `:45` | Returns "already pending" without publishing again (`:341-344`) |
| Energy, periodic day refresh | every 60000 ms | inline literal, `energy_service_periodic`, `:358` | Re-publishes `period=day` if not otherwise busy |

The `hold_ms` parameter seen in the numeric/discrete/energy publish calls
(`20000`, `20000`, `12000` at `mqtt_handlers.cpp:2425`, `:2489`, `:2556`) is
**not** a response-wait timeout — it is how long the message may sit in the
local outbound MQTT command queue before being dropped as stale if the
connection is busy (`mqttEnqueuePublishWithLargeBuffer`,
`network_manager.cpp:1385-1396`, `hold_ms` defaults to 15000 if 0). Do not
confuse it with the response timeouts in the table above.

## 8. Categorical vs numeric — how the firmware tells them apart

The distinguishing field is the response's `"kind"` key, checked as a plain
string compare (`sensor_popup.cpp:2303-2313`):

- Absent, or any value other than `"binary"`/`"state"` → **numeric graph**
  path (§4.1): a flat `"values"` array of positional, evenly-spaced numbers.
- `"binary"` → **boolean timeline** (§4.2): 2-bit codes (off/on/unknown/
  unavailable), `"2bit-hex"` packed timeline + explicit `segments` + `activity`
  log, all epoch-**second** timestamps.
- `"state"` → **arbitrary categorical timeline** (§4.3): same shape as binary
  but states are free-text labels resolved through a `palette` array (max 16
  entries) and a `"palette4-hex"` (1 hex nibble/point) packed timeline instead
  of 2-bit codes.

The *request* also signals which kind is expected, via the discrete request's
`"kind":"binary"|"state"` field (§3.2) or the plain absence of a `kind` field
for `mqttPublishHistoryRequest` (§3.1) — a correctly-behaving responder should
answer with the same `kind` it was asked for (or omit it for a numeric
request), but note from §4.1 that the firmware's numeric-dispatch check
(`mqtt_handlers.cpp:1845-1847`) only *peeks* `kind` for its own bookkeeping;
the popup-side dispatch (`sensor_popup.cpp:2303-2313`) is the one that
actually gates rendering, and it is driven by the response's own `kind`, not
by which request function was originally called.

Editable-value popups (§4.4) are a hybrid: they always consume the
categorical shape (segments/activity/palette) for their Activity list
regardless of the response's `kind`, and, only for Number tiles, additionally
consume a numeric `values` array from the *same* response object.

## 9. Special values — null / empty / "unavailable" / "unknown"

| Value | Where | Meaning |
| --- | --- | --- |
| `values: []` (empty array) | numeric response | Explicit "no history data"; chart is cleared to zero points (`sensor_popup.cpp:2343-2347`; firmware's own empty-fallback payload shape, `mqtt_handlers.cpp:285-308`) |
| `values: null` or key absent | numeric response | Whole response dropped, nothing rendered (`sensor_popup.cpp:2337-2339`) |
| An element of `values` is JSON `null` | numeric response | Gap; carried/back-filled from a neighboring valid sample for non-editable popups and tile graphs, left as a genuine gap for editable-number popups (§4.1) |
| An element of `values` is a non-numeric JSON string (e.g. `"unavailable"`) | numeric response | Also treated as a gap by both parsers — the ArduinoJson path (`extract_numeric`, rejects unparseable strings) and the raw-substring tile-graph path (`tile_renderer.cpp:4542-4548`, explicitly skips quoted strings as NaN) |
| `"error"` key present (any value) | binary/state response | Forces `history_available=false` regardless of an explicit `history_available` value (`sensor_popup.cpp:1873-1874`, `:2121-2122`) |
| `"history_available": false` | binary/state response | UI shows a localized "history unavailable" status label instead of the timeline/segments/activity (`:1967-1976`, `:2237-2246`) and skips decoding the timeline/segments/activity fields even if present (`:1887`, `:1895`, `:1920`, `:2155`, `:2164`, `:2188` all gate on `history_available`) |
| A nullable field (`device_class`, `current`, `available`, `last_changed`, ...) is JSON `null` | binary/state response | **Explicitly clears** the cached value (e.g. `last_changed` resets to 0) — this is different from the key being **absent**, which **keeps the previous cached value unchanged**. Pattern: `doc.containsKey(key) && variant.isNull()` (`sensor_popup.cpp:1846-1870` for binary, mirrored for state). A responder that omits a field to mean "no change" and one that sends it as `null` produce different, deliberate outcomes — do not conflate them |
| `state` string `"unavailable"`, or `available:false` | binary segments/activity | Coded as state `3` ("unavailable"), distinct from state `2` ("unknown", used for empty/unrecognized strings) (`binary_state_code`, `sensor_popup.cpp:854-865`) |
| `palette_complete: false` | state response | Bridge-side palette overflow signal; overflow states render as "unknown" client-side, logged once per response (`sensor_popup.cpp:2126-2131`) |
| Entry `total`/`cost` is JSON `null` or absent | energy response | `total`→`0.0`; `cost`→`0.0` **and** `has_cost` stays `false` (distinct from a real `cost:0`, which sets `has_cost=true`) (`energy_data.cpp:249-255`) |
| Element of entry `values` is JSON `null` | energy response | `value_valid[i]=false`, `values[i]=0.0` — explicit "no data for this bucket", distinct from a real `0` (`energy_data.cpp:262-269`) |
| Entry has no `id` | energy response | Entry silently skipped, not an error (`energy_data.cpp:222-223`) |

## 10. Summary of hard limits (for overflow handling)

| Limit | Value | Citation | Behavior beyond limit |
| --- | --- | --- | --- |
| Concurrent pending numeric-history timeout slots | 8 | `mqtt_handlers.cpp:67` | Oldest evicted (bookkeeping only, not the eventual response) |
| Concurrent pending discrete-history requests | 1 (global) | `mqtt_handlers.cpp:86-94` | New request unconditionally replaces old bookkeeping |
| Binary/state timeline points | 768 | `sensor_popup.cpp:60` | Whole timeline rejected (not truncated) if exceeded or if hex length mismatches |
| Binary/state segments | 96 | `sensor_popup.cpp:59` | Extra segments truncated; order-independent (re-sorted) |
| Binary/state activity entries | 96 | `sensor_popup.cpp:61` | Extra entries truncated by array-tail; **requires oldest→newest wire order** to keep the right ones |
| State palette entries | 16 | `sensor_popup.cpp:62` | Whole palette discarded if exceeded or if any entry isn't a string |
| Editable-number history points | 288 | `sensor_popup.cpp:2288, 2342` | Whole response dropped if exceeded |
| Energy values per entry | 32 | `energy_data.h:7` | Extra values silently ignored (array read stops) |
| Numeric/discrete history payload | 32767 bytes | `mqtt_handlers.cpp:1496, 1836` (the `doc(24576)` capacity at `sensor_popup.cpp:2269` is ignored by ArduinoJson 7.4.3) | Payload truncated, then `deserializeJson` fails; whole response dropped |
| Energy response payload | 32767 bytes | `mqtt_handlers.cpp:1496, 1880` (the `doc(32768)` capacity at `energy_data.cpp:202` is ignored by ArduinoJson 7.4.3) | Payload truncated, then `deserializeJson` fails; whole response dropped |

## UNVERIFIED items (exact scope of what was and wasn't checked)

- Exact MQTT QoS level for any of these publishes/subscriptions. Checked:
  every `mqttEnqueuePublish*` call site used in this document; none pass a
  QoS parameter, only `retain` (always `false` here) and, for the "large
  buffer" variant, `hold_ms`/`priority`. The QoS default lives inside
  `HomeTilesNetworkManager`'s PubSubClient plumbing, not read for this task.
- The full member list of `hardwareIo.isLocalEntityId(...)`
  (`mqtt_handlers.cpp:2388`) — only its call site and effect (no MQTT request
  at all) were confirmed; `src/io/hardware_io.cpp` itself was not read.
- Exact display/business-logic difference `is_total=true` makes versus
  `false` beyond being stored on `EnergyEntryData` (`energy_data.cpp:233`) —
  `src/ui/popups/energy/energy_popup.cpp` was not read for this task.
- Expected format/consumption of the energy response's top-level `"start"`
  string (`energy_data.cpp:211,228`) beyond "stored verbatim, not parsed as a
  timestamp here" — same file not read.
- Maximum practical `entries` count for an energy response — bounded only by
  the 32768-byte document size, not an explicit count field; not computed.
- Whether a real Home Assistant Bridge ever sends its own `"error"` key on a
  history response (as opposed to it only being firmware-synthesized locally)
  — no Bridge source was in scope for this task (`HomeTiles Bridge` is
  documented in this repo's `PROJECT_CONTEXT.md` as a separate repository).
