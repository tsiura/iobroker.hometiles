# Verified firmware contract for the v0.2 domains

Read out of HomeTiles v0.6.12 source on 2026-09-22. Line references are to
that tree. Nothing here is inferred from the Bridge's Python.

## Entity list arrays in `bridge/apply`

`HaBridgeConfig::applyJson` (`src/network/bridge/ha_bridge_config.cpp:543`)
pulls each of these with `parseArraySection`:

    sensors  configured_sensors  numbers  selects  datetimes
    binary_sensors  weathers  lights  switches  media_players
    climates  covers  cameras

`scene_map` (stored as the scene alias list) uses `parseObjectSection`.

**ADDED 2026-09-24 (Task 21):** each section is found at the FIRST occurrence
of its quoted key, then the first `[` and the first `]` after it (:426-450,
:567-636), so a free-text value spelling a key earlier in the payload shadows
it. A list whose key is absent is KEPT (numbers/selects/datetimes :581-587,
weathers, lights, switches, climates, covers, binary_sensors, sensors), except
`media_players` and `cameras`, which are CLEARED absent or empty (:614-619,
:631-636). Every number, select and datetime listed gets a `control`
subscription whether or not a tile uses it (`mqtt_handlers.cpp:1306-1314`).

**Size (Task 21, Ruling 108):** the panel copies the payload into a
32768-byte buffer and cuts anything longer to 32767 bytes, then applies the
cut text (`mqtt_handlers.cpp:1497`, `:1729-1742`). Reception is not the
limit: it grows for any PUBLISH up to 65535 bytes (`mqtt_packet_safety.h:13`,
`PubSubClient.cpp:397-413`). The Bridge has no limit (`__init__.py:1497-1510`).

## The `*_meta` sections are name/icon maps, not state

This is the single most important finding, and it contradicts the obvious
assumption. `media_player_meta`, `climate_meta`, `cover_meta`, `camera_meta`
and `editable_meta` are each fed to:

    parseEntityNameSection(json, "<key>", merged.sensor_names_map);

All five merge into **one shared** `sensor_names_map`. Actual state travels on
`state/<domain>/<entity>`.

**CORRECTED 2026-09-24 (Task 21):** they are not name-only. `parseIconMetaSections`
(:1382-1394) reads `icon` from these same sections and from `sensor_meta`,
`binary_sensor_meta`, `weather_meta`, `light_meta`, `switch_meta` and
`scene_meta`. `weather_meta` is icon-only (weather names come from the weather
payload); `light_meta`, `switch_meta` and `scene_meta` are read for icons and
nothing else. There is no `number_meta`: `editable_meta` covers all three.

Consequence: adding a domain does not need a bespoke meta parser on the
firmware side. It needs the entity id in the right array, a name and icon in
the matching `*_meta`, and state on the state topic.

## Extra topics beyond state/cmnd

**CORRECTED 2026-09-22:** these are NOT built from the user-configured base
topic. `network_manager.cpp:585-587` hardcodes the root:

```cpp
String base = "tab5_lvgl/config/";
base += did;                                  // eFuse MAC-derived device id
bridge_apply_topic_ = base + "/bridge/apply";
```

So the config-plane topics live under `tab5_lvgl/config/<deviceId>/`,
independent of `baseTopic` and `haPrefix`. v0.1 already implements this
correctly via `CONFIG_TOPIC_ROOT` in `src/protocol/topics.ts`; only this note
was wrong. Built in `network_manager.cpp:585-593`:

    <base>/bridge/apply
    <base>/history/request     <base>/history/response
    <base>/weather/request
    <base>/energy/request      <base>/energy/response

`weather/request` has no matching response topic: the firmware subscribes only
to `bridge_apply_topic_`, `history_response_topic_`, `energy_response_topic_`
and `bridge_icons_topic_`. Weather answers therefore arrive through
`bridge/apply`, not a dedicated response topic. Confirm before implementing.

## Service names the firmware emits

Cover: `open_cover` `stop_cover` `set_cover_position` `open_cover_tilt`
`stop_cover_tilt` `toggle_cover_tilt` `set_cover_tilt_position`
Climate: `set_fan_mode` `set_swing_mode`, with `swing_mode` and
`swing_horizontal_mode` as distinct channels.
Media: `play_pause` among the transport commands.

These are Home Assistant service names carried in the command payload, so the
adapter maps service name to ioBroker channel write, exactly as v0.1 does for
light and switch.

## Still to verify before coding each domain

- payload shape per domain (bare string vs JSON) — v0.1 learned the hard way
  that this differs per domain and a wrong guess is silent
- history request/response payload schema, including the `day` / `week` ranges
- ~~energy request/response schema and the keys `parseEnergySection` reads~~
  **CORRECTED 2026-09-22:** `parseEnergySection`
  (`ha_bridge_config.cpp:1108`) is *not* the energy/response handler. It
  parses an unrelated entity-catalog array inside the `bridge/apply`
  config-sync payload. The energy response is a separate contract; see
  `docs/contract-history-energy.md`. Treating these as one thing would
  misroute the whole implementation.
- ~~whether `numbers`, `selects` and `datetimes` share one `editable_meta` or
  need separate name entries~~ one shared `editable_meta` (:661, :1386)
