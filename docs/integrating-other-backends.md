# Connecting HomeTiles panels to a backend that is not Home Assistant

Research note. Every claim here was read out of the HomeTiles firmware source
at v0.6.9, not inferred from documentation.

## The decisive constraint: MQTT on the panel has no TLS

`src/network/network_manager.h:149` declares the socket the MQTT client uses:

```cpp
NetworkClient net_client;      // plaintext TCP
```

and `network_manager.cpp:602` hands exactly that to PubSubClient. There is no
`NetworkClientSecure`, no CA certificate handling, and no cipher configuration
anywhere on the MQTT path. The port is freely configurable (`uint16_t
mqtt_port`), so a panel *can* be pointed at 8883 — it will simply speak
plaintext at a TLS listener and fail.

The device is not incapable of TLS. `src/core/github_update.cpp` uses
`NetworkClientSecure` with `HTTPClient` for HTTPS OTA downloads. TLS exists on
the device; it was never wired into MQTT.

**Consequence: pointing a stock panel directly at a cloud MQTT broker means
sending broker credentials and all home state across the internet in the
clear. That is not an acceptable design.** Everything below follows from this.

## The panel's contract is retained-state pub/sub

Two properties shape any integration:

- **Retained state is mandatory.** A panel that boots must find current entity
  state already sitting on the broker, or its tiles render empty until
  something changes. The backend is expected to publish retained.
- **Presses must feel instant.** A tile press publishes a command and the panel
  waits for the state to come back. A cloud round trip on every light toggle is
  visibly bad.

Both argue for something local holding state regardless of where the "real"
backend lives. A local broker is therefore not a workaround — it is the correct
shape.

## Option 1 — local broker, cloud bridge (recommended, no firmware change)

```
[panel] --plaintext MQTT--> [local broker] <--TLS--> [cloud]
         (stays on the LAN)   Mosquitto/EMQX          any protocol
```

The panel never leaves the LAN, so plaintext is contained to a network segment
the user already trusts with the same traffic. The bridge upstream is ordinary
software and can speak anything: MQTTS, HTTPS, WebSocket, gRPC.

