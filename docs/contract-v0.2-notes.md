# Verified firmware contract for the v0.2 domains

Read out of HomeTiles v0.6.12 source on 2026-09-22. Line references are to
that tree. Nothing here is inferred from the Bridge's Python.

## Entity list arrays in `bridge/apply`

`HaBridgeConfig::applyJson` (`src/network/bridge/ha_bridge_config.cpp:543`)
pulls each of these with `parseArraySection`:

    sensors  configured_sensors  numbers  selects  datetimes
    binary_sensors  weathers  lights  switches  media_players
    climates  covers  cameras

`scene_alias` uses `parseObjectSection`.

## The `*_meta` sections are name/icon maps, not state

This is the single most important finding, and it contradicts the obvious
assumption. `media_player_meta`, `climate_meta`, `cover_meta`, `camera_meta`
and `editable_meta` are each fed to:

    parseEntityNameSection(json, "<key>", merged.sensor_names_map);

All five merge into **one shared** `sensor_names_map`. They carry the display
name per entity id and nothing else. Icons come separately via
`parseIconMetaSections`. Actual state travels on `state/<domain>/<entity>`.

Consequence: adding a domain does not need a bespoke meta parser on the
firmware side. It needs the entity id in the right array, a name in the
matching `*_meta`, and state on the state topic.

## Extra topics beyond state/cmnd

Built in `network_manager.cpp:587-593` from the configured base topic:

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
- energy request/response schema and the `grid`/`solar`/`battery`/`gas`/
  `water`/`_cost` keys `parseEnergySection` reads
  (`ha_bridge_config.cpp:1108`)
- whether `numbers`, `selects` and `datetimes` share one `editable_meta` or
  need separate name entries
