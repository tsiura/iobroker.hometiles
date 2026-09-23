# HomeTiles firmware wire contract — media_player and weather

This document records the `media_player` and `weather` slice of the HomeTiles
MQTT contract, at the same level of rigor as `docs/protocol.md`. The firmware
is the fixed side and is never modified for this project. Every claim below
was read out of the firmware source, not inferred or copied from the
firmware's own end-user documentation (`docs/bridge.md`,
`docs/home-assistant-setup.md`) — those docs are cited only as corroboration,
and one place where they actively **understate** the real topic shape is
called out explicitly.

Firmware reference: HomeTiles working tree at commit `5d25167` ("Add
persistent global tile radius with live previews"), four commits past the
`v0.6.12` release baseline (`9605b6a`) recorded in `PROJECT_CONTEXT.md`. Files
read: `src/network/mqtt/mqtt_handlers.cpp` (2749 lines), `mqtt_topics.cpp`,
`mqtt_topics.h`, `network_manager.cpp`/`.h`, `ha_bridge_config.cpp`,
`src/core/json_scan.h`, `src/tiles/runtime/tile_renderer.cpp`,
`src/ui/popups/media/media_popup.cpp`, `src/ui/popups/weather/weather_popup.cpp`,
`src/types/media/*`, `src/types/weather/*`, `src/ui/tabs/tiles/tab_tiles_unified.cpp`.

This is the panel's half of the weather story; the ioBroker
type-detector half is in `contract-iobroker-types.md`.

## Answer to the weather-response question (read this first)

**There is no `weather/response` topic. There is no response topic for
weather at all.** The firmware never subscribes to anything named
`weather/response`; `network_manager.cpp:903-920` subscribes exactly four
dynamic/config topics — `bridge_apply_topic_`, `history_response_topic_`,
`energy_response_topic_`, `bridge_icons_topic_` — and nothing weather-shaped.
`grep` for `weather_response` / `WeatherResponseTopic` across the whole
source tree returns zero hits; only `weather_request_topic_` exists
(`network_manager.h:222`).

The `<base>/weather/request` publish (`network_manager.cpp:591`,
`mqtt_handlers.cpp:2515-2529`) is a **fire-and-forget nudge**, not an RPC
call. The actual forecast answer arrives on a completely different topic
tree: the same per-entity HA-statestream-shaped topic that the panel
subscribes to continuously for every weather tile, built as
`<ha_prefix>/weather/<object_id>/weather` (`mqtt_handlers.cpp:1415`, via
`buildHaStatestreamTopic(entity, "weather")` at `mqtt_handlers.cpp:1254-1267`).
For entity `weather.home` with the default HA prefix this is literally
`ha/statestream/weather/home/weather` — note the trailing segment is the
literal word `"weather"`, **not** `"state"` as every other domain uses
(sensors, numbers, selects, datetimes, and media_player all end in
`/state`; only weather ends in `/weather`). Getting this one segment wrong
is the single easiest way to build a publisher that silently never reaches
the panel.

Full trace, in call order:

1. `mqttPublishWeatherRequest(entity_id)` (`mqtt_handlers.cpp:2515-2529`)
   publishes `{"entity_id":"<id>"}` to `getWeatherRequestTopic()`
   (`network_manager.cpp:1586-1587`) = `weather_request_topic_` =
   `"tab5_lvgl/config/" + deviceId + "/weather/request"`
   (`network_manager.cpp:583-591`). It is **not priority-queued**
   (`mqttEnqueuePublish`, not `...Priority`).
2. The only caller in the entire codebase is
   `request_weather_for_context()` in the weather popup
   (`weather_popup.cpp:2487-2491`), which is itself only invoked from
   `show_weather_popup()` (`weather_popup.cpp:3996` and `:4014`) — and, per
   `weather_popup.cpp:3980-4015`, **only when the panel's local entity cache
   has no payload at all for that entity yet**. If any cached payload
   exists (even stale), the popup renders it immediately and sends nothing.
   The compact grid tile never calls this function at all — a tile that is
   never opened as a popup never triggers a request. Practically: a sender
   must proactively publish/keep the entity's weather topic current (see
   below); the request is only a cold-cache bootstrap, not the normal
   refresh path.
3. There is no correlation ID, sequence number, or timeout anywhere in this
   path. The firmware does not know or care whether a given weather-topic
   publish was caused by its own request or happened on its own.
4. The answer channel is populated the same way for every weather tile,
   requested or not: `rebuildDynamicWeatherRoutes()`
   (`mqtt_handlers.cpp:1407-1452`) subscribes
   `<ha_prefix>/weather/<object_id>/weather` for every entity assigned to a
   `TILE_WEATHER` tile in any folder (`mqtt_handlers.cpp:1443-1445`). Inbound
   messages on that topic are matched in `tryHandleDynamicWeather()`
   (`mqtt_handlers.cpp:1485-1493`) and dispatched to
   `tiles_update_weather_by_entity()` (`tab_tiles_unified.cpp:2346-2361`),
   which caches the payload and queues it for both the grid tile
   (`queue_weather_tile_update`) and, if open, the popup
   (`queue_weather_popup_payload`, `weather_popup.h:22`).
