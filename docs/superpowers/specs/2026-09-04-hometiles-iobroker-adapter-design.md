# HomeTiles ioBroker Adapter — Design

Date: 2026-09-04
Status: approved for implementation planning
Repository: `ioBroker.hometiles` (npm `iobroker.hometiles`, adapter id `hometiles`)

## 1. Purpose

HomeTiles is a tile-based touch dashboard firmware for ESP32-P4 and ESP32-S3
panels. Today the panel's backend is Home Assistant, reached through the
separate `HomeTiles-Bridge` custom integration (Python, HA domain `tab5_lvgl`,
v0.6.40, ~5.7k lines plus ~2k lines of tests).

This project replaces that backend with an ioBroker adapter written in
TypeScript. The ESP32 firmware is **not** modified and **not** forked. The
adapter speaks the firmware's existing MQTT contract so stock HomeTiles
firmware works against ioBroker with no reflash and no protocol change.

## 2. Goals and non-goals

### Goals

- Stock HomeTiles firmware (v0.6.9 and newer) operates fully against ioBroker.
- ioBroker devices appear on panels as tiles, with live state and working
  controls.
- Each panel appears in the ioBroker object tree with its own control and
  status states, usable from scripts, vis, and other adapters.
- Panel discovery and MQTT credential pairing work the same way they do under
  Home Assistant.
- The protocol layer is testable without ioBroker, without a broker, and
  without hardware.

### Non-goals

- No firmware change, patch, or fork.
- No Home Assistant dependency, and no requirement that HA be installed.
- No vis widgets. The panel is the UI.
- No attempt to reimplement Home Assistant beyond the subset the firmware
  actually consumes.

## 3. Constraints from the firmware

The firmware is the fixed side of the contract. Its expectations are drawn from
`src/network/mqtt_handlers.cpp`, `src/network/mqtt_topics.h`,
`src/network/ha_bridge_config.{h,cpp}` and `docs/bridge.md` in the HomeTiles
repository.

### 3.1 Topic surface

`{base}` is the panel's configured device topic base (default `hometiles`,
unique per panel). `{ha_prefix}` is the shared entity-state prefix (default
`ha/statestream`). `{id}` is the panel device id.

| Topic | Direction | Purpose |
| --- | --- | --- |
| `tab5_lvgl/config/{id}/bridge` | panel → adapter | device announcement, including local Hardware I/O channels |
| `tab5_lvgl/config/{id}/bridge/apply` | adapter → panel | full configuration push |
| `tab5_lvgl/config/{id}/bridge/icons` | adapter → panel | lightweight icon-only update |
| `tab5_lvgl/config/{id}/bridge/request` | panel → adapter | forced re-push of configuration |
| `tab5_lvgl/config/{id}/history/{request,response}` | both | numeric, binary and categorical history |
| `tab5_lvgl/config/{id}/weather/{request,response}` | both | forecast |
| `tab5_lvgl/config/{id}/energy/{request,response}` | both | energy dashboard data |
| `{ha_prefix}/{domain}/{object_id}/{suffix}` | adapter → panel | entity state, retained |
| `{base}/cmnd/{light,switch,scene,media,climate,cover,camera}` | panel → adapter | control commands |
| `{base}/stat/{connected,ip,camera}` | panel → adapter | panel status |
| `{base}/cmnd/{display_brightness,screensaver_brightness,display_rotate,display_sleep,sleep_mains,sleep_battery}` | adapter → panel | panel settings |
| `{base}/stat/{display_brightness,screensaver_brightness,display_rotate,display_sleep,sleep_mains,sleep_battery}` | panel → adapter | panel settings echo, retained |
| `{base}/cmnd/io/{channel_id}` | adapter → panel | local switch command (`ON` / `OFF`) |
| `{base}/stat/io/{channel_id}` | panel → adapter | local switch or temperature state, retained |

The entity-state topic is built by lowercasing the entity id and replacing the
domain separator `.` with `/`, e.g. `light.kueche_decke` becomes
`{ha_prefix}/light/kueche_decke/state`.

### 3.2 Semantic expectations

