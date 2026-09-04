# HomeTiles MQTT contract

This document records the wire contract of the HomeTiles firmware, which this
adapter must satisfy exactly. The firmware is the fixed side: it is never
modified for this project. Every value here was read out of the firmware source
at the commit named below, not inferred from documentation.

Firmware reference: HomeTiles v0.6.9, files `src/network/mqtt_handlers.cpp`,
`src/network/mqtt_topics.cpp`, `src/network/ha_bridge_config.cpp`,
`src/network/network_manager.cpp`, `src/io/hardware_io.cpp`,
`src/web/web_admin.cpp`.

The single most dangerous asymmetry: `sensor`, `binary_sensor` and `switch`
state topics carry a bare string, while `light` carries a JSON object.

## Verified Firmware Contract

These values were read out of the HomeTiles firmware source and are authoritative. Do not re-derive them.

### Announcement — panel publishes retained to `tab5_lvgl/config/{deviceId}/bridge`

Built by `HaBridgeConfig::buildJsonPayload` in `src/network/ha_bridge_config.cpp`:

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

`type` is `relay` or `temperature`. `local_io` is appended by `HardwareIoManager::appendBridgeJson`.

### Refresh request — panel publishes to `tab5_lvgl/config/{deviceId}/bridge/request`

Plain text, not JSON. Payload is `force` or the empty string.

### Configuration push — adapter publishes to `tab5_lvgl/config/{deviceId}/bridge/apply`

The firmware parses this with **substring scanning, not a JSON parser** (`HaBridgeConfig::applyJson`). Exact key spelling matters. Top-level keys it looks for:

`"sensors"`, `"binary_sensors"`, `"energy"`, `"weathers"`, `"lights"`, `"switches"`, `"media_players"`, `"climates"`, `"covers"`, `"cameras"` (arrays), `"scene_map"` (object).

Metadata sections, scanned separately: `"sensor_meta"`, `"binary_sensor_meta"`, `"light_meta"`, `"switch_meta"`, `"media_player_meta"`, `"climate_meta"`, `"cover_meta"`, `"camera_meta"`, `"weather_meta"`, `"scene_meta"`.

`sensor_meta` entry keys: `entity_id`, `name`, `unit`, `state`, `value`, `state_kind`, `number`, `icon`. **`state_kind` accepts only `number` or `state`** — `parseSensorMetaSection` stores the key for no other value, and `src/types/sensor/renderer.cpp` branches on exactly those two to choose graph versus history mode. A textual sensor is `state`, not `text`.
`binary_sensor_meta` entry keys: `entity_id`, `name`, `device_class`, `state`, `on`, `off`, `unknown`, `unavailable`, `icon`, `available`, `last_changed`.
Every `*_meta` section is additionally scanned for `icon` by `parseIconMetaSections`.

### Entity state — adapter publishes retained to `{haPrefix}/{domain}/{objectId}/state`

Topic is built by lowercasing the entity id and replacing `.` with `/`.

**Payload format is domain-dependent. This is the single most important detail in the port:**

| Domain | Payload | Evidence |
| --- | --- | --- |
| `sensor` | bare string, e.g. `23.4` or `unavailable` | `sync_external_temp_entity` publishes `dtostrf` output or the literal `unavailable` |
| `binary_sensor` | bare string `on` / `off` / `unknown` / `unavailable` | consumed by `tiles_update_sensor_by_entity` as a raw value |
| `switch` | bare string `on` / `off` / `unavailable` | `TILE_SWITCH` branch of `tiles_update_sensor_by_entity` |
| `light` | JSON object with `state` plus attributes, e.g. `{"state":"on","brightness_pct":42}` | `sync_local_device_entities` publishes exactly this shape for the panel's own display-brightness light |
| `scene` | not published | fire-and-forget activation only |

### Commands — panel publishes to `{baseTopic}/cmnd/{leaf}`

`cmnd/light`, built by `mqttPublishLightCommand`. Optional members are omitted when absent:

```json
{"entity_id":"light.x","state":"on","brightness_pct":42,"rgb_color":[255,180,90],"color_temp_kelvin":3000}
```

`cmnd/switch` and the on/off path of `cmnd/light`, built by `mqttPublishSwitchCommand`. When no state is supplied the firmware sends `toggle`. An `entity_id` starting with `light.` is routed to `cmnd/light`, everything else to `cmnd/switch`:

```json
{"entity_id":"switch.x","state":"on"}
```

`cmnd/scene`, built by `mqttPublishScene`: **plain text**, the scene name or alias. Not JSON.

### Panel status and settings

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