5. The PubSubClient callback signature the firmware registers is
   `(char* topic, uint8_t* payload, unsigned int length)`
   (`network_manager.cpp:602`) — there is no retained-flag parameter, so the
   firmware cannot and does not distinguish a retained message from a live
   one. Publishing with `retain=true` is still recommended so a
   freshly-(re)connected panel has something in its cache immediately
   (avoiding the cold-cache request path above), but it makes no difference
   to how the payload is processed once received.

`docs/bridge.md:118` lists `tab5_lvgl/config/{id}/weather/*` as carrying
weather traffic "Both" directions. That row is a simplification for end
users and is technically misleading if read as "the answer comes back under
`tab5_lvgl/config/{id}/weather/...`": the request does, the answer does not.
`docs/bridge.md:101` separately confirms the general principle this relies
on: *"Entity states use `<HA prefix>/<entity>/...`. The Bridge publishes them
itself; Home Assistant's MQTT Statestream integration is not required."* — an
implementer does not need HA's real `mqtt_statestream` component, only
something that publishes the same shapes.

## Topic construction reference

Two independent, non-configurable-vs-configurable topic families are in play; confusing them is the second-easiest way to build a broken publisher.

| Family | Root | Configurable? | Built at |
| --- | --- | --- | --- |
| `cmnd`/`stat`/`tele` (media commands live here) | `<device_base>/...` | Yes — "Device topic base" in Web Admin / Bridge pairing, default `"hometiles"` | `mqtt_topics.h:65`, reasserted `mqtt_topics.cpp:38-39` |
| HA-statestream mirror (media *state* and weather answer live here) | `<ha_prefix>/...` | Yes — "HA prefix" in Bridge config, default `"ha/statestream"`; must be identical on Bridge and every display (`docs/home-assistant-setup.md:91`) | `mqtt_topics.h:66`, reasserted `mqtt_topics.cpp:44-45` |
| Bridge/config RPC (weather *request*, history, energy, icons, bridge apply) | `tab5_lvgl/config/<deviceId>/...` | **No** — literal hardcoded string, unrelated to `device_base`/`ha_prefix` | `network_manager.cpp:585-594` |

`buildHaStatestreamTopic(entity_id, suffix)` (`mqtt_handlers.cpp:1254-1267`):
`<ha_prefix>` + `/` + `entity_id` with every `.` replaced by `/` + `/` +
`suffix` (default `"state"` if the caller passes an empty suffix). Example:
`media_player.living_room` with suffix `"state"` → `ha/statestream/media_player/living_room/state`.

A dynamic route (media state/state_fast, weather) is only subscribed while
at least one tile of the matching type, referencing that exact entity,
exists in a **loaded folder or the screensaver grid**
(`mqtt_handlers.cpp:1325-1341` media, `:1431-1451` weather, `:1366-1379`
screensaver). Publishing to an entity with no configured tile is a no-op —
nothing is listening.

Both the media dynamic-sensor path and the weather dynamic path share one
inbound copy buffer, capped by `SMALL_BUF=96` / `LARGE_BUF=32768`
(`mqtt_handlers.cpp:1495-1497`); an incoming payload longer than 32767 bytes
is **silently truncated**, not rejected (`copy_len = min(length, dyn_len-1)`,
`mqtt_handlers.cpp:1816-1822`). Before that, the underlying MQTT client's own
receive buffer is the binding limit in practice: `kMqttBufferNormal = 16384`
bytes, grown to `kMqttBufferMedia = 24576` bytes only while at least one
`TILE_MEDIA` tile is configured anywhere (`network_manager.cpp:35,40`,
`mqttNormalBufferSize()` at `:1472-1477`, gated by
`setMqttMediaBufferNeeded(has_media_tiles)` at `mqtt_handlers.cpp:1383`, and
pre-sized at boot by `mqttAnyMediaTileConfigured()` at `:1390-1405`). Whether
the vendored PubSubClient itself drops or corrupts a packet larger than its
configured buffer before the firmware's own callback ever runs is library
behavior this review did not verify — see UNVERIFIED.

---

## media_player

### Inbound state topics

| Topic | Suffix | Carries |
| --- | --- | --- |
| `<ha_prefix>/media_player/<object_id>/state` | `"state"` (default) | Full state, may include embedded cover art |
| `<ha_prefix>/media_player/<object_id>/state_fast` | `"state_fast"` (explicit) | Same schema, intended cover-free |

