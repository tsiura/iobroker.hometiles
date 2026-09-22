# HomeTiles climate & cover MQTT contract

Firmware reference: HomeTiles `FW_VERSION "v0.6.12"` (`version.txt:4`), commit
`5d251671dce602c3a539cbb59769ef922bf12b2c`. Every claim below was read directly
from that commit's source; nothing here is inferred from Home Assistant's own
documentation unless explicitly marked. Files read:

- `src/network/mqtt/mqtt_handlers.cpp`
- `src/network/mqtt/mqtt_topics.cpp`
- `src/network/bridge/ha_bridge_config.cpp`, `ha_bridge_config.h`
- `src/network/network_manager.cpp`, `network_manager.h`
- `src/types/climate/state.h`, `src/types/cover/state.h`, `src/types/cover/renderer.cpp`, `src/types/cover/renderer.h`
- `src/tiles/runtime/tile_renderer.cpp` (climate parsing actually lives here, not in `src/types/climate/`)
- `src/types/tile_type_policy.h`
- `src/ui/popups/cover/cover_popup.cpp` (to confirm which allow-listed cover commands the shipped UI actually sends)
- `src/core/json_scan.h` (the shared scanner climate's own local helpers build on)

**The two most dangerous things in this document, read this before writing any publisher code:**

1. **Climate and cover both cache state by full overwrite, never by merge.** Every time a *valid* JSON payload arrives on an entity's state topic, the firmware replaces the entire cached `ClimateState`/`CoverState` struct with a freshly-parsed one. Any field your payload omits does **not** mean "unchanged" — it snaps back to a hardcoded struct default (e.g. climate's `target_temperature` reverts to exactly `20.0`, `min_temp` to `7.0`, `max_temp` to `35.0`). **You must publish the complete current attribute set on every single publish**, not a diff. See "The overwrite problem" under each domain.
2. **`null` is safe for cover, dangerous for climate.** Cover's JSON parser (ArduinoJson) treats an explicit `null` exactly like an absent key. Climate's hand-rolled string-scanning parser does **not** — sending `"hvac_mode": null` can make the parser silently swallow the *next unrelated quoted token in the payload* (often the following key's own name) as the value of `hvac_mode`. Never send `null` for a climate string field; omit the key instead.

---

## Climate

### 1. Inbound state topic

There is no static climate state topic in `mqtt_topics.cpp` — it is a **dynamic, per-configured-tile subscription**, built the same way for every entity assigned to a `TILE_CLIMATE` tile anywhere in the folder tree or the screensaver grid:

- Topic: `buildHaStatestreamTopic(entity_id, "state")` → `<ha_prefix>/<domain>/<object_id>/state`, where every `.` in `entity_id` becomes `/` (`src/network/mqtt/mqtt_handlers.cpp:1254-1266`).
- `ha_prefix` defaults to the literal string `ha/statestream` if not configured (`src/network/mqtt/mqtt_topics.cpp:42-46`) — **despite the name, this is not what Home Assistant's native `statestream` MQTT integration publishes** (that integration publishes one sub-topic per attribute). The payload shape below (one JSON blob with `state`+`attributes`) matches a custom aggregator such as HomeTiles-Bridge, not the native HA component.
- Example: `climate.living_room` → `ha/statestream/climate/living_room/state`.
- The route is only registered when `tileTypeSubscribesDynamicState(TILE_CLIMATE)` is true (it is — `src/types/tile_type_policy.h:46-50`), added with the default suffix `"state"` (`mqtt_handlers.cpp:1272`, gated at `mqtt_handlers.cpp:1327-1332`). Panel-local entities are excluded (`mqtt_handlers.cpp:1280-1284`) — not relevant to climate in practice.
- Subscriptions are (re)computed by `rebuildDynamicRoutes`/`mqttReloadDynamicSlots` and re-sent after MQTT reconnect and after every Bridge config reload (`mqtt_handlers.cpp:1891-1904`, `2604`).
- Entities merely listed in the Bridge's `"climates"` config array are **not** subscribed by themselves — see the cross-cutting section below.

### 2. State payload format

JSON object, required (`src/tiles/runtime/tile_renderer.cpp:2138-2303`, function `parse_climate_payload`). A payload that doesn't start with `{` after trimming is dropped outright, cache unchanged (`tile_renderer.cpp:2141`).

The parser is a **hand-rolled, allocation-free substring scanner** (`extract_json_string_field`/`_number_field`/`_array_field`/`_bool_field_cstr`/`_object_field`, all in `tile_renderer.cpp:802-935`), **not** a structural JSON parser (contrast with cover, which uses real ArduinoJson). It runs twice: once over the *entire raw payload* (`parse_source(json)`, called at `tile_renderer.cpp:2268`) and once over just the substring located by the `"attributes"` key (`parse_source(attributes)`, `tile_renderer.cpp:2269-2271`, using `extract_json_object_field`/`hometiles_json::objectSpan`). Because pass 1 scans the whole raw text, a key nested inside `attributes` is already found on pass 1 — pass 2 is largely redundant except when the same key exists at both levels.

Expected shape (mirrors a Home Assistant `state_changed` event):

```json
{
  "state": "heat",
  "attributes": {
    "current_temperature": 21.4,
    "temperature": 22.0,
    "hvac_action": "heating",
    "hvac_modes": ["off", "heat", "cool"],
    "fan_modes": ["auto", "low", "high"],
    "supported_features": 401,
    "min_temp": 7,
    "max_temp": 35
  }
}
```

`hvac_mode` may be used instead of `state` (checked first, `state` is the fallback — `tile_renderer.cpp:2147-2148`).

#### Every key read, and what happens when it's absent

| JSON key | Fallback key | Read as | Struct field | If absent from this payload | Citation |
|---|---|---|---|---|---|
| `hvac_mode` | `state` | string, trim+lowercase | `hvac_mode[16]` | reverts to `""` (state.h:31 default) | `tile_renderer.cpp:2147-2152` |
| `hvac_action` | — | string, trim+lowercase | `hvac_action[16]` | reverts to `""` | `2153-2157` |
| `preset_mode` | — | string → matched against 8 fixed names | `preset_mode_id` (uint8) | `0xFF` ("no preset") — same result as an *unrecognized* name | `2158-2160`, name table `climate_preset_id` `2049-2055` |
| `fan_mode` | — | string, trim+lowercase | `fan_mode[16]` | `""` | `2161-2165` |
| `swing_mode` | — | string, trim+lowercase | `swing_mode[16]` | `""` | `2166-2170` |
| `swing_horizontal_mode` | — | string, trim+lowercase | `swing_horizontal_mode[16]` | `""` | `2171-2176` |
| `temperature_unit` | `unit_of_measurement` | string | `temperature_unit[8]` | if **both** absent, defaulted at end-of-parse to `"°C"` (UTF-8 `C2 B0` + `C`) | `2177-2181`, default at `2287-2290` |
| `available` | — | bool | `ClimateState.available` | stays `true` (struct default, state.h:11) unless the `hvac_mode`-unavailable rule below fires | `2183-2187` |
| `hvac_modes` | — | JSON array → CSV → bitmask (off/heat/cool/heat_cool/auto/dry/fan_only) | `hvac_modes_mask` (uint8) | `0` (no mode buttons shown) | `2191-2194`, mask table state.h:45-53 |
| `preset_modes` | — | array → bitmask, same 8 names as `preset_mode` | `preset_modes_mask` (uint8) | `0` | `2195-2198` |
| `fan_modes` | — | array → bitmask (10 names: auto/low/medium/high/on/off/top/middle/focus/diffuse) | `fan_modes_mask` (uint16) | `0` | `2199-2202`, state.h:99-110 |
| `swing_modes` | — | array → bitmask (5 names) | `swing_modes_mask` (uint8) | `0` | `2203-2206`, state.h:125-131 |
| `swing_horizontal_modes` | — | array → bitmask (7 names) | `swing_horizontal_modes_mask` (uint8) | `0` | `2207-2210`, state.h:145-153 |
| `supported_features` | — | number-or-string, must be finite and `>=0`, clamped to 65535 | `supported_features` (uint16) + `has_supported_features` | `has_supported_features=false`, value `0` | `2211-2219` |
| `current_temperature` | — | number-or-string | `current_temperature` + `has_current_temperature` | flag `false`, value reverts to `0.0` | `2220-2223` |
| `current_humidity` | — | number-or-string | `current_humidity` + `has_current_humidity` | flag `false`, value `0.0` | `2224-2227` |
| `target_humidity` | `humidity` | number-or-string | `target_humidity` + `has_target_humidity` | flag `false`, value reverts to `50.0` | `2228-2232` |
| `temperature` | — | number-or-string | `target_temperature` + `has_target_temperature` | flag `false`, value reverts to `20.0` | `2233-2236` |
| `target_temp_low` | — | number-or-string | `target_temp_low` + `has_target_range` (**shared flag with high**) | value reverts to `18.0`; see caveat below | `2237-2240` |
| `target_temp_high` | — | number-or-string | `target_temp_high` + `has_target_range` (**shared flag with low**) | value reverts to `24.0`; see caveat below | `2241-2244` |
| `min_temp` | — | number-or-string, **no `has_*` flag** | `min_temp` | reverts to `7.0` | `2245-2247` |
| `max_temp` | — | number-or-string, **no `has_*` flag** | `max_temp` | reverts to `35.0` | `2248-2250` |
| `min_humidity` | — | number-or-string, **no `has_*` flag** | `min_humidity` | reverts to `30.0` | `2251-2253` |
| `max_humidity` | — | number-or-string, **no `has_*` flag** | `max_humidity` | reverts to `99.0` | `2254-2256` |
| `target_temp_step` | `precision` | number-or-string | `target_temp_step` | reverts to `0.5` | `2257-2261` |
| `target_humidity_step` | — | number-or-string | `target_humidity_step` | reverts to `1.0` | `2262-2265` |

All numeric defaults above are the compiled-in struct defaults in `src/types/climate/state.h:18-29`, not zero.

**`target_temp_low`/`target_temp_high` share one presence flag.** If you send only `target_temp_low`, `has_target_range` becomes `true` but `target_temp_high` silently takes its `24.0` default — a consumer that trusts `has_target_range` alone will believe both bounds are fresh when only one is.

Post-parse clamps applied unconditionally after both scan passes (`tile_renderer.cpp:2273-2291`):
- if `max_temp <= min_temp` → both reset to `7.0`/`35.0`
- `target_temp_step` outside `(0, 10]` → reset to `0.5`
- `target_humidity_step` outside `(0, 100]` → reset to `1.0`
- if `max_humidity <= min_humidity` → both reset to `30.0`/`99.0`

#### The overwrite problem

`update_climate_tile_state` (`tile_renderer.cpp:2407-2426`) does:
```cpp
ClimateState state = parse_climate_payload(payload);
if (!state.valid) return;
...
states[grid_index] = state;   // full replace, no field-level merge
```
There is no merge with the previously cached state. Combined with the defaults table above: omit `"temperature"` from one update and the cached target snaps to `20.0`; omit `"hvac_modes"` and the mode-button bitmask clears to `0` (hiding every mode button); omit `"supported_features"` and `has_supported_features` drops to `false`. **Publish the full current attribute set every time**, not just the changed fields.

#### `null` on a string field is actively dangerous

Both the numeric and string helpers are built on the same primitive (`extract_json_string_field`, `tile_renderer.cpp:802-815`), which after finding the key and its colon does `indexOf('"', colon)` for the **next quote character anywhere in the rest of the string**, with no bound to the current value:

- **Numeric fields** (temperature, humidity, etc.): `hometiles_json::number()` (`src/core/json_scan.h:124-133`) rejects `null` outright (comment at line 122 says quoted/non-numeric values are rejected), so `extract_json_number_or_string_field` falls back to the string scanner. That scanner usually lands on the *next JSON key's own opening quote* and extracts the key name as text; `strtof` then fails to parse a key name as a number, so the field ends up treated as absent. This happens to fail safe, but only because key names aren't numeric — it is not a deliberate null check.
- **String fields** (`hvac_mode`, `hvac_action`, `fan_mode`, `swing_mode`, `swing_horizontal_mode`, `preset_mode`, `temperature_unit`): there is no numeric-parse safety net. `{"hvac_mode": null, "hvac_action": "idle"}` sets `hvac_mode` to the literal string `"hvac_action"` — the *next key's name* — because that's the next quoted token after the colon. This is silently accepted (`out.length() > 0` is true) and stored as if it were real data.

**Recommendation: never emit JSON `null` for a climate field. Omit the key.**

#### Buffer truncation

`climate_copy_text` (`tile_renderer.cpp:2011-2017`) truncates silently (no log) to the destination buffer size minus one: 15 characters for `hvac_mode`/`hvac_action`/`fan_mode`/`swing_mode`/`swing_horizontal_mode` (16-byte buffers), 7 characters for `temperature_unit` (8-byte buffer).

#### `preset_mode` name table is closed

`climate_preset_id` (`tile_renderer.cpp:2049-2055`) only recognizes the 8 HA-core preset names: `none, eco, away, boost, comfort, home, sleep, activity`. Any other name (a custom integration preset) is **not preserved** — it maps to sentinel `0xFF`, which `climatePresetName()` renders as an empty string. The original name is lost, not passed through.

### 3 & 4. Outbound commands and service names

All climate commands share **one** topic: `mqttTopics.topic(TopicKey::CLIMATE_CMND)` = `<device_base>/cmnd/climate` (`device_base` defaults to `hometiles`; descriptor at `mqtt_topics.cpp:13`, resolved via the `Command` domain, `mqtt_topics.cpp:56,82-83`). Every publish uses `mqttEnqueuePublishPriority(topic, payload, false)` — **not retained** (confirmed via the `retain` parameter position, `network_manager.h:59`, `network_manager.cpp:1376-1382`). Every payload is discriminated by a `"command"` field plus `"entity_id"`.

| User action | `command` value | Extra JSON fields | Exact payload | Function : lines |
|---|---|---|---|---|
| Set target temperature (single) | `set_temperature` | `temperature` (float, 2dp) | `{"entity_id":"<id>","command":"set_temperature","temperature":%.2f}` | `mqttPublishClimateTemperature`, `mqtt_handlers.cpp:2124-2151` (branch `2140-2143`) |
| Set target temperature range | `set_temperature` | `target_temp_low`, `target_temp_high` (float, 2dp each) | `{"entity_id":"<id>","command":"set_temperature","target_temp_low":%.2f,"target_temp_high":%.2f}` | same function, branch `2137-2139` |
| Set target humidity | `set_humidity` | `humidity` (float, 1dp) | `{"entity_id":"<id>","command":"set_humidity","humidity":%.1f}` | `mqttPublishClimateHumidity`, `2155-2172` |
| Set HVAC mode | `set_hvac_mode` | `hvac_mode` (string) | `{"entity_id":"<id>","command":"set_hvac_mode","hvac_mode":"<mode>"}` | `mqttPublishClimateHvacMode`, `2175-2192` |
| Set preset mode | `set_preset_mode` | `preset_mode` (string) | `{"entity_id":"<id>","command":"set_preset_mode","preset_mode":"<mode>"}` | `mqttPublishClimatePresetMode`, `2195-2213` |
| Set fan mode | `set_fan_mode` | `fan_mode` (string) | `{"entity_id":"<id>","command":"set_fan_mode","fan_mode":"<mode>"}` | `mqttPublishClimateFanMode` (`2244-2247`) → `mqtt_publish_climate_option` (`2216-2242`) |
| Set swing mode | `set_swing_mode` | `swing_mode` (string) | `{"entity_id":"<id>","command":"set_swing_mode","swing_mode":"<mode>"}` | `mqttPublishClimateSwingMode`, `2250-2253` |
| Set horizontal swing mode | `set_swing_horizontal_mode` | `swing_horizontal_mode` (string) | `{"entity_id":"<id>","command":"set_swing_horizontal_mode","swing_horizontal_mode":"<mode>"}` | `mqttPublishClimateHorizontalSwingMode`, `2256-2260` |

Every one of these functions returns without publishing (only logs) if `entity_id`/the value argument is null or empty, or if `networkManager.isMqttConnected()` is false (e.g. `mqtt_handlers.cpp:2125-2133`). None of them validate the mode string against the `*_modes_mask` the firmware itself parsed from state — any non-empty string is sent verbatim; validation is HA/Bridge-side only.

### 5. Feature/capability gating

`supported_features` (uint16) is stored verbatim (clamped, `has_supported_features` flag) at `state.h:12,30` / parser `tile_renderer.cpp:2211-2219`, and is passed through to the popup init struct (`build_climate_popup_init`, `tile_renderer.cpp:2213 area`). **HomeTiles does not define its own bit-name enum for this mask** — unlike cover, there is no `ClimateEntityFeature`-style constant list anywhere in `state.h`, `renderer.cpp`, or `control_contract.h`.

The actual per-control gating instead comes from the explicit `*_modes` **arrays** (`hvac_modes`, `preset_modes`, `fan_modes`, `swing_modes`, `swing_horizontal_modes`), each converted to its own bitmask against a fixed, hardcoded name table (`state.h:45-165`). A control is only populated from names present in its mask; an unrecognized name in the array is silently dropped, not an error.

UNVERIFIED: whether/how individual `supported_features` bits gate any specific climate widget beyond being carried through to the popup. Confirming that would require reading `src/ui/popups/climate/climate_popup.cpp`, which is outside the primary sources for this task and was not opened in this pass.

### 6. Special / sentinel values

- `hvac_mode`/`state` equal to `"unavailable"` (case-insensitive, after the lowercase step) forces `available = false` regardless of any `"available"` key — `tile_renderer.cpp:2294-2295`.
- Payload empty or not starting with `{` → entire message ignored, previous cached state kept — `2141`.
- Syntactically valid JSON with none of the "validity" fields present → `valid=false` → ignored, cache kept. Validity requires `!available` OR non-empty `hvac_mode`/`hvac_action` OR any of the four temperature/humidity `has_*` flags — `2297-2300`. **A payload containing only `supported_features` (with no mode/temperature/humidity field) is invalid and is dropped.**
- `supported_features` negative or non-finite → ignored (`has_supported_features` stays `false`) — condition at `2211-2213` (`isfinite(number) && number >= 0.0f`).
- `null` on a string field → see the dedicated warning above.

---

## Cover

### 1. Inbound state topic

Same mechanism and shape as climate: `<ha_prefix>/<domain>/<object_id>/state`, e.g. `ha/statestream/cover/kitchen_blind/state`, built by the same `buildHaStatestreamTopic` (`mqtt_handlers.cpp:1254-1266`), gated by `tileTypeSubscribesDynamicState(TILE_COVER)` (`src/types/tile_type_policy.h:46-50`), default suffix `"state"` (`mqtt_handlers.cpp:1272`, `1327-1332`).

### 2. State payload format

Real JSON parser this time: ArduinoJson, `DynamicJsonDocument doc(1024); deserializeJson(doc, payload);` (`src/types/cover/renderer.cpp:81-90`, function `parse_cover_payload`) — materially safer than climate's hand-rolled scanner.

**Non-JSON fallback:** if `deserializeJson` fails, the raw payload is treated as a bare state token: trimmed, lower-cased, stored directly as `CoverState.state`; `available = (payload != "unavailable")`; `supported_features` defaults to `OPEN|CLOSE|STOP` only, no position/tilt (`renderer.cpp:87-99`). An **empty** payload (after trim) is dropped entirely, `valid` stays `false`, cache untouched (`renderer.cpp:94-96`).

For valid JSON, every field is checked at the **root first, falling back to a nested `"attributes"` object** if present (`JsonVariantConst attrs = root["attributes"];`, `renderer.cpp:101`):

| JSON key | Where checked | Type | Struct field | If absent everywhere checked | Citation |
|---|---|---|---|---|---|
| `state` | root, then `attributes` | string | `state[12]`, trim+lowercase | explicit fallback string `"unknown"` (not `""`, not dropped) | `renderer.cpp:102-106` |
| `available` | **root only**, no `attributes` fallback | bool | `available` | `null`/absent → `true`, unless `state=="unavailable"` | `108-110` |
| `assumed_state` | root, then `attributes` | bool | `assumed_state` | `false` | `111-113` |
| `current_position` | root, then `attributes` | int (also accepts a numeric string) | `position` (0-100, clamped) + `has_position` | flag `false`, value `0` | `116-119` |
| `current_tilt_position` | root, then `attributes` | int (also numeric string) | `tilt_position` (0-100, clamped) + `has_tilt_position` | flag `false`, value `0` | `120-123` |
| `supported_features` | root, then `attributes` | int, clamped 0-255 | `supported_features` (uint8) | see feature-gating below — **not simply 0** | `124-135` |
| `device_class` | root, then `attributes` | string | `device_class[12]` | `""` | `136-139` |

`read_int`/`read_text` (`renderer.cpp:50-75`) use ArduinoJson `JsonVariantConst`, where a **missing key and an explicit JSON `null` are indistinguishable** (`item.isNull()` is true for both). For cover this is safe and well-defined: sending `null` for any of these keys behaves exactly like omitting it. **This is the opposite of climate — the two domains are not symmetric, see the top-of-document warning.** `read_int` also accepts a quoted numeric string via `strtol`, matching climate's leniency for numbers.

#### The overwrite problem (cover)

`apply_state` (`src/types/cover/renderer.cpp:267-291`) does the same full-replace as climate:
```cpp
CoverState state = parse_cover_payload(payload);
if (!state.valid) return;
...
states[index] = state;   // full replace, no merge
```
Every field a given valid payload omits reverts to the `CoverState` struct default (`state.h:17-28`): `position`/`tilt_position` to `0` (with their `has_*` flags `false`), `device_class` to `""`, `assumed_state` to `false`. Less surface area than climate, but the same rule applies: **publish the complete current attribute set on every update**, in particular `current_tilt_position` on every message for any cover that has tilt, and `supported_features` consistently if you ever send it at all (see below for why the *absence* of `supported_features` is not neutral).

### 3 & 4. Outbound commands and service names

Single command topic: `<device_base>/cmnd/cover` (`TopicKey::COVER_CMND`, `mqtt_topics.cpp:14`). `mqttPublishCoverCommand(entity_id, command, position)` (`mqtt_handlers.cpp:2263-2320`) validates `command` against a **fixed 10-string allow-list** (`2268-2271`) before publishing anything; anything else is silently rejected — logged only, no MQTT publish (`2276-2281`).

| `command` string | Payload | Wired to a UI control in this firmware? | Citation |
|---|---|---|---|
| `open_cover` | `{"entity_id":"<id>","command":"open_cover"}` | yes — main open button | `cover_popup.cpp:761` |
| `close_cover` | `{"entity_id":"<id>","command":"close_cover"}` | yes — main close button | `cover_popup.cpp:763` |
| `stop_cover` | `{"entity_id":"<id>","command":"stop_cover"}` | yes — stop button, only if `COVER_FEATURE_STOP` set | `cover_popup.cpp:769-771` |
| `set_cover_position` | `{"entity_id":"<id>","command":"set_cover_position","position":<0-100>}` | yes — position slider release / preset tap | `cover_popup.cpp:662-666, 745-749` |
| `open_cover_tilt` | `{"entity_id":"<id>","command":"open_cover_tilt"}` | yes — tilt-open button | `cover_popup.cpp:765` |
| `close_cover_tilt` | `{"entity_id":"<id>","command":"close_cover_tilt"}` | yes — tilt-close button | `cover_popup.cpp:767` |
| `stop_cover_tilt` | `{"entity_id":"<id>","command":"stop_cover_tilt"}` | yes — stop button, only if `COVER_FEATURE_STOP_TILT` set | `cover_popup.cpp:772-774` |
| `set_cover_tilt_position` | `{"entity_id":"<id>","command":"set_cover_tilt_position","tilt_position":<0-100>}` | yes — tilt slider release / preset tap | `cover_popup.cpp:662-666, 745-749` |
| `toggle` | `{"entity_id":"<id>","command":"toggle"}` | **no caller found anywhere in this repo** — accepted by the validator but dead as of this commit (verified with a repo-wide grep; the only other `"toggle"` usages are for the unrelated Switch domain) | allow-list only, `mqtt_handlers.cpp:2270` |
| `toggle_cover_tilt` | `{"entity_id":"<id>","command":"toggle_cover_tilt"}` | **no caller found anywhere in this repo**, same caveat | allow-list only, `mqtt_handlers.cpp:2271` |

Other verified behavior:
- `position`/`tilt_position` are clamped to `[0,100]` by the **outbound publisher itself** before formatting (`mqtt_handlers.cpp:2290-2291`), independent of what the caller passed.
- If the formatted payload would not fit the internal 384-byte buffer, the command is **dropped entirely**, not truncated (`2311-2315`) — unreachable in normal use, but it's a hard reject.
- Not retained — same `mqttEnqueuePublishPriority(topic, payload, false)` pattern as climate (`2318-2319`).

### 5. Feature/capability gating

`CoverFeature` bit enum, verified directly from firmware source (`src/types/cover/state.h:6-15`):

| Bit | Name | Value |
|---|---|---|
| 0 | `COVER_FEATURE_OPEN` | 1 |
| 1 | `COVER_FEATURE_CLOSE` | 2 |
| 2 | `COVER_FEATURE_SET_POSITION` | 4 |
| 3 | `COVER_FEATURE_STOP` | 8 |
| 4 | `COVER_FEATURE_OPEN_TILT` | 16 |
| 5 | `COVER_FEATURE_CLOSE_TILT` | 32 |
| 6 | `COVER_FEATURE_STOP_TILT` | 64 |
| 7 | `COVER_FEATURE_SET_TILT_POSITION` | 128 |

UNVERIFIED (outside firmware, flagging so nobody assumes it's confirmed here): these bit positions/names look the same as Home Assistant core's `CoverEntityFeature` enum from general knowledge of HA, which would mean a publisher could often pass HA's own `supported_features` attribute straight through. I did not open Home Assistant's source in this task to confirm that alignment, and the firmware source itself contains no comment asserting it — it just stores whatever integer arrives. Verify against the exact HA version you're bridging before relying on pass-through.

**Default when `supported_features` is absent from both root and attributes is not 0** (`renderer.cpp:124-135`): the firmware synthesizes `OPEN|CLOSE|STOP` (11) always, **plus** `SET_POSITION` (4) if `current_position` was present in the same payload, **plus** `OPEN_TILT|CLOSE_TILT|STOP_TILT|SET_TILT_POSITION` (240) if `current_tilt_position` was present. A cover with no `supported_features` field at all but with both position fields present will show full controls.

If `supported_features` **is** present, it is used exactly as given (clamped 0-255) — the position/tilt inference above is not layered on top. `has_position`/`has_tilt_position` (which gate whether a position readout displays at all) are driven purely by whether `current_position`/`current_tilt_position` were present, **independently** of whatever the `supported_features` bits say — a cover can report `supported_features` without the `SET_POSITION` bit and still have `has_position=true` if `current_position` was sent.

The non-JSON bare-string fallback path always uses `OPEN|CLOSE|STOP` only; it never infers tilt/position support (`renderer.cpp:98`).

### 6. Special / sentinel values

- `state == "unavailable"` (case-insensitive after lowercasing) forces `available=false` regardless of the `"available"` key — `renderer.cpp:109`.
- `state` key missing everywhere checked → literal string `"unknown"` is stored (not `""`, not dropped) — `renderer.cpp:103`.
- Empty payload string → entire message dropped, cache retained — `renderer.cpp:94-96`.
- Non-empty, non-JSON payload → accepted as a bare state token, see fallback above — `renderer.cpp:87-99`.
- `current_position`/`current_tilt_position` out of `[0,100]` (e.g. `-5` or `150`) are silently clamped on the inbound side too, never rejected — `clamp_percent`, `renderer.cpp:44-48`.
- `null` on any cover key → treated exactly like an absent key (safe, unlike climate) — see `read_int`/`read_text`, `renderer.cpp:50-75`.

---

## Cross-cutting: entity announce / config channel

Separate from the per-entity state/command topics above: the Bridge config JSON published retained to `tab5_lvgl/config/<deviceId>/bridge/apply` (consumed by `HaBridgeConfig::applyJson`, `src/network/bridge/ha_bridge_config.cpp`) carries top-level `"climates"` and `"covers"` arrays of entity IDs (substring-located via `json.indexOf("\"climates\"")`/`"\"covers\""`, `ha_bridge_config.cpp:621-629`), plus `"climate_meta"`/`"cover_meta"` sections that feed display names (`parseEntityNameSection`, `ha_bridge_config.cpp:658-659`) and icons (`parseEntityIconSection`, `ha_bridge_config.cpp:1392-1393`).

**Important: these lists do not themselves create an MQTT subscription.** They only populate the Web Admin entity picker. The actual per-entity state-topic subscription documented above is driven exclusively by which entity is assigned to a real `TILE_CLIMATE`/`TILE_COVER` tile in the grid or screensaver config (`mqtt_handlers.cpp:1305-1341`), independent of whether that entity also appears in `"climates"`/`"covers"`.

The `bridge/apply` topic itself uses a **different, hardcoded topic base** than the `cmnd`/`stat` topics: `"tab5_lvgl/config/" + <12-hex-char-uppercase eFuse-MAC device ID>` (`src/network/network_manager.cpp:585-587`, ID built by `buildDeviceId`, `network_manager.cpp:320-323`, format `%012llX`) — it is **not** derived from the configurable `device_base` (`hometiles`) that `cmnd/climate`/`cmnd/cover` use. Do not assume one "base topic" setting controls every HomeTiles topic family.

UNVERIFIED: the exact per-entry sub-keys inside `"climate_meta"`/`"cover_meta"` (I confirmed the section names and that they feed the shared name/icon maps, but did not trace `parseEntityNameSection`/`parseEntityIconSection` far enough to enumerate every accepted sub-key such as `entity_id`/`name`/`icon`). If an implementer needs to emit these sections, read those two functions in `ha_bridge_config.cpp` directly first.

## Consolidated UNVERIFIED list

1. Whether/how individual `supported_features` bits gate specific climate popup controls beyond being stored and forwarded — would require reading `src/ui/popups/climate/climate_popup.cpp` (not a listed primary source, not opened in this task).
2. Whether HomeTiles' `CoverFeature` bit values are intentionally aligned with Home Assistant core's `CoverEntityFeature` enum — the bit pattern looks identical from general knowledge of HA, but this was not checked against Home Assistant source in this task; the firmware source has no comment confirming the alignment.
3. The exact sub-key schema of `"climate_meta"`/`"cover_meta"` entries in the `bridge/apply` payload (section names and their two consumers are confirmed; per-entry field names are not).
