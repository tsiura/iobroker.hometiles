# HomeTiles MQTT contract

This document records the wire contract of the HomeTiles firmware that this
adapter implements, and what the adapter sends and accepts on each topic. The
firmware is the fixed side: it is never modified for this project. Every
firmware fact here was read out of the firmware source, not inferred from its
documentation, and nothing here has been checked against a physical panel.

Firmware reference:

- Everything added in 0.2.0 (climate, cover, media player, weather, number,
  select, date/time, history, energy, the icon map, and the apply's new
  sections): HomeTiles v0.6.12, commit `5d25167`. The evidence, with
  `file:line` citations into the firmware and the HomeTiles Bridge, is in the
  contract documents below. This document summarises them and says what the
  adapter does.
- The v0.1 sections (announcement, refresh, sensor, binary sensor, switch,
  light, scene, panel settings, local I/O): first read at v0.6.9, in files
  that have since moved to `src/network/mqtt/` and `src/network/bridge/`. The
  parts of them 0.2.0 touched (the apply, the icon map, the retain flag of
  commands) were read again at v0.6.12.

| Document | Covers |
| --- | --- |
| [contract-climate-cover.md](contract-climate-cover.md) | climate, cover |
| [contract-media-weather.md](contract-media-weather.md) | media player, weather, the weather request |
| [contract-editable.md](contract-editable.md) | number, select, date/time: `/control`, `cmnd/value`, `stat/value` |
| [contract-history-energy.md](contract-history-energy.md) | history and energy requests and responses |
| [contract-v0.2-notes.md](contract-v0.2-notes.md) | the lists, meta sections, icon map and size limits of `bridge/apply` |
| [contract-iobroker-types.md](contract-iobroker-types.md) | which ioBroker type-detector types become which domain |
| [contract-iobroker-history.md](contract-iobroker-history.md) | how history is read from a history, SQL or InfluxDB instance |

Where a contract document and this summary disagree, the contract document
holds the evidence and this summary is the one to fix.

Two asymmetries cause most mistakes:

- **The payload shape is per domain.** `sensor`, `binary_sensor` and `switch`
  carry a bare string; `light`, `climate`, `cover`, `media_player` and
  `weather` a JSON object; `number`, `select` and `datetime` a JSON object in
  the `/control` schema; `scene` carries nothing.
- **The last topic segment is per domain.** It is `state`, except `weather`
  for weather and `control` for number, select and date/time.

## Topic map

Three topic families, each under its own root:

| Family | Root | Where it comes from |
| --- | --- | --- |
| Config plane | `tab5_lvgl/config/<deviceId>` | Hard-coded in the firmware. `<deviceId>` is the panel's 12 hex digit id, built from its eFuse MAC. Ignores the base topic and the entity prefix. |
| Commands and panel status | `<baseTopic>` | The panel's device topic base, default `hometiles`. Unique per panel. |
| Entity state | `<haPrefix>` | The panel's entity state prefix, default `ha/statestream`. The same on every panel. |

The adapter takes each panel's `baseTopic` and `haPrefix` from that panel's
announcement. The Connection tab's values are what pairing writes into a
panel, and what the admin's preview shows.