Both are registered for the same entity whenever a `TILE_MEDIA` tile
references it (`mqtt_handlers.cpp:1330-1338` for folders, `:1373-1377` for
the screensaver grid). Per the comment at `mqtt_handlers.cpp:1334-1336`:
*"New bridges publish cover-free state changes here first. Keep the normal
state subscription as well for retained full payloads and compatibility with
older bridge versions."* — i.e. a sender may publish lightweight
position/volume ticks to `state_fast` and the full payload (with artwork) to
`state` less often; the firmware treats messages on either topic identically
once received (both route through `tryHandleDynamicSensor` →
`tiles_update_sensor_by_entity`, `mqtt_handlers.cpp:1454-1483`,
`tab_tiles_unified.cpp:2260-2306` → `queue_media_tile_update` →
`update_media_tile_state`, `tile_renderer.cpp:4244-4411`).

Repeated updates coalesce: `queue_media_tile_update`
(`tile_renderer.cpp:4413-4428`) overwrites a still-pending queued payload for
the same tile slot rather than queuing both, and `update_media_tile_state`
hashes the payload and returns immediately on an exact repeat
(`tile_renderer.cpp:4261-4263`). A sender must not assume every published
message is individually rendered — only the latest matters.

### State payload format

JSON object (a bare non-JSON string is also accepted as a last resort and
treated as the literal `state` value only — `tile_renderer.cpp:4300-4303`).
All extraction goes through small hand-rolled scanners
(`extract_json_*_field_cstr`, `tile_renderer.cpp:818-912`) with one uniform
rule that answers the "absent vs null vs zero" question for every key below:
**a JSON `null` value and a missing key are indistinguishable to the
firmware.** `valueOffset()` (`src/core/json_scan.h:33-60`) locates `"key":`
and returns the offset right after it regardless of what follows; but the
string/number/bool extractors then require that following text to actually
look like a quoted string / numeric literal / `true`/`false` — `null` matches
none of those, so `extract_json_string_field_cstr`, `extract_json_number_field_cstr`
and `extract_json_bool_field_cstr` all return `false` for `null` exactly as
they do when the key is absent entirely. An explicit empty string
(`"key":""`) is different: `stringSpan` (`json_scan.h:64-87`) matches it and
returns `true` with an empty result — so `""` is distinguishable from
absent/`null` for string fields, but `null` is not.

> **CORRECTION (2026-09-23, verified against firmware source): the rule above
> is WRONG for `extract_json_string_field_cstr`.** That reader
> (`tile_renderer.cpp:818-835`) does not go through `stringSpan`. It finds
> `"key"`, then the colon, then does `strchr(colon, '"')` — the **next quote
> anywhere after the colon**, without checking that the value itself starts
> with one. So for `"media_title":null,"media_artist":"X"` it returns the
> string `media_artist` as the title. A `null` string value is therefore
> **not** absent: it yields the following quoted token, typically the next
> key's name. This is the same hazard documented for climate in
> `contract-climate-cover.md`.
>
> Readers built on `hometiles_json::stringSpan` (`json_scan.h:64-87`) — such
> as `media_artwork::read_string` below — may behave as described above;
> that has NOT been re-verified per field.
>
> **Policy for every sender, regardless of reader: never send `null` for a
> string field. Omit the key** (or send `""` where the contract says an empty
> string clears a value). The number and bool extractors are not affected by
> this finding. Found by the Task 9 implementer during execution.

| Key | Type | Absent/`null` means | Notes |
| --- | --- | --- | --- |
| `state` | string | Empty string internally | See state handling below |
| `media_title` | string | No title | `tile_renderer.cpp:4284` |
| `media_artist`, `media_album_name`, `app_name`, `source`, `media_channel` | string | No candidate | First non-empty of artist/album/app/source used as subtitle; `media_channel` substitutes for title only (`tile_renderer.cpp:4285-4289,4334,4339`) |
| `volume_level`, fallback `volume` | number 0–1 (or 0–100, auto-divided if `>1 and <=100`) | Volume UI hidden/ignored, **not shown as 0** — tracked via a separate `has_volume_level` flag | `tile_renderer.cpp:4290-4293,4319-4327` |
| `media_position`, `media_duration` | number, seconds | Seek bar hidden entirely unless **both** are present **and** `media_duration>0` | `tile_renderer.cpp:4294-4295,4329-4332` |
| `is_volume_muted`, fallback `muted` | bool | Existing mute display is **left unchanged**, not reset to unmuted | `tile_renderer.cpp:4296-4299,4328` — `if (has_muted) widgets.media_is_muted = is_muted;` |
| `entity_picture`, fallback `media_image_url` | string URL | See artwork below | `tile_renderer.cpp:4396-4398` |
| `entity_picture_data` | string (inline image bytes) | See artwork below | `tile_renderer.cpp:4399,4403-4404` |

Position is **not** live-ticked from repeated payloads: the firmware stamps
its own receipt time (`media_position_received_ms = millis()`,
`tile_renderer.cpp:4332`) and extrapolates locally while `state=="playing"`
(`media_popup.cpp:289-296`). One update establishes an anchor; a sender does
not need to republish every second.

#### `state` handling and icon mapping

