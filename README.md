# ioBroker.hometiles

Connects [HomeTiles](https://github.com/GalusPeres/HomeTiles) ESP32-P4 and
ESP32-S3 touch panels to ioBroker over MQTT.

HomeTiles firmware normally talks to Home Assistant through the HomeTiles
Bridge integration. This adapter replaces that backend. The firmware is
**not modified and not forked**: the adapter speaks the same MQTT contract, so
stock HomeTiles firmware works against ioBroker with no reflash.

## What works in v0.1

| Tile type | Status |
| --- | --- |
| Sensor (numeric and textual) | supported |
| Binary sensor | supported |
| Switch | supported |
| Light (on/off, dimmer, RGB, colour temperature) | supported |
| Scene | supported |
| Panel settings: brightness, screensaver, rotation, sleep | supported |
| Local Hardware I/O: relays and DS18B20 | supported |
| Panel pairing | supported, by IP address |
| Climate, Cover, Media | planned for v0.2 |
| Sensor history popups | planned for v0.3 |
| Weather, Energy | planned for v0.4 |
| Camera | planned for v0.5 |

Deferred tile types still render on the panel; their popups show no data.

Single-channel colour devices — ioBroker `rgbSingle`, `rgbwSingle` and `cie`
roles, which carry colour as one combined value rather than independent
red/green/blue channels — deliberately do **not** advertise colour in v0.1.
The command dispatcher only has an encoder for separate red/green/blue
channels, so advertising colour for a combined channel would put a colour
picker on the panel whose writes silently do nothing. Such a light still
works normally for on/off, brightness and colour temperature; only the
colour picker is absent. This is intentional, not a bug — a future version
can add the combined-channel encoder.

## What "supported" means here

Every row above is verified against the HomeTiles firmware's own parser rules —
read out of its C++ source — and exercised end to end against an in-process MQTT
broker. **No physical panel has ever run this adapter.**

A green test suite is not evidence of behaviour on a device. These remain
outstanding and need a real panel:

1. Announcement and configuration push against real firmware, including the
   panel's Web Admin entity dropdowns populating.
2. Light popup slider interaction, including the final value on release.
3. Retained state surviving a panel reboot with the adapter running.
4. Pairing a factory-fresh panel by IP address.
5. Local relay and DS18B20 channels on a panel that has them.

Until those are done, treat v0.1 as ready to test, not ready to rely on.

## Requirements

- ioBroker js-controller 5.0.19 or newer
- An MQTT broker reachable by both ioBroker and the panels. The ioBroker `mqtt`
  adapter in broker mode works, as does any external broker.
- HomeTiles firmware v0.6.9 or newer

## Setup

1. Install the adapter and open its settings.
2. **Connection**: enter the broker address and credentials. Keep the base topic
   matching the panel's own device topic base, and leave the entity prefix at
   `ha/statestream` unless you changed it on the panel.
3. **Devices**: press *Scan for devices*, then include the devices you want on
   your panels. Overrides are stored per object id, so renaming an object in
   ioBroker never breaks a tile you already placed.
4. **Panels**: a panel that already has broker credentials announces itself and
   appears under `hometiles.0.panels.*` automatically. A brand-new panel has no
   credentials yet, so enter its IP address here once to push them.

## Objects

Each panel appears as a device with its own status and control states, usable
from scripts and vis:

```text
hometiles.0.panels.<deviceId>.info.connected
hometiles.0.panels.<deviceId>.info.ip
hometiles.0.panels.<deviceId>.control.display_brightness
hometiles.0.panels.<deviceId>.control.screensaver_brightness
hometiles.0.panels.<deviceId>.control.display_sleep
hometiles.0.panels.<deviceId>.io.<channelId>
```

## Protocol

The wire contract this adapter implements is documented in
[docs/protocol.md](docs/protocol.md).

## Release blockers

These are known gaps left open at the end of v0.1 development. Both must be
resolved before this adapter is published to npm or submitted to the
ioBroker repository.

- **`admin/hometiles.png` is a placeholder, not artwork.** It is a 1x1
  transparent pixel, present only so `common.icon` in `io-package.json`
  points at a file that exists. It must be replaced with a real icon before
  release.
- **The repository URLs are unverified.** `package.json` (`repository`,
  `bugs`, `homepage`) and `io-package.json` (`common.extIcon`) all assume
  this project lives at `github.com/GalusPeres/ioBroker.hometiles`. If that
  repository does not exist yet, or exists under a different name or owner,
  these fields need to be corrected before publishing — `extIcon` in
  particular is fetched by the ioBroker admin UI from raw GitHub content and
  will silently show a broken image if the URL is wrong.

## License

MIT