| Topic | From | Retained | Payload | Section |
| --- | --- | --- | --- | --- |
| `tab5_lvgl/config/<deviceId>/bridge` | panel | yes | announcement, JSON | [Announcement](#announcement) |
| `tab5_lvgl/config/<deviceId>/bridge/request` | panel | no | `force` or empty | [Refresh request](#refresh-request) |
| `tab5_lvgl/config/<deviceId>/bridge/apply` | adapter | yes | configuration, JSON | [Configuration push](#configuration-push-bridgeapply) |
| `tab5_lvgl/config/<deviceId>/bridge/icons` | adapter | yes | icon map, JSON | [Icon map](#icon-map-bridgeicons) |
| `tab5_lvgl/config/<deviceId>/weather/request` | panel | no | `{"entity_id":…}` | [Weather](#weather) |
| `tab5_lvgl/config/<deviceId>/history/request` | panel | no | one of four request shapes | [History](#history) |
| `tab5_lvgl/config/<deviceId>/history/response` | adapter | no | history response | [History](#history) |
| `tab5_lvgl/config/<deviceId>/energy/request` | panel | no | `{"period":…}` | [Energy](#energy) |
| `tab5_lvgl/config/<deviceId>/energy/response` | adapter | no | energy response | [Energy](#energy) |
| `<haPrefix>/<domain>/<object_id>/state` | adapter | yes | per domain | [Entity state](#entity-state) |
| `<haPrefix>/weather/<object_id>/weather` | adapter | yes | weather, JSON | [Weather](#weather) |
| `<haPrefix>/<number\|select\|datetime>/<object_id>/control` | adapter | yes | `/control`, JSON | [Number, select and date/time](#number-select-and-datetime) |
| `<baseTopic>/cmnd/light`, `cmnd/switch`, `cmnd/scene` | panel | no | see [Commands](#commands) | [Commands](#commands) |
| `<baseTopic>/cmnd/climate` | panel | no | JSON with `command` | [Climate](#climate) |
| `<baseTopic>/cmnd/cover` | panel | no | JSON with `command` | [Cover](#cover) |
| `<baseTopic>/cmnd/media` | panel | no | JSON with `command` | [Media player](#media-player) |
| `<baseTopic>/cmnd/value` | panel | no | JSON value command | [Number, select and date/time](#number-select-and-datetime) |
| `<baseTopic>/stat/value` | adapter | no | `{entity_id, id, status}` | [Number, select and date/time](#number-select-and-datetime) |
| `<baseTopic>/stat/*`, `cmnd/*` of the panel settings and local I/O | both | see table | see table | [Panel status and settings](#panel-status-and-settings) |

The adapter ignores a retained message on every command leaf and on the
history and energy request topics: a broker replays a retained message at
every subscription, so it would run again at every reconnect and restart. The
panel retains none of them. It still reads the panel's retained announcement,
`stat/connected` and `stat/ip`.

A panel subscribes to an entity's state topic only while a tile uses that
entity, or, for number, select and date/time, while the apply lists it
([contract-media-weather.md](contract-media-weather.md), "Topic construction
reference"; [contract-editable.md](contract-editable.md) §3). Publishing to an
entity with no tile is harmless: nothing listens.

## The absent-key rule is different in every domain family

The firmware's parsers disagree on what a missing key and a JSON `null` mean.
Carrying one family's rule to another produced four silent defects in v0.1:
no exception, no log, only wrong values on a wall panel. This table is the
rule the adapter follows. The contract documents hold the citations.

| Family | What an omitted key means | What `null` means |
| --- | --- | --- |
| sensor, binary_sensor, switch, light | per field; see [Entity state](#entity-state) | per field; the adapter sends none |
| **climate, cover** | **snaps to a hardcoded default, never "unchanged"**, and clears the field's presence flag: the panel replaces its whole cached state with each valid payload, never merges | safe for cover (same as omitted); **unsafe for climate strings** |
| **media_player** | no value (no title, the volume slider disabled, the seek bar hidden), except that a missing `is_volume_muted` keeps the previous mute display and missing artwork keeps the previous cover, which only `""` clears | **unsafe for strings**: the panel reads the next quoted token after the colon |
| **weather** | while a `forecast` follows, the first forecast day's value is read in its place (the panel takes the first match of a key anywhere in the payload), so unknown current values go out as `""` | **unsafe for strings**, as for media |
| **history responses** (binary/state header: `current`, `available`, `last_changed`, `device_class`) | preserves the popup's value | **explicitly clears** it (`sensor_popup.cpp:1845-1866`) |
| **numeric history responses** | `values` missing drops the whole response | a `null` element is a gap, filled from its neighbours on graphs and sensor popups, drawn as a gap on an editable number's popup |
| **energy responses** | `total` shows 0.000; `cost` absent means no cost | **identical to omitted**: `total.isNull()` is 0.0, and each period's cache is replaced wholesale (`energy_data.cpp:249-255`, Ruling 128) |
| **editable `/control`** | a missing `state` key **rejects the whole message** | `state: null` is valid and renders `--`, but also makes the value unavailable and read-only, so the adapter sends `"unknown"` instead |

For climate and cover this means: publish the **complete set of known
attributes** on every publish, never a diff; and omit what is unknown. An
omitted key clears its presence flag, which is the correct way to say "this
device has no such value". Filling an unknown with the firmware's default
(20.0 for the target temperature) would set that flag and put a fabricated,
commandable value on the panel. Always sending `temperature`, for example,
breaks the dual-setpoint mode, which the popup enters only when a range is
present and a single target is not (`climate_popup.cpp:1169`). The target
setpoint's wire key is `temperature` (`tile_renderer.cpp:2234`), not
`target_temperature`.

Never send `null` for a climate, media or weather string field. Their
hand-rolled string readers do not check that the value starts with a quote:
`{"hvac_mode":null,"hvac_action":"idle"}` reads `hvac_mode` as the text
`hvac_action`. Omit the key instead.

## Announcement

The panel publishes, retained, to `tab5_lvgl/config/{deviceId}/bridge`. Built
by `HaBridgeConfig::buildJsonPayload` in `src/network/ha_bridge_config.cpp`:

```json
{
  "device_id": "a1b2c3d4e5f6",
  "base_topic": "hometiles",
  "ha_prefix": "ha/statestream",
  "device_name": "Waveshare 8\"",
  "manufacturer": "HomeTiles",
  "model": "waveshare_touch_lcd_8",
  "sensors": ["sensor.wohnzimmer_temperatur"],
  "binary_sensors": ["binary_sensor.haustuer"],
  "scene_map": { "gute nacht": "scene.gute_nacht" },
  "local_io": [
    {
      "id": "relay_1",
      "entity_id": "switch.waveshare_8_relay_1",
      "legacy_entity_ids": ["switch.relay_1"],
      "name": "Relay 1",
      "type": "relay"
    }
  ]
}
```

`type` is `relay` or `temperature`. `local_io` is appended by
`HardwareIoManager::appendBridgeJson`. The adapter starts one session per
announced device id and warns when two panels announce the same base topic:
they would share command and status topics.

## Refresh request

The panel publishes to `tab5_lvgl/config/{deviceId}/bridge/request`. Plain
text, not JSON: `force` or the empty string. The adapter answers with a fresh
apply, icon map and every entity state for that panel, whether or not
anything changed, provided it has anything to publish (see the last rule
under [Configuration push](#configuration-push-bridgeapply)). The same
happens when `panels.<deviceId>.control.refresh` is pressed.

## Configuration push (bridge/apply)

The adapter publishes, retained, to
`tab5_lvgl/config/{deviceId}/bridge/apply`. Evidence:
[contract-v0.2-notes.md](contract-v0.2-notes.md); the adapter's builder is
`src/protocol/apply.ts`.

The firmware parses this with **substring scanning, not a JSON parser**
(`HaBridgeConfig::applyJson`). It finds each section at the FIRST occurrence
of its quoted key anywhere in the payload; a list then runs from the first
`[` to the first `]` after it. Exact key spelling matters, and a free-text
value that spells a key ahead of that key's section would shadow it.

The adapter sends, in this order:

1. The entity lists, every one of them, an empty one too: `sensors`,
   `binary_sensors`, `lights`, `switches`, `media_players`, `climates`,
   `covers`, `weathers`, `numbers`, `selects`, `datetimes`. The panel keeps a
   list whose key is absent (all but `media_players`), so an absent key would
   leave stale entities in its pickers. Entity ids hold a dot, so none can
   spell a key.
2. `energy`: the energy meters' catalog (see [Energy](#energy)), sent empty
   without meters: while the key is absent the panel keeps an old energy
   configuration, for example one from the Home Assistant Bridge.
3. `scene_map`: the panel's scene aliases, lowercased, each with its scene
   entity id.
4. The metadata sections, which carry names and icons, never state:

   | Section | Entry keys |
   | --- | --- |
   | `sensor_meta` | `entity_id`, `name`, `unit` (`""` when none), `value` (the value shown until a state arrives), `state_kind`, `icon` |
   | `binary_sensor_meta` | `entity_id`, `name`, `device_class` (`""` when none), `state`, `available`, `last_changed` (epoch seconds, omitted when never observed), `icon` |
   | `light_meta`, `switch_meta`, `scene_meta` | `entity_id`, `icon`: read for icons alone, so only entities with an MDI icon are listed |
   | `media_player_meta`, `climate_meta`, `cover_meta`, `weather_meta`, `editable_meta` | `entity_id`, `name`, `icon` |

   `icon` is sent only when it is an MDI name (`mdi:` plus letters, digits
   and hyphens, any case). The panel draws any other icon text as a "?"
   glyph in place of the tile's own icon, and on a cover in place of its
   open and closed icons. `weather_meta` is read for icons only: a weather
   tile's name comes from its payload. There is no `number_meta`:
   `editable_meta` serves number, select and date/time, whose kind comes from
   the list the entity is in and from its `/control` payload.

   **`state_kind` accepts only `number` or `state`.** `parseSensorMetaSection`
   stores the key for no other value, and the sensor renderer branches on
   exactly those two to choose graph versus history mode. A textual sensor
   is `state`, not `text`. The adapter derives it from the object's declared
   type (or a value that is a JSON number), never from a text that happens to
   look numeric, so a sensor unavailable at startup still gets its graph.

Other rules:

- **No `cameras` and no `camera_meta`.** The adapter serves no camera. The
  panel clears its camera list whether the key is absent or empty, so a
  panel moved over from the Home Assistant Bridge loses its camera entities.
- **Free text is made safe for the hand-rolled parsers.** In names, units and
  values, `[` `]` `{` `}` become `(` `)`, `"` becomes `'`, and a control
  character becomes a space. A text equal to a key the panel looks for gets a
  trailing space, which the panel trims. Entity ids and scene aliases are
  never rewritten: they must match topics, commands and the panel's scene
  slots.
- **At most 128 numbers, selects and date/times** together, the first 128 by
  entity id: the panel keeps no more values. The log names how many were left
  out.
- **At most 32767 bytes.** The panel copies the payload into a 32768-byte
  buffer, cuts anything longer and applies the cut text, losing every section
  past the cut. A configuration over the limit is not published: the adapter
  logs one error per configuration, naming its size and its three largest
  sections, and the broker keeps the last retained apply that fitted. The
  success line gives the size: `Configuration pushed, 130 entities, 9841 of
  32767 bytes`.
- **Never an apply whose lists are all empty.** The panel would drop every
  tile slot no list names and save that to flash. So the adapter publishes
  nothing to the panels (no apply, icons or states) before its first
  successful discovery; while the Devices tab has not been armed by Refresh
  detected devices and Save; while no picked device or manual entity lands in
  a list (a scene lands in none) and no energy meter is set; and while the
  adapter stops. Each panel keeps its last configuration meanwhile.

An apply is published when its content changes, and again, unchanged, when a
panel announces itself or asks for a refresh.

## Icon map (bridge/icons)

The adapter publishes, retained, to `tab5_lvgl/config/{deviceId}/bridge/icons`
a flat map of entity id to icon, the shape the Bridge sends:

```json
{"light.kitchen":"mdi:ceiling-light","sensor.balkon":""}
```

Every published entity is in it: an MDI icon, or `""`, which removes an icon
the panel still holds. That is the only way to clear one; an apply without
icons, or an empty map, changes nothing. An icon the panel holds for an id the
adapter does not publish stays until the panel restarts. A wrapped
`{"icons":{…}}` would be ignored.

The map has the same 32767-byte cut as the apply. Over it, the `""` entries are
dropped first, with a warning: the entities without an MDI icon then keep any
icon the panel holds until it restarts. If the MDI icons alone are over the
limit, no map is published and an error is logged; the apply still goes out.

## Entity state

The adapter publishes each entity's state retained to
`{haPrefix}/{domain}/{object_id}/{leaf}`. The topic is built by lowercasing
the entity id and replacing its dot with `/`. An empty retained payload on the
same topic removes the retained state when an entity leaves a panel.

**The payload format is domain-dependent. This is the single most important
detail in the port:**

| Domain | Leaf | Payload | Evidence and rules |
| --- | --- | --- | --- |
| `sensor` | `state` | bare string, e.g. `23.4`, `Auto` or `unavailable` | `sync_external_temp_entity` publishes `dtostrf` output or the literal `unavailable`. A blank reading is `unknown`, never `0` |
| `binary_sensor` | `state` | bare string `on` / `off` / `unknown` / `unavailable` | consumed by `tiles_update_sensor_by_entity` as a raw value |
| `switch` | `state` | bare string `on` / `off` / `unknown` / `unavailable` | `TILE_SWITCH` branch of `tiles_update_sensor_by_entity` |
| `light` | `state` | JSON object with `state` plus attributes, e.g. `{"state":"on","brightness_pct":42}` | `sync_local_device_entities` publishes this shape for the panel's own display-brightness light. See below |
| `scene` | none | not published | fire-and-forget activation only |
| `climate` | `state` | JSON object, the complete known attribute set | [Climate](#climate) |
| `cover` | `state` | JSON object, the complete known attribute set | [Cover](#cover) |
| `media_player` | `state` | JSON object | [Media player](#media-player) |
| `weather` | **`weather`** | JSON object: current conditions, then the daily forecast | [Weather](#weather) |
| `number` | **`control`** | JSON object in the `/control` schema | [Number, select and date/time](#number-select-and-datetime) |
| `select` | **`control`** | JSON object in the `/control` schema | [Number, select and date/time](#number-select-and-datetime) |
| `datetime` | **`control`** | JSON object in the `/control` schema | [Number, select and date/time](#number-select-and-datetime) |

A light's payload carries `state` and whichever of these are known:
`friendly_name`, `icon`, `supported_color_modes`, `color_mode`, `brightness`
(0-255), `brightness_pct` (0-100), `rgb_color`, `color_temp_kelvin`,
`min_color_temp_kelvin` and `max_color_temp_kelvin`. An unknown value is
omitted, never sent as `null` or `0`. A colour mode is advertised only for a
channel that can be commanded: a read-only dimmer gives no brightness, and a
single combined colour channel (`rgbSingle`, `rgbwSingle`, `cie`) gives no
colour, since no encoder writes one. A dimmer's level is scaled from its
declared range to 0..100. A colour temperature in mireds is converted to
kelvin; the kelvin bounds are whole numbers, rounded inwards, exactly the
range the panel clamps to. What the firmware does with each omitted light key
was not extracted for 0.2.0.

## Commands

The panel publishes every command with retain false (current firmware:
`src/network/mqtt/mqtt_handlers.cpp:1976-2377`,
`src/types/value/value_control.cpp:312`). This adapter ignores a retained
command on every leaf (Ruling 101): the broker replays it at every
subscription, so it would run again at every reconnect and restart. The
HomeTiles Bridge ignores only retained `value`, `switch` and `scene` commands
(`__init__.py:1550`, `:2999`, `:3082`). The panel's retained announcement and
`stat/*` topics are read as always.

Command leaves: `light`, `switch`, `scene`, `climate`, `cover`, `media` (not
`media_player`) and `value` (for number, select and date/time). The adapter
subscribes to no other `cmnd` leaf of an entity domain.

Every command is checked before anything is written:

- The entity must be one the adapter publishes, and the command one its
  domain allows. Anything else is refused and logged.
- A command that would write nothing is refused, never reported as a
  success: no writable channel (`no_writable_channel`), a value the channel
  cannot hold (`cannot_encode_value`), or a number outside the channel's
  declared range (`value_out_of_range`; never clamped).
- A channel whose object declares `write: false` is never written.
- Only number, select and date/time commands are answered on the wire
  (`stat/value`). Every other refusal is visible only in the adapter's log,
  and on the panel only as a state that does not change.

`cmnd/light`, built by `mqttPublishLightCommand`. Optional members are omitted
when absent:

```json
{"entity_id":"light.x","state":"on","brightness_pct":42,"rgb_color":[255,180,90],"color_temp_kelvin":3000}
```

The adapter writes what the light can take. A brightness the light cannot
take (no level channel, a read-only one, or bounds a percentage cannot be
scaled over) and a colour temperature it cannot take (no such channel, a
read-only one, a unit that cannot be read as kelvin or mireds, or a value
outside the published range) are skipped with a warning, and `on`, the colour
and the rest still land: the panel's power button and slider send them
together, so refusing the call would stop them switching the light on. A
brightness outside 0..100 or a colour component outside 0..255 is refused,
never clamped.

`cmnd/switch` and the on/off path of `cmnd/light`, built by
`mqttPublishSwitchCommand`. When no state is supplied the firmware sends
`toggle`. An `entity_id` starting with `light.` is routed to `cmnd/light`,
everything else to `cmnd/switch`:

```json
{"entity_id":"switch.x","state":"on"}
```

A toggle of a switch or light whose state is unknown or unavailable turns it
on.

`cmnd/scene`, built by `mqttPublishScene`: **plain text**, the scene name or
alias. Not JSON.

## Climate

Evidence: [contract-climate-cover.md](contract-climate-cover.md), "Climate".
Adapter: `src/registry/synth/climate.ts` (ioBroker `thermostat` and
`airCondition` devices), `src/protocol/climate.ts` (payload),
`src/runtime/dispatcher.ts` (commands).

**State**, retained on `<haPrefix>/climate/<object_id>/state`. The panel
parses it with a hand-rolled scanner. It drops a payload that holds none of a
mode, an action, a temperature, a humidity, a range or `available: false`,
and otherwise replaces its whole cached state with it. The adapter sends
every known key on every publish and omits every unknown one:

| Key | Sent when | From |
| --- | --- | --- |
| `available` | always | whether any channel the climate synth reads has a usable value |
| `temperature` | the single target is known | SET, or a lone SET_HEATING or SET_COOLING |
| `target_temp_low`, `target_temp_high` | both are known, never one alone | SET_HEATING and SET_COOLING, when there is no SET |
| `min_temp`, `max_temp` | the setpoint channel declares them, and min < max | the setpoint channel's `common.min` and `common.max` |
| `current_temperature` | known | ACTUAL, unless ACTUAL is the setpoint's own object |
| `current_humidity` | known | HUMIDITY |
| `hvac_mode` | known | MODE, decoded through its states list (and the Climate modes table) |
| `hvac_action` | known | WORKING_MODE |
| `fan_mode` | known | SPEED, else SPEED_LEVEL |
| `swing_mode` | known | the numeric SWING |
| `swing_horizontal_mode` | known | the boolean SWING toggle, `on` or `off` |
| `hvac_modes`, `fan_modes`, `swing_modes`, `swing_horizontal_modes` | at least one name survives | see below |
| `supported_features` | always | see below |
| `friendly_name`, `icon`, `power`, `boost` | set | passed through; the panel's climate parser reads none of them |

- **The `*_modes` lists are the panel's buttons.** Each list is turned into a
  bitmask against the firmware's fixed name tables (hvac: `off`, `heat`,
  `cool`, `heat_cool`, `auto`, `dry`, `fan_only`; fan: `auto`, `low`,
  `medium`, `high`, `on`, `off`, `top`, `middle`, `focus`, `diffuse`; swing:
  `off`, `on`, `vertical`, `horizontal`, `both`), and an unknown name is
  dropped. The adapter lists only names the channel can take back exactly:
  the channel is writable, number- or string-typed, and its states list maps
  the name to one raw value. A channel with no states list gets no list.
  Without a list the popup still offers the current value as a single
  option, which re-selects the current value.
- **The Climate modes table** (Devices tab) renames a thermostat's own modes
  to panel modes, for example `MANU-MODE` as `heat`. The rename is applied to
  the device's MODE states list, so the payload, the list and the command all
  use it: the panel's `heat` then writes MANU's own raw value. A row that
  names no picked climate device, no mode, a mode two states share, or a
  panel mode that would stand for two device modes is left out, and the log
  says why. A mode state with no states list cannot be mapped.
- **`supported_features` is always sent**, computed from what can be
  commanded, because without it the panel assumes every feature:
  TARGET_TEMPERATURE 1 (a writable single setpoint), TARGET_TEMPERATURE_RANGE
  2 (both range setpoints writable), TARGET_HUMIDITY 4, FAN_MODE 8,
  PRESET_MODE 16, SWING_MODE 32, SWING_HORIZONTAL_MODE 512. The HVAC mode has
  no bit: the popup shows it whenever it has an option. TURN_ON and TURN_OFF
  are never read by the firmware and never set. No ioBroker climate pattern
  has a preset or a writable humidity target, so bits 4 and 16 are never set
  today.
- **No `null` anywhere**, and no `preset_mode` outside the firmware's eight
  names (`none`, `eco`, `away`, `boost`, `comfort`, `home`, `sleep`,
  `activity`).

**Commands** on `<baseTopic>/cmnd/climate`, one topic, told apart by
`command` (contract §3 & 4):

| `command` | Other keys | The adapter writes |
| --- | --- | --- |
| `set_temperature` | `temperature` | SET, or the lone SET_HEATING or SET_COOLING |
| `set_temperature` | `target_temp_low`, `target_temp_high` (always both) | SET_HEATING and SET_COOLING |
| `set_humidity` | `humidity` | nothing today: no ioBroker climate pattern has a writable humidity target |
| `set_hvac_mode` | `hvac_mode` | MODE, the label encoded back to its raw value |
| `set_fan_mode` | `fan_mode` | SPEED or SPEED_LEVEL, encoded |
| `set_swing_mode` | `swing_mode` | the numeric SWING, encoded |
| `set_swing_horizontal_mode` | `swing_horizontal_mode` (`on` or `off`) | the boolean SWING toggle, `true` or `false` |
| `set_preset_mode` | `preset_mode` | nothing today: no ioBroker climate pattern has a preset |

A label is written as the raw value its states list gives it, matched
without regard to case. A label two states share is refused. Re-selecting the
current value writes the current raw value. A setpoint outside the channel's
declared range is refused, never clamped.

## Cover

Evidence: [contract-climate-cover.md](contract-climate-cover.md), "Cover".
Adapter: `src/registry/synth/cover.ts` (ioBroker `blind`, `blindButtons` and
`gate` devices), `src/protocol/cover.ts`, `src/runtime/dispatcher.ts`.

**State**, retained on `<haPrefix>/cover/<object_id>/state`. The panel parses
it with ArduinoJson, where `null` equals a missing key, and replaces its whole
cached state with each payload.

| Key | Sent when | Meaning |
| --- | --- | --- |
| `state` | always | `open` or `closed`: from the position (0 is closed), else from a gate's OPENED and CLOSED contacts, else from a boolean SET; `unknown` or `unavailable` otherwise |
| `available` | always | |
| `current_position` | known | 0..100: ACTUAL, else SET, scaled from the channel's declared range and rounded to a whole percent |
| `current_tilt_position` | known | the same for the tilt |
| `supported_features` | always | see below |
| `friendly_name`, `icon` | set | |

`supported_features` is always sent because without it the panel infers
features from which keys are present: a gate that reports its position would
get a position slider it can never obey. The bits, from what can be
commanded: OPEN 1, CLOSE 2, SET_POSITION 4, STOP 8, OPEN_TILT 16, CLOSE_TILT
32, STOP_TILT 64, SET_TILT_POSITION 128. A boolean SET (a gate) opens and
closes but sets no position. A position channel whose declared bounds are
equal or inverted gets no position control; a missing minimum is 0 and a
missing maximum 100.

**Commands** on `<baseTopic>/cmnd/cover`, one topic, told apart by
`command`. The firmware accepts exactly ten names:

| `command` | Other keys | The adapter writes |
| --- | --- | --- |
| `open_cover`, `close_cover` | | OPEN or CLOSE `true`; on a gate, SET `true` or `false` |
| `stop_cover` | | STOP `true` |
| `set_cover_position` | `position` 0..100 | SET, scaled into its declared range |
| `open_cover_tilt`, `close_cover_tilt`, `stop_cover_tilt` | | TILT_OPEN, TILT_CLOSE or TILT_STOP `true` |
| `set_cover_tilt_position` | `tilt_position` 0..100 | TILT_SET, scaled |
| `toggle`, `toggle_cover_tilt` | | open or close by the current state; refused while it is unknown. No panel control sends either |

A position outside 0..100 is refused.

## Media player

Evidence: [contract-media-weather.md](contract-media-weather.md),
"media_player". Adapter: `src/registry/synth/media_player.ts` (ioBroker
`media` devices), `src/protocol/media.ts`, `src/runtime/dispatcher.ts`.

**State**, retained on `<haPrefix>/media_player/<object_id>/state`. The
firmware also routes `…/state_fast` the same way; the adapter uses `state`
only. There is no acceptance check and no `supported_features`: each message
is parsed afresh, and two readings are controls.

| Key | Sent when | Meaning |
| --- | --- | --- |
| `state` | always, first | `playing`, `paused`, `idle`, `buffering`, `standby`, `on`, `off`, `unknown` or `unavailable`, decoded from STATE: `true` playing and `false` paused; a name such as `play`, `pause` or `stop` (idle); or a number, 0 paused, 1 playing, 2 idle |
| `volume_level` | the volume can be set | 0..1. It enables the panel's volume slider, so a read-only volume is left out |
| `is_volume_muted` | known | MUTE |
| `media_position`, `media_duration` | SEEK can be set, and the duration is above 0 | seconds. Together they show the seek bar |
| `entity_picture` | always | the cover URL, only an absolute `http://` or `https://` one; otherwise `""`, which clears the last cover |
| `media_title`, `media_artist`, `media_album_name` | known | TITLE, ARTIST, ALBUM |

- Every key the panel reads is sent before any free text. The panel looks a
  key up anywhere in the payload, values included, so every quote inside a
  text is sent as `\u0022`, and a text equal to one of the 16 keys the panel
  reads has its first letter `\u`-escaped. The panel decodes `\u` escapes, so
  the text looks unchanged.
- The panel advances a playing position itself. A position within about 2 s
  of what it extrapolates is not republished; a refresh goes out with the
  first such update 30 s after the last publish.
- A SEEK state whose unit is neither empty nor `%` (`s` or `ms`, say) gets no
  seek bar: ioBroker's `media.seek` is a percentage, and a guessed time unit
  could be off by a factor of 1000.

**Commands** on `<baseTopic>/cmnd/media` (the leaf is `media`, not the domain
name), told apart by `command`:

| `command` | Other keys | The adapter writes |
| --- | --- | --- |
| `previous`, `next` | | PREV or NEXT `true` |
| `play_pause` | | PAUSE `true` while playing, PLAY `true` otherwise; without those buttons, STATE, encoded |
| `volume_set` | `volume_level` 0..1 | see below |
| `media_seek` | `seek_position`, seconds | SEEK, as the percentage of the published duration |

The mute icon sends `volume_set` too: 0 to mute, the last level to unmute. A
slider released at 0 sends the same bytes. So `volume_set` 0 sets MUTE `true`
when MUTE is writable, keeping the level; any other level is written to
VOLUME, scaled into its range, and ends a mute. A player with a writable MUTE
but no settable volume toggles its mute on any `volume_set`. The firmware's
`volume_mute` command has no caller, and the adapter refuses it. No panel
control sends a stop.

## Weather

Evidence: [contract-media-weather.md](contract-media-weather.md), "weather"
and "Answer to the weather-response question". Adapter:
`src/registry/synth/weather.ts` (ioBroker `weatherCurrent` and
`weatherForecast`, one source's two detections merged into one entity),
`src/protocol/weather.ts`, `src/runtime/panel-session.ts`.

**State**, retained on `<haPrefix>/weather/<object_id>/weather`: the last
segment is the word `weather`, not `state`. There is no response topic.

```json
{"state":"rainy","condition":"rainy","temperature":7.5,"temperature_unit":"°C","precipitation_unit":"mm","name":"Wetterstation",
 "forecast":[{"date_local":"2026-09-25","condition":"rainy","temperature":11,"templow":4,"precipitation":2.1,"precipitation_probability":80}]}
```

- **Current conditions come first.** Every panel lookup takes the first
  `"key"` anywhere in the payload, a forecast entry's included. While a
  forecast follows, an unknown `state`, `condition` or `temperature` goes out
  as `""`, which every reader shows as no value; left out, the first
  forecast day's value would be shown as the current one (its high as the
  current temperature). With no forecast they are left out.
- **`state` and `condition` carry the same value**: the tile reads `state`
  first, the popup `condition`. It is one of Home Assistant's 15 conditions
  (`clear-night`, `cloudy`, `exceptional`, `fog`, `hail`, `lightning`,
  `lightning-rainy`, `partlycloudy`, `pouring`, `rainy`, `snowy`,
  `snowy-rainy`, `sunny`, `windy`, `windy-variant`) when the provider's icon
  or text maps to one: an OpenWeatherMap icon code first, else German and
  English words in the text. An unmapped current text is sent as it is, and
  the panel shows it with no icon; a text equal to a key the panel looks up
  is treated as no text.
- **No `icon` and no `units` object**: the panel derives the icon from the
  condition, and a forecast entry's `icon` or a `units.temperature` would be
  read as the current one. Units go out flat, as the source declares them.
- **`name`** is the entity's name, left out when it equals a key the panel
  looks up; the tile's own title wins anyway.
- **Each forecast day**: `condition` only when it is one of the 15 (a day
  shows an icon, never text, and a `]` in a text would cut the tile's array),
  `temperature` the day's high and `templow` its low, both the provider's own
  daily values with no aggregation, and `precipitation` and
  `precipitation_probability`.
- **`date_local`** is the host's local date, `YYYY-MM-DD`, sent for every
  day or for none. The panel places a dated day by comparing it with its own
  today, and an undated one in the first free slot in arrival order, so a
  mixed set would misorder. **The ioBroker host and the panels must share a
  time zone**; a host without `TZ` (a container in UTC, say) shifts the row
  by a day.
- An unavailable weather entity goes out as `{"name":…}` alone, which both
  readers show as `--`.
- ioBroker's weather patterns carry no hourly data, so `forecast_hourly` is
  never sent.

**Request** on `tab5_lvgl/config/<deviceId>/weather/request`:
`{"entity_id":"weather.x"}`. The popup sends it only when the panel has no
cached payload for the entity. The adapter answers by publishing that
entity's payload again, retained, on its weather topic. It ignores malformed
JSON, an id that is no weather entity pushed to that panel, and a repeat
within 1 s of the last answer.

## Number, select and date/time

Evidence: [contract-editable.md](contract-editable.md). Adapter:
`src/registry/synth/editable.ts`, `src/protocol/editable.ts`,
`src/runtime/panel-session.ts`.

Where they come from: a number from an ioBroker `slider` or `percentage`
level that is the only control and the only adjustable level of its channel
or device, so that a dimmer's or a thermostat's spare parameters never become
numbers; a select and a date/time only from a Forced type on the Devices tab
or from a manual entity. See
[contract-iobroker-types.md](contract-iobroker-types.md), "Editable domains".

### The /control payload

Retained on `<haPrefix>/<number|select|datetime>/<object_id>/control`. The
panel validates it field by field and rejects the whole message, or strips a
capability, on any single mistake, without a log.

```json
{"version":1,"kind":"number","available":true,"writable":true,"session":"<32 hex>","min":15,"max":28,"step":0.5,"mode":"auto","unit":"°C","state":"21","revision":"<16 hex>","last_changed":1790218800}
```

| Key | Rule |
| --- | --- |
| `version` | always `1` |
| `kind` | `number`, `select`, or for a date/time `date`, `time` or `datetime` |
| `state` | always a string, at most 255 bytes: the value, `"unknown"` for a value not set yet (still writable), `"unavailable"` for bad quality. Never `null`, which the panel shows as `--` and makes read-only. A select state with a line break, NUL or a lone surrogate goes out as `"unknown"`: a line break would make every tap on the dropdown submit the option below the one tapped |
| `available` | `false` for bad quality |
| `writable` | `available` and the value can be written back: a writable channel of the right type, a complete range for a number, a complete option list for a select, a value in the panel's date/time grammar |
| `session` | 32 hex characters, one per adapter process: a new one tells the panel its constraints may have changed |
| `revision` | 16 hex characters: the first 16 of a SHA-256 over every field but `state`, `last_changed` and `revision`. It changes with the constraints, never with the value, because the panel abandons an edit on any change |
| `last_changed` | epoch seconds, left out when never observed |
| `min`, `max`, `step`, `mode`, `unit` | number only. A missing `common.step` is Home Assistant's derived one (1, divided by 10 while the range is at most the step); a percent value's missing bound is 0 or 100. `mode` is always `auto`. A unit over 128 bytes is left out |
| `options_complete`, `options` | select only: every label of the state's states list, 1 to 64, each 1 to 255 bytes, no line break, NUL or lone surrogate, unique in any case. One bad option means no list and a read-only select: the panel accepts no partial list |

A payload over 24576 bytes is dropped by the panel without a log. The only
unbounded part is a select's option list, so such a select is sent without
it, read-only, with one warning.

Values: a number is shown as its value, a select as its option label (or the
raw value when no label names it), a date/time as `YYYY-MM-DD`, `HH:MM[:SS]`
or `YYYY-MM-DD HH:MM:SS`. A date/time state holding epoch milliseconds is
shown and written in the host's time zone; any other text outside the panel's
grammar is shown as it is, read-only.

### cmnd/value

The panel publishes one topic for all three, `<baseTopic>/cmnd/value`, not
retained:

```json
{"entity_id":"number.kitchen_target","session":"<echoed>","revision":"<echoed>","value":21.5,"id":"1a2b3c4d-0002b1c8-00000007","deadline":1758547200}
```

`value` is a JSON number for a number, a string for the rest. `deadline` is
the panel's own clock plus 10 s, in epoch seconds. The panel sends nothing
before its clock is set.

The adapter checks a command as the Bridge does, in this order:

1. **Dropped without an answer**: a retained command; one over 2048 bytes; no
   JSON object; an `entity_id` that is no number, select or date/time pushed
   to this panel; an `id` that is not a string of 1 to 48 characters.
2. **`expired`**: a `deadline` that is not a number, or not 0 to 15 s ahead
   of the host's clock, or a `session` other than the adapter's own. A
   command is therefore accepted only while **the panel's clock is at most
   about 5 s ahead of the host's, or up to about 10 s behind it**, less the
   time in transit. When an expired command's deadline puts the panel's clock
   7 s or more ahead, or 12 s or more behind, the log warns, at most once an
   hour per panel.
3. **Dropped without an answer**: an `id` seen before whose deadline has not
   passed, or any command while 128 ids are held.
4. **`changed`**: a `revision` other than the one the entity's `/control` has
   now.
5. **`unavailable`**: the `/control` says `writable: false`.
6. The value: a number must be a JSON number within `min`..`max`
   (`invalid_value`) and on the step grid from `min` (`invalid_step`); a
   select option must be one of `options` exactly (`invalid_option`) and is
   written as its raw value; a date or time must be in the kind's shape and a
   real calendar value (`invalid_value`). A text keeps its own shape (a `T`,
   seconds) when written back; a spring-forward time the zone skips is
   refused, and a repeated autumn time is written as its first instant.
7. A write that throws: `failed`, logged at most once a minute per panel.

**The panel's numbers carry about 7 significant digits.** ArduinoJson 7.4.3
keeps a short decimal as a 32-bit float and prints a float with 6 decimals,
so `min`, `max` and `step` are not quite the published ones on the panel (a
step of `0.08197082` is `0.081971` there). The adapter checks a number on the
panel's own grid (`src/protocol/arduinojson.ts`) and writes the panel's own
draft for that step. A value with more than about 7 significant digits that
a float holds exactly (20000002, or 12345.125 on a step of 0.001) is sent by
the panel already rounded (`2e7`, `12345.13`): another point of the grid,
possibly several steps away. The adapter writes it as sent and answers `ok`,
as the Bridge does; the panel then waits in vain for its own value and shows
an error after 30 s. The written value is at most about 5e-7 of itself off.
Contract §5, "Where this adapter differs", has the details.

### stat/value

The answer, `<baseTopic>/stat/value`, not retained, at most 1024 bytes:

```json
{"entity_id":"number.kitchen_target","id":"1a2b3c4d-0002b1c8-00000007","status":"ok"}
```

`entity_id` and `id` echo the command exactly. `status` is `ok`, `expired`,
`changed`, `unavailable`, `invalid_value`, `invalid_step`, `invalid_option` or
`failed`. **Only the literal `"ok"` is acceptance**; anything else, absent
included, is a rejection. Even `ok` is confirmed only when a `/control`
arrives that shows the value, so after every answer the adapter publishes the
entity's current `/control` again. The panel gives up on a command after 30 s.

## History

Evidence: [contract-history-energy.md](contract-history-energy.md) §1-5 and
§7-10, [contract-iobroker-history.md](contract-iobroker-history.md). Adapter:
`src/protocol/history.ts`, `src/runtime/history-provider.ts`,
`src/runtime/panel-session.ts`.

All history requests share one topic,
`tab5_lvgl/config/<deviceId>/history/request`, and every answer goes to
`tab5_lvgl/config/<deviceId>/history/response`, never retained. There is no
per-kind topic: the payload's `kind` decides.

### Requests

| Shape | Sent by | Payload |
| --- | --- | --- |
| numeric | a sensor popup's graph (24 h in 5-minute periods, or 7 days in hours) and every graph tile (24 h, 5 min) | `{"entity_id":"sensor.x","hours":24,"period_minutes":5,"points":288,"stat":"mean"}`, no `kind` |
| binary | a binary sensor popup | `{"version":1,"kind":"binary","entity_id":"binary_sensor.x","hours":24,"max_transitions":96}` |
| state | a textual sensor popup | the same with `"kind":"state"` |
| editable | a number, select or date/time popup | `{"entity_id":"number.x","kind":"editable","version":1,"hours":24,"max_transitions":96,"request_id":"1a2b3c4d-005f31a0-00000001"}` |

`hours` of a binary, state or editable request is 24 or 168; the adapter
refuses anything else, and a `max_transitions` that is no whole number of at
least 2 (more than 96 counts as 96; none counts as 48). A numeric range with
zero, negative or non-finite values, or more than 288 periods, gets no
answer: the firmware never sends one, and even an empty answer would wipe a
graph tile.

### How the adapter answers

- Only for an entity pushed to the requesting panel, so nothing while the
  Devices tab is not armed, and an editable request only for a number,
  select or date/time. A history exists for `sensor`, `binary_sensor`,
  `number`, `select` and `datetime`; a request for any other entity is
  ignored.
- It reads the state the entity's synth reads (sensor: ACTUAL, else
  PRESSURE, else SET; binary sensor: ACTUAL, else LEVEL, else SET; number,
  select, date/time: SET, else ACTUAL) from the history instance chosen on
  the Advanced tab, or the system's default history instance when none is
  chosen. It reads raw rows (never an average), the newest 5000 at most, plus
  the reading in effect before the window. A graph drops rows of bad quality;
  a timeline keeps them as unavailable.
- The state must be logged by that instance (its custom settings enabled).
- The whole answer has 7 s from the request's arrival, the wait for a query
  slot included (two queries at a time per panel, 32 queued); the panel's
  own timer is 8 s.

### Numeric response

```json
{"entity_id":"sensor.x","hours":24,"period_minutes":5,"values":[20.1,20.1,null,…]}
```

- `entity_id`, `hours` and `period_minutes` are echoed: the popup drops a
  response whose range differs from its own.
- There are no timestamps: `values` holds exactly `hours × 60 /
  period_minutes` values, oldest first, the last period ending now.
- A period with readings holds their mean. An empty period carries the
  reading in effect, the latest one before it, because the panel would fill a
  `null` from the previous period's mean. A value is `null` only before the
  first reading.
- With no history at all (no instance, the state not logged, the instance
  not running, or no rows) the answer is the live value in the last period
  and `null` before it, as the Bridge answers. A read that failed for now (a
  timeout, a busy instance) gets no answer, so a drawn graph stays as it is.
- `unit` and `current` are not sent: the popup keeps its own.

### Binary, state and editable responses

`kind`, `entity_id`, `hours` and, for an editable request, `request_id` come
first: the panel's dispatcher reads them by first match in the text.

| Key | Binary | State | Editable number | Editable select, date/time |
| --- | --- | --- | --- | --- |
| `kind` | `binary` | `state` | `number` | `state` |
| `range_start`, `range_end` | epoch seconds | epoch seconds | epoch seconds | epoch seconds |
| `history_available` | `true` | `true` | `true` | `true` |
| `current` | the live state | the live state | | |
| `available`, `last_changed` | the live ones; `last_changed` left out when never observed | | | |
| `timeline_points`, `timeline_encoding`, `timeline_data` | 768 bins, `2bit-hex` (off 0, on 1, unknown 2, unavailable 3) | 768 bins, `palette4-hex` | | 768 bins, `palette4-hex` |
| `palette`, `palette_complete` | | up to 16 states, `unknown` and `unavailable` first | | as for state |
| `segments` | `{start, end, state}`, the newest `max_transitions`, oldest first | the same | | the same |
| `activity` | `{timestamp, state}`, the newest `max_transitions`, oldest first | the same | the same | the same |
| `period_minutes`, `values` | | | 5 for 24 h, 60 for 168 h; the reading in effect at each period's end, a non-number being a gap | |

- Timestamps are whole epoch seconds: the panel reads a fraction as 0.
- A state label over 32 bytes is sent under the panel's own name for it (23
  bytes, `~` and 8 hex of its SHA-256), so a live change and the history
  agree.
- The timeline is always sent: the popup draws the bar from it, and segments
  alone would leave all but the newest 96 of a busy window blank.
- With no history (no instance, the state not logged, the instance not
  running) or a failed read, the answer is `{kind, entity_id, hours,
  [request_id], "history_available":false, "error":"history_unavailable"}`,
  and the popup says "History unavailable".
  An answer over 32767 bytes, which the panel would cut and drop, is replaced
  by the same with `"error":"response_too_large"`.

## Energy

Evidence: [contract-history-energy.md](contract-history-energy.md) §6.
Adapter: `src/protocol/energy.ts`, `src/runtime/energy-source.ts`,
`src/protocol/apply.ts` (the catalog).

Energy is not an entity domain. Its data comes from the energy meters on the
Energy tab: ioBroker states holding a cumulative counter, such as a kWh total.

### Request

`tab5_lvgl/config/<deviceId>/energy/request`, not retained:
`{"period":"day"}`, `"week"` or `"month"`; anything else is day. No entity id:
one request asks for every configured meter. The panel asks for the day every
60 s and for the week when its popup shows it; v0.6.12 never asks for the
month. It waits 15 s for an answer.

The adapter answers nothing while the Devices tab is not armed, while no
meter is set, for a payload that is no JSON object, and for a retained
request.

### Response

`tab5_lvgl/config/<deviceId>/energy/response`, not retained:

One grid meter with a price of 0.30, asked at 02:40:

```json
{"period":"day","start":"2026-09-25T00:00:00+02:00","entries":[
 {"id":"consumption_total","category":"consumption","sign":1,"name":"Total consumption","values":[0.25,0.2,0.15],"is_total":true,"total":0.6,"unit":"kWh"},
 {"id":"energy.netzbezug","category":"grid","sign":1,"values":[0.25,0.2,0.15],"name":"Netzbezug","total":0.6,"unit":"kWh"},
 {"id":"energy.netzbezug_cost","category":"grid","sign":1,"values":[0.075,0.06,0.045],"unit":"EUR","is_cost":true,"name":"Netzbezug (EUR)","total":0.18}
]}
```

- **`period` is the first key**: the panel picks the answer's queue by the
  first `"period"` anywhere in the text. `start` is the period's local start
  in ISO 8601; the popup names the week's days from it.
- **Buckets**, in the host's time zone: day, every hour from local midnight,
  the running hour included (23 or 25 on a clock-change day; the popup draws
  24); week, the 7 days ending today; month, every day from the 1st. At most
  32 values per entry are read.
- **A bucket's value** is the counter's increase from the reading before the
  bucket's start to the reading before the next one, the live reading for the
  running bucket. A decrease is a reset: that bucket is 0 and counting goes
  on from the new reading. A bucket with a reading missing on either side is
  `null`, which the panel shows as no data. So only cumulative counters work;
  a counter that resets every day gives wrong weeks and months.
- **`total`** is the sum of the increases between consecutive known
  readings (the live one last, rises only), so it spans gaps. An unknown
  total is left out: `null` and a missing `total` both show 0.000, and JSON
  has no "not a number" for `--`.
- **`sign`** is 1 for import, -1 for export. The panel turns a positive
  value negative for sign -1 and leaves a negative one alone, so the adapter
  sends the values as measured and the total already signed, and neither is
  flipped twice. Solar and battery discharge count as import; battery charge
  and grid feed-in as export. A device meter is always import.
- **Entries**: one per meter, `energy.<name>`; a `<id>_cost` entry for a meter
  with a price (a price of 0 included), in the currency; `<category>_total`
  for a category with two or more meters, and `<category>_total_cost` when
  two or more of them have a price; `consumption_total` when a grid, solar or
  battery meter is set (the signed sum of those meters); and
  `consumption_untracked` when a device meter is set too (the house
  consumption less the device meters). Those two come first, so a size cut
  strips them last. A house slot is known only when every grid, solar and
  battery meter has a value in it, and its total only when each has a total:
  **while any of them is unknown, the house entries show 0.000.**
- **Rounding** follows the Bridge (Python's round, ties to even): values and
  kWh totals to 3 decimals, cost values to 4, cost totals to 2.
- **Size**: at most 32767 bytes. Over that, the last entries lose their
  `values` first, then the last entries go, with a warning at most once an
  hour per period.
- Each meter's readings come from the history instance; a boundary reading
  at least a minute old is cached. One answer has 7 s; a meter that misses
  it goes out with what was read, the rest `null`.

Only the day's entries reach energy tiles; week and month reach the popup.
The response's `name`, `category`, `is_total` and `cost` are stored but never
displayed by v0.6.12: a tile's title and icon come from the catalog below,
its unit from the response, else from the catalog.

### The energy catalog in bridge/apply

The apply's `energy` section is an entity catalog, not a response: one
`{"id","name","unit","category"}` per id any answer carries (meters, cost
entries, totals and the house entries), `unit` left out when there is none.
The panel files each name and unit under its id, and gives the id an icon
by its category, or the currency icon when the id ends in `_cost`
(`ha_bridge_config.cpp:1083-1099`); so no meter id ends in `_cost`. The
section is sent empty without meters, and never while the Devices tab is
not armed.

## Panel status and settings

| Topic | Payload |
| --- | --- |
| `{base}/stat/connected` | retained, panel presence |
| `{base}/stat/ip` | retained, IPv4 string |
| `{base}/cmnd/display_brightness` | integer 1..100 |
| `{base}/stat/display_brightness` | retained integer; a value above 100 means legacy 121..255 encoding |
| `{base}/cmnd/screensaver_brightness`, `{base}/stat/screensaver_brightness` | as above |
| `{base}/cmnd/display_rotate` | **boolean** via `parseBoolPayload`: `1`/`on`/`true`/`yes` or `0`/`off`/`false`/`no`. Means rotated 180°, NOT an angle |
| `{base}/stat/display_rotate` | retained `ON` / `OFF` |
| `{base}/cmnd/display_sleep` | **boolean** via `parseBoolPayload`. Means sleep now / wake, NOT a timeout |
| `{base}/stat/display_sleep` | retained `ON` / `OFF`, reflecting `powerManager.isInSleep()` |
| `{base}/cmnd/sleep_mains`, `{base}/cmnd/sleep_battery` | **duration string** via `parseSleepPayload`: `nie`/`never`/`off`/`0` disables; otherwise one of the labels `5 s`, `15 s`, `30 s`, `60 s`, `5 min`, `15 min`, `30 min`, `60 min`, or a free-form form like `30s`, `15min`, or a bare number of seconds in 1..3600 |
| `{base}/stat/sleep_mains`, `{base}/stat/sleep_battery` | retained label from `sleepLabelFromConfig` |
| `{base}/cmnd/io/{channelId}` | `ON` / `OFF` |
| `{base}/stat/io/{channelId}` | retained `ON` / `OFF` for a relay, a decimal string or `unavailable` for a temperature channel |

## Not implemented

- **Camera.** Excluded by decision: no `camera` domain, no `cameras` list,
  no `camera_meta`.
- **The three firmware entry points the 0.2.0 plan deferred**, which are no
  entity domain. No contract was extracted for them; what follows is a first
  reading of `src/network/mqtt/mqtt_handlers.cpp` at the same commit, enough
  to say what the adapter leaves alone:
  - `mqttPublishHomeSnapshot` (`:1909-1928`) publishes the panel's own
    readings, retained, to `<baseTopic>/sensor/outside_c`,
    `<baseTopic>/sensor/inside_c` and `<baseTopic>/sensor/soc_pct` (the
    battery charge, `unavailable`, or an empty payload that removes it). The
    adapter subscribes to none of them, so ioBroker gets no objects for them.
  - `mqttPublishDiscovery` (`:2565-2597`) publishes empty retained payloads
    to `homeassistant/sensor/<deviceId>_<leaf>/config` and
    `homeassistant/button/<deviceId>_<leaf>/config`, removing Home Assistant
    MQTT discovery entries of older firmware. Nothing answers it.
  - `mqttRequestDynamicSlotsReload` (`:2664-2672`) only schedules the panel's
    own re-subscription of its dynamic state topics; it publishes nothing.
