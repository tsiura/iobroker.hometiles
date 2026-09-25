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

## What the panel can parse (Task 21 fix round 1, Rulings 109-112)

- **Only read fields are sent (R109).** sensor_meta: entity_id, name, unit,
  value, state_kind, icon (:1209-1236); binary_sensor_meta: entity_id, name,
  device_class, state, available, last_changed, icon (:1259-1313);
  light/switch/scene_meta: entity_id and icon only, entities without one left
  out (:1388-1390).
- **Icons are MDI names or nothing (R110):** `mdi:` + `[a-z0-9-]+`, any
  case. Anything else is stored verbatim and drawn as the "?" glyph 0xF02D8
  in place of the tile's icon, on a cover in place of its open/closed icon
  (`mdi_icons.cpp:7549`, `cover/renderer.cpp:304-311`).
- **`bridge/icons` is a flat map** `{"<entity_id>":"<icon>"}`, one pair per
  entity (`applyIconUpdate` :743-771); `""` removes the icon the panel holds
  (:757-762). A wrapped `{"icons":{...}}` is ignored.
- **Zero icons:** an apply that carries no icon at all keeps the panel's
  whole map (:663-665), and an empty map `{}` or empty section clears
  nothing. Only a `""` pair does, so the adapter sends every entity it
  publishes, `""` where it has no MDI icon: its own entities lose a stale
  icon on the next push or reconnect, no reboot needed. An icon held for an
  id the adapter does not publish (a removed device, an HA leftover) stays
  until the panel reboots (the map is RAM only).
- **`bridge/icons` is cut at 32767 bytes too (R114):** the panel copies it
  into its own 32768-byte buffer and cuts it without a log
  (`mqtt_handlers.cpp:1496`, `:1779-1785`); the cut map fails to parse and
  none of it is applied (`ha_bridge_config.cpp:736-737`). Over the limit the
  adapter drops the `""` entries first and publishes the MDI ones: **a
  degraded map leaves the dropped entities' stale icons until a panel
  reboot.** Over the limit even then -- possible only through the icons of
  numbers, selects and datetimes past the 128th, which are in the map but not
  in the apply -- it publishes no map and logs an error; the apply still goes
  out. A map that fits again is published.
- **Free text (R112):** in names, units and values, `[ ] { }` become `( )`,
  `"` becomes `'`, control characters a space. sensor_meta and
  binary_sensor_meta end at the first `]` (:1198, :1246), a sensor_meta entry
  at the first `}` (:1205); `extractStringField` ends a value at the first `"`
  (:1073-1077); every map is a blob of `id=text` lines, first line wins
  (:1627-1660). Entity ids and scene_map aliases are never rewritten: a
  changed alias clears the panel's scene slots and saves that (:693-699).
- **At most 128 numbers, selects and datetimes (R111)**, the first by entity
  id: the panel keeps no more values (:1781-1786).

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

`weather/request` has no matching response topic: of these config-plane
topics the firmware subscribes to `bridge_apply_topic_`,
`history_response_topic_`, `energy_response_topic_` and `bridge_icons_topic_`.
Weather is not answered through `bridge/apply`: a panel reads each weather
entity's payload on its weather leaf, `<ha_prefix>/weather/<object_id>/weather`,
and a `weather/request` is answered by publishing that payload there again,
retained ([contract-media-weather.md](contract-media-weather.md),
[protocol.md](protocol.md#weather)).

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
