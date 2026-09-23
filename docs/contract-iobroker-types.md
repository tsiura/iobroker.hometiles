# ioBroker type-detector mapping for the v0.2 domains

Read from the installed `@iobroker/type-detector` 6.0.1 on 2026-09-22 by
loading `build/typePatterns.js` directly. Not from documentation.

## Trap: pattern keys are not `Types` values

The pattern object is keyed differently from the `Types` enum. Getting this
wrong yields a silent "no such pattern" rather than an error:

| Pattern key | `Types` value |
| --- | --- |
| `mediaPlayer` | `media` |
| `blinds` | `blind` |
| `levelSlider` | `slider` |

`thermostat`, `airCondition`, `blindButtons`, `gate`, `volume`,
`volumeGroup`, `percentage`, `weatherCurrent` and `weatherForecast` agree in
both places.

## Required vs optional channels

Required channels are the ones a device must expose to be detected at all.
Everything else may be absent, and absent must not be confused with zero.

| Type | Required | Notable optional |
| --- | --- | --- |
| `thermostat` | one of `SET` `SET_HEATING` `SET_COOLING` | `ACTUAL` `HUMIDITY` `BOOST` `POWER` `PARTY` `MODE` `VALVE` `WORKING_MODE` `WINDOW` |
| `airCondition` | `MODE`, and one of `SET` `SET_HEATING` `SET_COOLING` | `ACTUAL` `HUMIDITY` `SPEED` `SPEED_LEVEL` `SWING` (×2) `AIRFLOW_DIRECTION` `BOOST` `POWER` |
| `blinds` | `SET` | `ACTUAL` `STOP` `OPEN` `CLOSE` `TILT_SET` `TILT_ACTUAL` `TILT_STOP` `TILT_OPEN` `TILT_CLOSE` `DIRECTION` |
| `blindButtons` | `STOP` `OPEN` `CLOSE` | `TILT_*`, `DIRECTION` |
| `gate` | `SET` | `ACTUAL` `STOP` `OPENED` `CLOSED` |
| `mediaPlayer` | `STATE` | `PLAY` `PAUSE` `STOP` `NEXT` `PREV` `SHUFFLE` `REPEAT` `ARTIST` `ALBUM` `TITLE` `COVER` (×2) `DURATION` `ELAPSED` `SEEK` `TRACK` `VOLUME` `VOLUME_ACTUAL` `MUTE` |
| `volume` | `SET` | `ACTUAL` `MUTE` |
| `levelSlider` (Types `slider`) | `SET`: role `level` or `level.*` except `*.setting.*`, `common.type` number, numeric `common.min` and `common.max`, writable. The write check is skipped when the role is exactly `level`. | `ON` (`switch`, `switch.active`), `ON_ACTUAL` (`state.active`, `sensor.switch`), `ACTUAL` (`value` or `value.*` number with numeric min and max) |
| `percentage` | `SET`: the same role rule, number, `common.unit` exactly `%`, writable (skipped for the role `level`). No min or max is required. | `ACTUAL` (`value` or `value.*` number) |
| `weatherCurrent` | `ACTUAL` `ICON` | `PRECIPITATION_CHANCE` `PRESSURE` `HUMIDITY` `UV` `WEATHER` `WIND_*` `REAL_FEEL_TEMPERATURE` |
| `weatherForecast` | `ICON` `TEMP_MIN` `TEMP_MAX` | day-indexed channels, below |

The `levelSlider` and `percentage` rows: typePatterns.js:3331-3414;
ChannelDetector.js:81-83, 99, 103-116, 126-129.

Pattern order decides what the catch-alls get. `percentage` (36) and
`levelSlider` (37) run after every lighting, climate, cover and media
pattern. They run *before* `socket` (38), `button` (39), `temperature` (42),
`humidity` (43), `illuminance`, `pressure`, `flow`, `fillLevel`, `image`,
`electricity` and `info` (50).

This has two consequences:

- A `%` level is always a `percentage`, never a slider. levelSlider's own
  `%` exception to min/max (ChannelDetector.js:103-116) never takes effect.