`state` is trimmed and lower-cased before comparison
(`tile_renderer.cpp:2904-2914,2954-2960`). Only five values get a distinct
localized placeholder label when there is no title/channel text to show
instead: `playing`, `paused`, `idle`, `standby`, `off`
(`media_empty_title_label`, `tile_renderer.cpp:2904-2914`) — **every other
value, including `"unavailable"`, `"unknown"`, and empty, falls through to
the same generic "no playback" label** (`tr.media_no_playback`). The
play/pause icon glyph is even coarser: it shows the "pause" icon only when
`state=="playing"`, and the "play" icon for literally everything else —
paused, idle, off, unavailable, unknown are all visually identical here
(`media_icon_for_state`, `tile_renderer.cpp:2954-2960`). An exhaustive grep
of `media_popup.cpp`/`renderer.cpp`/`tile_renderer.cpp` found no code path
that special-cases `"unavailable"` or `"unknown"` for media beyond this
generic fallback (contrast with sensor/switch/climate tiles elsewhere in the
same file, which do have explicit `"unavailable"` branches).

#### Artwork (including the `state_fast` distinction)

Cover art is only touched when `media_artwork::has_fields()`
(`src/types/media/artwork_payload.h:8-13`) reports that the payload contains
at least one of `entity_picture_data`, `entity_picture`, or
`media_image_url` **as a key**, regardless of that key's value
(`valueOffset` only checks the key exists). This is the mechanism that makes
`state_fast` safe to send without a cover: a payload that omits all three
keys leaves the currently-displayed cover completely untouched
(`tile_renderer.cpp:4349-4351,4393`: *"Artwork is independent of
title/state. Lightweight payloads omit it; explicit empty/null fields clear
it, and URL changes must always apply."*).

- If `entity_picture_data` (assumed base64-encoded inline image) is a
  non-empty string, it is decoded directly and wins over any URL
  (`tile_renderer.cpp:4403-4404`).
- Otherwise `entity_picture` is used; if absent, `media_image_url` is tried
  (`tile_renderer.cpp:4396-4398`).
- Reading any of these three via `media_artwork::read_string`
  (`artwork_payload.h:15-22`, built on `hometiles_json::stringSpan`) fails
  for `null` (not quoted) exactly like an absent key, per the general
  null-vs-absent rule above, leaving that variable as an empty `String`.
  (This relies on `stringSpan`, not on `extract_json_string_field_cstr`; see
  the CORRECTION above. Do not send `null` for these keys either.)
  Concretely: `"entity_picture":null` and `"entity_picture":""` both end up
  calling `update_media_cover(...,"")` — i.e. both **clear** the cover — the
  only way to leave the cover alone is to omit all three keys from the
  payload entirely.
- Purely receiver-side (a sender does not need to replicate this): the
  panel's own entity cache (used for cold-tile catch-up on grid
  reload/reboot, not the live render path) splices a previous
  `entity_picture_data` block back into a newer cover-free payload so a
  fast/lightweight update never blanks a cached cover in that cache
  (`merge_cached_cover_fields`, `tab_tiles_unified.cpp:391-416`, used by
  `cache_entity_payload_at` at `:418-449`).

### Outbound commands

All media commands publish to **one shared topic**, differentiated only by
the `entity_id` field in the JSON body — there is no per-entity command
topic:

`<device_base>/cmnd/media` — default `hometiles/cmnd/media`
(`mqtt_topics.cpp:12`: `{MEDIA_CMND, Command, "media"}` → `command_root_ + "media"`).

All four publish functions require `networkManager.isMqttConnected()` and a
non-empty `entity_id` and topic, else they log to `Serial` and drop the call
silently (no MQTT traffic at all, no UI error). All four use
`mqttEnqueuePublishPriority` (jumps the outbound queue ahead of
normal-priority publishes such as the weather request above).

> **NOTE (2026-09-23, verified):** `mqttPublishMediaMute` is declared (`mqtt_handlers.h:24`) and defined (`mqtt_handlers.cpp:2098`) but has **no caller** anywhere in the firmware, so no panel ever sends `volume_mute`. The mute icon instead sends `volume_set` with 0 to mute and the last level to unmute. Found during Task 10.

| Action | Function | Payload | Source |
| --- | --- | --- | --- |
| Generic transport command | `mqttPublishMediaCommand(entity_id, command)` | `{"entity_id":"<id>","command":"<command>"}`; `command` defaults to `"play_pause"` if null/empty | `mqtt_handlers.cpp:2020-2040` |
| Seek | `mqttPublishMediaSeek(entity_id, position_seconds)` | `{"entity_id":"<id>","command":"media_seek","seek_position":<1 decimal>}`; negative clamped to `0` | `mqtt_handlers.cpp:2042-2068` |
| Volume | `mqttPublishMediaVolume(entity_id, volume_level)` | `{"entity_id":"<id>","command":"volume_set","volume_level":<0–1, 3 decimals>}`; clamped to `[0,1]` | `mqtt_handlers.cpp:2070-2096` |
| Mute | `mqttPublishMediaMute(entity_id, muted)` | `{"entity_id":"<id>","command":"volume_mute","is_volume_muted":true\|false}` | `mqtt_handlers.cpp:2098-2122` |