- Entity ids are Home Assistant shaped: `<domain>.<object_id>`.
- Attribute names are Home Assistant's: `friendly_name`,
  `unit_of_measurement`, `device_class`, `state_class`, `icon`,
  `supported_features`, `assumed_state`, `options`, and the per-domain sets
  (`current_position`, `current_tilt_position`, `hvac_modes`, `min_temp`,
  `max_temp`, `min_humidity`, `max_humidity`, `temperature_unit`).
- Raw protocol values stay stable English identifiers: `on`, `off`, `open`,
  `closed`, `unavailable`, `unknown`. The firmware localizes them for display.
- Retained state is expected at startup: a panel that boots must find current
  entity state already on the broker.
- Icons are Material Design Icon names (`mdi:...`).

## 4. Architecture

### 4.1 Approach

The adapter maintains an in-memory **virtual Home Assistant entity registry**.
ioBroker objects are classified into devices, each device becomes one or more
virtual entities carrying Home Assistant shaped state and attributes, and all
bridge behaviour operates on that registry exactly as the Python bridge
operates on `hass.states`.

The alternative — mapping each configured ioBroker state directly onto firmware
topics inside each handler — was rejected. The firmware's contract is Home
Assistant shaped, so that approach re-derives Home Assistant semantics
scattered across handlers, with no single place to test them and no way to keep
parity with upstream bridge changes.

### 4.2 Module layout

```
ioBroker.hometiles/
  src/
    main.ts                     adapter lifecycle, wiring
    config/
      options.ts                typed native config, defaults, validation
    registry/
      detector.ts               @iobroker/type-detector -> DetectedDevice[]
      overrides.ts              admin include/exclude/rename/force-type
      entity-registry.ts        virtual entity store and change events
      entity-id.ts              ioBroker object id -> stable HA entity id
      synth/
        sensor.ts
        binary_sensor.ts
        switch.ts
        light.ts
        scene.ts
    protocol/
      topics.ts                 topic builders for every domain above
      announce.ts               parse device announcement, validate local I/O
      apply.ts                  build bridge/apply payload
      icons.ts                  build bridge/icons payload
      state-payload.ts          VirtualEntity -> statestream payload
      commands.ts               parse cmnd/* -> validated ServiceCall
    runtime/
      mqtt-client.ts            mqtt.js connect, reconnect, LWT, publish queue
      panel-manager.ts          one PanelSession per announced device id
      panel-session.ts          subscriptions, apply push, coalescing
      dispatcher.ts             ServiceCall -> setForeignStateAsync
      pairing.ts                MQTT credential push to unconfigured panels
      panel-objects.ts          hometiles.0.panels.* object tree and sync
  test/
  admin/jsonConfig.json
```

**Hard boundary:** nothing under `src/protocol/` or `src/registry/synth/`
imports `@iobroker/adapter-core` or `mqtt`. Those modules are pure functions
over plain data. This is what makes the protocol testable headless and what
keeps future upstream bridge changes portable.

### 4.3 Data flow

Inbound (ioBroker → panel):

1. `detector.ts` classifies the object tree into devices; `overrides.ts`
   applies the admin's include/exclude/rename/force-type decisions.
2. `entity-registry.ts` builds `VirtualEntity` records and subscribes to the
   underlying foreign states.
3. A foreign state change updates the entity, is coalesced per entity, and
   `state-payload.ts` renders the retained statestream publish.
4. Registry membership changes (entity added, removed, renamed, icon changed)
   mark the config signature dirty; `apply.ts` re-pushes to every panel whose
   signature no longer matches.

Outbound (panel → ioBroker):

1. `commands.ts` parses a `cmnd/*` payload into a `ServiceCall` and validates
   it against the registry: unknown entity id, wrong domain, or an argument out
   of range is rejected and logged, never forwarded.
2. `dispatcher.ts` resolves the `ServiceCall` to concrete ioBroker state writes
   through a fixed per-domain allow-list, clamping numeric arguments.
3. The resulting ioBroker state change flows back through the inbound path, so
   the panel sees a confirmed value rather than only its own optimistic one.

## 5. Virtual entity model

```ts
type Domain = 'sensor' | 'binary_sensor' | 'switch' | 'light' | 'scene';

type VirtualEntity = {
  entityId: string;                     // "light.kueche_decke"
  domain: Domain;
  source: Record<string, string>;       // channel role -> ioBroker state id
  state: string;                        // "on" | "23.4" | "unavailable" | "unknown"
  attributes: Record<string, unknown>;  // Home Assistant shaped
  available: boolean;
  lastChanged: number;                  // epoch ms
};
```

