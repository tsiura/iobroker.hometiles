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
`volumeGroup`, `weatherCurrent` and `weatherForecast` agree in both places.

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
| `levelSlider` | `SET` | `ON` `ON_ACTUAL` `ACTUAL` |
| `weatherCurrent` | `ACTUAL` `ICON` | `PRECIPITATION_CHANCE` `PRESSURE` `HUMIDITY` `UV` `WEATHER` `WIND_*` `REAL_FEEL_TEMPERATURE` |
| `weatherForecast` | `ICON` `TEMP_MIN` `TEMP_MAX` | day-indexed channels, below |

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
