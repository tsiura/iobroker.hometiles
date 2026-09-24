# ioBroker side of history and energy

Read from the installed `@iobroker/types` on 2026-09-22, not from memory.
Line references are into `node_modules/@iobroker/types/build/`.

**Corrected by Task 19 (2026-09-24)** from the adapters' own sources:
iobroker.history 5.0.1, iobroker.sql 4.1.5, iobroker.influxdb 5.0.3, the
@iobroker/aggregate 1.0.1 they share, and js-controller-adapter 7.2.3 and
8.0.0-alpha. `.superpowers/sdd/2026-09-22-iobroker-hometiles-v0.2/task-19-report.md`
has the per-adapter table with file:line. `src/runtime/history-provider.ts`
implements it.

## There is no sendTo plumbing to write

`adapter-core` already exposes history directly (`types.d.ts:101`):

```ts
getHistoryAsync(id: string, options?: ioBroker.GetHistoryOptions): Promise<{
  result?: ioBroker.GetHistoryResult;
  step?: number;
  sessionId?: number;
}>;
```

This routes to whichever history adapter is named in `options.instance`, so a
single call site serves `history.0`, `sql.0` and `influxdb.0` alike. Do not
hand-roll `sendTo(instance, 'getHistory', …)`.

What js-controller does with it (adapter.js `_getHistory`):

- It sends the message **without a timeout**. A stopped instance never
  answers. influxdb sends no answer when its Flux query fails (main.js
  :2924-2929), nor when storing its buffered points first fails
  (:2578-2580, :2932-2934). Bound the call yourself. A sent message cannot
  be taken back, so the instance may go on working on it.
- It resolves with no `result` when the message could not be sent.
- With no `instance`, it guesses one: `system.config` `common.defaultHistory`,
  else the first instance of type `storage`, else `history.0`. Pass the
  instance explicitly. iobroker.history sets `defaultHistory` to itself when
  it starts and none is set (main.js:457-467).

## GetHistoryOptions (`shared.d.ts:321`)

The fields that matter here, as the three adapters actually treat them:

| Field | Meaning |
| --- | --- |
| `instance` | which history adapter answers, e.g. `"sql.0"` |
| `start` / `end` | **milliseconds**. `end` defaults to now + 5000 s |
| `step` | interval width in ms for aggregation |
| `count` | the cap on rows. For `none` and `onchange` history, sql and InfluxDB 1.x default it to `limit` (2000), not 500, which applies to the other aggregates. InfluxDB 2.x defaults every count to 500 (main.js:2593). With `aggregate: 'none'` it cuts the result, so exactly `count` rows means "`count` or more": ask for one more to tell |
| `returnNewestEntries` | keep the **newest** `count` rows. Without it, all three keep the OLDEST |
| `limit` | the default for `count` |
| `aggregate` | `onchange` `minmax` `min` `max` `average` `total` `count` `none` `percentile` `quantile` `integral` `integralTotal` |
| `ignoreNull` | `false` keeps null rows. `true` **drops** them (beautify), whatever the type comment says. `0` substitutes zero. influxdb forces `true` |
| `ack` / `q` | history and sql return these fields only when asked. influxdb always returns them, except on InfluxDB 1.x's border rows, which it reads as `value` alone. **InfluxDB 2.x with "Use tags to store metadata"** stores them as tags (DatabaseInfluxDB2x.js:158-165), so they come back as strings: `q: "0"`, `ack: "true"` (main.js:2903-2908) |
| `sessionId` | echoed back verbatim in the answer |
| `round` | decimal places |

## Result shape

`GetHistoryResult = Array<State & { id?: string }>` (`shared.d.ts:517`), so
each sample is an ordinary ioBroker `State`: `val`, `ts`, `ack`, `q`, `from`,
`lc`. **`ts` is milliseconds**, which will need converting if the firmware
wants epoch seconds — check `docs/contract-history-energy.md` before writing
the responder.

A raw read (`aggregate: 'none'`) returns only rows from `start` to `end`.
Each adapter also reads the row before `start`, and sometimes the row after
`end`. @iobroker/aggregate's beautify drops both before answering and, for
`none`, adds no border values. The exception: when history's or sql's
not-yet-written rows alone fill `count`, they are sent without beautify
(history main.js:1244-1256, sql main.js:2720-2736) and can hold the row before
`start` or the one after `end`.

Every adapter sends its rows oldest first. sql can send one row twice while
it writes a batch: from its cache, and once committed as the first row at or
after `end` (sql main.js:2738-2741, sqlite.js:170-187).

Adapter limits no caller can change:

- influxdb never stores null and drops null rows (C4).
- sql turns a **null boolean into `false`** (main.js:2442-2445, :2480-2483),
  so a binary timeline on sql shows "off" where the state was null with q 0.

## Mapping to the panel's two history modes (Ruling 123)

Both modes read **raw rows** (`aggregate: 'none'`), never an average:

- numeric graph: the builder computes each bucket's mean itself and carries
  the reading in effect into empty buckets (Ruling 75). An average loses that
  reading, and each adapter stamps its aggregates at a different place in the
  interval.
- categorical timeline: `ignoreNull: false`, so every transition survives,
  bad quality included.

The reading in effect at the window start must be asked for separately, as
the newest rows up to `start`. On the history adapter, the window's own rows
of that day come first, because it reads each day file newest first with no
end check, so `count` must exceed them. Ask within a bounded start first,
such as the week before: with no `start`, InfluxDB 2.x reads its whole
retention (a year by default) to answer (main.js:2718-2723, :2776). Ask with
no start only when that holds nothing.

## Correlation

`sessionId` is returned in the answer, which gives a correlation handle that
costs nothing. Whether the firmware needs it depends on how it matches a
response to a request — see the correlation section of
`docs/contract-history-energy.md`.

## Discovering which instances can answer

Adapter objects carry `common.getHistory: boolean` (`objects.d.ts:517`,
`objects.d.ts:714`). In jsonConfig, `{"type": "instance", "adapter":
"_dataSources"}` lists exactly the instances with that flag, and adds a
"none" choice stored as `''` (@iobroker/json-config 10.0.6
ConfigInstanceSelect.js:17-25, :54-56).

A state is logged by an instance when its `common.custom[instance].enabled`
is truthy: history (main.js:73-75, :550), sql on an object change
(main.js:227-229) and influxdb (main.js:159-161, :968) read it so. sql at
startup drops only `enabled === false` (main.js:3842).
