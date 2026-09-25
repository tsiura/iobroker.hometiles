# ioBroker.hometiles

Connects [HomeTiles](https://github.com/GalusPeres/HomeTiles) ESP32-P4 and
ESP32-S3 touch panels to ioBroker over MQTT.

HomeTiles firmware normally talks to Home Assistant through the HomeTiles
Bridge integration. This adapter replaces that backend. The firmware is
**not modified and not forked**: the adapter speaks the same MQTT contract, so
stock HomeTiles firmware works against ioBroker with no reflash.

**New to all this?** Follow
[Step by step: from zero to a working panel](#step-by-step-from-zero-to-a-working-panel).
It assumes no MQTT or HomeTiles knowledge.

## Contents

- [Status: read this first](#status-read-this-first)
- [Step by step: from zero to a working panel](#step-by-step-from-zero-to-a-working-panel)
  - [Troubleshooting for beginners](#troubleshooting-for-beginners)
- [What 0.2.0 covers](#what-020-covers) and
  [what it does not cover](#what-020-does-not-cover)
- [Requirements](#requirements)
- [Setup: every settings tab in detail](#setup)
- [Upgrading from 0.1.0](#upgrading-from-010)
- [Limits and requirements](#limits-and-requirements)
- [Objects](#objects)
- [Hardware checks still outstanding](#hardware-checks-still-outstanding)
- [Development](#development), [Changelog](#changelog), [License](#license)

## Status: read this first

**No physical panel has ever run this adapter.**

Every tile type below is checked against the HomeTiles firmware's own parser
rules, read out of its C++ source, and exercised end to end in tests: against
an in-process MQTT broker, a real js-controller and, for history and energy, a
real `iobroker.history` instance. A green test suite is not evidence of
behaviour on a device. The checks that still need a real panel are listed under
[Hardware checks still outstanding](#hardware-checks-still-outstanding). Treat
0.2.0 as ready to test, not ready to rely on.

0.2.0 is the first release that can serve a panel. 0.1.0 failed during startup
on any installation with ordinary detected devices: it subscribed to every
state in the installation, then stopped with an error before connecting to
MQTT, and js-controller restarted it in a loop.

## Step by step: from zero to a working panel

This guide takes you from nothing to a panel on your wall that shows and
switches your ioBroker devices. You need no MQTT or HomeTiles knowledge. Plan
about an hour. Every step ends with a **Check**: do not go on until it passes.

> **You are an early tester.** 0.2.0 has not yet run on a physical panel (see
> [Status](#status-read-this-first)). If a step does not do what it says, note
> what you saw and what the log says, and report it at
> <https://github.com/tsiura/iobroker.hometiles/issues>.

### How the parts fit together

```text
 your devices ──► ioBroker ──► HomeTiles adapter ──► MQTT broker ◄── network ──► HomeTiles panel
 (lamps, plugs,   (objects,    (this adapter, the    (passes the                  (the touch screen
  sensors, …)      states)      translator)           messages)                    on your wall)
```

- The **panel** runs the HomeTiles firmware. It never talks to ioBroker
  directly. It sends and receives short messages through an **MQTT broker**, a
  small program that passes messages between devices, like a post office.
- The **HomeTiles adapter** is the translator. It tells the panel which devices
  exist, keeps their values up to date, and turns a tap on the panel into a
  command for ioBroker.
- You choose which devices the panel may use in the adapter's settings. Then
  you place tiles in the panel's own web page, the **Web Admin**.

### Step 1: Check what you need

**Hardware**

- A touch panel that HomeTiles supports. Find your **exact** model, including
  its revision, in the
  [HomeTiles device list](https://galusperes.github.io/#device-support), for
  example the M5Stack Tab5 or a Waveshare ESP32-P4 panel.
- A USB **data** cable for the panel. A charge-only cable cannot flash it.
- A computer with desktop **Chrome** or **Edge**, to install the firmware once.
- A **2.4 GHz** Wi-Fi network (the panels' Wi-Fi does not use 5 GHz), or a
  network cable on a panel that has Ethernet. The panel and the ioBroker
  computer must be on the same home network, not a guest network.

**Software**

- ioBroker with **js-controller 6.0.11** or newer, **admin 7.6.17** or newer
  and **Node.js 20** or newer.
- HomeTiles firmware **v0.6.12**, which you install in Step 5. This adapter
  was built against v0.6.12. A newer firmware release probably works, but it
  has not been checked.

**Check your ioBroker versions**

1. Open the ioBroker Admin page in your browser, usually
   `http://<ioBroker-IP>:8081`.
2. Click **Hosts** in the left menu. The row of your computer shows the
   js-controller and Node.js versions.
3. Click **Adapters** and search for `admin`. Its card shows the installed
   version.

If something is too old, update ioBroker first. On Linux the usual way to
update js-controller is `iob stop`, `iob update`, `iob upgrade self` and
`iob start` in a terminal. Update admin from the **Adapters** page. For
Node.js, follow the ioBroker documentation for your kind of installation.

**Keep notes.** You will need these values in the later steps:

| What | Example | Yours |
| --- | --- | --- |
| IP address of the ioBroker computer | `192.168.1.10` | |
| MQTT user name | `hometiles` | |
| MQTT password | a password you choose | |
| IP address of the panel (Step 6) | `192.168.1.50` | |

The ioBroker computer's IP address is the part before `:8081` in the address
you use to open Admin. If you open Admin by a name, such as
`iobroker.local`, run `hostname -I` in a terminal on the ioBroker computer, or
look it up in your router's list of devices.

### Step 2: Set up an MQTT broker

The panel and the adapter meet at the broker.

**If you already run an MQTT broker**, such as Mosquitto, that both the
ioBroker computer and the panel can reach, create a user for HomeTiles on it,
write down the user name and password, and go to Step 3.

**Otherwise, let ioBroker be the broker** with its MQTT adapter:

1. In Admin, open **Adapters**, search for `mqtt` and install
   **MQTT Broker/Client**.
2. Open its settings (**Instances**, then the wrench icon of `mqtt.0`) and set
   **Type** to **Server/broker**.
3. Leave **Port** at `1883`.
4. Under **Authentication**, enter a user name, such as `hometiles`, and a
   password. Write both down.
5. Leave the other settings as they are, then click **Save and close**.

The ioBroker MQTT broker keeps each message it receives as a state under
`mqtt.0`, so HomeTiles topics will show up there. That is normal.

**Check:** In **Instances**, `mqtt.0` (or your own broker) is running.

### Step 3: Install the HomeTiles adapter

The adapter is not in the ioBroker repository yet, so you install it from its
file, named like `iobroker.hometiles-0.2.0.tgz`. **Keep the file name as you
got it.** ioBroker reads the adapter's name from it.

1. Copy the file to the ioBroker computer, for example into `/tmp`. On Windows
   use a tool such as WinSCP. On macOS or Linux run
   `scp iobroker.hometiles-0.2.0.tgz <user>@192.168.1.10:/tmp/`.
2. Open a terminal on the ioBroker computer (for example over SSH) and run
   these two lines, with your file's exact name:

   ```sh
   chmod a+r /tmp/iobroker.hometiles-0.2.0.tgz
   iobroker url /tmp/iobroker.hometiles-0.2.0.tgz
   ```

   The second command installs the adapter together with its settings page.
   Wait until it finishes without an error.
   - **ioBroker in Docker:** copy the file into the container with
     `docker cp`, then run the same command inside it, for example
     `docker exec -it iobroker iobroker url /tmp/iobroker.hometiles-0.2.0.tgz`.
     Your container's name may differ.
3. In Admin, open **Adapters**, find **HomeTiles** and click **+** to add an
   instance. Alternatively, run `iobroker add hometiles` in the terminal.

**Check:** **Instances** lists `hometiles.0`.

### Step 4: Connect the adapter to the broker

Open the settings of `hometiles.0` (**Instances**, then its wrench icon). On
the **Connection** tab:

1. **MQTT broker host:** the broker's IP address, such as `192.168.1.10`. Use
   the real network address even when the broker runs on the ioBroker computer
   itself. **Never enter `127.0.0.1` or `localhost`.** The adapter hands this
   address to the panel when it pairs, and for the panel `127.0.0.1` means the
   panel itself.
2. **Port:** `1883`.
3. **Username** and **Password:** the MQTT user from Step 2.
4. Leave **Use TLS** off. Leave **MQTT client id**, **Panel base topic**
   (`hometiles`) and **Entity state prefix** (`ha/statestream`) as they are.
5. Click **Test broker connection**. It must answer "Connected to the MQTT
   broker at …". If it does not, see
   [Troubleshooting](#troubleshooting-for-beginners).
6. Click **Save and close**. Saving restarts the adapter, which is normal and
   happens at every save.

**Check:**
- `hometiles.0` turns green in **Instances**.
- In **Objects**, `hometiles.0.info.connection` is `true`.

### Step 5: Install the HomeTiles firmware on the panel

Skip this step if your panel already runs HomeTiles v0.6.12. The panel shows
its version under **Settings → System**.

1. Connect the panel to your computer with the USB data cable.
2. Open the HomeTiles online flasher in Chrome or Edge:
   <https://galusperes.github.io/installer/>.
3. Fill in the flasher's sections:
   - **1. Firmware:** keep the published release.
   - **2. Device:** select the exact model printed on the device or on its rear
     label.
   - **3. Flash mode:** choose **First install / factory reset** for a new
     panel. This erases everything on it. Choose **Update** only for a panel
     that already runs HomeTiles and should keep its settings.
   - **4. Confirm:** tick the confirmations.
   - **5. Connect and flash:** click **Connect and flash** and choose the
     panel's port in the browser's pop-up.
4. Keep the cable plugged in and the browser tab open until the flasher says
   it has finished.
5. Restart the panel.

If the browser shows no port, try another cable or USB port and close other
programs that use the port. Some panels need their **BOOT** button held down
while you connect. The flasher page has more help.

**Check:** the panel starts and shows the HomeTiles screen.

### Step 6: Connect the panel to Wi-Fi

1. On the panel, open **Settings → WiFi**, choose your network and enter its
   password.
   - **Typing on the panel is awkward?** Tap **Enable AP** instead. Connect
     your phone to the panel's own Wi-Fi hotspot (password `12345678`) and
     enter your Wi-Fi details on the page that opens. The hotspot switches off
     after 10 minutes.
2. Write down the panel's IP address. **Settings → WiFi** on the panel shows
   it.

**Tip:** in your router, give the panel a fixed IP address, often called a
"DHCP reservation", so that it never changes.

**Check:** on your computer, open `http://<panel-IP>/`. The panel's Web Admin
page appears.

### Step 7: Pair the panel with ioBroker

Pairing hands the panel the broker's address and login.

1. Open the settings of `hometiles.0` and go to the **Panels** tab.
2. **Panel address:** the panel's IP address from Step 6.
3. Click **Pair a panel by address**. The answer should be "Credentials sent to
   the panel at … It restarts now and then connects to the broker."
4. Wait about a minute while the panel restarts.

**Check:**
- In **Objects**, `hometiles.0.panels` now holds your panel, under an id of
  12 letters and digits.
- Its `info.connected` is `true`.

The adapter pairs only while it is connected to the broker itself, which is
the check of Step 4. For any other message, see
[Troubleshooting](#troubleshooting-for-beginners).

**If pairing keeps failing, enter the settings by hand:**

1. Open `http://<panel-IP>/`, go to the **Settings** tab and find **MQTT**.
2. Enter these values, then select **Save**. The panel reconnects.
   - **Host:** the broker's IP address.
   - **Port:** `1883`.
   - **Username / Password:** the MQTT user from Step 2.
   - **Device topic base:** `hometiles`.
   - **Home Assistant prefix:** `ha/statestream`. The panel keeps its Home
     Assistant name for this field; with ioBroker it means the same.

**A second panel needs its own base topic.**

1. Before pairing it, open the **Connection** tab.
2. Change **Panel base topic** to a new value, such as `hometiles2`, and save.
3. Pair the second panel.

When entering the settings by hand, use that value as its **Device topic
base**. The first panel keeps working, because the adapter uses the topic
each panel reports for itself.

### Step 8: Choose what the panel may show

Nothing reaches the panel until you choose devices.

1. Open the settings of `hometiles.0` and go to the **Devices** tab.
2. Click **Refresh detected devices**. A table lists every device ioBroker
   could recognise, with its **Type** (Light, Switch, Sensor, …) and its room.
3. Tick **Show on panels** for each device the panel should get. Start with a
   few, such as a lamp and a thermometer.
   - Optionally, give a device a friendlier **Name override**.
   - **Preview** shows exactly what the adapter sends to the panel for that
     device.
4. Click **Save and close**. The adapter restarts and sends your choice to the
   panel.

> **Warning:** from the first save on, each panel removes its tiles for
> everything it is not given. A new panel has nothing to lose. For a panel that
> already has a layout, for example from Home Assistant, save it first: open
> the panel's Web Admin, go to **Import / Export** and click **Export**.

**Your device is not in the table?** ioBroker recognises a device by the roles
of its states. There are two ways to add one:

- **A single state,** such as a helper in `0_userdata.0`: add it under
  **Manual entities** on the same tab. Pick the **State**, choose its **Type**,
  and save.
- **A whole device:** ioBroker's **Devices** adapter can create a properly
  typed alias for it, which the next **Refresh detected devices** finds.

**Check:**
- In **Objects**, `hometiles.0.info.entities` shows how many entities were
  published.
- The log (Admin, **Log**, filter `hometiles`) has a line such as
  "Configuration pushed, 12 entities, 2310 of 32767 bytes".

### Step 9: Put tiles on the panel

1. Open the panel's Web Admin at `http://<panel-IP>/`.
2. Click an empty cell in the grid.
3. Choose the tile **Type** that fits the device:

   | Device in ioBroker | Tile type on the panel |
   | --- | --- |
   | Lamp, dimmer, colour light, plug, switch | **Switch**. A lamp's tile also opens brightness and colour controls. |
   | Thermometer, humidity, light level, a value or text | **Sensor** |
   | Window or door contact, motion, smoke, water leak | **Binary Sensor** |
   | Blind, shutter, gate | **Cover** |
   | Thermostat, air conditioner | **Climate** |
   | Media player | **Media** |
   | Weather adapter | **Weather** |
   | Button or scene | **Scene** |
   | Adjustable number, options list, date or time | **Number**, **Select**, **Date/Time** |
   | Energy meter (Step 10) | **Energy** |

4. Choose the device in the entity list. The list shows the devices of that
   type that you ticked in Step 8.
5. Optionally, set a **Title**, an **Icon** and a **Color**. The icon is a
   Material Design Icons name, such as `mdi:lamp`.

Changes save automatically and appear on the panel at once.

**Check:**
- Tap the tile on the panel: the lamp switches, and its state changes in
  ioBroker's **Objects**.
- Switch the lamp from ioBroker: the tile follows.

**Your panel works.**

### Step 10 (optional): graphs, energy and thermostat modes

- **Graphs and timelines** (tap a sensor tile) need a history instance:
  1. Install the **History** adapter if you have none. SQL and InfluxDB work
     too.
  2. In **Objects**, open the settings of each chosen state (the gear icon)
     and enable logging in that instance.
  3. On the adapter's **Advanced** tab, select it as the **History instance**.

  Details: [Advanced tab](#6-advanced-tab-the-history-instance).
- **Energy tiles:** add your meters that count up, such as kWh totals, on the
  **Energy** tab, and log each of them in the history instance. Details:
  [Energy tab](#5-energy-tab-energy-meters).
- **Thermostat mode buttons**, for thermostats whose modes have their own
  names such as MANU or AUTO: map the modes under **Climate modes** on the
  Devices tab. Details: [Climate modes](#4-climate-modes).

### Everyday use

- **After a settings save:** the adapter restarts, and the panel reconnects by
  itself within seconds.
- **When ioBroker or the broker is down:** the panel keeps showing the last
  values and reconnects when they are back.
- **More devices later:** on the **Devices** tab, click **Refresh detected
  devices**, tick the new devices and save. Then add their tiles in the Web
  Admin.
- **Updating the adapter:**
  1. Read [Upgrading from 0.1.0](#upgrading-from-010) and the
     [Changelog](#changelog) first.
  2. Run `iobroker url` with the new file.
  3. Run `iobroker restart hometiles`.
- **Updating the panel's firmware:** on the panel, use **Settings → System →
  Check for updates**, or use **Firmware** in the Web Admin. First check which
  firmware version this adapter supports, under
  [Requirements](#requirements).
- **Brightness, screensaver, rotation and sleep** of each panel can be set
  from ioBroker, in `hometiles.0.panels.<id>.control.*`. See
  [Objects](#objects).

### Troubleshooting for beginners

**Look at the log first.** Open Admin, go to **Log** and filter for
`hometiles`. The messages are in English and name the problem.

| What you see | What to do |
| --- | --- |
| **Test broker connection** says "No connection" or "did not complete the connection in time" | Check the host (an IP address), the port (`1883`) and that the broker runs (`mqtt.0` green). A firewall on the ioBroker computer must allow port 1883. |
| The log says "Connection refused", or the broker refuses the login | The user name or password is wrong. Enter the password again on the **Connection** tab and save. |
| `hometiles.0` stays yellow | The adapter is not connected to the broker. Do the same checks as above. |
| Pairing says the panel "did not answer" | Check the panel's IP address. Check that the panel is on and has finished Step 6: its hotspot mode has no Web Admin. A computer and a panel in different networks, such as a guest Wi-Fi, cannot reach each other. |
| Pairing says "not connected to the broker, so nothing was sent" | Finish Step 4 first, then pair again once `hometiles.0` is green. |
| The panel does not appear under `hometiles.0.panels` | Open `http://<panel-IP>/`, go to **Settings**, then **MQTT**. The host must be the broker's IP address, not `127.0.0.1`, and the port, user name and password must be right. On the panel, **Settings → System → Pairing** announces the panel again. |
| The entity list in the Web Admin is empty | Step 8 is not done yet (**Refresh**, tick, **Save**), or nothing of that tile's type is ticked. |
| A tile shows `--` or "unavailable" | The ioBroker state has no value yet, or its device is offline. For an alias, the log names aliases whose target is missing. |
| A graph shows only the current value, or a popup says "History unavailable" | Logging is not enabled for that state. See Step 10. |
| Changing a number, select or date/time fails as "expired" | The clocks of the panel and of the ioBroker computer differ. On the panel, set the time zone under **Settings → Localization**, and let both get their time from the internet (NTP). |
| The log says the installation is incomplete and names `iobroker upload hometiles` | Run `iobroker upload hometiles`, then `iobroker restart hometiles`. |
| The log says the broker password "could not be decrypted" | Enter the password again on the **Connection** tab and save. |
| The log says the configuration is over 32767 bytes | Too many devices are ticked. Untick some or shorten long names. See [Limits](#limits-and-requirements). |

For problems on the panel itself, such as the display, Wi-Fi or updates, see
the [HomeTiles troubleshooting page](https://galusperes.github.io/faq/). To
read the panel's own log over USB, use
[HomeTiles device logs](https://galusperes.github.io/device-logs/).

### Words used in this guide

- **MQTT:** a simple way of sending messages that many smart-home devices use.
- **Broker:** the program that passes MQTT messages between devices.
- **Topic:** the address an MQTT message is sent to.
- **Base topic:** a panel's own MQTT address. Every panel needs a different one.
- **Entity:** one thing a panel can show or control, such as a lamp or a
  sensor, as the adapter describes it to the panel.
- **Tile:** a square on the panel's screen, showing one entity or something of
  the panel's own, such as a clock or a folder.
- **Instance:** one running copy of an adapter, such as `hometiles.0`.
- **Object and state:** an object is ioBroker's description of a value, such
  as a lamp's on/off; the state is the value itself.
- **Web Admin:** the panel's own settings page, at `http://<panel-IP>/`.

## What 0.2.0 covers

| Tile type | Made from | On the panel |
| --- | --- | --- |
| Sensor (numeric and textual) | ioBroker temperature, humidity, illuminance, pressure and info devices; a manual entity | the value; a 24 h / 7 day graph for a number, a timeline with Activity for a text |
| Binary sensor | window, door, contact, motion, fire, flood, CO and warning devices; a manual entity | on/off; a timeline with Activity |
| Switch | socket devices; a manual entity | on, off, toggle |
| Light | light, dimmer, RGB, colour-temperature (kelvin or mired), Hue and single-channel colour devices | on/off, brightness, RGB colour, colour temperature |
| Scene | button devices; a manual entity | activate |
| Climate | thermostat and air conditioner devices | setpoint (single, or a heat/cool range), current temperature and humidity, mode, fan and swing buttons, the running action |
| Cover | blind, blind-button and gate devices | open, close, stop, position, tilt |
| Media player | media player devices | play/pause, previous, next, volume, mute, seek, title, artist, album, cover art |
| Weather | a weather adapter's current and forecast channels | current conditions and the daily forecast |
| Number | an adjustable level that is its device's only control; a manual entity | set a value within its range and step; a history graph |
| Select | a state with a states list, by Forced type or as a manual entity | pick an option; a timeline |
| Date/time | a date/time text or an epoch-ms state, by Forced type or as a manual entity | set a date, a time, or both; a timeline |
| Energy | energy meters on the Energy tab | energy tiles and popup: today by the hour, the week by the day, costs and totals |
| Panel settings | | brightness, screensaver, rotation, sleep, as `panels.<deviceId>.control.*` |
| Local hardware I/O | | relays and DS18B20 sensors on panels that have them, as `panels.<deviceId>.io.*` |
| Pairing | | send broker credentials to a panel by its address |

Weather detection was checked against the object trees of OpenWeatherMap
2.0.0, Weather Underground 3.7.0, AccuWeather 2.3.0 and DasWetter 4.5.10,
rebuilt from their published packages. OpenWeatherMap and Weather Underground
each become one weather entity with its forecast days; AccuWeather becomes
three entities and DasWetter five one-day entities, because their objects hold
nothing that links the parts. OpenWeatherMap's first forecast day covers only
the rest of today, so today's high and low can fall during the afternoon; the
adapter shows the provider's own values, as its own widgets do.

## What 0.2.0 does not cover

- **Camera.** Deliberately absent. The adapter serves no camera, and each
  configuration it pushes clears the panel's camera list.
- **The panel's own outside and inside temperature** (`mqttPublishHomeSnapshot`,
  `<base>/sensor/{outside_c,inside_c}`): firmware placeholders, never fed by a
  real sensor, deliberately left out. The battery charge on the same
  HomeSnapshot message (`soc_pct`) is read instead, as
  `panels.<deviceId>.info.battery`, for a panel that announces the
  `battery_soc` capability (the Tab5); the panel sends it once per broker
  connection, so it refreshes when the panel reconnects, not continuously.
  Discovery (`mqttPublishDiscovery`) and DynamicSlotsReload
  (`mqttRequestDynamicSlotsReload`) need nothing from ioBroker: the panel only
  removes its own legacy Home Assistant discovery entries, and reloads its own
  dynamic subscriptions internally.
  [docs/protocol.md](docs/protocol.md#not-implemented) has what is known.
- **Climate presets, humidity targets, power and boost.** No ioBroker climate
  pattern has a preset or a writable humidity target, and the panel sends no
  power or boost command.
- **Thermostat modes with names of their own** (such as MANU or AUTO-MODE) get
  no buttons unless the Climate modes table maps them; a mode state without a
  states list gets none.
- **An hourly weather forecast.** ioBroker's weather patterns carry no hourly
  data.
- **Energy counters that reset daily**, price entities (only a fixed price per
  unit), and unit conversion (a category total adds its meters' values as
  they are).
- **A meter's reading right after a start**: a meter whose history is not read
  within 7 s of the adapter starting shows 0.000 until the panel's next
  request, about a minute later.
- **Colour on single-channel colour lights** (`rgbSingle`, `rgbwSingle`,
  `cie`): the colour is one combined value, and there is no encoder for it.
  Such a light still works for on/off, brightness and colour temperature; only
  the colour picker is absent.
- **Colour temperature from a state whose declared min and max are inverted
  or equal**: such a state gets no colour-temperature control.
- **On/off for a level detected as a Number**: it carries none. Add its switch
  state as a manual Switch entity.
- **Media:** a stop button (the panel has none), a seek bar for a SEEK state
  whose unit is neither empty nor `%`, and cover art that is not an absolute
  `http(s)://` URL. A player whose only play state is text (a string
  `media.state`) is detected as a sensor, and a Chromecast whose detection
  binds its `…paused` state gets no media tile.
- **Select and date/time are never detected on their own**: use a Forced type
  on the Devices tab, or a manual entity.

## Requirements

- ioBroker js-controller 6.0.11 or newer, and Node.js 20 or newer.
- An MQTT broker reachable by both ioBroker and the panels. The ioBroker `mqtt`
  adapter in broker mode, or any external broker, should work (not tested; the
  tests use an in-process aedes broker).
- HomeTiles firmware v0.6.12. The 0.2.0 wire contract was read from its source
  (commit `5d25167`); the v0.1 domains were first read at v0.6.9. Other
  versions were not checked.
- For graphs, timelines and energy: a history, SQL or InfluxDB instance.
- ioBroker admin 7.6.17 or newer. It is declared as a global dependency, but
  js-controller checks that only when the adapter is installed from the
  ioBroker repository. An install or upgrade from GitHub or another URL, the
  only way until the adapter is in the repository, is not checked. Make sure
  admin is up to date before you upgrade. An admin older than 6.2.3 encrypts
  the broker password in a form the adapter cannot tell from plain text:
  beside such an admin the adapter migrates no password, logs an error at
  each start, and uses the password as js-controller decrypts it. If the
  broker then refuses it, enter the password again on the Connection tab and
  save.
- For the settings page, by the version of admin's json-config component:
  - json-config 8.1.10 or newer for the Preview dialog on the Devices tab.
    Older versions answer the button with a bare "Ok".
  - json-config 9.0.24 or newer for the Direction list on the Energy tab to
    follow a change of the row's Category at once. json-config 8.4.0 up to
    9.0.23 offers the new choices only after the settings are saved and
    reopened.
  - Admin 8.0.11 was checked to contain both. For the other admin versions the
    json-config version is inferred from release dates, not read from the admin
    itself. The dialog relies on json-config's `copyDialog` reply, which its
    documentation does not describe.

## Setup

Every settings tab in detail. For a first installation, follow
[Step by step](#step-by-step-from-zero-to-a-working-panel) instead; it links
back here where the details matter.

### 1. Connection tab: the broker

1. Install the adapter and open its settings.
2. Enter the broker host, port, TLS, user name and password.
3. **Panel base topic** and **Entity state prefix** are what pairing writes
   into a panel. Leave the prefix at `ha/statestream` unless you changed it on
   the panel. At runtime each panel's own announced values are used.
4. **Test broker connection** tries the values as typed, before you save, and
   shows the broker's answer.

### 2. Devices tab: pick what the panels get

Nothing is published to a panel until you click **Refresh detected devices**
and **save**. Until then each panel keeps the layout it has, whatever an
earlier version or the Home Assistant Bridge left.

1. With the adapter running, click **Refresh detected devices**. It detects
   the devices anew and fills the **Detected devices** table: rows you
   already have keep your choices, and new devices are added unticked.
2. Tick **Show on panels** for each device the panels should get. Optionally
   set a **Name override**, or a **Forced type** to publish the device as
   another tile type, for example a text state with a states list as a Select.
3. **Preview** in a row shows the MQTT topic and payload the row would
   publish, unsaved edits included. A device that is new since the last start
   can be previewed after saving.
4. Save. Saving restarts the adapter.

**Saving prunes the panels.** From the first save on, each panel removes its
tiles for every entity it is not given, and saves that to flash. It is given
the ticked devices, every manual entity and every energy meter, even with no
device ticked. **Export each panel's tile layout first if you want to keep
it.**

A device keeps its entity id when it is renamed in ioBroker, and when it is
unticked and ticked again. Rows of devices no longer detected are marked
"(not detected)" and can be deleted.

### 3. Manual entities

For a state no detection reaches, such as a helper in `0_userdata.0`: add a
row under **Manual entities** on the Devices tab with the **State**, the
**Type** and, optionally, a **Name override**. Every row is published once
the Devices tab has been refreshed and saved. What each type needs:

| Type | The state |
| --- | --- |
| Sensor | a number, a text or a mixed value |
| Binary sensor | a boolean, a number (0 is off) or an on/off text |
| Switch, Scene | a boolean that is not read-only |
| Number | a number with `common.min` and `common.max` (a `%` unit alone means 0 to 100); `common.step` is optional |
| Select | a number or a text with a states list of 1 to 64 labels, no two the same in any case |
| Date/time | a text holding `YYYY-MM-DD`, `HH:MM[:SS]` or `YYYY-MM-DD HH:MM[:SS]`, or a number holding epoch milliseconds (a date and a time) |

**Date/time kind** matters only for a text state that holds no value yet:
choose Date, Time or Date and time, so the panel knows which editor to show
before anything is written. Leave it at From the value otherwise: the value's
own shape decides, and a kind that differs from that shape makes the tile
read-only, which the log says.

The log names each row the adapter cannot use, and why, and each manual value
that comes out read-only, with what it lacks (such as "no min/max"). The
state is the manual entity's identity: pointing a row at another state or
changing its type gives it a new entity id.

### 4. Climate modes

A panel knows only its own mode names: `off`, `heat`, `cool`, `heat_cool`,
`auto`, `dry` and `fan_only`. A thermostat whose modes are named otherwise,
such as a Homematic thermostat's AUTO-MODE and MANU-MODE, gets no mode
buttons. Map such modes in the **Climate modes** table on the Devices tab:

1. Pick the **Thermostat**. The list holds the detected thermostats, and saved
   picks forced to Climate. The thermostat must be ticked under Detected
   devices.
2. Enter the **Device mode** as its value or its label, such as `MANU-MODE` or
   `1`.
3. Choose the **Panel mode** it stands for, such as Heat.

The panel's Heat button then writes MANU-MODE's own value. Each panel mode
stands for at most one mode of a thermostat. A mode mapped nowhere keeps its
own name: one of the panel's names stays a button, any other has none. A mode
state without a states list cannot be mapped. The log names each row the
adapter cannot use, and why. Only the mode is mapped, not the running action.

### 5. Energy tab: energy meters

Add one row per meter: an ioBroker **State** holding a **cumulative** counter,
such as a kWh or m³ total, with its **Category** (grid, solar, battery, gas,
water, device, water device), **Direction**, an optional **Name override**
and an optional **Price per unit** in the **Currency** below (default EUR).

- **Cumulative counters only.** A counter that resets every day, such as
  "energy today" or a daily yield, is not supported: its weeks and months
  would be wrong. A counter that drops is read as a reset, and counting goes
  on from the new value.
- **Direction:** solar and battery discharge count as import; battery
  charging and grid feed-in count as export, and show negative. A device or
  water device is always import.
- Each meter's consumption comes from the history instance (step 6), so **each
  meter's state must be logged there**. A meter nothing logs shows 0.000; the
  log names it.
- An energy tile shows today's total; its popup shows today by the hour and
  the week by the day, in the ioBroker host's time zone.
- A price adds a cost entry. A category with two or more meters also gets a
  total, and the house gets a **Total consumption** from its grid, solar and
  battery meters, plus an **Untracked consumption** when device meters are
  set. **While any grid, solar or battery meter is unknown**, **the house
  totals show 0.000**: for example a meter the history instance does not log
  (the log names it), or one with no readings yet.
- On a panel, pick the meters as `energy.<name>`, a category total as
  `<category>_total` (for example `grid_total`), and the house as
  `consumption_total` and `consumption_untracked`.
- **Meters publish and prune once armed.** Like devices, meters reach the
  panels only after Refresh detected devices and Save on the Devices tab. From
  then on they are published even with no device ticked, and each panel
  removes its tiles for everything it is not given.
- If the **Direction** column offers no export after a row's Category was
  changed, save and reopen the settings (see the admin versions under
  [Requirements](#requirements)).

### 6. Advanced tab: the history instance

**History instance** is the history, SQL or InfluxDB instance the panels read
graphs, timelines and energy from. With none chosen, the system's default
history instance is used, if one is set.

**Enable logging in that instance for every state a panel should show history
for**, in the state's custom settings in the admin's Objects tab: each picked
sensor, binary sensor, number, select and date/time, and each energy meter.
Without it a graph (tile or sensor popup) shows only the current value, a
timeline popup (binary, text, number, select, date/time) says "History
unavailable", and an energy tile shows 0.000.

The history adapter was run for real in the tests; SQL and InfluxDB were
checked from their sources only.

Two storage differences show on the panel: InfluxDB stores no empty (null)
values, and SQL stores an empty boolean as false, so a binary timeline read
from SQL shows "off" where the state was empty.

### 7. Panels tab: pairing

A panel that already has broker credentials announces itself and appears
under `hometiles.0.panels.<deviceId>` automatically. A brand-new panel has
none:

1. Save the Connection tab first: pairing sends the saved values. The broker
   host must be an address the panel can reach, not 127.0.0.1 or localhost.
   Pairing sends nothing while the adapter is not connected to the broker:
   it sends only credentials the adapter itself connects with.
2. Enter the panel's IP address or host name in **Panel address** and click
   **Pair a panel by address**.
3. The adapter posts the broker address, port, user, password, panel base
   topic and entity prefix to the panel's setup page, then restarts the panel.
   The dialog shows the outcome.

An announced panel can be paired again with its `control.pair` button.

Every panel needs its own base topic: two panels announcing the same one share
their command and status topics, and the log warns. Before pairing a second
panel, change **Panel base topic** on the Connection tab and save.

## Upgrading from 0.1.0

- **The broker password is stored encrypted since 0.2.0.** A password 0.1.0
  stored in plain text is migrated automatically at the first start: the
  adapter stores it encrypted, which restarts it once, and logs one line
  saying so.
  - **Start the adapter once after upgrading, and wait for the log line
    "…it is stored encrypted now" (the adapter restarts once), before you
    open its settings page.** A settings page opened earlier can save an
    unusable value over the password.
  - **If the log then says the password could not be decrypted, or the broker
    refuses the login ("Connection refused"), enter the password again on the
    Connection tab and save.** Pairing sends nothing until the adapter shows
    connected: it sends the password the adapter holds.
- **Picks start over.** Nothing is published until you click Refresh detected
  devices, tick the devices again and save: rows and ticks saved by 0.1.0
  builds are shown unticked and publish nothing. Each panel keeps its layout
  until then.

## Limits and requirements

- **Secure the broker.** Anyone who can publish to a panel's `cmnd/*` topics
  can command every entity the adapter publishes, exactly as a panel can; the
  tokens in number, select and date/time commands are readable from their
  retained state and prove nothing. The Home Assistant Bridge has the same
  exposure. Anyone who can publish a panel's `stat/ip` can also make its
  `control.pair` send the broker password to a host of their choosing.
  Protect the broker with user names and an ACL.
- **Pairing sends the broker password over plain HTTP** to the panel's setup
  page. Pair on a network you trust.
- **Clocks: keep the panel within about 5 s ahead of the ioBroker host's
  clock, or 10 s behind it.** Number, select and date/time commands carry a
  deadline from the panel's clock, and outside that window every one is
  refused as expired. Use NTP on both. The log warns, at most once an hour per
  panel, once the offset reaches about 7 s ahead or 12 s behind. A panel sends
  no such command before its clock is set.
- **Editable numbers carry about 7 significant digits.** The panel handles
  them as 32-bit floats. A value with more digits (20000002, or 12345.125 on a
  step of 0.001) is sent by the panel already rounded, is written as sent, and
  the panel shows an error after 30 s because the value it then sees is not
  the one it asked for. Choose a range and step whose values need no more
  than 7 significant digits.
- **The ioBroker host and the panels must share a time zone.** The host's
  zone decides the weather forecast's days, the energy periods (midnight, the
  hours, the week, the month), and the date and time of an epoch-ms date/time
  state. A Docker container without `TZ` runs in UTC: set `TZ`, for example
  `TZ=Europe/Berlin`, or the forecast shifts by a day and the energy day
  starts at the wrong hour.
- **Only `mdi:` icons are shown**, Material Design Icons names such as
  `mdi:lamp`. Only `mdi:` names are used as tile icons: other icons are left
  out of the configuration and the icon map, so such a tile shows its type's
  default icon (light, climate and cover state payloads still carry the
  object's icon text, which the panel ignores). An `mdi:` name the panel does
  not know shows as "?".
- **A panel takes one configuration of at most 32767 bytes.** It holds every
  picked entity's id, name and icon, the energy catalog and the scene list. A
  configuration over the limit is not published: the log names its size and
  its three largest sections, and each panel keeps its last one. Trim it by
  ticking fewer devices, removing manual entities or energy meters, or
  shortening long names with Name override. In a realistic test
  configuration about 270 entities fitted, or about 195 with an `mdi:` icon on
  every one. The log's "Configuration pushed, N entities, B of 32767 bytes"
  line shows how close an installation is.
- **At most 128 numbers, selects and date/times** per panel, the first 128 by
  entity id; the log names how many were left out.
- **A select's options:** 1 to 64, each at most 255 bytes, no line breaks, no
  two the same in any case. Otherwise the select is read-only. A select whose
  options take its payload over the panel's 24576 bytes goes out without
  them, read-only, with a warning.
- **A command a device cannot take is refused**, never reported as done: a
  read-only state, a value outside the declared range (never clamped), a mode
  label the state cannot hold (a light's brightness or colour temperature, or
  a player's volume, that the device cannot take is skipped and logged; the
  rest of the command still lands). Number, select and date/time refusals are
  answered to the panel. Every other refusal is only in the adapter's log;
  the panel then shows the unchanged state.
- **An alias whose target cannot be read is left out.** An alias with no
  target or an invalid one is neither subscribed nor read: its device shows
  unavailable until the alias is repaired and the adapter restarted, and the
  log names each such alias. An alias whose target is missing or not a state
  is subscribed and read all the same, and the log names it too: its device
  shows unavailable until the target exists, and js-controller follows it
  then, with no restart. A js-controller call at start that is not answered
  within 5 s is given up: the log names it, and its device may show
  unavailable until the adapter restarts.

## Objects

The adapter's own states, and each panel as a device with its own status and
control states, usable from scripts and vis:

```text
hometiles.0.info.connection          broker connected
hometiles.0.info.panels              announced panels
hometiles.0.info.entities            published entities
hometiles.0.panels.<deviceId>.info.connected
hometiles.0.panels.<deviceId>.info.ip
hometiles.0.panels.<deviceId>.info.baseTopic
hometiles.0.panels.<deviceId>.info.model
hometiles.0.panels.<deviceId>.info.battery     charge %, panels that announce it
hometiles.0.panels.<deviceId>.control.display_brightness
hometiles.0.panels.<deviceId>.control.screensaver_brightness
hometiles.0.panels.<deviceId>.control.display_rotate
hometiles.0.panels.<deviceId>.control.display_sleep
hometiles.0.panels.<deviceId>.control.sleep_mains
hometiles.0.panels.<deviceId>.control.sleep_battery
hometiles.0.panels.<deviceId>.control.pair       send the broker credentials again
hometiles.0.panels.<deviceId>.control.refresh    push the configuration again
hometiles.0.panels.<deviceId>.io.<channelId>
```

`info.entityIds`, `info.rootAnchors` and `info.publishedIds` are the adapter's
own records of entity ids; do not edit them.

## Hardware checks still outstanding

A green test suite is not evidence of behaviour on a device. These need a real
panel:

1. Announcement and configuration push against real firmware, including the
   panel's Web Admin entity dropdowns populating.
2. Light popup slider interaction, including the final value on release.
3. Retained state surviving a panel reboot with the adapter running.
4. Pairing a factory-fresh panel by IP address.
5. Local relay and DS18B20 channels on a panel that has them.
6. Climate: a single setpoint and a heat/cool range, current temperature and
   humidity, and the mode, fan and swing buttons, each landing on the device.
   On an air conditioner with two swing channels, check that each swing
   control moves the vanes it names: the numeric SWING is sent as
   `swing_mode` and the on/off one as `swing_horizontal_mode`, which nothing
   in the device's objects confirms.
7. Climate modes table: a thermostat with its own mode names (MANU, AUTO)
   gets the mapped buttons, and each writes the right value.
8. Cover: open, close, stop, the position slider and presets, and tilt, on a
   blind and on a gate; a blind whose range is not 0..100 (such as 0..255)
   goes to the percentage shown.
9. Media player: play/pause, previous, next, the volume slider, the mute icon,
   the seek bar, and cover art over `http://` and `https://`, on an ESP32-P4
   and an ESP32-S3 panel.
10. Weather: current conditions and each forecast day under the right weekday,
    with the condition icons, for each weather adapter in use.
11. Number: editing by slider, by +/- and by roller; the `stat/value` answer;
    the new value confirmed on the tile; and a value beyond 7 significant
    digits.
12. Select: the dropdown lists the options, a choice lands, and a current
    value that is none of the options shows above them.
13. Date/time: date, time, and date-and-time tiles, for a text helper and for
    an epoch-ms state.
14. History: a sensor's 24 h and 7 day graph in the popup and on a graph tile,
    binary and textual timelines with Activity, and the history of a number,
    select and date/time popup, from a real history, SQL and InfluxDB
    instance.
15. Energy: tiles and the day and week popup, an export meter shown negative,
    cost entries, category totals, and the house's total and untracked
    consumption.
16. Opt-in picking on a panel that already has a layout: nothing changes
    before the first Refresh and Save; afterwards the unpicked tiles go; the
    exported layout can be restored.
17. The clock window: a panel whose clock is off by 7 s ahead or 12 s behind
    or more gets "expired" for number, select and date/time commands, and the
    log names the offset.
18. Many editable values: up to 128 retained number, select and date/time
    states arrive together after a reconnect, against the panel's inbound
    queue of 64 messages; watch the panel's log for "Inbound queue full".
19. Icons: `mdi:` icons show on the tiles, a removed icon is cleared, and a
    tile without one shows its type's icon.
20. Upgrading a 0.1.0 installation with a saved broker password: it connects
    after one restart, and the password is stored encrypted.
21. Reconnect snapshot: each time a panel announces itself (after every
    connection), the adapter sends every picked entity's state again. After a
    broker restart that lost its retained messages, every tile shows its
    state again; watch the panel's log for "Inbound queue full".
22. Battery charge: on a Tab5, `panels.<deviceId>.info.battery` shows the
    charge after the panel connects; a mains-powered panel has no such state.

Until those are done, treat 0.2.0 as ready to test, not ready to rely on.

## Development

`npm run check` lints, builds and runs the unit tests. The integration tests
run the adapter under a real js-controller, with a real iobroker.history,
against in-process MQTT brokers. They are opt-in and need the network the
first time:

```sh
npm run build
HOMETILES_INTEGRATION=1 npm test
```

They install js-controller, the packed adapter and iobroker.history under
`$TMPDIR/test-iobroker.hometiles` (about 200 MB) and reuse that directory on
later runs. Every port they open is one the system hands out, but the
directory holds one run's databases: **two integration runs at the same time
need two different `TMPDIR`s**, for example `TMPDIR=/tmp/run-a` and
`TMPDIR=/tmp/run-b`. An install that fails, a full disk or quota included,
stops the run with npm's own error; only a missing network skips the suites
that need iobroker.history.

## Protocol

The wire contract this adapter implements is documented in
[docs/protocol.md](docs/protocol.md), with the evidence in the
`docs/contract-*.md` files it lists.

## Release blockers

Before this adapter is published to npm or submitted to the ioBroker
repository, the hardware checks above are outstanding, and so is whatever
`npx @iobroker/repochecker` reports when run online against the pushed
repository. Its io-package.json and README checks, run offline at the end of
0.2.0 development, left these:

- **E1024:** the main file, `build/main.js`, is not in the git repository
  (`build/` is ignored), and the checker reads it from GitHub.
- **Warnings:** admin 7.6.20 is recommended over the declared 7.6.17
  (W1056), and `titleLang`, `desc` and the news have no translations beyond
  English and German (W1027, W1034, W1054).

Its other checks (package.json, npm, the repository, the code, the tests,
GitHub, the licence file and the ignore files) need the network and were not
run.

## Changelog

### 0.2.0

- First release that can serve a panel: 0.1.0 failed at startup and
  restarted in a loop on any installation with ordinary detected devices.
- New tile types: climate, cover, media player, weather, number, select and
  date/time.
- History for graphs and timelines from a history, SQL or InfluxDB instance;
  energy tiles from cumulative energy meters on the Energy tab.
- Opt-in device selection on the Devices tab, manual entities, a Climate
  modes table and a per-row MQTT payload preview.
- Panel battery charge, for a panel that announces it (the Tab5), as
  `panels.<deviceId>.info.battery`.
- The broker password is stored encrypted; one that 0.1.0 stored in plain
  text is migrated at the first start (see
  [Upgrading from 0.1.0](#upgrading-from-010)).
- Pairing sends credentials only while the adapter is connected to the
  broker.
- Each js-controller call at start is given up after 5 s, and an alias whose
  target cannot be read is left out, each with a warning.
- Requires js-controller 6.0.11 and admin 7.6.17 or newer.
- Camera tiles are not supported. Not yet run on a physical panel.

### 0.1.0

- Initial release: sensor, binary sensor, switch, light and scene tiles,
  panel control, local Hardware I/O and pairing.

## License

MIT License

Copyright (c) 2026 Evgenij Cjura

The full text is in [LICENSE](LICENSE).