### 5.1 Missing-value discipline

Absent, null, empty, zero, unknown and unavailable are six distinct conditions
and must not be conflated:

- The backing object does not exist → the entity is never created and never
  published.
- The ioBroker state is `null`, or its quality `q` is non-zero → `state` is
  `unavailable` and `available` is `false`.
- A value is present but cannot be parsed for the domain → `state` is
  `unknown`, `available` stays `true`.
- A legitimate `0` or `off` is published as itself and is never substituted for
  any of the above.

### 5.2 Type mapping (v0.1)

| type-detector type | HA domain | Notes |
| --- | --- | --- |
| `socket`, `switch` | `switch` | boolean `SET` channel |
| `light` (on/off only) | `light` | `supported_color_modes: ["onoff"]` |
| `dimmer` | `light` | ioBroker `0..100` scaled to HA `0..255` |
| `rgb`, `rgbSingle`, `hue`, `ct` | `light` | color modes derived from present channels only |
| `temperature`, `humidity`, other numeric `value.*` | `sensor` | `unit_of_measurement` from `common.unit`, `device_class` from role |
| `window`, `door`, `motion`, `fireAlarm`, `flood` | `binary_sensor` | `device_class` mapped from detector type |
| enum or free-text states | `sensor` | textual state, drives the categorical popup path |
| ioBroker scene objects and button states | `scene` | fire-and-forget activation |
| anything else | excluded | the admin can force a domain per object |

### 5.3 Feature synthesis

`supported_features` and `supported_color_modes` are derived **only** from the
channels the detector actually found on the device. They are never inferred
from a current value. A dimmer with no color channel never advertises color; a
cover with no tilt channel never advertises tilt. This mirrors the firmware's
own rule that a control is rendered only when its feature bit is present.

### 5.4 Entity id stability

`entity-id.ts` derives `<domain>.<slug>` from the object id tail, falling back
to `common.name`. Slugs are lowercased, non-alphanumerics become `_`, and
collisions get a numeric suffix in a deterministic order.

The resulting id is **persisted** in the adapter's own objects, keyed by source
object id. Renaming an object in ioBroker therefore does not orphan tiles a
user already placed on a panel. Breaking that link is only allowed through an
explicit admin action.

## 6. ioBroker object tree

```
hometiles.0.info.connection                bool    indicator.connected (broker)
hometiles.0.info.panels                    number  announced panels
hometiles.0.info.entities                  number  published virtual entities

hometiles.0.panels.<deviceId>                      device
  .info.connected                          bool    from <base>/stat/connected, LWT aware
  .info.ip                                 string  from <base>/stat/ip
  .info.baseTopic                          string
  .info.firmware                           string  from the announcement
  .info.model                              string  from the announcement
  .control.display_brightness              number  1..100, rw
  .control.screensaver_brightness          number  1..100, rw
  .control.display_rotate                  number  rw
  .control.display_sleep                   string  enum, rw
  .control.sleep_mains                     string  enum, rw
  .control.sleep_battery                   string  enum, rw
  .control.pair                            button  re-push broker credentials
  .control.refresh                         button  force bridge/apply
  .battery.soc                             number  percent, battery panels only
  .io.<channelId>                          bool|number, rw, local relay or DS18B20
```

A write to `.control.*` with `ack: false` publishes the matching `cmnd` topic.
The panel's retained `stat` echo is written back with `ack: true`. This is the
same optimistic-then-confirm shape the Python bridge gives its Home Assistant
entities, so ioBroker scripts and vis can drive panels directly.

Removing a panel deletes its objects **and** clears its retained MQTT state by
publishing an empty retained payload to each owned topic. That is the analog of
the Python bridge marking removed entities unavailable, and it prevents a stale
retained value from resurrecting a deleted panel.

## 7. Admin UI

`admin/jsonConfig.json`, four tabs.

| Tab | Contents |
| --- | --- |
| Connection | broker host, port, TLS, username, password (encrypted native), base topic (default `hometiles`), HA prefix (default `ha/statestream`), client id |
| Devices | live table of detected devices: object id, detected type, proposed entity id, name; per row an include checkbox, a name override and a forced-domain select |
| Panels | announced panels, pairing action, optional per-panel entity scoping |
| Advanced | publish rate limit, protocol trace logging, entity-id collision strategy |