The **generic command vocabulary the UI actually sends** is exactly three
literal strings, wired to the tile's and the popup's transport buttons:
`"previous"`, `"play_pause"`, `"next"` (`media_popup.cpp:774-794`,
`types/media/renderer.cpp:478-498`). **No control anywhere in this firmware
sends `"media_stop"` or any `stop` command** — a targeted grep for
`stop`/`media_stop`/`next_track`/`previous_track` across the media popup and
both media renderers returned zero hits. `mqttPublishMediaCommand` would
forward such a string unchanged if something called it, but nothing does.
`play_pause` also updates the button icon optimistically before the MQTT
round-trip completes (`media_popup.cpp:454-467`); HA/the sender remains
authoritative and the next state message corrects it if the actual command
failed.

---

## weather

### Inbound answer topic

`<ha_prefix>/weather/<object_id>/weather` — see "Answer to the
weather-response question" above for the full trace. Registered per entity
by `rebuildDynamicWeatherRoutes()` whenever a `TILE_WEATHER` tile references
it (`mqtt_handlers.cpp:1407-1452`).

### Outbound request

`tab5_lvgl/config/<deviceId>/weather/request` — fixed literal namespace, see
topic construction table above. Payload `{"entity_id":"<id>"}`
(`mqtt_handlers.cpp:2515-2529`). Sent only as a cold-cache bootstrap from the
popup; see the trace above for exactly when.

The adapter subscribes this topic per panel. It answers `{"entity_id":"weather.x"}`, for a weather entity it
pushed to that panel, by publishing that entity's payload again, retained, on
`<ha_prefix>/weather/<object_id>/weather`. There is no response topic.

It ignores malformed JSON, any other id, and a repeat within 1 s of the last answer
(`src/runtime/panel-session.ts`). The Bridge, given no `entity_id`, re-publishes every weather entity
(`__init__.py:2991-2995`); the adapter ignores such a request.

### Current-conditions payload

Parsed independently by the compact tile (`update_weather_tile_state`, `tile_renderer.cpp:2530-2649`) and the
popup header (`apply_weather_header`, `weather_popup.cpp:2493-2586`). Every lookup is a first-substring match of
`"key"` over the WHOLE payload, `forecast` entries and string values included (`json_scan.h:41-47`,
`tile_renderer.cpp:804-805`), followed by the value after the next colon. The tile's string reader treats `""`
as absent (`tile_renderer.cpp:813-815`). The popup's (`json_scan.h:64-87`) returns `""` as present. Both render
it as no value.

| Key | Type | Absent means | `""` means |
| --- | --- | --- | --- |
| `state`, `condition` | string | With no `forecast`: no condition text and no derived icon. With a `forecast`: day 0's `condition` is read as the current one (tile `:2552-2554`, popup `:1046-1049`). | No text and no icon on both (`i18n.cpp:1732`; tile `:2588-2593`; popup `:1054-1059`, `:2542-2543`). |
| `icon` | string | The icon comes from the current condition, unless any `forecast` entry has `icon`: that one is then read as the current icon. | — |
| `temperature` | number or numeric string (comma decimal tolerated) | With no `forecast`: `--`, never 0. With a `forecast`: day 0's `temperature`, its HIGH, is shown as the current temperature. | `--` on both (`json_scan.h:124-133`; tile `:924-936`, `:2600`; popup `:480-491`, `:2546`). |
| `temperature_unit`, or `units.temperature` (the object is preferred when present) | string | Tile header: no unit. Popup header: the previous payload's unit (`:2515-2516`). Forecast columns on both: `°C` (`tile_renderer.cpp:961-963`, `weather_popup.cpp:537-542`). | — |
| `precipitation_unit`, or `units.precipitation` | string | Popup: the previous payload's unit, else `mm` (`:2517-2522`). The tile does not read it. | — |
| `name` | string | The tile's own title always wins. `name` is read only when that title is empty (popup: or `--`). With neither, `--` is shown (tile `:2636-2647`, popup `:2571-2582`). | — |

Sender rule:

- Put every current key before `forecast`.
- While a `forecast` follows, always send `state`, `condition` and `temperature`, as `""` when unknown.
- Send no `icon` and no `units` object anywhere. A `units` object's `temperature` is found by the
  current-temperature lookup when it precedes the top-level key.

**Key-priority asymmetry (verified, not a guess):** the compact tile tries
`state` **before** `condition` (`tile_renderer.cpp:2552-2554`), while the
popup's `resolve_weather_visual_fields` tries `condition`, then a short key
`"c"`, then `icon`-from-condition, and only falls back to `state` last
(`weather_popup.cpp:1040-1060`). A dead-code function
`extract_weather_condition_field` (`weather_popup.cpp:1027-1032`, `state`
before `condition` before `"c"`) exists but is never called from anywhere in
the file — ignore it.

