# ioBroker side of history and energy

Read from the installed `@iobroker/types` on 2026-09-22, not from memory.
Line references are into `node_modules/@iobroker/types/build/`.

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

## GetHistoryOptions (`shared.d.ts:321`)

The fields that matter here:

| Field | Meaning |
| --- | --- |
| `instance` | which history adapter answers, e.g. `"sql.0"` |
| `start` / `end` | **milliseconds**, end defaults to now |
| `step` | interval width in ms for aggregation |
| `count` | number of intervals; ignored when `step` is set; defaults to 500 |
| `limit` | hard cap on returned entries |
| `aggregate` | `onchange` `minmax` `min` `max` `average` `total` `count` `none` `percentile` `quantile` `integral` `integralTotal` |
| `ignoreNull` | `false` keeps nulls, `true` carries the last value forward, `0` substitutes zero |
| `sessionId` | echoed back verbatim in the answer |
| `round` | decimal places |

## Result shape

`GetHistoryResult = Array<State & { id?: string }>` (`shared.d.ts:517`), so
each sample is an ordinary ioBroker `State`: `val`, `ts`, `ack`, `q`, `from`,
`lc`. **`ts` is milliseconds**, which will need converting if the firmware
wants epoch seconds — check `docs/contract-history-energy.md` before writing
the responder.

## Mapping to the panel's two history modes

The panel renders numeric sensors as graphs and textual ones as categorical
timelines. That maps onto `aggregate` directly:

- numeric graph → `aggregate: 'average'` (or `'minmax'` to keep spikes) with
  `step` set from the requested range
- categorical timeline → `aggregate: 'none'` with `ignoreNull: false`, so
  every transition survives instead of being averaged into nonsense

Averaging a categorical state is silently wrong rather than an error, so this
choice must follow the entity's declared kind, never a guess from the values.

## Correlation

`sessionId` is returned in the answer, which gives a correlation handle that
costs nothing. Whether the firmware needs it depends on how it matches a
response to a request — see the correlation section of
`docs/contract-history-energy.md`.

## Discovering which instances can answer

Adapter objects carry `common.getHistory: boolean` (`objects.d.ts:517`,
`objects.d.ts:714`). Enumerating instances with that flag set gives the admin
UI a populated dropdown instead of a free-text field.
