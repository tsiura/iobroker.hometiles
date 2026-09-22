# Gap: v0.1 core → full HomeTiles coverage

Measured 2026-09-22 against firmware v0.6.12 (`src/network/bridge/ha_bridge_config.cpp`)
and HomeTiles-Bridge v0.6.47 (11,191 LOC Python, the reference implementation).

## bridge/apply meta sections the firmware parses

| Section | v0.1 | Notes |
| --- | --- | --- |
| `sensor_meta` | yes | |
| `binary_sensor_meta` | yes | |
| `switch_meta` | yes | |
| `light_meta` | yes | |
| `scene_meta` + `ha_scene_alias` | yes | |
| `ha_sensors` / `_names` / `_units` / `_vals` | yes | local Hardware I/O |
| energy (`grid` `solar` `battery` `gas` `water` `_cost`) | partial | section published, no request handler |
| `climate_meta` | **no** | |
| `cover_meta` | **no** | |
| `media_player_meta` | **no** | |
| `weather_meta` | **no** | |
| `editable_meta` | **no** | number / select / datetime |
| `camera_meta` | **no** | see below |

## Command surface

Firmware exposes 25 outbound entry points. v0.1 handles 4:
`mqttPublishLightCommand`, `mqttPublishSwitchCommand`, `mqttPublishScene`,
`mqttPublishDeviceSettings`.

Unhandled (21):

- **Climate (7)** — Temperature, Humidity, HvacMode, FanMode, PresetMode,
  SwingMode, HorizontalSwingMode
- **Media (4)** — MediaCommand, MediaMute, MediaSeek, MediaVolume
- **Cover (1)** — CoverCommand
- **Camera (1)** — CameraCommand
- **Request/response (5)** — HistoryRequest, StateHistoryRequest,
  BinaryHistoryRequest, WeatherRequest, EnergyRequest
- **Other (3)** — HomeSnapshot, Discovery, DynamicSlotsReload

## ioBroker mapping

`@iobroker/type-detector` 6.0.1 already carries the types needed for every
missing domain except editable and camera:

- climate → `thermostat`, `airCondition`
- cover → `blind`, `blindButtons`, `gate`, `window`
- media → `media`, `volume`, `volumeGroup`
- weather → `weatherCurrent`, `weatherForecast`
- editable → no direct type; `slider` / `level` for number, enum states for
  select, nothing for datetime — these need manual overrides
- camera → `camera`, `image` (URL-shaped, not a frame stream)

History has no type-detector involvement: ioBroker stores history in the
`history`, `sql` or `influxdb` adapters, all three reachable through the same
`sendTo(instance, 'getHistory', …)` call. The Bridge reads HA's Recorder for
the same purpose.

## The one item that does not port cleanly

The Bridge's `camera_stream.py` is 1,041 LOC and uses ffmpeg to transcode an
HA camera proxy into frames the panel can render. ioBroker has no camera
entity abstraction and no equivalent proxy: sources are typically a snapshot
URL or a raw RTSP stream, and ffmpeg would become a runtime dependency of the
adapter. Every other gap item is mechanical against the existing architecture.

## Why the rest is mechanical

`src/registry/types.ts:1` holds the `Domain` union. `payloadShape()` in
`src/protocol/state-payload.ts:25` has no `default` case, so widening that
union produces a compile error at every place a new domain must be handled.
The synth layer is one file per domain and the protocol layer is free of
ioBroker and MQTT imports. The extension points already exist.