Send the same value in `state` and `condition`, both before `forecast`.

- The popup's strict reader counts `"condition":""` as present, so it skips `c`, and then falls back to `state`
  (`weather_popup.cpp:1054-1059`).
- The tile's lenient reader skips an empty `state` and reads `condition` (`tile_renderer.cpp:2552-2554`).

Canonical condition strings recognized by `weather_icon_from_condition`
(`weather_popup.cpp:1004-1024`), 15 values, matching the array size declared
at `src/core/i18n/i18n.h:480` (`weather_conditions[15]`): `clear-night`,
`cloudy`, `exceptional`, `fog`, `hail`, `lightning`, `lightning-rainy`,
`partlycloudy`, `pouring`, `rainy`, `snowy`, `snowy-rainy`, `sunny`, `windy`,
`windy-variant`. These match Home Assistant's own weather condition enum. An
unrecognized condition string still displays as text (via
`i18n::weather_condition_label`) but resolves to no icon unless an explicit
`icon` key is also given.

A forecast entry's condition text is never displayed. Each day keeps only the icon of one of the 15 conditions
(`tile_renderer.cpp:2692`, `:2702-2704`; `ForecastData`, `weather_popup.cpp:223-236`). So the adapter sends a
day's `condition` only when it is one of the 15, and no day text at all: a `]` in one would cut the tile's
array (see below), and a text equal to a key such as `templow` would capture that day's lookup.

### Daily forecast (`forecast` array)

Present on both the tile (up to `WEATHER_FORECAST_MAX=8` slots,
`types/weather/widgets.h:19`, visible count via `weather_forecast_count(span_w)`:
span 1→1, 2→2, 3→4, 4→5, 5→6, ≥6→8 days, `widgets.h:28-39`) and the popup
(fixed `kCols=7`, `weather_popup.cpp:36`). Parsing:
`tile_renderer.cpp:2651-2734` (tile), `weather_popup.cpp:2602-2696` (popup).

The two readers differ:

- The tile ends the array at the first `]` after `"forecast"`, even inside a string (`tile_renderer.cpp:846-857`).
  A `]` in any entry's text therefore drops that day and every later day from the tile.
- The popup walks the array string-aware (`json_scan.h:139-168`, from `weather_popup.cpp:2602-2615`) and reads
  at most `kCols`=7 entries (`:2614`).
- The tile's fallback slot skips slots with `has_data` (`tile_renderer.cpp:2717`). The popup's skips slots that
  have a `date_local` (`weather_popup.cpp:2662`).

An entry's keys are read from that entry's own substring (`tile_renderer.cpp:2679`, `weather_popup.cpp:1269`),
so an entry may omit any key.

Per-entry keys:

| Key | Type | Notes |
| --- | --- | --- |
| `temperature` | number/numeric-string | Day's **high** |
| `templow`, else `temperature_low`, else `temp_low`, else `low` | number/numeric-string | First present wins; day's **low** |
| `condition`, `icon` | string | Same fallback rule as current conditions |
| `datetime` (ISO 8601) and/or `date_local` (`YYYY-MM-DD`) | string | `date_local` sets the slot, and in the popup also the weekday (`weather_popup.cpp:2639-2645`). The tile takes the weekday label from `datetime` whenever `datetime` is present (`tile_renderer.cpp:2696-2697`, used at `:2746-2753`), so a UTC `datetime` can label a day with the previous weekday. Send `date_local` only, as a `YYYY-MM-DD` date in the panel's zone. |
| `precipitation`, `precipitation_probability` | number/numeric-string | Popup-only (7-day precip bars); the compact tile does not read these |

**Day-slot assignment is date-based, not positional.** Each entry's date is
compared against the device's own local "today" date to compute a day
offset (`iso_date_day_offset`), and the entry is placed into that offset's
slot (0 = today) — entries can arrive in any order. An entry whose date is
missing or does not resolve to a valid in-range offset is instead placed
into the first still-empty slot in **arrival order**
(`tile_renderer.cpp:2709-2721`, `weather_popup.cpp:2654-2668`).

Undated entries fill the slots from the left. With a set clock, slot i is labelled today+i
(`tile_renderer.cpp:2741-2753`, `weather_popup.cpp:2686-2695`). So an undated list whose first entry is tomorrow
shows tomorrow as today.

A dated entry for a past day, or for a day beyond the visible columns, is not dropped. It takes the first free
slot, and the tile always labels slot 0 "today" (`tile_renderer.cpp:2710-2721`, `:2747-2748`).

A mixed set misorders, so the adapter dates every entry or none (Ruling 74). `date_local` must be in the panel's
zone. The adapter uses the ioBroker host's zone, so the host's `TZ` must be the panels' zone.