Mosquitto has a built-in [bridge](https://mosquitto.org/man/mosquitto-conf-5.html)
that does MQTT-over-TLS upstream with no code at all. For a non-MQTT cloud, a
small process subscribes locally and translates.

This is exactly what `ioBroker.hometiles` in this repository is: a broker-side
consumer implementing the panel's contract. It is a working template for
"HomeTiles ↔ anything".

Cost: one always-on local process. For an ESP32 Zigbee hub that already runs
continuously, that is where it belongs.

## Option 2 — add TLS to the MQTT client (small, well-scoped fork)

Swap `NetworkClient` for `NetworkClientSecure`, add CA certificate storage and
configuration, and the panel can address a cloud broker directly.

Genuinely small in lines — essentially one member and its setup — but it makes
you the owner of a firmware fork and of certificate lifecycle on a wall device
with no keyboard. Verify memory first: the MQTT receive buffer already reaches
32 KB (`kMqttBufferLarge`), and a TLS record buffer plus handshake state on top
of that is the thing to measure, not assume.

Worth it if panels must work off-LAN. Otherwise Option 1 dominates.

## Option 3 — replace the transport entirely (not recommended *for this goal*)

Rewriting the panel to use WebSocket or HTTP long-polling means rewriting
`mqtt_handlers.cpp` (~2,755 lines) plus the dynamic routing, retained-state
handling and last-will semantics that MQTT provides for free. MQTT is already
the right protocol for this problem: pub/sub, retained state, LWT presence.
Replacing it buys nothing and discards a working contract.

This verdict is scoped to the goal above — reaching a cloud from panels that
still live on a LAN. If the product itself is cloud-native, the calculus
changes and the appendix at the end of this document works through it.

## Option 4 — the HTTP admin API (LAN-only, not a state channel)

The panel serves a REST surface on port 80: `/api/tiles`, `/api/status`,
`/api/sensor_values`, `/api/entity_options`, plus OTA and file endpoints. This
is how pairing works — `POST /mqtt` then `POST /restart`.

It is not a substitute for the state channel. It is pull-shaped from the
panel's perspective, LAN-only, and a cloud service cannot reach a panel behind
NAT without an outbound tunnel the firmware does not have. Useful for
provisioning from a local agent; not for live state.

## For the ESP32 Zigbee hub case specifically

The hub already has cloud connectivity, so it is the natural bridge host:

1. Run a broker on the hub, or beside it.
2. Panels connect to it locally over plaintext MQTT — unchanged firmware.
3. The hub publishes Zigbee device state to the panel's contract, retained.
4. The hub's existing cloud link carries whatever the cloud needs.

The panel then does not know or care that a cloud exists, which is the property
you want: cloud outage degrades remote access, not the wall panel in the
hallway.

## The reusable integration point

Whatever the backend, the work is the same: implement the MQTT contract the
firmware already speaks. That contract is documented in `docs/protocol.md` and
implemented end to end in this repository's `src/protocol/`, which is
deliberately free of any ioBroker dependency so it can be lifted wholesale.

The parts worth copying rather than rediscovering:

- entity state is a **bare string** for `sensor`, `binary_sensor` and `switch`,
  but **JSON** for `light`
- `bridge/apply` is parsed by substring scanning, not a JSON parser, so key
  spelling and present-but-empty sections matter
- `cmnd/scene` carries plain text; every other command topic carries JSON
- `state_kind` accepts only `number` or `state`

---

# Appendix: forking the firmware for a cloud-native transport

Question considered: change the firmware so the user enters a cloud URL and a
token, connects over some purpose-built protocol instead of MQTT, and reuses
all the HomeTiles graphics.

## Feasibility: high, and the seam is unusually clean

Measured against v0.6.9:

| Area | Lines | Transport-coupled? |
| --- | --- | --- |
| `src/ui` + `src/tiles` + `src/types` | 59,097 | no, except 14 files' includes |
| `src/devices` + `src/core` | 64,017 | no — display, touch, HAL, i18n, power |
| `src/web` | 33,542 | mostly no — admin UI and its assets |
| `src/network` | 9,403 | **yes, this is the part you replace** |

The UI talks to the transport through exactly **21 outbound functions**, all
named `mqttPublish*` / `mqttRequest*`:

```
mqttPublishLightCommand        mqttPublishSwitchCommand      mqttPublishCoverCommand
mqttPublishClimateTemperature  mqttPublishClimateHumidity    mqttPublishClimateHvacMode
mqttPublishClimateFanMode      mqttPublishClimatePresetMode  mqttPublishClimateSwingMode
mqttPublishClimateHorizontalSwingMode
mqttPublishMediaCommand        mqttPublishMediaVolume        mqttPublishMediaSeek
mqttPublishCameraCommand       mqttPublishDeviceSettings     mqttRequestDynamicSlotsReload
mqttPublishHistoryRequest      mqttPublishStateHistoryRequest
mqttPublishBinaryHistoryRequest mqttPublishWeatherRequest    mqttPublishEnergyRequest
```

and the transport reaches back into the UI through roughly **three** entry
points: `tiles_update_sensor_by_entity`, `tiles_update_weather_by_entity`, and
`queue_sensor_popup_history`.

That is a genuine interface hiding behind a naming convention. Introducing an
abstract `PanelTransport` with those ~24 operations, and pointing the 14
coupled files at it instead of `mqtt_handlers.h`, is mechanical work. The
plumbing is days, not months.

## What is actually hard

None of the hard parts are the graphics. They are the semantics MQTT was
providing for free:

**Retained state.** A panel that boots must immediately render current values.
MQTT retained messages give this at no cost. A raw WebSocket does not — you
need an explicit `hello` → `full snapshot` handshake, and the server must hold
per-entity current state. This is the single biggest thing you would be
rebuilding.

**Presence.** MQTT's last will announces a panel dropping off. Over WebSocket
you need heartbeats and server-side timeout, and you must decide what a missed
heartbeat means while someone is standing in front of the panel.

**Offline behaviour.** A LAN broker keeps working during an internet outage. A
cloud-only panel is a dark rectangle on the wall when the WAN drops. This is a
product decision, not a technical one: decide now whether the panel caches last
known state and renders it greyed, or shows a connection error.

**Token entry.** Typing a long token on a touchscreen keyboard is miserable.
Use the device-code flow televisions use: panel shows a short code, user
approves on a phone, panel polls for its real credential. The firmware already
has an on-device keyboard and an HTTPS client, so this is achievable.

**TLS memory.** The MQTT receive path already reaches a 32 KB buffer
(`kMqttBufferLarge`), and media states approach 24 KB. TLS record buffers and
handshake state land on top of that. Measure on the tightest target (ESP32-S3)
before committing; P4 with PSRAM is likely comfortable.

**The entity model.** Decide whether to keep the Home Assistant shaped contract
or define your own. Keeping it means the existing renderers, popups and
`state_kind` logic work untouched. Replacing it means touching the 59k lines
you were trying to reuse. Strong recommendation: keep the shape, change only
the pipe.

## Protocol suggestion

**WebSocket over TLS carrying the existing JSON payloads.** One outbound
connection traverses NAT, TLS is standard, tokens fit naturally in the upgrade
request, and it is bidirectional so commands and state share a socket. Keep the
payload shapes already documented in `docs/protocol.md` and add a framing
envelope with a type discriminator and the snapshot handshake.

**MQTT over WSS** is worth considering as the lazier option: it keeps retained
state, LWT, and every existing payload semantic, and only changes the socket
underneath. If a cloud broker is acceptable, this is dramatically less work
than a bespoke protocol and loses almost nothing.

## The cheap option that gets most of the UX

If the goal is really "enter a URL and a token" rather than "own the
protocol", the smallest viable change is:

1. Swap `NetworkClient` for `NetworkClientSecure` on the MQTT path.
2. Add CA certificate configuration.
3. Use the token as the MQTT password.
4. Point the panel at a managed cloud broker.

That is roughly one file, keeps every semantic the firmware already depends on,
and gives the user exactly the URL-plus-token experience. Reach for a bespoke
protocol only when something concrete requires it — per-panel authorisation
policy, non-MQTT cloud infrastructure, or payloads MQTT genuinely cannot carry.
