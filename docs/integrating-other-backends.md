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

## Option 3 — replace the transport entirely (not recommended)

Rewriting the panel to use WebSocket or HTTP long-polling means rewriting
`mqtt_handlers.cpp` (~2,755 lines) plus the dynamic routing, retained-state
handling and last-will semantics that MQTT provides for free. MQTT is already
the right protocol for this problem: pub/sub, retained state, LWT presence.
Replacing it buys nothing and discards a working contract.

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