- In the same root, a slider's optional slots absorb a `switch` or
  `switch.active` power switch, a `state.active` indicator and a bounded
  `value.*` reading before `socket`, `temperature` or `info` can see them.
  A fan's speed level next to its power switch is therefore published as a
  number, and the absorbed switch is published by nothing; a manual entity
  (Task 13b) exposes it. (This corrects Ruling 85's premise, which had it the
  other way round.)

Each pattern matches at most once per root (ChannelDetector.js:571-574).
When several objects compete for one slot, the tie-break at :258-297
decides:

1. the object whose role equals the slot's defaultRole;
2. then the deeper role;
3. then the id that sorts later.

The losers are withheld from every later pattern of that root (:315, :328,
:618). A root with several bounded, writable levels therefore yields exactly
one slider, the tie-break winner.

## Both climate types require a setpoint

An earlier version of this section said `thermostat` has no required channel
at all. That is false for 6.0.1: `SET`, `SET_HEATING` and `SET_COOLING` share
`requiredOneOf: 'setpoint'` (typePatterns.js:1874, :44, :55), `airCondition`
adds `MODE` with `required: true` (:1750), and ChannelDetector enforces both
(ChannelDetector.js:479-500, :580-611). A naturally detected climate device
therefore always carries a setpoint.

The climate synth still treats a missing setpoint as read-only and refuses to
advertise a setpoint control, the same way v0.1 learned to refuse a light
command when no writable channel exists: the dependency is `^6.0.1`, a later
minor could relax the rule, and a domain override can make any device
climate. Reporting success for a write that went nowhere is the bug class
this project has already hit three times.

`SET_HEATING` and `SET_COOLING` are separate from `SET`: a dual-setpoint
thermostat may expose those two and no `SET`.

## Editable domains

`number` comes from Types `slider` and, since Ruling 82, from `percentage`
(unmapped at `43b72d9`). Both are catch-alls of adjustable values, and
`discoverDevices` publishes one only when both hold:

- it is its root's one control of its own: beside any other control of the
  root's own, mapped or not, it is that control's leftover parameter (a
  dimmer's RAMP_TIME, a thermostat's calibration offset);
- it is its root's one adjustable level (Ruling 86). The detector reports one
  slider and one percentage per root, the tie-break winners, so beside a
  second level no deeper root claimed and no other control of the root holds,
  it would be one arbitrary parameter. A root of parameters, such as a
  device's configuration channel, publishes none; manual entities (Task 13b)
  reach any of them.

A number carries SET alone. A missing `common.step` is Home Assistant's
derived one (Ruling 81). A percent value's missing min is 0 and its missing
max is 100, each on its own (Ruling 82).

A lone level in a channel of its own is a number, even when that channel
belongs to a device whose own control sits elsewhere: a zigbee lamp's
`config.transition` beside the lamp, a Homematic dimmer's RAMP_TIME alone in
channel 2 beside the dimmer in channel 1 (Ruling 87). A tile appears on a
panel only where one is placed. An override with `include: false` hides the
number from the picker.

No type-detector type produces `select` or `datetime`: both come only from a
user's `forcedDomain` on a detected device, and from Task 13b's manual
entities.

## Duplicate channel names

`airCondition` lists `SWING` twice and `mediaPlayer` lists `COVER` twice.
Two distinct state definitions share one name, so a channel mapper keyed on
name alone picks whichever it meets first. For `airCondition` the two are
plausibly the firmware's `swing_mode` and `swing_horizontal_mode`, which the
panel treats as independent controls — resolve them by role, not by name, and
write a test that pins which is which.

## The forecast is day-indexed

`weatherForecast` carries both flat channels and a `%d`-suffixed family:

    ICON%d TEMP_MIN%d TEMP_MAX%d DATE%d DOW%d STATE%d TEMP%d
    PRESSURE%d HUMIDITY%d HUMIDITY_MAX%d PRECIPITATION_CHANCE%d
    PRECIPITATION%d WIND_SPEED%d WIND_DIRECTION%d WIND_DIRECTION_STR%d
    WIND_ICON%d TIME_SUNRISE%d TIME_SUNSET%d

`%d` is the day offset, so a multi-day forecast is read by walking the index
rather than by reading a list. The number of available days is whatever the
source adapter happens to publish, so the walk must stop at the first missing
index rather than assuming a fixed count.

This is the ioBroker half of the weather story; the panel's half is in
`docs/contract-media-weather.md`.