**Time zone (known limitation, review M3).** The adapter converts each dated instant — DasWetter's UTC
midnight, AccuWeather's offset time, OpenWeatherMap's epoch milliseconds — to a `YYYY-MM-DD` in the ioBroker
host's own zone, and the panel places that date against its own local today. The two must be the same zone. A
host with no `TZ` set (for example a container running in UTC) serving panels in Berlin sends the 24th's
DasWetter forecast (`2026-09-23T22:00:00.000Z`) as `2026-09-23`, and the panel shows it under today: the whole
row shifts left by one day.

**OpenWeatherMap's dates (Ruling 79(a)).** ioBroker.openweathermap 2.0.0 gives each forecast day three states of
role `date.forecast.N`: the epoch-ms number `date`, and the weekday names `day` and `day_short`
(`io-package.json` instanceObjects). The type-detector's `DATE` takes a string only, so it binds a weekday name,
which is no date. Discovery therefore dates each day by the number beside it (same parent, same role), and the
adapter sends it as `date_local`. After today's last 3-hour slot, the adapter's day 0 is tomorrow, and it is
now placed under tomorrow instead of today.

**Aggregation the firmware expects the sender to have already done:** the
parser has no concept of a forecast "type" (`daily` vs `hourly` vs
`twice_daily`, the three values Home Assistant's own
`weather.get_forecasts` service can return) — it takes whatever
`temperature`/`templow` numbers are in each `forecast` array entry at face
value for that day's slot. Per `PROJECT_CONTEXT.md:71` and the firmware's
own release notes (`docs/releases/v0.6.12.md:9`: *"Preserved the weather
provider's daily minimum and maximum when hourly data covers only part of
the day. Partial hourly forecasts no longer replace the full-day temperature
labels."*; also `docs/index.md:123`), this is a real regression class the
Bridge (the sender) had to fix on **its own** side — the firmware itself
does no min/max aggregation. A sender publishing raw partial-day/hourly
values into the `forecast` array instead of pre-aggregated full-day extrema
will make the tile display a partial reading as if it were the day's true
high/low.

The adapter sends each provider's own daily maximum and minimum unchanged (Ruling 72). ioBroker.openweathermap
2.0.0 builds day 0 from today's remaining 3-hour slots only (`build/main.js:216-239`, `:331-360`). Its day-0
high and low are therefore partial later in the day, which is the symptom described above. The adapter cannot
correct it.

**Known limitation (Ruling 79(b)).** OpenWeatherMap's day 0 covers only the rest of today, and the panel shows
it as given. At 20:00, when today's remaining slots are 14 °C and 11 °C, the panel shows today as 14°/11° on a
day whose high was 24 °C. This is the provider's own definition of day 0 (its own VIS widgets show the same).
The adapter neither fills it from the current reading nor aggregates hours.

### Hourly forecast (`forecast_hourly` array, popup only)

Grep-verified: `forecast_hourly` is read **only** by the weather popup
(`weather_popup.cpp:2699-2701`); the compact grid tile never looks for it.
Used for the popup's per-hour precipitation/temperature detail view
(`docs/tiles.md:66`: "hourly bars for the day and daily bars for the week").

Up to `kHourlyForecastMax=168` entries (7×24h, `weather_popup.cpp:39`) are
accepted **on every device profile** — `kHourlyParseBatchSize` and
`kHourlyInputObjectLimit` are both `0` off the `DEVICE_ESP32_S3_RGB_480`
build (`weather_popup.cpp:43-45`), which disables both the per-call batch
cap and the total-objects-scanned cap in `parse_weather_hourly_batch`
(`:2761-2784`), so a non-S3 panel parses the whole array in one pass; on the
S3 build the same 168-entry result is reached in bounded 12-object chunks
spread across multiple UI-loop iterations purely for frame-rate
responsiveness (`weather_popup.cpp:4241`). This is a parsing-schedule
difference only, **not** a wire-contract difference — do not trim the array
below, and there is no benefit sending more than, 168 entries.

Per-entry keys, each with a short single/double-letter alias (payload-size
optimization for up to 168 entries) — `parse_hourly_weather_object`,
`weather_popup.cpp:2704-2758`:

| Full key | Short alias | Type |
| --- | --- | --- |
| `datetime` or `date_local` | `d` | string |
| `hour_local` | `h` | number, local hour 0–23 |
| `temperature` | `t` | number/numeric-string |
| `precipitation` | `p` | number/numeric-string |
| `precipitation_probability` | `pp` | number/numeric-string |
| `condition` / `icon` | — (no alias) | string, same fallback rule as current conditions |

An entry with no resolvable date **and** hour (neither the long nor short
key present) is discarded entirely and does not count toward the 168 cap
(`weather_popup.cpp:2736`: `if (!h_date_local.length() || h_hour_local < 0.0f) return false;`).

---

## Cross-cutting notes (both domains)

- **Flat-JSON assumption.** All extraction (`json_scan.h`, the
  `extract_json_*` families) is plain substring/offset scanning, not a real
  parser. The header comment (`json_scan.h:29-32`) assumes flat payloads. Weather is not flat and cannot be:
  each `forecast` entry must carry `temperature`, the only key for the day's high (`tile_renderer.cpp:2686`,
  `weather_popup.cpp:2626`), and `condition`.

  A lookup matches the first `"key"` anywhere, including a nested member or a string VALUE equal to the key, and
  reads past the next colon. The rules that follow:

  - current keys come before `forecast`;
  - use the `""` placeholders from the current-conditions table;
  - send no `icon` and no `units` anywhere;
  - send no string value equal to a key the panel reads. A friendly name `icon` hides the tile's icon, and a name
    `temperature_unit` with no declared unit becomes the tile's unit.

  `\uXXXX`-escaping such a value does not help for weather. Neither reader decodes a condition, and the popup
  decodes only `°`/`°` (to `°`), `\/`, `\"` and `\\`, in `name` and in units
  (`weather_popup.cpp:443-450`).

  The adapter treats a name, or an unmapped current text, equal to any key the panel looks up over the whole
  payload as absent: `state`, `condition`, `c`, `icon`, `i`, `temperature`, `units`, `temperature_unit`,
  `precipitation_unit`, `name`, `forecast` and `forecast_hourly` (tile `tile_renderer.cpp:2552-2570`, `:2641`,
  `:2667`; popup `weather_popup.cpp:1029-1059`, `:2501-2511`, `:2576`, `:2602`, `:2700`), and
  `entity_picture_data`. The entity cache looks that key up in every JSON payload it stores, and appends an old
  payload's tail from it onward to a new payload that lacks it (`tab_tiles_unified.cpp:398-416`, `:435-436`).
  The name is then omitted, so the tile's title or `--` shows. The text follows the `""` rule.
