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
  answers, and influxdb's Flux path sends no answer when its query fails.
  Bound the call yourself.
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
| `count` | the cap on rows. For `none` and `onchange` it defaults to `limit` (2000), not 500, which applies to the other aggregates. With `aggregate: 'none'` it cuts the result |
| `returnNewestEntries` | keep the **newest** `count` rows. Without it, all three keep the OLDEST |
| `limit` | the default for `count` |
| `aggregate` | `onchange` `minmax` `min` `max` `average` `total` `count` `none` `percentile` `quantile` `integral` `integralTotal` |
| `ignoreNull` | `false` keeps null rows. `true` **drops** them (beautify), whatever the type comment says. `0` substitutes zero. influxdb forces `true` |
| `ack` / `q` | history and sql return these fields only when asked. influxdb always returns them, except on InfluxDB 1.x's border rows, which it reads as `value` alone |
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
`none`, adds no border values.

## Mapping to the panel's two history modes (Ruling 123)

Both modes read **raw rows** (`aggregate: 'none'`), never an average:

- numeric graph: the builder computes each bucket's mean itself and carries
  the reading in effect into empty buckets (Ruling 75). An average loses that
  reading, and each adapter stamps its aggregates at a different place in the
  interval.
- categorical timeline: `ignoreNull: false`, so every transition survives,
  bad quality included.

The reading in effect at the window start must be asked for separately, as
the newest rows up to `start` with no `start` of its own. On the history
adapter, the window's own rows of that day come first, because it reads each
day file newest first with no end check, so `count` must exceed them.

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
is true.