Device overrides are persisted keyed by **object id**, never by table row
index, so reordering or filtering the table cannot silently reassign an
override to a different device.

`onMessage` handlers:

- `listDetected` — run the detector against the current object tree and return
  the table rows.
- `testBroker` — validate broker credentials without saving.
- `previewEntity` — return the exact statestream topic and payload a chosen
  object would produce. This is a deliberate addition over the Python bridge:
  it turns a mapping bug from a multi-hour MQTT-sniffing session into one
  click.

## 8. Resilience and performance

- **MQTT client:** exponential reconnect backoff, a last will on the adapter's
  own status topic, and a bounded outbound queue. On overflow the oldest
  message is dropped and a rate-limited warning is logged; the queue never
  grows without limit.
- **Announcement validation is atomic.** A malformed non-empty local I/O list
  is rejected as a whole. It is never partially applied and never mistaken for
  the intentional empty list that removes all channels.
- **Per-entity coalescing,** default 200 ms. A chatty ioBroker state cannot
  flood a panel. The trailing edge is always delivered, so the final value is
  never lost — the same guarantee the firmware's sliders rely on.
- **Config signature gating.** `bridge/apply` carries a hash of the pushed
  configuration. An unchanged configuration is never re-pushed, even across
  adapter restarts.
- **Logging.** All runtime, diagnostic, warning and error logs are English with
  stable prefixes and are rate-limited. No per-message logging on the hot path.

## 9. Security

- The dispatcher's command allow-list is fixed at compile time. An MQTT payload
  can never name an arbitrary ioBroker state: the target must already be in the
  virtual entity registry, and the requested operation must be in that domain's
  allow-list.
- Numeric service arguments are range-clamped before any write.
- Broker credentials are stored in encrypted native config and are transmitted
  to a panel only during an explicit pairing action against a panel that has
  announced itself with no credentials configured.

## 10. Testing

- `src/protocol/` and `src/registry/synth/` are covered by pure unit tests with
  no ioBroker, no broker and no hardware. Golden payload fixtures are derived
  from the firmware parsers (`mqtt_handlers.cpp`, `ha_bridge_config.cpp`) as
  the primary source, cross-checked against the Python bridge's own tests.
- One contract test per tile type in scope, proving the statestream payload it
  consumes parses under the firmware's rules, including the unavailable and
  unknown paths.
- Integration tests run an in-process `aedes` broker against a fake object
  database and assert the full round trip: announce → apply → state →
  command → `setForeignState`.
- `@iobroker/testing` provides the standard adapter startup and unload suite.
- Every reproduced bug gets a focused regression test before the fix.

## 11. Phasing

| Release | Scope |
| --- | --- |
| **v0.1 (this spec)** | sensor, binary_sensor, switch, light, scene, panel control, local Hardware I/O, pairing, admin UI |
| v0.2 | climate, cover, media |
| v0.3 | history via `sendTo(history \| sql \| influxdb, 'getHistory')` |
| v0.4 | weather forecast normalizer, energy from explicitly configured meter states |
| v0.5 | camera: ffmpeg transcode to acknowledged TCP JPEG on ports 8124–8131 |

Deferred subsystems are stubbed cleanly rather than absent: the firmware
degrades gracefully, showing empty popups while tiles continue to render.

## 12. Scaffolding

Generate the project with `@iobroker/create-adapter` using the TypeScript
template, then replace the generated `src/` with the layout in section 4.2.
This keeps the standard ioBroker build, lint, release and CI tooling.

## 13. Open items for the implementation plan

These are known work items, not unresolved design questions:

1. Extract the exact `bridge/apply` and `bridge/icons` payload schemas from the
   firmware parser and record them as versioned fixtures.
2. Extract the exact per-domain statestream payload shapes the firmware
   accepts, including which suffixes beyond `state` are read.
3. Enumerate the `cmnd/light`, `cmnd/switch` and `cmnd/scene` payload variants
   the firmware emits, including the slider throttling and final-release
   behaviour.
4. Confirm the DS18B20 and relay announcement descriptor fields against
   `src/io/hardware_io.cpp`.