- **No retained-flag awareness.** Confirmed via the PubSubClient callback
  signature (`network_manager.cpp:602`, 3 parameters, no retained flag): the
  firmware cannot tell a retained message from a live one for either domain.
- **`"unavailable"`/`"unknown"` are not special-cased for media_player or
  weather.** An exhaustive grep of every media and weather rendering file
  found zero occurrences of literal `"unavailable"`/`"unknown"` checks in
  those files (contrast: `tile_renderer.cpp` does special-case them at
  lines 1418, 1631, 2294, 4855+ for switch/climate/generic-sensor/editable
  tiles). For media, an `"unavailable"` state falls through to the generic
  "no playback" label exactly like any other unrecognized string. For
  weather, an `"unavailable"`/`"unknown"` `state`/`condition` string is
  displayed as literal (untranslated, since it isn't one of the 15 canonical
  slugs) text with no icon, and `temperature` absence (which is what a real
  HA `unavailable` weather entity would actually produce, since HA drops
  numeric attributes entirely when unavailable) already correctly shows
  `"--"` rather than `0` per the generic absent-number handling above.

  This adapter never sends `unavailable` or `unknown`. An unavailable weather entity goes out as `{"name":…}`
  alone. Both readers render that as `--`, with no icon and no condition text, and the forecast is emptied
  (`tile_renderer.cpp:2663-2669`; `weather_popup.cpp:2599-2603`). The Bridge's `"state":"unavailable"` would show
  the untranslated English word on tiles wider than one column and in the popup header (`i18n.cpp:1744-1748`).

## UNVERIFIED

- **PubSubClient behavior on an oversized incoming packet.** This review
  confirmed the firmware's own post-receive buffer sizes
  (`kMqttBufferNormal`/`kMqttBufferMedia`, 16 KiB/24 KiB) and that the
  firmware's own scratch copy silently truncates at `LARGE_BUF` (32768
  bytes). Whether the vendored PubSubClient library itself drops, truncates,
  or partially delivers a broker packet larger than the currently configured
  client buffer size — before the firmware's callback ever runs — was not
  checked; that logic lives in the PubSubClient library, not in the files
  this task listed as primary sources.
- **Exact ordering of `bridge_apply`/`energy_response` checks relative to
  the dynamic sensor/weather checks** in the main MQTT callback. This
  review directly read and can cite the static `kRoutes` table
  (`mqtt_handlers.cpp:1793-1810`), the `bridge_icons` check
  (`:1779-1791`), the dynamic sensor/weather checks (`:1823-1830`), and the
  `history_response` check (`:1832`) — all in that relative order — but did
  not locate and read the exact line of the `bridge_apply` comparison
  (referenced indirectly via surrounding log text at `:1774`) or the
  `energy_response` comparison. This does not affect the media/weather
  contract itself since topic names never collide across these checks, but
  is flagged for completeness since exact dispatch order was not
  independently confirmed end-to-end.

Resolved since (Task 12 review):

- **Retained.** The Bridge publishes weather retained (`__init__.py:3833-3843`; the callers at `:1745`, `:2988`
  and `:2995` pass `retain=True`, and `:3801` uses the default `True`).
- **Duplicate keys.** `valueOffset` takes the first match anywhere, values included. See the flat-JSON note
  under "Cross-cutting notes".
