# ioBroker.hometiles v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an ioBroker adapter that makes stock, unmodified HomeTiles ESP32 firmware work against ioBroker instead of Home Assistant, covering sensor, binary_sensor, switch, light and scene tiles plus panel control, local Hardware I/O and pairing.

**Architecture:** The adapter keeps an in-memory virtual Home Assistant entity registry. `@iobroker/type-detector` classifies the ioBroker object tree into devices, admin overrides adjust that classification, and each device becomes a `VirtualEntity` carrying Home Assistant shaped state and attributes. All MQTT behaviour operates on that registry. Everything under `src/protocol/` and `src/registry/synth/` is pure — no `@iobroker/adapter-core`, no `mqtt` — so the wire contract is testable with no broker, no ioBroker and no hardware.

**Tech Stack:** TypeScript 5, Node 20+, `@iobroker/adapter-core`, `@iobroker/type-detector`, `mqtt` (mqtt.js), mocha + chai + sinon, `@iobroker/testing`, `aedes` (in-process broker for integration tests).

**Spec:** `docs/superpowers/specs/2026-09-04-hometiles-iobroker-adapter-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- The HomeTiles firmware is never modified and never forked. The firmware is the fixed side of the contract.
- v0.1 domains are exactly: `sensor`, `binary_sensor`, `switch`, `light`, `scene`. No climate, cover, media, camera, history, weather or energy handling.
- Defaults: base topic `hometiles`, HA prefix `ha/statestream`, config topic root `tab5_lvgl/config`.
- Nothing under `src/protocol/` or `src/registry/synth/` may import `@iobroker/adapter-core` or `mqtt`. Enforced by a lint rule in Task 1.
- Missing-value discipline: absent, `null`, empty, zero, `unknown` and `unavailable` are six distinct conditions and are never conflated.
- `supported_features` and `supported_color_modes` are derived only from channels the detector actually found. Never inferred from a current value.
- All runtime, diagnostic, warning and error logs are English, carry a stable prefix, and are rate-limited. No per-message logging on the hot path.
- Commands from MQTT resolve only through a fixed allow-list against entities already in the registry. Numeric arguments are range-clamped before any write.
- Entity ids are persisted keyed by source object id so an ioBroker rename never orphans tiles already placed on a panel.
- Every reproduced bug gets a focused regression test before the fix.

## Verified Firmware Contract

These values were read out of the HomeTiles firmware source and are authoritative. Do not re-derive them.

### Announcement — panel publishes retained to `tab5_lvgl/config/{deviceId}/bridge`

Built by `HaBridgeConfig::buildJsonPayload` in `src/network/ha_bridge_config.cpp`:

```json
{
  "device_id": "a1b2c3d4e5f6",
  "base_topic": "hometiles",
  "ha_prefix": "ha/statestream",
  "device_name": "Waveshare 8\"",
  "manufacturer": "HomeTiles",
  "model": "waveshare_touch_lcd_8",
  "sensors": ["sensor.wohnzimmer_temperatur"],
  "binary_sensors": ["binary_sensor.haustuer"],
  "scene_map": { "gute nacht": "scene.gute_nacht" },
  "local_io": [
    {
      "id": "relay_1",
      "entity_id": "switch.waveshare_8_relay_1",
      "legacy_entity_ids": ["switch.relay_1"],
      "name": "Relay 1",
      "type": "relay"
    }
  ]
}
```

`type` is `relay` or `temperature`. `local_io` is appended by `HardwareIoManager::appendBridgeJson`.

### Refresh request — panel publishes to `tab5_lvgl/config/{deviceId}/bridge/request`

Plain text, not JSON. Payload is `force` or the empty string.

### Configuration push — adapter publishes to `tab5_lvgl/config/{deviceId}/bridge/apply`

The firmware parses this with **substring scanning, not a JSON parser** (`HaBridgeConfig::applyJson`). Exact key spelling matters. Top-level keys it looks for:

`"sensors"`, `"binary_sensors"`, `"energy"`, `"weathers"`, `"lights"`, `"switches"`, `"media_players"`, `"climates"`, `"covers"`, `"cameras"` (arrays), `"scene_map"` (object).

Metadata sections, scanned separately: `"sensor_meta"`, `"binary_sensor_meta"`, `"light_meta"`, `"switch_meta"`, `"media_player_meta"`, `"climate_meta"`, `"cover_meta"`, `"camera_meta"`, `"weather_meta"`, `"scene_meta"`.

`sensor_meta` entry keys: `entity_id`, `name`, `unit`, `state`, `value`, `state_kind`, `number`, `icon`. **`state_kind` accepts only `number` or `state`** — `parseSensorMetaSection` stores the key for no other value, and `src/types/sensor/renderer.cpp` branches on exactly those two to choose graph versus history mode. A textual sensor is `state`, not `text`.
`binary_sensor_meta` entry keys: `entity_id`, `name`, `device_class`, `state`, `on`, `off`, `unknown`, `unavailable`, `icon`, `available`, `last_changed`.
Every `*_meta` section is additionally scanned for `icon` by `parseIconMetaSections`.

### Entity state — adapter publishes retained to `{haPrefix}/{domain}/{objectId}/state`

Topic is built by lowercasing the entity id and replacing `.` with `/`.

**Payload format is domain-dependent. This is the single most important detail in the port:**

| Domain | Payload | Evidence |
| --- | --- | --- |
| `sensor` | bare string, e.g. `23.4` or `unavailable` | `sync_external_temp_entity` publishes `dtostrf` output or the literal `unavailable` |
| `binary_sensor` | bare string `on` / `off` / `unknown` / `unavailable` | consumed by `tiles_update_sensor_by_entity` as a raw value |
| `switch` | bare string `on` / `off` / `unavailable` | `TILE_SWITCH` branch of `tiles_update_sensor_by_entity` |
| `light` | JSON object with `state` plus attributes, e.g. `{"state":"on","brightness_pct":42}` | `sync_local_device_entities` publishes exactly this shape for the panel's own display-brightness light |
| `scene` | not published | fire-and-forget activation only |

### Commands — panel publishes to `{baseTopic}/cmnd/{leaf}`

`cmnd/light`, built by `mqttPublishLightCommand`. Optional members are omitted when absent:

```json
{"entity_id":"light.x","state":"on","brightness_pct":42,"rgb_color":[255,180,90],"color_temp_kelvin":3000}
```

`cmnd/switch` and the on/off path of `cmnd/light`, built by `mqttPublishSwitchCommand`. When no state is supplied the firmware sends `toggle`. An `entity_id` starting with `light.` is routed to `cmnd/light`, everything else to `cmnd/switch`:

```json
{"entity_id":"switch.x","state":"on"}
```

`cmnd/scene`, built by `mqttPublishScene`: **plain text**, the scene name or alias. Not JSON.

### Panel status and settings

| Topic | Payload |
| --- | --- |
| `{base}/stat/connected` | retained, panel presence |
| `{base}/stat/ip` | retained, IPv4 string |
| `{base}/cmnd/display_brightness` | integer 1..100 |
| `{base}/stat/display_brightness` | retained integer; a value above 100 means legacy 121..255 encoding |
| `{base}/cmnd/screensaver_brightness`, `{base}/stat/screensaver_brightness` | as above |
| `{base}/cmnd/display_rotate`, `{base}/stat/display_rotate` | integer |
| `{base}/cmnd/display_sleep`, `{base}/stat/display_sleep` | enum string |
| `{base}/cmnd/sleep_mains`, `{base}/stat/sleep_mains` | enum string |
| `{base}/cmnd/sleep_battery`, `{base}/stat/sleep_battery` | enum string |
| `{base}/cmnd/io/{channelId}` | `ON` / `OFF` |
| `{base}/stat/io/{channelId}` | retained `ON` / `OFF` for a relay, a decimal string or `unavailable` for a temperature channel |

---

## File Structure

| File | Responsibility |
| --- | --- |
| `package.json`, `tsconfig.json`, `.mocharc.json`, `eslint.config.mjs`, `.gitignore` | build, test and lint harness |
| `io-package.json` | ioBroker adapter manifest and native config defaults |
| `src/config/options.ts` | typed native config, defaults, validation |
| `src/protocol/topics.ts` | every topic string in the contract, in one place |
| `src/protocol/announce.ts` | parse the announcement, validate local I/O atomically |
| `src/protocol/apply.ts` | build the `bridge/apply` payload and its config signature |
| `src/protocol/icons.ts` | build the `bridge/icons` payload |
| `src/protocol/state-payload.ts` | `VirtualEntity` to retained state publish, per domain |
| `src/protocol/commands.ts` | parse `cmnd/*` into a validated `ServiceCall` |
| `src/registry/types.ts` | `VirtualEntity`, `DeviceInput`, `SourceValue` and friends |
| `src/registry/entity-id.ts` | stable, collision-free entity id derivation |
| `src/registry/synth/{sensor,binary_sensor,switch,light,scene}.ts` | per-domain attribute synthesis |
| `src/registry/synth/index.ts` | domain dispatch |
| `src/registry/detector.ts` | `@iobroker/type-detector` to `DeviceInput[]` |
| `src/registry/overrides.ts` | admin include/exclude/rename/force-type |
| `src/registry/entity-registry.ts` | live registry, subscriptions, coalescing |
| `src/runtime/mqtt-client.ts` | mqtt.js wrapper, LWT, bounded queue, backoff |
| `src/runtime/dispatcher.ts` | `ServiceCall` to `setForeignStateAsync`, allow-list |
| `src/runtime/panel-session.ts` | one panel: subscriptions, apply gating, fan-out |
| `src/runtime/panel-manager.ts` | announcement routing, session lifecycle |
| `src/runtime/panel-objects.ts` | `hometiles.0.panels.*` object tree and sync |
| `src/runtime/pairing.ts` | broker credential push to an unconfigured panel |
| `src/main.ts` | adapter lifecycle and wiring, `onMessage` handlers |
| `admin/jsonConfig.json` | admin UI |

---

## Task 1: Project scaffold, build and test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `.mocharc.json`, `eslint.config.mjs`, `.gitignore`, `io-package.json`, `LICENSE`, `README.md`
- Create: `src/config/options.ts`
- Test: `test/config/options.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AdapterOptions`, `DEFAULTS`, `normaliseTopic(value: string, fallback: string): string`, `validateOptions(raw: Partial<AdapterOptions>): { options: AdapterOptions; errors: string[] }`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "iobroker.hometiles",
  "version": "0.1.0",
  "description": "Connects HomeTiles ESP32-P4/S3 touch panels to ioBroker over MQTT",
  "author": "Evgenij Cjura",
  "license": "MIT",
  "main": "build/main.js",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "mocha",
    "lint": "eslint .",
    "check": "npm run lint && npm run build && npm test"
  },
  "dependencies": {
    "@iobroker/adapter-core": "^3.2.3",
    "@iobroker/type-detector": "^6.0.1",
    "mqtt": "^5.10.1"
  },
  "devDependencies": {
    "@iobroker/testing": "^5.0.4",
    "@types/chai": "^4.3.20",
    "@types/mocha": "^10.0.10",
    "@types/node": "^20.17.6",
    "@types/sinon": "^17.0.3",
    "@typescript-eslint/eslint-plugin": "^8.18.0",
    "@typescript-eslint/parser": "^8.18.0",
    "aedes": "^0.51.3",
    "chai": "^4.5.0",
    "eslint": "^9.17.0",
    "mocha": "^10.8.2",
    "sinon": "^19.0.2",
    "ts-node": "^10.9.2",
    "typescript": "^5.7.2"
  },
  "files": ["admin/", "build/", "io-package.json", "LICENSE"]
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2022"],
    "outDir": "build",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "build", "test"]
}
```

- [ ] **Step 3: Create `.mocharc.json`**

```json
{
  "require": ["ts-node/register"],
  "spec": ["test/**/*.test.ts"],
  "timeout": 10000,
  "recursive": true
}
```

- [ ] **Step 4: Create `eslint.config.mjs` with the purity rule**

The `no-restricted-imports` block is the enforcement of the Global Constraint that protocol and synth stay pure. Do not weaken it.

```js
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: { parser: tsparser, parserOptions: { sourceType: 'module' } },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    files: ['src/protocol/**/*.ts', 'src/registry/synth/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: '@iobroker/adapter-core', message: 'protocol and synth must stay pure' },
          { name: 'mqtt', message: 'protocol and synth must stay pure' },
        ],
      }],
    },
  },
  { ignores: ['build/', 'node_modules/'] },
];
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
build/
*.log
.DS_Store
```

- [ ] **Step 6: Create `io-package.json`**

```json
{
  "common": {
    "name": "hometiles",
    "version": "0.1.0",
    "news": { "0.1.0": { "en": "Initial release: sensor, binary sensor, switch, light and scene tiles, panel control, local Hardware I/O and pairing." } },
    "title": "HomeTiles",
    "titleLang": { "en": "HomeTiles", "de": "HomeTiles" },
    "desc": { "en": "Connects HomeTiles ESP32 touch panels to ioBroker over MQTT", "de": "Verbindet HomeTiles ESP32 Touch-Panels ueber MQTT mit ioBroker" },
    "authors": ["Evgenij Cjura"],
    "keywords": ["hometiles", "esp32", "mqtt", "panel", "display"],
    "license": "MIT",
    "platform": "Javascript/Node.js",
    "mode": "daemon",
    "type": "visualization",
    "compact": true,
    "connectionType": "local",
    "dataSource": "push",
    "adminUI": { "config": "json" },
    "dependencies": [{ "js-controller": ">=5.0.19" }],
    "messagebox": true
  },
  "native": {
    "brokerHost": "127.0.0.1",
    "brokerPort": 1883,
    "brokerTls": false,
    "brokerUser": "",
    "brokerPassword": "",
    "clientId": "iobroker-hometiles",
    "baseTopic": "hometiles",
    "haPrefix": "ha/statestream",
    "coalesceMs": 200,
    "maxPublishQueue": 2000,
    "protocolTrace": false,
    "deviceOverrides": []
  },
  "objects": [],
  "instanceObjects": [
    { "_id": "info", "type": "channel", "common": { "name": "Information" }, "native": {} },
    { "_id": "info.connection", "type": "state", "common": { "role": "indicator.connected", "name": "Broker connected", "type": "boolean", "read": true, "write": false, "def": false }, "native": {} },
    { "_id": "info.panels", "type": "state", "common": { "role": "value", "name": "Announced panels", "type": "number", "read": true, "write": false, "def": 0 }, "native": {} },
    { "_id": "info.entities", "type": "state", "common": { "role": "value", "name": "Published entities", "type": "number", "read": true, "write": false, "def": 0 }, "native": {} }
  ]
}
```

- [ ] **Step 7: Write the failing test for `src/config/options.ts`**

Create `test/config/options.test.ts`:

```ts
import { expect } from 'chai';
import { DEFAULTS, normaliseTopic, validateOptions } from '../../src/config/options';

describe('config/options', () => {
  it('strips leading and trailing slashes and collapses doubles', () => {
    expect(normaliseTopic('/hometiles//panel/', 'hometiles')).to.equal('hometiles/panel');
  });

  it('falls back when the value is empty or whitespace', () => {
    expect(normaliseTopic('   ', 'ha/statestream')).to.equal('ha/statestream');
  });

  it('rejects MQTT wildcards in a topic', () => {
    const { errors } = validateOptions({ ...DEFAULTS, baseTopic: 'home/+/tiles' });
    expect(errors).to.include('baseTopic must not contain MQTT wildcards');
  });

  it('clamps the coalesce window into 0..5000 ms', () => {
    expect(validateOptions({ ...DEFAULTS, coalesceMs: 99999 }).options.coalesceMs).to.equal(5000);
    expect(validateOptions({ ...DEFAULTS, coalesceMs: -5 }).options.coalesceMs).to.equal(0);
  });

  it('rejects an out-of-range broker port', () => {
    const { errors } = validateOptions({ ...DEFAULTS, brokerPort: 70000 });
    expect(errors).to.include('brokerPort must be between 1 and 65535');
  });

  it('applies every default for an empty input', () => {
    expect(validateOptions({}).options).to.deep.equal(DEFAULTS);
  });
});
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `npm install && npx mocha test/config/options.test.ts`
Expected: FAIL, `Cannot find module '../../src/config/options'`

- [ ] **Step 9: Implement `src/config/options.ts`**

```ts
export interface AdapterOptions {
  brokerHost: string;
  brokerPort: number;
  brokerTls: boolean;
  brokerUser: string;
  brokerPassword: string;
  clientId: string;
  baseTopic: string;
  haPrefix: string;
  coalesceMs: number;
  maxPublishQueue: number;
  protocolTrace: boolean;
  deviceOverrides: DeviceOverride[];
}

export interface DeviceOverride {
  /** ioBroker object id of the device root. Overrides are keyed by this, never by list index. */
  objectId: string;
  include: boolean;
  name?: string;
  forcedDomain?: string;
}

export const DEFAULTS: AdapterOptions = {
  brokerHost: '127.0.0.1',
  brokerPort: 1883,
  brokerTls: false,
  brokerUser: '',
  brokerPassword: '',
  clientId: 'iobroker-hometiles',
  baseTopic: 'hometiles',
  haPrefix: 'ha/statestream',
  coalesceMs: 200,
  maxPublishQueue: 2000,
  protocolTrace: false,
  deviceOverrides: [],
};

export function normaliseTopic(value: string | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return fallback;
  const collapsed = trimmed.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  return collapsed || fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function validateOptions(raw: Partial<AdapterOptions>): {
  options: AdapterOptions;
  errors: string[];
} {
  const errors: string[] = [];
  const baseTopic = normaliseTopic(raw.baseTopic, DEFAULTS.baseTopic);
  const haPrefix = normaliseTopic(raw.haPrefix, DEFAULTS.haPrefix);

  if (/[+#]/.test(baseTopic)) errors.push('baseTopic must not contain MQTT wildcards');
  if (/[+#]/.test(haPrefix)) errors.push('haPrefix must not contain MQTT wildcards');

  const brokerPort = raw.brokerPort ?? DEFAULTS.brokerPort;
  if (!Number.isInteger(brokerPort) || brokerPort < 1 || brokerPort > 65535) {
    errors.push('brokerPort must be between 1 and 65535');
  }

  const options: AdapterOptions = {
    brokerHost: (raw.brokerHost ?? DEFAULTS.brokerHost).trim() || DEFAULTS.brokerHost,
    brokerPort: clamp(brokerPort, 1, 65535),
    brokerTls: raw.brokerTls ?? DEFAULTS.brokerTls,
    brokerUser: raw.brokerUser ?? DEFAULTS.brokerUser,
    brokerPassword: raw.brokerPassword ?? DEFAULTS.brokerPassword,
    clientId: (raw.clientId ?? DEFAULTS.clientId).trim() || DEFAULTS.clientId,
    baseTopic,
    haPrefix,
    coalesceMs: clamp(raw.coalesceMs ?? DEFAULTS.coalesceMs, 0, 5000),
    maxPublishQueue: clamp(raw.maxPublishQueue ?? DEFAULTS.maxPublishQueue, 100, 100000),
    protocolTrace: raw.protocolTrace ?? DEFAULTS.protocolTrace,
    deviceOverrides: raw.deviceOverrides ?? [],
  };

  return { options, errors };
}
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npx mocha test/config/options.test.ts`
Expected: PASS, 6 passing

- [ ] **Step 11: Verify lint and build both succeed**

Run: `npm run lint && npm run build`
Expected: no errors, `build/config/options.js` exists

- [ ] **Step 12: Commit**

```bash
git add package.json tsconfig.json .mocharc.json eslint.config.mjs .gitignore io-package.json src/config/options.ts test/config/options.test.ts
git commit -m "feat: project scaffold, build and test harness, typed adapter options"
```

---

## Task 2: Topic builders

**Files:**
- Create: `src/protocol/topics.ts`
- Test: `test/protocol/topics.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CONFIG_TOPIC_ROOT`, `ANNOUNCE_TOPIC_PATTERN`, `deviceIdFromAnnounceTopic(topic)`, `applyTopic(deviceId)`, `iconsTopic(deviceId)`, `bridgeRequestTopic(deviceId)`, `commandTopic(baseTopic, leaf)`, `stateTopic(baseTopic, leaf)`, `ioCommandTopic(baseTopic, channelId)`, `ioStateTopic(baseTopic, channelId)`, `entityStateTopic(haPrefix, entityId)`, `PANEL_SETTING_LEAVES`.

- [ ] **Step 1: Write the failing test**

Create `test/protocol/topics.test.ts`:

```ts
import { expect } from 'chai';
import {
  ANNOUNCE_TOPIC_PATTERN,
  applyTopic,
  bridgeRequestTopic,
  commandTopic,
  deviceIdFromAnnounceTopic,
  entityStateTopic,
  iconsTopic,
  ioCommandTopic,
  ioStateTopic,
  stateTopic,
} from '../../src/protocol/topics';

describe('protocol/topics', () => {
  it('subscribes to every panel announcement with one wildcard', () => {
    expect(ANNOUNCE_TOPIC_PATTERN).to.equal('tab5_lvgl/config/+/bridge');
  });

  it('extracts the device id from an announcement topic', () => {
    expect(deviceIdFromAnnounceTopic('tab5_lvgl/config/a1b2c3/bridge')).to.equal('a1b2c3');
  });

  it('returns null for a topic that is not an announcement', () => {
    expect(deviceIdFromAnnounceTopic('tab5_lvgl/config/a1b2c3/bridge/apply')).to.equal(null);
    expect(deviceIdFromAnnounceTopic('something/else')).to.equal(null);
  });

  it('builds the per-device config topics', () => {
    expect(applyTopic('a1')).to.equal('tab5_lvgl/config/a1/bridge/apply');
    expect(iconsTopic('a1')).to.equal('tab5_lvgl/config/a1/bridge/icons');
    expect(bridgeRequestTopic('a1')).to.equal('tab5_lvgl/config/a1/bridge/request');
  });

  it('builds command and state topics under the panel base', () => {
    expect(commandTopic('hometiles', 'light')).to.equal('hometiles/cmnd/light');
    expect(stateTopic('hometiles', 'connected')).to.equal('hometiles/stat/connected');
    expect(ioCommandTopic('hometiles', 'relay_1')).to.equal('hometiles/cmnd/io/relay_1');
    expect(ioStateTopic('hometiles', 'relay_1')).to.equal('hometiles/stat/io/relay_1');
  });

  it('maps an entity id onto the statestream topic by replacing the domain dot', () => {
    expect(entityStateTopic('ha/statestream', 'light.Kueche_Decke'))
      .to.equal('ha/statestream/light/kueche_decke/state');
  });

  it('rejects an entity id without a domain separator', () => {
    expect(() => entityStateTopic('ha/statestream', 'kueche')).to.throw('invalid entity id');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx mocha test/protocol/topics.test.ts`
Expected: FAIL, `Cannot find module '../../src/protocol/topics'`

- [ ] **Step 3: Implement `src/protocol/topics.ts`**

```ts
export const CONFIG_TOPIC_ROOT = 'tab5_lvgl/config';
export const ANNOUNCE_TOPIC_PATTERN = `${CONFIG_TOPIC_ROOT}/+/bridge`;

/** Panel settings mirrored in both directions, as cmnd/<leaf> and stat/<leaf>. */
export const PANEL_SETTING_LEAVES = [
  'display_brightness',
  'screensaver_brightness',
  'display_rotate',
  'display_sleep',
  'sleep_mains',
  'sleep_battery',
] as const;

export type PanelSettingLeaf = (typeof PANEL_SETTING_LEAVES)[number];

export function deviceIdFromAnnounceTopic(topic: string): string | null {
  const parts = topic.split('/');
  if (parts.length !== 4) return null;
  if (`${parts[0]}/${parts[1]}` !== CONFIG_TOPIC_ROOT) return null;
  if (parts[3] !== 'bridge') return null;
  const deviceId = parts[2];
  return deviceId ? deviceId : null;
}

export function applyTopic(deviceId: string): string {
  return `${CONFIG_TOPIC_ROOT}/${deviceId}/bridge/apply`;
}

export function iconsTopic(deviceId: string): string {
  return `${CONFIG_TOPIC_ROOT}/${deviceId}/bridge/icons`;
}

export function bridgeRequestTopic(deviceId: string): string {
  return `${CONFIG_TOPIC_ROOT}/${deviceId}/bridge/request`;
}

export function commandTopic(baseTopic: string, leaf: string): string {
  return `${baseTopic}/cmnd/${leaf}`;
}

export function stateTopic(baseTopic: string, leaf: string): string {
  return `${baseTopic}/stat/${leaf}`;
}

export function ioCommandTopic(baseTopic: string, channelId: string): string {
  return `${baseTopic}/cmnd/io/${channelId}`;
}

export function ioStateTopic(baseTopic: string, channelId: string): string {
  return `${baseTopic}/stat/io/${channelId}`;
}

/**
 * Builds the retained entity-state topic.
 *
 * The firmware's `buildHaStatestreamTopic` (src/network/mqtt_handlers.cpp)
 * trims the entity id and replaces EVERY '.' with '/', leaving case untouched.
 * This function lowercases and replaces only the FIRST '.'. The two are
 * equivalent for every id this adapter can produce: `entity-id.ts` emits
 * `<domain>.<slug>` where the slug is already lowercase and cannot contain a
 * dot, because slugify collapses every non-alphanumeric run to '_'. The
 * lowercasing is defensive, for an id that reaches here from an admin override.
 * Do not "align" this with the firmware by replacing every dot: a
 * multi-dot id is a bug upstream, and one slash-joined topic segment per dot
 * would silently address the wrong entity rather than fail loudly.
 */
export function entityStateTopic(haPrefix: string, entityId: string): string {
  const dot = entityId.indexOf('.');
  if (dot <= 0 || dot === entityId.length - 1) {
    throw new Error(`invalid entity id: ${entityId}`);
  }
  const path = entityId.toLowerCase().replace('.', '/');
  return `${haPrefix}/${path}/state`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx mocha test/protocol/topics.test.ts`
Expected: PASS, 7 passing

- [ ] **Step 5: Commit**

```bash
git add src/protocol/topics.ts test/protocol/topics.test.ts
git commit -m "feat(protocol): topic builders for the HomeTiles MQTT contract"
```

---

## Task 3: Announcement parsing and local I/O validation

**Files:**
- Create: `src/protocol/announce.ts`
- Test: `test/protocol/announce.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LocalIoChannel`, `Announcement`, `AnnounceError`, `parseAnnouncement(deviceId: string, raw: string): Announcement`, `normaliseLocalIo(raw: unknown): LocalIoChannel[]`.

Atomicity rule: a malformed non-empty `local_io` list throws. It is never partially applied and never silently treated as the empty list, because the empty list is the intentional "remove all channels" signal.

- [ ] **Step 1: Write the failing test**

Create `test/protocol/announce.test.ts`:

```ts
import { expect } from 'chai';
import { AnnounceError, normaliseLocalIo, parseAnnouncement } from '../../src/protocol/announce';

const FULL = JSON.stringify({
  device_id: 'a1b2c3',
  base_topic: 'hometiles',
  ha_prefix: 'ha/statestream',
  device_name: 'Waveshare 8',
  manufacturer: 'HomeTiles',
  model: 'waveshare_touch_lcd_8',
  sensors: ['sensor.wohnzimmer_temperatur'],
  binary_sensors: ['binary_sensor.haustuer'],
  scene_map: { 'gute nacht': 'scene.gute_nacht' },
  local_io: [
    { id: 'relay_1', entity_id: 'switch.ws8_relay_1', legacy_entity_ids: ['switch.relay_1'], name: 'Relay 1', type: 'relay' },
    { id: 'temp_1', entity_id: 'sensor.ws8_temp_1', name: 'Aussen', type: 'temperature' },
  ],
});

describe('protocol/announce', () => {
  it('parses a full announcement', () => {
    const a = parseAnnouncement('a1b2c3', FULL);
    expect(a.deviceId).to.equal('a1b2c3');
    expect(a.baseTopic).to.equal('hometiles');
    expect(a.haPrefix).to.equal('ha/statestream');
    expect(a.model).to.equal('waveshare_touch_lcd_8');
    expect(a.sensors).to.deep.equal(['sensor.wohnzimmer_temperatur']);
    expect(a.sceneMap).to.deep.equal({ 'gute nacht': 'scene.gute_nacht' });
    expect(a.localIo).to.have.length(2);
    expect(a.localIo[0]).to.deep.equal({
      id: 'relay_1',
      entityId: 'switch.ws8_relay_1',
      legacyEntityIds: ['switch.relay_1'],
      name: 'Relay 1',
      type: 'relay',
    });
    expect(a.localIo[1].legacyEntityIds).to.deep.equal([]);
  });

  it('prefers the topic device id over a mismatching payload field', () => {
    const a = parseAnnouncement('fromtopic', FULL);
    expect(a.deviceId).to.equal('fromtopic');
  });

  it('applies defaults when base topic or prefix are missing', () => {
    const a = parseAnnouncement('a1', JSON.stringify({ device_id: 'a1' }));
    expect(a.baseTopic).to.equal('hometiles');
    expect(a.haPrefix).to.equal('ha/statestream');
    expect(a.sensors).to.deep.equal([]);
    expect(a.localIo).to.deep.equal([]);
  });

  it('rejects a payload that is not a JSON object', () => {
    expect(() => parseAnnouncement('a1', '[]')).to.throw(AnnounceError);
    expect(() => parseAnnouncement('a1', 'not json')).to.throw(AnnounceError);
  });

  it('treats an empty local_io list as the intentional removal signal', () => {
    expect(normaliseLocalIo([])).to.deep.equal([]);
    expect(normaliseLocalIo(undefined)).to.deep.equal([]);
  });

  it('rejects a malformed local_io list atomically rather than partially applying it', () => {
    const raw = [
      { id: 'ok_1', entity_id: 'switch.a', name: 'A', type: 'relay' },
      { id: '', entity_id: 'switch.b', name: 'B', type: 'relay' },
    ];
    expect(() => normaliseLocalIo(raw)).to.throw(/invalid_local_io_item_1/);
  });

  it('rejects duplicate channel ids', () => {
    const raw = [
      { id: 'dup', entity_id: 'switch.a', name: 'A', type: 'relay' },
      { id: 'dup', entity_id: 'switch.b', name: 'B', type: 'relay' },
    ];
    expect(() => normaliseLocalIo(raw)).to.throw(/duplicate_local_io_id_dup/);
  });

  it('accepts the firmware type aliases', () => {
    expect(normaliseLocalIo([{ id: 'a', entity_id: 'switch.a', name: 'A', type: 'switch' }])[0].type).to.equal('relay');
    expect(normaliseLocalIo([{ id: 'b', entity_id: 'sensor.b', name: 'B', type: 'temp' }])[0].type).to.equal('temperature');
  });

  it('refuses more channels than the firmware can announce', () => {
    const raw = Array.from({ length: 65 }, (_, i) => ({ id: `c${i}`, entity_id: `switch.c${i}`, name: 'C', type: 'relay' }));
    expect(() => normaliseLocalIo(raw)).to.throw(/too_many_local_io_channels/);
  });

  it('accepts exactly the maximum number of channels', () => {
    const raw = Array.from({ length: 64 }, (_, i) => ({ id: `c${i}`, entity_id: `switch.c${i}`, name: 'C', type: 'relay' }));
    expect(normaliseLocalIo(raw)).to.have.length(64);
  });

  it('bounds the sensor and binary sensor lists', () => {
    const many = Array.from({ length: 513 }, (_, i) => `sensor.s${i}`);
    expect(() => parseAnnouncement('a1', JSON.stringify({ sensors: many }))).to.throw(/too_many_sensors/);
    expect(() => parseAnnouncement('a1', JSON.stringify({ binary_sensors: many }))).to.throw(
      /too_many_binary_sensors/,
    );
  });

  it('bounds the scene alias map', () => {
    const aliases: Record<string, string> = {};
    for (let i = 0; i < 257; i++) aliases[`alias ${i}`] = `scene.s${i}`;
    expect(() => parseAnnouncement('a1', JSON.stringify({ scene_map: aliases }))).to.throw(
      /too_many_scene_aliases/,
    );
  });

  it('bounds legacy entity ids per channel', () => {
    const raw = [
      {
        id: 'relay_1',
        entity_id: 'switch.a',
        name: 'A',
        type: 'relay',
        legacy_entity_ids: Array.from({ length: 9 }, (_, i) => `switch.old${i}`),
      },
    ];
    expect(() => normaliseLocalIo(raw)).to.throw(/too_many_legacy_entity_ids_relay_1/);
  });

  it('drops a malformed legacy entity id instead of failing the announcement', () => {
    const raw = [
      {
        id: 'relay_1',
        entity_id: 'switch.a',
        name: 'A',
        type: 'relay',
        legacy_entity_ids: ['switch.old_one', 'not an entity id', 'light.wrong_domain', 'SWITCH.OLD_TWO'],
      },
    ];
    // A legacy alias is a migration aid, not load-bearing state: a bad one is
    // dropped, and a differently-cased valid one is normalised and kept.
    expect(normaliseLocalIo(raw)[0]!.legacyEntityIds).to.deep.equal(['switch.old_one', 'switch.old_two']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx mocha test/protocol/announce.test.ts`
Expected: FAIL, `Cannot find module '../../src/protocol/announce'`

- [ ] **Step 3: Implement `src/protocol/announce.ts`**

```ts
export type LocalIoType = 'relay' | 'temperature';

export interface LocalIoChannel {
  id: string;
  entityId: string;
  legacyEntityIds: string[];
  name: string;
  type: LocalIoType;
}

export interface Announcement {
  deviceId: string;
  baseTopic: string;
  haPrefix: string;
  deviceName: string;
  manufacturer: string;
  model: string;
  sensors: string[];
  binarySensors: string[];
  sceneMap: Record<string, string>;
  localIo: LocalIoChannel[];
}

export class AnnounceError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'AnnounceError';
  }
}

const MAX_LOCAL_IO_CHANNELS = 64;
/**
 * Every list in this payload is bounded. The announcement arrives as a retained
 * MQTT message, so anything able to publish to the config topic can hand us this
 * blob and we would hold whatever we parsed until the panel is removed. The
 * caps below are far above what real firmware emits (a panel has tens of tiles,
 * and HardwareIoManager tops out at 8 channels) and exist only to keep a
 * malformed or hostile payload from turning into unbounded work and memory.
 */
const MAX_ENTITY_LIST = 512;
const MAX_SCENE_ALIASES = 256;
/** Parity with the Python bridge's MAX_LOCAL_IO_LEGACY_ENTITY_IDS. */
const MAX_LEGACY_ENTITY_IDS = 8;
const CHANNEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENTITY_ID_RE = /^(sensor|switch)\.[a-z0-9][a-z0-9_]{0,254}$/;

const TYPE_ALIASES: Record<string, LocalIoType> = {
  relay: 'relay',
  switch: 'relay',
  temperature: 'temperature',
  temperature_sensor: 'temperature',
  temp: 'temperature',
};

function asStringArray(value: unknown, cap: number, code: string): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > cap) throw new AnnounceError(code);
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function asStringRecord(value: unknown, cap: number, code: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > cap) throw new AnnounceError(code);
  const out: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (typeof entry === 'string' && entry.length > 0) out[key] = entry;
  }
  return out;
}

export function normaliseLocalIo(raw: unknown): LocalIoChannel[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AnnounceError('invalid_local_io');
  if (raw.length > MAX_LOCAL_IO_CHANNELS) throw new AnnounceError('too_many_local_io_channels');

  const result: LocalIoChannel[] = [];
  const seenIds = new Set<string>();

  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AnnounceError(`invalid_local_io_item_${index}`);
    }
    const record = item as Record<string, unknown>;
    const type = TYPE_ALIASES[String(record.type ?? '').trim().toLowerCase()];
    const id = String(record.id ?? '').trim();
    const entityId = String(record.entity_id ?? '').trim().toLowerCase();

    if (!type || !CHANNEL_ID_RE.test(id) || !ENTITY_ID_RE.test(entityId)) {
      throw new AnnounceError(`invalid_local_io_item_${index}`);
    }
    if (seenIds.has(id)) throw new AnnounceError(`duplicate_local_io_id_${id}`);
    seenIds.add(id);

    // Legacy aliases are best-effort migration aids, not load-bearing state, so
    // an entry that is not a well-formed entity id is dropped rather than
    // failing the whole announcement. The count is still capped: an absurd list
    // is a malformed payload, not a migration.
    const legacyEntityIds = asStringArray(
      record.legacy_entity_ids,
      MAX_LEGACY_ENTITY_IDS,
      `too_many_legacy_entity_ids_${id}`,
    )
      .map((value) => value.trim().toLowerCase())
      .filter((value) => ENTITY_ID_RE.test(value));

    result.push({
      id,
      entityId,
      legacyEntityIds,
      name: String(record.name ?? '').trim() || id,
      type,
    });
  }

  return result;
}

export function parseAnnouncement(deviceId: string, raw: string): Announcement {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AnnounceError('invalid_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AnnounceError('invalid_payload');
  }
  const payload = parsed as Record<string, unknown>;

  const text = (key: string, fallback: string): string => {
    const value = payload[key];
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  };

  return {
    // The topic is authoritative: it is what the panel actually owns.
    deviceId,
    baseTopic: text('base_topic', 'hometiles'),
    haPrefix: text('ha_prefix', 'ha/statestream'),
    deviceName: text('device_name', ''),
    manufacturer: text('manufacturer', 'HomeTiles'),
    model: text('model', ''),
    sensors: asStringArray(payload.sensors, MAX_ENTITY_LIST, 'too_many_sensors'),
    binarySensors: asStringArray(payload.binary_sensors, MAX_ENTITY_LIST, 'too_many_binary_sensors'),
    sceneMap: asStringRecord(payload.scene_map, MAX_SCENE_ALIASES, 'too_many_scene_aliases'),
    localIo: normaliseLocalIo(payload.local_io),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx mocha test/protocol/announce.test.ts`
Expected: PASS, 14 passing

- [ ] **Step 5: Commit**

```bash
git add src/protocol/announce.ts test/protocol/announce.test.ts
git commit -m "feat(protocol): parse panel announcements with atomic local I/O validation"
```

---

## Task 4: Registry types and stable entity ids

**Files:**
- Create: `src/registry/types.ts`, `src/registry/entity-id.ts`
- Test: `test/registry/entity-id.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Domain`, `VirtualEntity`, `SourceValue`, `ChannelInput`, `DeviceInput`, `slugify(input: string): string`, `buildEntityId(domain: Domain, source: string, taken: ReadonlySet<string>): string`, `resolveEntityIds(devices: DeviceInput[], persisted: Record<string, string>): Record<string, string>`.

`resolveEntityIds` is the mechanism behind the Global Constraint that entity ids survive an ioBroker rename: an object id already present in `persisted` keeps its id verbatim, and only new object ids get a freshly derived one.

- [ ] **Step 1: Write the failing test**

Create `test/registry/entity-id.test.ts`:

```ts
import { expect } from 'chai';
import { buildEntityId, resolveEntityIds, slugify } from '../../src/registry/entity-id';
import type { DeviceInput } from '../../src/registry/types';

function device(objectId: string, name: string): DeviceInput {
  return { objectId, name, detectorType: 'socket', domain: 'switch', channels: {} };
}

describe('registry/entity-id', () => {
  it('lowercases and replaces every non-alphanumeric run with a single underscore', () => {
    expect(slugify('Küche Decke / 2')).to.equal('kuche_decke_2');
    expect(slugify('  Wohnzimmer--Lampe  ')).to.equal('wohnzimmer_lampe');
  });

  it('never produces a leading or trailing underscore', () => {
    expect(slugify('__abc__')).to.equal('abc');
  });

  it('falls back to a placeholder when nothing survives slugification', () => {
    expect(slugify('***')).to.equal('unnamed');
  });

  it('builds a domain-prefixed entity id', () => {
    expect(buildEntityId('light', 'hue.0.Kueche Decke', new Set())).to.equal('light.kueche_decke');
  });

  it('suffixes deterministically on collision', () => {
    const taken = new Set(['light.decke']);
    expect(buildEntityId('light', 'decke', taken)).to.equal('light.decke_2');
    taken.add('light.decke_2');
    expect(buildEntityId('light', 'decke', taken)).to.equal('light.decke_3');
  });

  it('keeps a persisted entity id when the ioBroker object is renamed', () => {
    const persisted = { 'hue.0.old_name': 'light.old_name' };
    const resolved = resolveEntityIds([{ ...device('hue.0.old_name', 'Brand New Name'), domain: 'light' }], persisted);
    expect(resolved['hue.0.old_name']).to.equal('light.old_name');
  });

  it('assigns fresh ids only to object ids that are not yet persisted', () => {
    const persisted = { 'hue.0.a': 'light.a' };
    const resolved = resolveEntityIds(
      [
        { ...device('hue.0.a', 'A'), domain: 'light' },
        { ...device('hue.0.b', 'B'), domain: 'light' },
      ],
      persisted,
    );
    expect(resolved).to.deep.equal({ 'hue.0.a': 'light.a', 'hue.0.b': 'light.b' });
  });

  it('does not let a new device steal an id already persisted for another object', () => {
    const persisted = { 'hue.0.a': 'light.decke' };
    const resolved = resolveEntityIds(
      [
        { ...device('hue.0.a', 'Decke'), domain: 'light' },
        { ...device('zigbee.0.x', 'Decke'), domain: 'light' },
      ],
      persisted,
    );
    expect(resolved['hue.0.a']).to.equal('light.decke');
    expect(resolved['zigbee.0.x']).to.equal('light.decke_2');
  });

  it('reserves a persisted id whose device is currently absent, so it can be reclaimed', () => {
    // This is the whole reason the reservation pass runs before assignment: an
    // offline device must find its id waiting for it, not taken by a newcomer.
    const persisted = { 'hue.0.gone': 'light.decke' };
    const resolved = resolveEntityIds([{ ...device('zigbee.0.x', 'Decke'), domain: 'light' }], persisted);
    expect(resolved['zigbee.0.x']).to.equal('light.decke_2');

    // And when the absent device comes back, it reclaims its original id.
    const afterReturn = resolveEntityIds(
      [
        { ...device('zigbee.0.x', 'Decke'), domain: 'light' },
        { ...device('hue.0.gone', 'Decke'), domain: 'light' },
      ],
      { ...persisted, 'zigbee.0.x': 'light.decke_2' },
    );
    expect(afterReturn['hue.0.gone']).to.equal('light.decke');
    expect(afterReturn['zigbee.0.x']).to.equal('light.decke_2');
  });

  it('slugifies a display name whole instead of splitting it on a dot', () => {
    // "Sensor v1.2" must not become sensor.2.
    const resolved = resolveEntityIds([{ ...device('zigbee.0.abc', 'Sensor v1.2'), domain: 'sensor' }], {});
    expect(resolved['zigbee.0.abc']).to.equal('sensor.sensor_v1_2');
  });

  it('falls back to the object id tail when the device has no name', () => {
    const resolved = resolveEntityIds([{ ...device('zigbee.0.kueche', '   '), domain: 'switch' }], {});
    expect(resolved['zigbee.0.kueche']).to.equal('switch.kueche');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx mocha test/registry/entity-id.test.ts`
Expected: FAIL, `Cannot find module '../../src/registry/entity-id'`

- [ ] **Step 3: Implement `src/registry/types.ts`**

```ts
export type Domain = 'sensor' | 'binary_sensor' | 'switch' | 'light' | 'scene';

export const DOMAINS: readonly Domain[] = ['sensor', 'binary_sensor', 'switch', 'light', 'scene'];

/** The subset of an ioBroker state this adapter cares about. */
export interface SourceValue {
  val: unknown;
  ack: boolean;
  /** ioBroker quality. Anything other than 0 means the value is not trustworthy. */
  q?: number;
  ts: number;
}

/** One ioBroker state backing a logical channel of a detected device. */
export interface ChannelInput {
  objectId: string;
  role?: string;
  unit?: string;
  type?: 'boolean' | 'number' | 'string' | 'mixed';
  min?: number;
  max?: number;
  states?: Record<string, string>;
  write?: boolean;
}

/** A device as classified by the detector plus the admin's overrides. */
export interface DeviceInput {
  objectId: string;
  name: string;
  /** Raw @iobroker/type-detector type name, kept for diagnostics and the admin table. */
  detectorType: string;
  domain: Domain;
  /**
   * Logical channel name to ioBroker state. Channel names are the detector's
   * state names lowercased, e.g. SET -> set, ACTUAL -> actual, DIMMER -> dimmer.
   */
  channels: Record<string, ChannelInput>;
  icon?: string;
}

export interface VirtualEntity {
  entityId: string;
  domain: Domain;
  /** Logical channel name to ioBroker state id. */
  source: Record<string, string>;
  /** Home Assistant state string. Never null, never undefined. */
  state: string;
  attributes: Record<string, unknown>;
  available: boolean;
  /** Epoch milliseconds of the last state change. */
  lastChanged: number;
}

export const STATE_UNAVAILABLE = 'unavailable';
export const STATE_UNKNOWN = 'unknown';
export const STATE_ON = 'on';
export const STATE_OFF = 'off';
```

- [ ] **Step 4: Implement `src/registry/entity-id.ts`**

```ts
import type { DeviceInput, Domain } from './types';

export function slugify(input: string): string {
  const folded = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  const slug = folded.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || 'unnamed';
}

/** Uses the last dot-separated segment of an object id, so hue.0.Kueche -> kueche. */
function sourceSlug(source: string): string {
  const tail = source.split('.').pop() ?? source;
  return slugify(tail);
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 10000; suffix++) {
    const candidate = `${base}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`cannot allocate an entity id for ${base}`);
}

/** Derives an id from an OBJECT ID, whose last dot-separated segment is the name. */
export function buildEntityId(domain: Domain, source: string, taken: ReadonlySet<string>): string {
  return uniqueId(`${domain}.${sourceSlug(source)}`, taken);
}

/**
 * Entity ids are keyed by ioBroker object id and persisted. A rename of the
 * underlying object must never orphan tiles already placed on a panel, so a
 * known object id always keeps the id it was first given.
 */
export function resolveEntityIds(
  devices: DeviceInput[],
  persisted: Readonly<Record<string, string>>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  const taken = new Set<string>();

  // Reserve every persisted id first, including ones whose device is currently
  // absent, so a returning device cannot find its id taken by a newcomer.
  for (const entityId of Object.values(persisted)) taken.add(entityId);

  for (const device of devices) {
    const existing = persisted[device.objectId];
    if (existing) resolved[device.objectId] = existing;
  }

  for (const device of devices) {
    if (resolved[device.objectId]) continue;
    // A display name is slugified WHOLE. Routing it through sourceSlug would
    // split on the last dot and turn "Sensor v1.2" into the id "sensor.2".
    // Only an object id has a meaningful dot-separated tail.
    const name = device.name.trim();
    const entityId = name
      ? uniqueId(`${device.domain}.${slugify(name)}`, taken)
      : buildEntityId(device.domain, device.objectId, taken);
    taken.add(entityId);
    resolved[device.objectId] = entityId;
  }

  return resolved;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx mocha test/registry/entity-id.test.ts`
Expected: PASS, 11 passing

- [ ] **Step 6: Commit**

```bash
git add src/registry/types.ts src/registry/entity-id.ts test/registry/entity-id.test.ts
git commit -m "feat(registry): virtual entity types and rename-stable entity ids"
```

---

## Task 5: Attribute synthesis for sensor, binary_sensor and switch

**Files:**
- Create: `src/registry/synth/sensor.ts`, `src/registry/synth/binary_sensor.ts`, `src/registry/synth/switch.ts`
- Test: `test/registry/synth/simple-domains.test.ts`

**Interfaces:**
- Consumes: `DeviceInput`, `SourceValue`, `VirtualEntity`, `STATE_*` from `src/registry/types`.
- Produces: `synthSensor(device, entityId, values): VirtualEntity`, `synthBinarySensor(device, entityId, values): VirtualEntity`, `synthSwitch(device, entityId, values): VirtualEntity`. All three take `values: Readonly<Record<string, SourceValue | null | undefined>>` keyed by ioBroker state id.
- Also produces the shared helper module `src/registry/synth/common.ts` exporting `readChannel(device, name, values): ChannelRead | null`, `isUsable(value: SourceValue | null | undefined): boolean`, `toBoolState(raw: unknown): string`.

- [ ] **Step 1: Write the failing test**

Create `test/registry/synth/simple-domains.test.ts`:

```ts
import { expect } from 'chai';
import { synthBinarySensor } from '../../../src/registry/synth/binary_sensor';
import { synthSensor } from '../../../src/registry/synth/sensor';
import { synthSwitch } from '../../../src/registry/synth/switch';
import type { DeviceInput, SourceValue } from '../../../src/registry/types';

const NOW = 1_757_000_000_000;

function value(val: unknown, q = 0): SourceValue {
  return { val, ack: true, q, ts: NOW };
}

const tempDevice: DeviceInput = {
  objectId: 'zigbee.0.temp',
  name: 'Wohnzimmer',
  detectorType: 'temperature',
  domain: 'sensor',
  channels: { actual: { objectId: 'zigbee.0.temp.value', unit: '°C', type: 'number', role: 'value.temperature' } },
};

const doorDevice: DeviceInput = {
  objectId: 'zigbee.0.door',
  name: 'Haustuer',
  detectorType: 'door',
  domain: 'binary_sensor',
  channels: { actual: { objectId: 'zigbee.0.door.state', type: 'boolean', role: 'sensor.door' } },
};

const socketDevice: DeviceInput = {
  objectId: 'shelly.0.plug',
  name: 'Kaffeemaschine',
  detectorType: 'socket',
  domain: 'switch',
  channels: { set: { objectId: 'shelly.0.plug.on', type: 'boolean', write: true, role: 'switch' } },
};

describe('registry/synth simple domains', () => {
  it('renders a numeric sensor as a bare value with its unit attribute', () => {
    const e = synthSensor(tempDevice, 'sensor.wohnzimmer', { 'zigbee.0.temp.value': value(21.5) });
    expect(e.state).to.equal('21.5');
    expect(e.available).to.equal(true);
    expect(e.attributes.unit_of_measurement).to.equal('°C');
    expect(e.attributes.device_class).to.equal('temperature');
    expect(e.attributes.friendly_name).to.equal('Wohnzimmer');
  });

  it('marks a sensor unavailable when the value is null', () => {
    const e = synthSensor(tempDevice, 'sensor.wohnzimmer', { 'zigbee.0.temp.value': value(null) });
    expect(e.state).to.equal('unavailable');
    expect(e.available).to.equal(false);
  });

  it('marks a sensor unavailable when the ioBroker quality is non-zero', () => {
    const e = synthSensor(tempDevice, 'sensor.wohnzimmer', { 'zigbee.0.temp.value': value(21.5, 0x02) });
    expect(e.state).to.equal('unavailable');
    expect(e.available).to.equal(false);
  });

  it('marks a sensor unknown when a numeric channel holds an unparseable value', () => {
    const e = synthSensor(tempDevice, 'sensor.wohnzimmer', { 'zigbee.0.temp.value': value('n/a') });
    expect(e.state).to.equal('unknown');
    expect(e.available).to.equal(true);
  });

  it('never turns a legitimate zero into unknown or unavailable', () => {
    const e = synthSensor(tempDevice, 'sensor.wohnzimmer', { 'zigbee.0.temp.value': value(0) });
    expect(e.state).to.equal('0');
    expect(e.available).to.equal(true);
  });

  it('marks a sensor unavailable when the backing state is entirely absent', () => {
    const e = synthSensor(tempDevice, 'sensor.wohnzimmer', {});
    expect(e.state).to.equal('unavailable');
    expect(e.available).to.equal(false);
  });

  it('keeps a textual sensor state verbatim', () => {
    const textDevice: DeviceInput = {
      ...tempDevice,
      detectorType: 'info',
      channels: { actual: { objectId: 'zigbee.0.temp.value', type: 'string', role: 'text' } },
    };
    const e = synthSensor(textDevice, 'sensor.status', { 'zigbee.0.temp.value': value('heating') });
    expect(e.state).to.equal('heating');
    expect(e.attributes.unit_of_measurement).to.equal(undefined);
  });

  it('maps a boolean door sensor onto on and off with a device class', () => {
    const open = synthBinarySensor(doorDevice, 'binary_sensor.haustuer', { 'zigbee.0.door.state': value(true) });
    expect(open.state).to.equal('on');
    expect(open.attributes.device_class).to.equal('door');
    const shut = synthBinarySensor(doorDevice, 'binary_sensor.haustuer', { 'zigbee.0.door.state': value(false) });
    expect(shut.state).to.equal('off');
  });

  it('marks a binary sensor unavailable rather than off when its value is missing', () => {
    const e = synthBinarySensor(doorDevice, 'binary_sensor.haustuer', {});
    expect(e.state).to.equal('unavailable');
    expect(e.state).to.not.equal('off');
  });

  it('renders a switch from its SET channel and advertises it as writable', () => {
    const e = synthSwitch(socketDevice, 'switch.kaffeemaschine', { 'shelly.0.plug.on': value(true) });
    expect(e.state).to.equal('on');
    expect(e.source.set).to.equal('shelly.0.plug.on');
    expect(e.attributes.assumed_state).to.equal(false);
  });

  it('prefers an ACTUAL channel over SET for switch feedback when both exist', () => {
    const withActual: DeviceInput = {
      ...socketDevice,
      channels: {
        set: { objectId: 'shelly.0.plug.on', type: 'boolean', write: true },
        actual: { objectId: 'shelly.0.plug.state', type: 'boolean' },
      },
    };
    const e = synthSwitch(withActual, 'switch.kaffeemaschine', {
      'shelly.0.plug.on': value(true),
      'shelly.0.plug.state': value(false),
    });
    expect(e.state).to.equal('off');
  });

  it('treats an empty or blank numeric value as unknown, never as zero', () => {
    // Number('') and Number('   ') are both 0 in JavaScript. A blank reading
    // must not render as a confident 0 on a panel.
    for (const blank of ['', '   ', '\t']) {
      const e = synthSensor(tempDevice, 'sensor.wohnzimmer', { 'zigbee.0.temp.value': value(blank) });
      expect(e.state, `blank ${JSON.stringify(blank)} must be unknown`).to.equal('unknown');
      expect(e.available).to.equal(true);
    }
  });

  it('leaves lastChanged at zero when no source value has ever been seen', () => {
    // Substituting Date.now() here would make a permanently dead entity look
    // freshly changed on every synthesis pass.
    const e = synthSensor(tempDevice, 'sensor.wohnzimmer', {});
    expect(e.lastChanged).to.equal(0);
  });

  it('carries the source timestamp into lastChanged', () => {
    // The value() helper stamps ts = NOW; its second argument is quality.
    const e = synthSensor(tempDevice, 'sensor.wohnzimmer', { 'zigbee.0.temp.value': value(21.5) });
    expect(e.lastChanged).to.equal(NOW);
  });

  it('reports assumed_state when the device offers no feedback channel', () => {
    const setOnly: DeviceInput = {
      ...socketDevice,
      channels: { set: { objectId: 'shelly.0.plug.on', type: 'boolean', write: true } },
    };
    const e = synthSwitch(setOnly, 'switch.k', { 'shelly.0.plug.on': value(true) });
    expect(e.attributes.assumed_state).to.equal(false);
    const noAck: DeviceInput = { ...setOnly };
    const e2 = synthSwitch(noAck, 'switch.k', { 'shelly.0.plug.on': { val: true, ack: false, q: 0, ts: NOW } });
    expect(e2.attributes.assumed_state).to.equal(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx mocha test/registry/synth/simple-domains.test.ts`
Expected: FAIL, `Cannot find module '../../../src/registry/synth/binary_sensor'`

- [ ] **Step 3: Implement `src/registry/synth/common.ts`**

```ts
import type { ChannelInput, DeviceInput, SourceValue } from '../types';
import { STATE_OFF, STATE_ON, STATE_UNAVAILABLE, STATE_UNKNOWN } from '../types';

export type Values = Readonly<Record<string, SourceValue | null | undefined>>;

export interface ChannelRead {
  channel: ChannelInput;
  value: SourceValue | null;
}

/**
 * Reads one logical channel. Returns null when the channel is not configured at
 * all, which is a different condition from a configured channel with no value.
 */
export function readChannel(device: DeviceInput, name: string, values: Values): ChannelRead | null {
  const channel = device.channels[name];
  if (!channel) return null;
  return { channel, value: values[channel.objectId] ?? null };
}

/** A value is usable only when it exists, is non-null and its quality is good. */
export function isUsable(value: SourceValue | null | undefined): value is SourceValue {
  if (!value) return false;
  if (value.val === null || value.val === undefined) return false;
  return !value.q;
}

export function toBoolState(raw: unknown): string {
  if (typeof raw === 'boolean') return raw ? STATE_ON : STATE_OFF;
  if (typeof raw === 'number') return raw !== 0 ? STATE_ON : STATE_OFF;
  if (typeof raw === 'string') {
    const text = raw.trim().toLowerCase();
    if (['true', 'on', '1', 'open', 'yes'].includes(text)) return STATE_ON;
    if (['false', 'off', '0', 'closed', 'no'].includes(text)) return STATE_OFF;
    return STATE_UNKNOWN;
  }
  return STATE_UNKNOWN;
}

export function numberToState(raw: unknown): string {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? String(raw) : STATE_UNKNOWN;
  }
  // Number('') and Number('   ') are both 0. Coercing here would turn a present
  // but empty value into a confident "0" on a wall panel, which is exactly the
  // swallowed zero this module exists to prevent. Blank is unknown, not zero.
  const text = String(raw).trim();
  if (!text) return STATE_UNKNOWN;
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return STATE_UNKNOWN;
  return String(numeric);
}

export function baseEntity(
  device: DeviceInput,
  entityId: string,
  values: Values,
): { source: Record<string, string>; lastChanged: number; friendly: Record<string, unknown> } {
  const source: Record<string, string> = {};
  let lastChanged = 0;
  for (const [name, channel] of Object.entries(device.channels)) {
    source[name] = channel.objectId;
    const value = values[channel.objectId];
    if (value && value.ts > lastChanged) lastChanged = value.ts;
  }
  const friendly: Record<string, unknown> = { friendly_name: device.name || entityId };
  if (device.icon) friendly.icon = device.icon;
  // 0 means "never observed" and is deliberately NOT replaced with Date.now():
  // that would re-evaluate on every synthesis, so an entity whose source has
  // never produced a value would look freshly changed on every pass. Consumers
  // must treat 0 as unknown — see buildApplyPayload, which omits last_changed
  // rather than publishing a fabricated timestamp.
  return { source, lastChanged, friendly };
}

export const UNAVAILABLE = STATE_UNAVAILABLE;
export const UNKNOWN = STATE_UNKNOWN;
```

- [ ] **Step 4: Implement `src/registry/synth/sensor.ts`**

```ts
import type { DeviceInput, VirtualEntity } from '../types';
import { baseEntity, isUsable, numberToState, readChannel, UNAVAILABLE, type Values } from './common';

/** Detector type to Home Assistant device_class, for the numeric sensors v0.1 covers. */
const DEVICE_CLASS_BY_DETECTOR: Record<string, string> = {
  temperature: 'temperature',
  humidity: 'humidity',
  illuminance: 'illuminance',
  pressure: 'pressure',
};

const DEVICE_CLASS_BY_ROLE: Record<string, string> = {
  'value.temperature': 'temperature',
  'value.humidity': 'humidity',
  'value.brightness': 'illuminance',
  'value.pressure': 'pressure',
  'value.battery': 'battery',
  'value.power': 'power',
  'value.voltage': 'voltage',
  'value.current': 'current',
};

export function synthSensor(device: DeviceInput, entityId: string, values: Values): VirtualEntity {
  const { source, lastChanged, friendly } = baseEntity(device, entityId, values);
  const read = readChannel(device, 'actual', values) ?? readChannel(device, 'set', values);

  const attributes: Record<string, unknown> = { ...friendly };
  const deviceClass =
    DEVICE_CLASS_BY_DETECTOR[device.detectorType] ??
    (read?.channel.role ? DEVICE_CLASS_BY_ROLE[read.channel.role] : undefined);
  if (deviceClass) attributes.device_class = deviceClass;
  if (read?.channel.unit) attributes.unit_of_measurement = read.channel.unit;
  if (read?.channel.states) attributes.options = Object.values(read.channel.states);

  if (!read || !isUsable(read.value)) {
    return { entityId, domain: 'sensor', source, state: UNAVAILABLE, attributes, available: false, lastChanged };
  }

  const numeric = read.channel.type === 'number' || typeof read.value.val === 'number';
  const state = numeric ? numberToState(read.value.val) : String(read.value.val);
  if (numeric) attributes.state_class = 'measurement';

  return { entityId, domain: 'sensor', source, state, attributes, available: true, lastChanged };
}
```

- [ ] **Step 5: Implement `src/registry/synth/binary_sensor.ts`**

```ts
import type { DeviceInput, VirtualEntity } from '../types';
import { baseEntity, isUsable, readChannel, toBoolState, UNAVAILABLE, type Values } from './common';

const DEVICE_CLASS_BY_DETECTOR: Record<string, string> = {
  window: 'window',
  windowTilt: 'window',
  door: 'door',
  contact: 'opening',
  motion: 'motion',
  fireAlarm: 'smoke',
  floodAlarm: 'moisture',
  coAlarm: 'carbon_monoxide',
  warning: 'problem',
};

export function synthBinarySensor(device: DeviceInput, entityId: string, values: Values): VirtualEntity {
  const { source, lastChanged, friendly } = baseEntity(device, entityId, values);
  const read = readChannel(device, 'actual', values) ?? readChannel(device, 'set', values);

  const attributes: Record<string, unknown> = { ...friendly };
  const deviceClass = DEVICE_CLASS_BY_DETECTOR[device.detectorType];
  if (deviceClass) attributes.device_class = deviceClass;

  if (!read || !isUsable(read.value)) {
    return {
      entityId,
      domain: 'binary_sensor',
      source,
      state: UNAVAILABLE,
      attributes,
      available: false,
      lastChanged,
    };
  }

  return {
    entityId,
    domain: 'binary_sensor',
    source,
    state: toBoolState(read.value.val),
    attributes,
    available: true,
    lastChanged,
  };
}
```

- [ ] **Step 6: Implement `src/registry/synth/switch.ts`**

```ts
import type { DeviceInput, VirtualEntity } from '../types';
import { baseEntity, isUsable, readChannel, toBoolState, UNAVAILABLE, type Values } from './common';

export function synthSwitch(device: DeviceInput, entityId: string, values: Values): VirtualEntity {
  const { source, lastChanged, friendly } = baseEntity(device, entityId, values);
  const actual = readChannel(device, 'actual', values);
  const set = readChannel(device, 'set', values);
  // ACTUAL is real feedback and wins over the last command written to SET.
  const read = actual && isUsable(actual.value) ? actual : set;

  const attributes: Record<string, unknown> = { ...friendly };
  // Without an ACTUAL channel the only evidence is SET. An unacknowledged SET
  // means the device never confirmed, which is exactly what assumed_state says.
  attributes.assumed_state = !actual && !(set?.value?.ack ?? false);

  if (!read || !isUsable(read.value)) {
    return { entityId, domain: 'switch', source, state: UNAVAILABLE, attributes, available: false, lastChanged };
  }

  return {
    entityId,
    domain: 'switch',
    source,
    state: toBoolState(read.value.val),
    attributes,
    available: true,
    lastChanged,
  };
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx mocha test/registry/synth/simple-domains.test.ts`
Expected: PASS, 15 passing

- [ ] **Step 8: Commit**

```bash
git add src/registry/synth/common.ts src/registry/synth/sensor.ts src/registry/synth/binary_sensor.ts src/registry/synth/switch.ts test/registry/synth/simple-domains.test.ts
git commit -m "feat(registry): attribute synthesis for sensor, binary sensor and switch"
```

---

## Task 6: Attribute synthesis for light and scene, plus domain dispatch

**Files:**
- Create: `src/registry/synth/light.ts`, `src/registry/synth/scene.ts`, `src/registry/synth/index.ts`
- Test: `test/registry/synth/light.test.ts`

**Interfaces:**
- Consumes: everything from Task 5.
- Produces: `synthLight(device, entityId, values): VirtualEntity`, `synthScene(device, entityId, values): VirtualEntity`, `synthesise(device: DeviceInput, entityId: string, values: Values): VirtualEntity`.

Light channel names used by the detector integration in Task 10: `set` (on/off), `dimmer` (0..100 percent), `brightness` (0..254 raw), `red`, `green`, `blue`, `rgb` (hex string), `temperature` (colour temperature), `actual`.

The colour-mode rule is a Global Constraint: modes come only from channels that exist, never from a current value.

- [ ] **Step 1: Write the failing test**

Create `test/registry/synth/light.test.ts`:

```ts
import { expect } from 'chai';
import { synthLight } from '../../../src/registry/synth/light';
import { synthScene } from '../../../src/registry/synth/scene';
import { synthesise } from '../../../src/registry/synth/index';
import type { DeviceInput, SourceValue } from '../../../src/registry/types';

const NOW = 1_757_000_000_000;
const value = (val: unknown, q = 0): SourceValue => ({ val, ack: true, q, ts: NOW });

const onOff: DeviceInput = {
  objectId: 'hue.0.decke',
  name: 'Decke',
  detectorType: 'light',
  domain: 'light',
  channels: { set: { objectId: 'hue.0.decke.on', type: 'boolean', write: true } },
};

const dimmer: DeviceInput = {
  objectId: 'hue.0.dim',
  name: 'Esstisch',
  detectorType: 'dimmer',
  domain: 'light',
  channels: {
    set: { objectId: 'hue.0.dim.on', type: 'boolean', write: true },
    dimmer: { objectId: 'hue.0.dim.level', type: 'number', min: 0, max: 100, write: true },
  },
};

const rgbct: DeviceInput = {
  objectId: 'hue.0.rgb',
  name: 'Sofa',
  detectorType: 'rgb',
  domain: 'light',
  channels: {
    set: { objectId: 'hue.0.rgb.on', type: 'boolean', write: true },
    dimmer: { objectId: 'hue.0.rgb.level', type: 'number', min: 0, max: 100, write: true },
    red: { objectId: 'hue.0.rgb.r', type: 'number', min: 0, max: 255, write: true },
    green: { objectId: 'hue.0.rgb.g', type: 'number', min: 0, max: 255, write: true },
    blue: { objectId: 'hue.0.rgb.b', type: 'number', min: 0, max: 255, write: true },
    temperature: { objectId: 'hue.0.rgb.ct', type: 'number', min: 2000, max: 6500, write: true },
  },
};

describe('registry/synth light and scene', () => {
  it('advertises only onoff for a light with no dimmer channel', () => {
    const e = synthLight(onOff, 'light.decke', { 'hue.0.decke.on': value(true) });
    expect(e.state).to.equal('on');
    expect(e.attributes.supported_color_modes).to.deep.equal(['onoff']);
    expect(e.attributes.brightness).to.equal(undefined);
  });

  it('never advertises colour for a dimmer that has no colour channel', () => {
    const e = synthLight(dimmer, 'light.esstisch', {
      'hue.0.dim.on': value(true),
      'hue.0.dim.level': value(60),
    });
    expect(e.attributes.supported_color_modes).to.deep.equal(['brightness']);
    expect(e.attributes.color_mode).to.equal('brightness');
  });

  it('scales an ioBroker 0..100 dimmer onto the Home Assistant 0..255 range', () => {
    const e = synthLight(dimmer, 'light.esstisch', {
      'hue.0.dim.on': value(true),
      'hue.0.dim.level': value(100),
    });
    expect(e.attributes.brightness).to.equal(255);
    const half = synthLight(dimmer, 'light.esstisch', {
      'hue.0.dim.on': value(true),
      'hue.0.dim.level': value(50),
    });
    expect(half.attributes.brightness).to.equal(128);
  });

  it('treats a dimmer at zero as off without inventing an unavailable state', () => {
    const e = synthLight(dimmer, 'light.esstisch', {
      'hue.0.dim.on': value(false),
      'hue.0.dim.level': value(0),
    });
    expect(e.state).to.equal('off');
    expect(e.available).to.equal(true);
  });

  it('derives on from a non-zero dimmer when the device has no dedicated on channel', () => {
    const dimmerOnly: DeviceInput = {
      ...dimmer,
      channels: { dimmer: { objectId: 'hue.0.dim.level', type: 'number', min: 0, max: 100, write: true } },
    };
    const e = synthLight(dimmerOnly, 'light.esstisch', { 'hue.0.dim.level': value(30) });
    expect(e.state).to.equal('on');
    expect(e.attributes.brightness).to.equal(77);
  });

  it('reports rgb and colour temperature modes when both channel groups exist', () => {
    const e = synthLight(rgbct, 'light.sofa', {
      'hue.0.rgb.on': value(true),
      'hue.0.rgb.level': value(80),
      'hue.0.rgb.r': value(255),
      'hue.0.rgb.g': value(180),
      'hue.0.rgb.b': value(90),
      'hue.0.rgb.ct': value(3000),
    });
    expect(e.attributes.supported_color_modes).to.deep.equal(['color_temp', 'rgb']);
    expect(e.attributes.rgb_color).to.deep.equal([255, 180, 90]);
    expect(e.attributes.color_temp_kelvin).to.equal(3000);
    expect(e.attributes.min_color_temp_kelvin).to.equal(2000);
    expect(e.attributes.max_color_temp_kelvin).to.equal(6500);
  });

  it('marks a light unavailable rather than off when every channel is missing', () => {
    const e = synthLight(dimmer, 'light.esstisch', {});
    expect(e.state).to.equal('unavailable');
    expect(e.available).to.equal(false);
  });

  it('omits brightness rather than publishing zero when the dimmer value is unusable', () => {
    const e = synthLight(dimmer, 'light.esstisch', {
      'hue.0.dim.on': value(true),
      'hue.0.dim.level': value(null),
    });
    expect(e.state).to.equal('on');
    expect(e.attributes.brightness).to.equal(undefined);
  });

  it('omits brightness for a blank dimmer reading instead of reporting zero percent', () => {
    // Number('') is 0, so a naive coercion would render a lamp at 0% rather
    // than admitting the level is unknown.
    const e = synthLight(dimmer, 'light.esstisch', {
      'hue.0.dim.on': value(true),
      'hue.0.dim.level': value('   '),
    });
    expect(e.state).to.equal('on');
    expect(e.attributes.brightness).to.equal(undefined);
    expect(e.attributes.brightness_pct).to.equal(undefined);
  });

  it('renders a scene as a stateless entity that is always available', () => {
    const scene: DeviceInput = {
      objectId: 'scene.0.gute_nacht',
      name: 'Gute Nacht',
      detectorType: 'button',
      domain: 'scene',
      channels: { set: { objectId: 'scene.0.gute_nacht', type: 'boolean', write: true } },
    };
    const e = synthScene(scene, 'scene.gute_nacht', {});
    expect(e.state).to.equal('unknown');
    expect(e.available).to.equal(true);
    expect(e.attributes.friendly_name).to.equal('Gute Nacht');
  });

  it('dispatches to the right synthesiser by domain', () => {
    expect(synthesise(onOff, 'light.decke', { 'hue.0.decke.on': value(true) }).domain).to.equal('light');
    expect(synthesise({ ...onOff, domain: 'switch' }, 'switch.decke', { 'hue.0.decke.on': value(true) }).domain).to.equal('switch');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx mocha test/registry/synth/light.test.ts`
Expected: FAIL, `Cannot find module '../../../src/registry/synth/light'`

- [ ] **Step 3: Implement `src/registry/synth/light.ts`**

```ts
import type { DeviceInput, VirtualEntity } from '../types';
import { STATE_OFF, STATE_ON } from '../types';
import { baseEntity, isUsable, readChannel, toBoolState, UNAVAILABLE, type Values } from './common';

/** ioBroker dimmers are 0..100 percent; Home Assistant brightness is 0..255. */
function percentToHaBrightness(percent: number): number {
  const clamped = Math.min(100, Math.max(0, percent));
  return Math.round((clamped * 255) / 100);
}

function readNumber(device: DeviceInput, name: string, values: Values): number | undefined {
  const read = readChannel(device, name, values);
  if (!read || !isUsable(read.value)) return undefined;
  const raw = read.value.val;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  // The same trap numberToState guards against: Number('') is 0, so a blank
  // dimmer reading would become brightness 0 and render the lamp as off at 0%.
  // Blank means the level is unknown, so the attribute is omitted entirely.
  const text = String(raw).trim();
  if (!text) return undefined;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function synthLight(device: DeviceInput, entityId: string, values: Values): VirtualEntity {
  const { source, lastChanged, friendly } = baseEntity(device, entityId, values);
  const attributes: Record<string, unknown> = { ...friendly };

  // Colour modes come only from channels that exist. Never from a current value.
  const hasDimmer = Boolean(device.channels.dimmer || device.channels.brightness);
  const hasRgb = Boolean(device.channels.red && device.channels.green && device.channels.blue) || Boolean(device.channels.rgb);
  const hasCt = Boolean(device.channels.temperature);

  const modes: string[] = [];
  if (hasCt) modes.push('color_temp');
  if (hasRgb) modes.push('rgb');
  if (!modes.length) modes.push(hasDimmer ? 'brightness' : 'onoff');
  attributes.supported_color_modes = modes;

  const setRead = readChannel(device, 'set', values) ?? readChannel(device, 'actual', values);
  const dimmerPercent = readNumber(device, 'dimmer', values);
  const anyUsable = Boolean(setRead && isUsable(setRead.value)) || dimmerPercent !== undefined;

  if (!anyUsable) {
    return { entityId, domain: 'light', source, state: UNAVAILABLE, attributes, available: false, lastChanged };
  }

  let state: string;
  if (setRead && isUsable(setRead.value)) {
    state = toBoolState(setRead.value.val);
  } else {
    // No on/off channel at all: a non-zero dimmer is the only evidence of "on".
    state = (dimmerPercent ?? 0) > 0 ? STATE_ON : STATE_OFF;
  }

  if (dimmerPercent !== undefined) {
    attributes.brightness = percentToHaBrightness(dimmerPercent);
    attributes.brightness_pct = Math.round(Math.min(100, Math.max(0, dimmerPercent)));
  }

  const red = readNumber(device, 'red', values);
  const green = readNumber(device, 'green', values);
  const blue = readNumber(device, 'blue', values);
  if (red !== undefined && green !== undefined && blue !== undefined) {
    attributes.rgb_color = [Math.round(red), Math.round(green), Math.round(blue)];
  }

  const kelvin = readNumber(device, 'temperature', values);
  if (kelvin !== undefined) attributes.color_temp_kelvin = Math.round(kelvin);
  const ctChannel = device.channels.temperature;
  if (ctChannel?.min !== undefined) attributes.min_color_temp_kelvin = ctChannel.min;
  if (ctChannel?.max !== undefined) attributes.max_color_temp_kelvin = ctChannel.max;

  // color_mode reports the mode currently in effect, chosen from advertised modes.
  if (hasRgb && attributes.rgb_color) attributes.color_mode = 'rgb';
  else if (hasCt && attributes.color_temp_kelvin !== undefined) attributes.color_mode = 'color_temp';
  else attributes.color_mode = modes[0];

  return { entityId, domain: 'light', source, state, attributes, available: true, lastChanged };
}
```

- [ ] **Step 4: Implement `src/registry/synth/scene.ts`**

```ts
import type { DeviceInput, VirtualEntity } from '../types';
import { STATE_UNKNOWN } from '../types';
import { baseEntity, type Values } from './common';

/**
 * A scene has no meaningful state: Home Assistant reports the last activation
 * timestamp and HomeTiles only ever fires it. It stays available so the tile
 * remains pressable, and no state is ever published for it.
 */
export function synthScene(device: DeviceInput, entityId: string, values: Values): VirtualEntity {
  const { source, lastChanged, friendly } = baseEntity(device, entityId, values);
  return {
    entityId,
    domain: 'scene',
    source,
    state: STATE_UNKNOWN,
    attributes: { ...friendly },
    available: true,
    lastChanged,
  };
}
```

- [ ] **Step 5: Implement `src/registry/synth/index.ts`**

```ts
import type { DeviceInput, VirtualEntity } from '../types';
import { synthBinarySensor } from './binary_sensor';
import type { Values } from './common';
import { synthLight } from './light';
import { synthScene } from './scene';
import { synthSensor } from './sensor';
import { synthSwitch } from './switch';

export type { Values } from './common';

export function synthesise(device: DeviceInput, entityId: string, values: Values): VirtualEntity {
  switch (device.domain) {
    case 'sensor':
      return synthSensor(device, entityId, values);
    case 'binary_sensor':
      return synthBinarySensor(device, entityId, values);
    case 'switch':
      return synthSwitch(device, entityId, values);
    case 'light':
      return synthLight(device, entityId, values);
    case 'scene':
      return synthScene(device, entityId, values);
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx mocha test/registry/synth/light.test.ts`
Expected: PASS, 11 passing

- [ ] **Step 7: Run the whole suite and lint**

Run: `npm run lint && npm test`
Expected: all tests pass, no lint errors. The purity rule must report nothing.

- [ ] **Step 8: Commit**

```bash
git add src/registry/synth/light.ts src/registry/synth/scene.ts src/registry/synth/index.ts test/registry/synth/light.test.ts
git commit -m "feat(registry): light and scene synthesis with channel-derived colour modes"
```

---

## Task 7: State payload builder

**Files:**
- Create: `src/protocol/state-payload.ts`
- Test: `test/protocol/state-payload.test.ts`

**Interfaces:**
- Consumes: `entityStateTopic` from `src/protocol/topics`, `VirtualEntity` from `src/registry/types`.
- Produces: `StatePublish { topic: string; payload: string; retain: true }`, `buildStatePublish(haPrefix: string, entity: VirtualEntity): StatePublish | null`, `buildStateClear(haPrefix: string, entityId: string): StatePublish`.

This is where the firmware contract's most dangerous asymmetry lives. `sensor`, `binary_sensor` and `switch` receive a **bare string**. `light` receives a **JSON object**. `scene` publishes nothing at all, so `buildStatePublish` returns `null` for it. Getting this wrong produces tiles that render the literal text `{"state":"on"}`.

- [ ] **Step 1: Write the failing test**

Create `test/protocol/state-payload.test.ts`:

```ts
import { expect } from 'chai';
import { buildStateClear, buildStatePublish } from '../../src/protocol/state-payload';
import { DOMAINS, type VirtualEntity } from '../../src/registry/types';

function entity(over: Partial<VirtualEntity>): VirtualEntity {
  return {
    entityId: 'sensor.x',
    domain: 'sensor',
    source: {},
    state: '1',
    attributes: {},
    available: true,
    lastChanged: 1_757_000_000_000,
    ...over,
  };
}

describe('protocol/state-payload', () => {
  it('publishes a sensor as a bare string, not JSON', () => {
    const p = buildStatePublish('ha/statestream', entity({ entityId: 'sensor.temp', state: '21.5' }));
    expect(p).to.not.equal(null);
    expect(p!.topic).to.equal('ha/statestream/sensor/temp/state');
    expect(p!.payload).to.equal('21.5');
    expect(p!.retain).to.equal(true);
  });

  it('publishes a binary sensor as a bare on or off', () => {
    const p = buildStatePublish('ha/statestream', entity({ entityId: 'binary_sensor.d', domain: 'binary_sensor', state: 'on' }));
    expect(p!.payload).to.equal('on');
  });

  it('publishes a switch as a bare on or off', () => {
    const p = buildStatePublish('ha/statestream', entity({ entityId: 'switch.k', domain: 'switch', state: 'off' }));
    expect(p!.payload).to.equal('off');
  });

  it('publishes unavailable as the bare literal for a bare-string domain', () => {
    const p = buildStatePublish('ha/statestream', entity({ entityId: 'sensor.t', state: 'unavailable', available: false }));
    expect(p!.payload).to.equal('unavailable');
  });

  it('publishes a light as JSON carrying state plus its attributes', () => {
    const p = buildStatePublish(
      'ha/statestream',
      entity({
        entityId: 'light.decke',
        domain: 'light',
        state: 'on',
        attributes: { friendly_name: 'Decke', brightness_pct: 60, rgb_color: [255, 180, 90] },
      }),
    );
    expect(p!.topic).to.equal('ha/statestream/light/decke/state');
    expect(JSON.parse(p!.payload)).to.deep.equal({
      state: 'on',
      friendly_name: 'Decke',
      brightness_pct: 60,
      rgb_color: [255, 180, 90],
    });
  });

  it('lets state win over an attribute that happens to be called state', () => {
    const p = buildStatePublish(
      'ha/statestream',
      entity({ entityId: 'light.d', domain: 'light', state: 'off', attributes: { state: 'on' } }),
    );
    expect(JSON.parse(p!.payload).state).to.equal('off');
  });

  it('drops undefined attributes rather than emitting null', () => {
    const p = buildStatePublish(
      'ha/statestream',
      entity({ entityId: 'light.d', domain: 'light', state: 'on', attributes: { brightness: undefined, icon: 'mdi:bulb' } }),
    );
    const parsed = JSON.parse(p!.payload);
    expect(parsed).to.not.have.property('brightness');
    expect(parsed.icon).to.equal('mdi:bulb');
  });

  it('publishes an unavailable light as JSON so the panel keeps parsing it the same way', () => {
    const p = buildStatePublish(
      'ha/statestream',
      entity({ entityId: 'light.d', domain: 'light', state: 'unavailable', available: false, attributes: { friendly_name: 'D' } }),
    );
    expect(JSON.parse(p!.payload).state).to.equal('unavailable');
  });

  it('publishes nothing for a scene', () => {
    expect(buildStatePublish('ha/statestream', entity({ entityId: 'scene.n', domain: 'scene' }))).to.equal(null);
  });

  it('clears a retained entity with an empty retained payload', () => {
    const p = buildStateClear('ha/statestream', 'sensor.gone');
    expect(p.topic).to.equal('ha/statestream/sensor/gone/state');
    expect(p.payload).to.equal('');
    expect(p.retain).to.equal(true);
  });

  it('assigns every v0.1 domain an explicit payload shape', () => {
    // Guards the exhaustive switch: a domain added to the union without a
    // decided payload shape must fail to compile, never default into JSON.
    // This test pins the runtime half of that contract.
    const shapes = DOMAINS.map((domain) => {
      const publish = buildStatePublish('ha/statestream', entity({ entityId: `${domain}.t`, domain, state: 'on' }));
      if (!publish) return [domain, 'none'] as const;
      return [domain, publish.payload.startsWith('{') ? 'json' : 'bare'] as const;
    });
    expect(Object.fromEntries(shapes)).to.deep.equal({
      sensor: 'bare',
      binary_sensor: 'bare',
      switch: 'bare',
      light: 'json',
      scene: 'none',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx mocha test/protocol/state-payload.test.ts`
Expected: FAIL, `Cannot find module '../../src/protocol/state-payload'`

- [ ] **Step 3: Implement `src/protocol/state-payload.ts`**

```ts
import type { Domain, VirtualEntity } from '../registry/types';
import { entityStateTopic } from './topics';

export interface StatePublish {
  topic: string;
  payload: string;
  retain: true;
}

type PayloadShape = 'bare' | 'json' | 'none';

/**
 * The wire format is domain-dependent, and getting it wrong is visible on a
 * wall panel as literal JSON text. This is an exhaustive switch with no
 * `default` on purpose: adding a domain to the `Domain` union without deciding
 * its payload shape must fail to COMPILE, not silently fall into the JSON
 * branch. Do not rewrite it as a set membership test with a fallthrough.
 *
 * - bare: sync_external_temp_entity publishes a bare dtostrf result or the
 *   literal "unavailable", and tiles_update_sensor_by_entity consumes the raw
 *   payload for TILE_SENSOR, TILE_SWITCH and TILE_BINARY_SENSOR.
 * - json: sync_local_device_entities publishes {"state":"on","brightness_pct":N}.
 * - none: a scene has no state; the panel only ever fires it.
 */
function payloadShape(domain: Domain): PayloadShape {
  switch (domain) {
    case 'sensor':
    case 'binary_sensor':
    case 'switch':
      return 'bare';
    case 'light':
      return 'json';
    case 'scene':
      return 'none';
  }
}

export function buildStatePublish(haPrefix: string, entity: VirtualEntity): StatePublish | null {
  const shape = payloadShape(entity.domain);
  if (shape === 'none') return null;

  const topic = entityStateTopic(haPrefix, entity.entityId);

  if (shape === 'bare') {
    return { topic, payload: entity.state, retain: true };
  }

  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entity.attributes)) {
    if (value === undefined) continue;
    body[key] = value;
  }
  // The entity's own state is authoritative and overwrites any attribute that
  // happens to share the name.
  body.state = entity.state;

  return { topic, payload: JSON.stringify(body), retain: true };
}

/** An empty retained payload removes the retained value from the broker. */
export function buildStateClear(haPrefix: string, entityId: string): StatePublish {
  return { topic: entityStateTopic(haPrefix, entityId), payload: '', retain: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx mocha test/protocol/state-payload.test.ts`
Expected: PASS, 11 passing

- [ ] **Step 5: Commit**

```bash
git add src/protocol/state-payload.ts test/protocol/state-payload.test.ts
git commit -m "feat(protocol): domain-correct state payloads, bare for sensors, JSON for lights"
```

---

## Task 8: Configuration push and icon update payloads

**Files:**
- Create: `src/protocol/apply.ts`, `src/protocol/icons.ts`
- Test: `test/protocol/apply.test.ts`

**Interfaces:**
- Consumes: `VirtualEntity` from `src/registry/types`.
- Produces: `ApplyInput { entities: VirtualEntity[]; sceneMap: Record<string, string> }`, `buildApplyPayload(input: ApplyInput): string`, `configSignature(payload: string): string`, `buildIconsPayload(entities: VirtualEntity[]): string`.

Key names come from the firmware's substring scanner and are not negotiable. The arrays the firmware looks for are `sensors`, `binary_sensors`, `lights`, `switches`, and the object `scene_map`. The metadata sections are `sensor_meta`, `binary_sensor_meta`, `light_meta`, `switch_meta` and `scene_meta`. Sections for the domains outside v0.1 are emitted as empty arrays so the firmware's scan for them finds a well-formed empty section rather than nothing.

- [ ] **Step 1: Write the failing test**

Create `test/protocol/apply.test.ts`:

```ts
import { expect } from 'chai';
import { buildApplyPayload, buildIconsPayload, configSignature } from '../../src/protocol/apply';
import type { VirtualEntity } from '../../src/registry/types';

function e(over: Partial<VirtualEntity>): VirtualEntity {
  return {
    entityId: 'sensor.x',
    domain: 'sensor',
    source: {},
    state: '1',
    attributes: {},
    available: true,
    lastChanged: 1_757_000_000_000,
    ...over,
  };
}

const ENTITIES: VirtualEntity[] = [
  e({ entityId: 'sensor.temp', state: '21.5', attributes: { friendly_name: 'Wohnzimmer', unit_of_measurement: '°C', icon: 'mdi:thermometer' } }),
  e({ entityId: 'binary_sensor.tuer', domain: 'binary_sensor', state: 'on', attributes: { friendly_name: 'Haustuer', device_class: 'door', icon: 'mdi:door' } }),
  e({ entityId: 'switch.kaffee', domain: 'switch', state: 'off', attributes: { friendly_name: 'Kaffee' } }),
  e({ entityId: 'light.decke', domain: 'light', state: 'on', attributes: { friendly_name: 'Decke', brightness_pct: 60 } }),
  e({ entityId: 'scene.nacht', domain: 'scene', state: 'unknown', attributes: { friendly_name: 'Gute Nacht' } }),
];

describe('protocol/apply', () => {
  it('emits every top-level key the firmware scanner looks for', () => {
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: {} }));
    for (const key of ['sensors', 'binary_sensors', 'lights', 'switches', 'media_players', 'climates', 'covers', 'cameras', 'weathers', 'scene_map']) {
      expect(parsed, `missing key ${key}`).to.have.property(key);
    }
  });

  it('routes each entity into the array for its domain', () => {
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: {} }));
    expect(parsed.sensors).to.deep.equal(['sensor.temp']);
    expect(parsed.binary_sensors).to.deep.equal(['binary_sensor.tuer']);
    expect(parsed.switches).to.deep.equal(['switch.kaffee']);
    expect(parsed.lights).to.deep.equal(['light.decke']);
  });

  it('emits empty arrays for the domains v0.1 does not implement', () => {
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: {} }));
    expect(parsed.media_players).to.deep.equal([]);
    expect(parsed.climates).to.deep.equal([]);
    expect(parsed.covers).to.deep.equal([]);
    expect(parsed.cameras).to.deep.equal([]);
    expect(parsed.weathers).to.deep.equal([]);
  });

  it('builds sensor_meta with the exact keys the firmware parser reads', () => {
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: {} }));
    expect(parsed.sensor_meta[0]).to.deep.equal({
      entity_id: 'sensor.temp',
      name: 'Wohnzimmer',
      unit: '°C',
      state: '21.5',
      value: '21.5',
      state_kind: 'number',
      number: true,
      icon: 'mdi:thermometer',
    });
  });

  it('marks a textual sensor with state_kind state and number false', () => {
    const text = e({ entityId: 'sensor.mode', state: 'heating', attributes: { friendly_name: 'Modus' } });
    const parsed = JSON.parse(buildApplyPayload({ entities: [text], sceneMap: {} }));
    expect(parsed.sensor_meta[0].state_kind).to.equal('state');
    expect(parsed.sensor_meta[0].number).to.equal(false);
  });

  it('builds binary_sensor_meta with availability and the localisable state labels', () => {
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: {} }));
    const meta = parsed.binary_sensor_meta[0];
    expect(meta.entity_id).to.equal('binary_sensor.tuer');
    expect(meta.device_class).to.equal('door');
    expect(meta.state).to.equal('on');
    expect(meta.available).to.equal(true);
    expect(meta.last_changed).to.equal(1_757_000_000);
    expect(meta.icon).to.equal('mdi:door');
  });

  it('omits last_changed entirely when the source has never produced a value', () => {
    // lastChanged 0 means never observed. Publishing unixSeconds(0) would claim
    // the entity last changed in 1970; fabricating a current timestamp would
    // make a dead entity look fresh on every push.
    const never = e({ entityId: 'binary_sensor.n', domain: 'binary_sensor', state: 'unavailable', available: false, lastChanged: 0, attributes: { friendly_name: 'N' } });
    const parsed = JSON.parse(buildApplyPayload({ entities: [never], sceneMap: {} }));
    expect(parsed.binary_sensor_meta[0]).to.not.have.property('last_changed');
  });

  it('reports an unavailable entity as available false in its metadata', () => {
    const gone = e({ entityId: 'binary_sensor.g', domain: 'binary_sensor', state: 'unavailable', available: false, attributes: { friendly_name: 'G' } });
    const parsed = JSON.parse(buildApplyPayload({ entities: [gone], sceneMap: {} }));
    expect(parsed.binary_sensor_meta[0].available).to.equal(false);
    expect(parsed.binary_sensor_meta[0].state).to.equal('unavailable');
  });

  it('passes the scene alias map through lowercased', () => {
    const parsed = JSON.parse(buildApplyPayload({ entities: ENTITIES, sceneMap: { 'Gute Nacht': 'scene.nacht' } }));
    expect(parsed.scene_map).to.deep.equal({ 'gute nacht': 'scene.nacht' });
  });

  it('produces a stable signature for identical input and a different one after a change', () => {
    const a = buildApplyPayload({ entities: ENTITIES, sceneMap: {} });
    const b = buildApplyPayload({ entities: ENTITIES, sceneMap: {} });
    expect(configSignature(a)).to.equal(configSignature(b));

    const changed = buildApplyPayload({
      entities: [...ENTITIES, e({ entityId: 'sensor.new', attributes: { friendly_name: 'New' } })],
      sceneMap: {},
    });
    expect(configSignature(changed)).to.not.equal(configSignature(a));
  });

  it('orders entities deterministically so an unchanged registry never re-pushes', () => {
    const forward = buildApplyPayload({ entities: ENTITIES, sceneMap: {} });
    const reversed = buildApplyPayload({ entities: [...ENTITIES].reverse(), sceneMap: {} });
    expect(configSignature(forward)).to.equal(configSignature(reversed));
  });

  it('builds an icons-only payload keyed by entity id', () => {
    const parsed = JSON.parse(buildIconsPayload(ENTITIES));
    expect(parsed.icons).to.deep.equal({
      'sensor.temp': 'mdi:thermometer',
      'binary_sensor.tuer': 'mdi:door',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx mocha test/protocol/apply.test.ts`
Expected: FAIL, `Cannot find module '../../src/protocol/apply'`

- [ ] **Step 3: Implement `src/protocol/apply.ts`**

```ts
import { createHash } from 'node:crypto';
import type { Domain, VirtualEntity } from '../registry/types';

export interface ApplyInput {
  entities: VirtualEntity[];
  sceneMap: Record<string, string>;
}

function text(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];
  return typeof value === 'string' && value.length ? value : undefined;
}

function idsFor(entities: VirtualEntity[], domain: Domain): string[] {
  return entities.filter((entity) => entity.domain === domain).map((entity) => entity.entityId);
}

function isNumericState(state: string): boolean {
  if (!state.length) return false;
  return Number.isFinite(Number(state));
}

/** The firmware stores last_changed as unix seconds. */
function unixSeconds(msValue: number): number {
  return Math.floor(msValue / 1000);
}

function sensorMeta(entities: VirtualEntity[]): Record<string, unknown>[] {
  return entities
    .filter((entity) => entity.domain === 'sensor')
    .map((entity) => {
      const numeric = isNumericState(entity.state);
      const meta: Record<string, unknown> = {
        entity_id: entity.entityId,
        name: text(entity.attributes, 'friendly_name') ?? entity.entityId,
        unit: text(entity.attributes, 'unit_of_measurement') ?? '',
        state: entity.state,
        value: entity.state,
        // Firmware accepts only "number" or "state" here: parseSensorMetaSection
        // in ha_bridge_config.cpp stores the key only for those two values, and
        // sensor/renderer.cpp branches on them to pick graph vs history mode.
        // Any other value, including the intuitive "text", is silently dropped
        // and the panel falls back to a unit-based heuristic that guesses wrong
        // for a textual sensor that happens to carry a unit.
        state_kind: numeric ? 'number' : 'state',
        number: numeric,
      };
      const icon = text(entity.attributes, 'icon');
      if (icon) meta.icon = icon;
      return meta;
    });
}

function binarySensorMeta(entities: VirtualEntity[]): Record<string, unknown>[] {
  return entities
    .filter((entity) => entity.domain === 'binary_sensor')
    .map((entity) => {
      const meta: Record<string, unknown> = {
        entity_id: entity.entityId,
        name: text(entity.attributes, 'friendly_name') ?? entity.entityId,
        device_class: text(entity.attributes, 'device_class') ?? '',
        state: entity.state,
        on: 'on',
        off: 'off',
        unknown: 'unknown',
        unavailable: 'unavailable',
        available: entity.available,
      };
      // lastChanged 0 means the source has never produced a value. Publishing
      // unixSeconds(0) would tell the panel this entity last changed in 1970,
      // and fabricating Date.now() would make a dead entity look fresh on every
      // push. Omitting the key lets the firmware's scanner simply not find it.
      if (entity.lastChanged > 0) meta.last_changed = unixSeconds(entity.lastChanged);
      const icon = text(entity.attributes, 'icon');
      if (icon) meta.icon = icon;
      return meta;
    });
}

function simpleMeta(entities: VirtualEntity[], domain: Domain): Record<string, unknown>[] {
  return entities
    .filter((entity) => entity.domain === domain)
    .map((entity) => {
      const meta: Record<string, unknown> = {
        entity_id: entity.entityId,
        name: text(entity.attributes, 'friendly_name') ?? entity.entityId,
        state: entity.state,
        available: entity.available,
      };
      const icon = text(entity.attributes, 'icon');
      if (icon) meta.icon = icon;
      return meta;
    });
}

function byEntityId(a: VirtualEntity, b: VirtualEntity): number {
  return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
}

export function buildApplyPayload(input: ApplyInput): string {
  // Deterministic ordering is what makes the config signature meaningful: a
  // registry that did not change must serialise byte-identically.
  const entities = [...input.entities].sort(byEntityId);

  const sceneMap: Record<string, string> = {};
  for (const alias of Object.keys(input.sceneMap).sort()) {
    const target = input.sceneMap[alias];
    if (target) sceneMap[alias.toLowerCase()] = target;
  }

  const payload = {
    sensors: idsFor(entities, 'sensor'),
    binary_sensors: idsFor(entities, 'binary_sensor'),
    lights: idsFor(entities, 'light'),
    switches: idsFor(entities, 'switch'),
    // Domains outside v0.1. Emitted empty so the firmware's scan finds a
    // well-formed section instead of falling back to a stale stored value.
    media_players: [] as string[],
    climates: [] as string[],
    covers: [] as string[],
    cameras: [] as string[],
    weathers: [] as string[],
    scene_map: sceneMap,
    sensor_meta: sensorMeta(entities),
    binary_sensor_meta: binarySensorMeta(entities),
    light_meta: simpleMeta(entities, 'light'),
    switch_meta: simpleMeta(entities, 'switch'),
    scene_meta: simpleMeta(entities, 'scene'),
  };

  return JSON.stringify(payload);
}

export function configSignature(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

export function buildIconsPayload(entities: VirtualEntity[]): string {
  const icons: Record<string, string> = {};
  for (const entity of [...entities].sort(byEntityId)) {
    const icon = text(entity.attributes, 'icon');
    if (icon) icons[entity.entityId] = icon;
  }
  return JSON.stringify({ icons });
}
```

- [ ] **Step 4: Create `src/protocol/icons.ts` as the public re-export**

Keeping the icon builder next to the apply builder avoids duplicating the entity sort and the attribute reader, while still giving callers the module name the file structure promises.

```ts
export { buildIconsPayload } from './apply';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx mocha test/protocol/apply.test.ts`
Expected: PASS, 12 passing

- [ ] **Step 6: Commit**

```bash
git add src/protocol/apply.ts src/protocol/icons.ts test/protocol/apply.test.ts
git commit -m "feat(protocol): bridge/apply and bridge/icons payloads with a stable config signature"
```

---

## Task 9: Command parsing

**Files:**
- Create: `src/protocol/commands.ts`
- Test: `test/protocol/commands.test.ts`

**Interfaces:**
- Consumes: `Domain` from `src/registry/types`.
- Produces:
  - `ServiceCall = { kind: 'turn_on' | 'turn_off' | 'toggle'; entityId: string } | { kind: 'set_light'; entityId: string; state?: 'on' | 'off'; brightnessPct?: number; rgb?: [number, number, number]; kelvin?: number } | { kind: 'activate_scene'; alias: string }`
  - `CommandError { code: string }`
  - `parseLightCommand(raw: string): ServiceCall`
  - `parseSwitchCommand(raw: string): ServiceCall`
  - `parseSceneCommand(raw: string): ServiceCall`
  - `parseCommand(leaf: 'light' | 'switch' | 'scene', raw: string): ServiceCall`

Clamping happens here, at the boundary, so no downstream module has to remember to do it. `brightness_pct` clamps to 0..100, each RGB component to 0..255, and kelvin to 1000..15000.

- [ ] **Step 1: Write the failing test**

Create `test/protocol/commands.test.ts`:

```ts
import { expect } from 'chai';
import { CommandError, parseCommand, parseLightCommand, parseSceneCommand, parseSwitchCommand } from '../../src/protocol/commands';

describe('protocol/commands', () => {
  it('parses a plain on command from the switch topic', () => {
    expect(parseSwitchCommand('{"entity_id":"switch.k","state":"on"}')).to.deep.equal({
      kind: 'turn_on',
      entityId: 'switch.k',
    });
  });

  it('parses off and toggle', () => {
    expect(parseSwitchCommand('{"entity_id":"switch.k","state":"off"}').kind).to.equal('turn_off');
    expect(parseSwitchCommand('{"entity_id":"switch.k","state":"toggle"}').kind).to.equal('toggle');
  });

  it('treats a missing state as toggle, which is what the firmware sends', () => {
    expect(parseSwitchCommand('{"entity_id":"switch.k"}').kind).to.equal('toggle');
  });

  it('parses an on-off-only light command as a plain turn_on', () => {
    expect(parseLightCommand('{"entity_id":"light.d","state":"on"}')).to.deep.equal({
      kind: 'turn_on',
      entityId: 'light.d',
    });
  });

  it('parses a light command carrying brightness', () => {
    expect(parseLightCommand('{"entity_id":"light.d","state":"on","brightness_pct":42}')).to.deep.equal({
      kind: 'set_light',
      entityId: 'light.d',
      state: 'on',
      brightnessPct: 42,
    });
  });

  it('parses rgb_color and color_temp_kelvin', () => {
    const call = parseLightCommand('{"entity_id":"light.d","rgb_color":[255,180,90],"color_temp_kelvin":3000}');
    expect(call).to.deep.equal({
      kind: 'set_light',
      entityId: 'light.d',
      rgb: [255, 180, 90],
      kelvin: 3000,
    });
  });

  it('clamps brightness, rgb components and kelvin at the boundary', () => {
    const call = parseLightCommand('{"entity_id":"light.d","brightness_pct":500,"rgb_color":[999,-4,90],"color_temp_kelvin":90000}');
    expect(call).to.deep.equal({
      kind: 'set_light',
      entityId: 'light.d',
      brightnessPct: 100,
      rgb: [255, 0, 90],
      kelvin: 15000,
    });
  });

  it('rejects a non-numeric brightness rather than coercing it to zero', () => {
    expect(() => parseLightCommand('{"entity_id":"light.d","brightness_pct":"bright"}')).to.throw(CommandError);
  });

  it('rejects an rgb_color that is not three numbers', () => {
    expect(() => parseLightCommand('{"entity_id":"light.d","rgb_color":[255,180]}')).to.throw(CommandError);
  });

  it('rejects a payload with no entity_id', () => {
    expect(() => parseSwitchCommand('{"state":"on"}')).to.throw(CommandError);
  });

  it('rejects an entity id with no domain separator', () => {
    expect(() => parseSwitchCommand('{"entity_id":"kaffee","state":"on"}')).to.throw(CommandError);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseSwitchCommand('not json')).to.throw(CommandError);
  });

  it('parses a scene command as plain text, not JSON', () => {
    expect(parseSceneCommand('  Gute Nacht  ')).to.deep.equal({ kind: 'activate_scene', alias: 'gute nacht' });
  });

  it('rejects an empty scene payload', () => {
    expect(() => parseSceneCommand('   ')).to.throw(CommandError);
  });

  it('bounds the scene alias length so a hostile payload cannot allocate freely', () => {
    expect(() => parseSceneCommand('x'.repeat(300))).to.throw(CommandError);
  });

  it('rejects an absurdly long entity id rather than passing it downstream', () => {
    const huge = `switch.${'a'.repeat(300)}`;
    expect(() => parseSwitchCommand(JSON.stringify({ entity_id: huge, state: 'on' }))).to.throw(
      /entity_id_too_long/,
    );
  });

  it('throws rather than returning undefined for an unknown topic leaf', () => {
    // parseCommand is typed to return a ServiceCall. A caller reaching it with
    // a wider string must fail loudly, not receive undefined.
    expect(() => parseCommand('bogus' as 'light', '{}')).to.throw(CommandError);
  });

  it('preserves a legitimate zero on every numeric field', () => {
    // Swallowed zeros have been a recurring defect class in this project.
    expect(parseLightCommand('{"entity_id":"light.d","brightness_pct":0}')).to.deep.equal({
      kind: 'set_light',
      entityId: 'light.d',
      brightnessPct: 0,
    });
    expect(parseLightCommand('{"entity_id":"light.d","rgb_color":[0,0,0]}')).to.deep.equal({
      kind: 'set_light',
      entityId: 'light.d',
      rgb: [0, 0, 0],
    });
  });

  it('clamps kelvin at both boundaries without rejecting them', () => {
    expect((parseLightCommand('{"entity_id":"light.d","color_temp_kelvin":1000}') as { kelvin: number }).kelvin).to.equal(1000);
    expect((parseLightCommand('{"entity_id":"light.d","color_temp_kelvin":15000}') as { kelvin: number }).kelvin).to.equal(15000);
  });

  it('dispatches by topic leaf', () => {
    expect(parseCommand('scene', 'Nacht').kind).to.equal('activate_scene');
    expect(parseCommand('light', '{"entity_id":"light.d","state":"off"}').kind).to.equal('turn_off');
    expect(parseCommand('switch', '{"entity_id":"switch.d","state":"on"}').kind).to.equal('turn_on');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx mocha test/protocol/commands.test.ts`
Expected: FAIL, `Cannot find module '../../src/protocol/commands'`

- [ ] **Step 3: Implement `src/protocol/commands.ts`**

```ts
export type ServiceCall =
  | { kind: 'turn_on'; entityId: string }
  | { kind: 'turn_off'; entityId: string }
  | { kind: 'toggle'; entityId: string }
  | {
      kind: 'set_light';
      entityId: string;
      state?: 'on' | 'off';
      brightnessPct?: number;
      rgb?: [number, number, number];
      kelvin?: number;
    }
  | { kind: 'activate_scene'; alias: string };

export class CommandError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'CommandError';
  }
}

const MAX_SCENE_ALIAS_LENGTH = 128;
/**
 * Home Assistant entity ids are far shorter than this; the cap exists for the
 * same reason the scene alias has one. Every field crossing this boundary is
 * untrusted, so none of them may be unbounded.
 */
const MAX_ENTITY_ID_LENGTH = 255;
const ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function parseObject(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CommandError('invalid_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CommandError('invalid_payload');
  }
  return parsed as Record<string, unknown>;
}

function requireEntityId(payload: Record<string, unknown>): string {
  const raw = payload.entity_id;
  if (typeof raw !== 'string') throw new CommandError('missing_entity_id');
  const entityId = raw.trim().toLowerCase();
  if (entityId.length > MAX_ENTITY_ID_LENGTH) throw new CommandError('entity_id_too_long');
  if (!ENTITY_ID_RE.test(entityId)) throw new CommandError('invalid_entity_id');
  return entityId;
}

function requireNumber(value: unknown, code: string): number {
  const numeric = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(numeric)) throw new CommandError(code);
  return numeric;
}

function onOffCall(entityId: string, state: unknown): ServiceCall {
  const text = typeof state === 'string' ? state.trim().toLowerCase() : '';
  // The firmware sends "toggle" whenever the tile had no explicit target state.
  if (!text || text === 'toggle') return { kind: 'toggle', entityId };
  if (text === 'on') return { kind: 'turn_on', entityId };
  if (text === 'off') return { kind: 'turn_off', entityId };
  throw new CommandError('invalid_state');
}

export function parseSwitchCommand(raw: string): ServiceCall {
  const payload = parseObject(raw);
  return onOffCall(requireEntityId(payload), payload.state);
}

export function parseLightCommand(raw: string): ServiceCall {
  const payload = parseObject(raw);
  const entityId = requireEntityId(payload);

  const hasBrightness = payload.brightness_pct !== undefined;
  const hasRgb = payload.rgb_color !== undefined;
  const hasKelvin = payload.color_temp_kelvin !== undefined;

  // Without any channel argument this is an ordinary on, off or toggle.
  if (!hasBrightness && !hasRgb && !hasKelvin) {
    return onOffCall(entityId, payload.state);
  }

  const call: Extract<ServiceCall, { kind: 'set_light' }> = { kind: 'set_light', entityId };

  if (typeof payload.state === 'string') {
    const text = payload.state.trim().toLowerCase();
    if (text === 'on' || text === 'off') call.state = text;
    else if (text.length) throw new CommandError('invalid_state');
  }

  if (hasBrightness) {
    call.brightnessPct = clamp(requireNumber(payload.brightness_pct, 'invalid_brightness'), 0, 100);
  }

  if (hasRgb) {
    const rgb = payload.rgb_color;
    if (!Array.isArray(rgb) || rgb.length !== 3) throw new CommandError('invalid_rgb');
    const [r, g, b] = rgb.map((component) => clamp(requireNumber(component, 'invalid_rgb'), 0, 255));
    call.rgb = [r as number, g as number, b as number];
  }

  if (hasKelvin) {
    call.kelvin = clamp(requireNumber(payload.color_temp_kelvin, 'invalid_kelvin'), 1000, 15000);
  }

  return call;
}

/** The scene topic carries plain text, not JSON. See mqttPublishScene. */
export function parseSceneCommand(raw: string): ServiceCall {
  const alias = raw.trim().toLowerCase();
  if (!alias) throw new CommandError('empty_scene');
  if (alias.length > MAX_SCENE_ALIAS_LENGTH) throw new CommandError('scene_alias_too_long');
  return { kind: 'activate_scene', alias };
}

export function parseCommand(leaf: 'light' | 'switch' | 'scene', raw: string): ServiceCall {
  switch (leaf) {
    case 'light':
      return parseLightCommand(raw);
    case 'switch':
      return parseSwitchCommand(raw);
    case 'scene':
      return parseSceneCommand(raw);
    default: {
      // The union makes this unreachable at compile time, and the `never`
      // binding keeps that guarantee if a leaf is added. The throw covers the
      // runtime: this function is typed to return a ServiceCall, so a caller
      // reaching it with a wider string must fail loudly rather than receive
      // undefined from a non-optional return type.
      const unreachable: never = leaf;
      throw new CommandError(`unsupported_command_leaf_${String(unreachable)}`);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx mocha test/protocol/commands.test.ts`
Expected: PASS, 20 passing

- [ ] **Step 5: Run the whole suite and lint**

Run: `npm run lint && npm test && npm run build`
Expected: all green. The protocol layer is now complete and fully covered without a broker, ioBroker or hardware.

- [ ] **Step 6: Commit**

```bash
git add src/protocol/commands.ts test/protocol/commands.test.ts
git commit -m "feat(protocol): parse and clamp light, switch and scene commands"
```

---

## Task 10: MQTT client with a bounded outbound queue

**Files:**
- Create: `src/runtime/mqtt-client.ts`
- Test: `test/runtime/mqtt-client.test.ts`

**Interfaces:**
- Consumes: `AdapterOptions` from `src/config/options`.
- Produces:
  - `Logger { info(m: string): void; warn(m: string): void; error(m: string): void; debug(m: string): void }`
  - `PublishRequest { topic: string; payload: string; retain?: boolean; qos?: 0 | 1 }`
  - `HomeTilesMqttClient` with `connect(): Promise<void>`, `disconnect(): Promise<void>`, `subscribe(topic: string): Promise<void>`, `unsubscribe(topic: string): Promise<void>`, `publish(request: PublishRequest): void`, `onMessage(handler: (topic: string, payload: string) => void): void`, `onConnectionChange(handler: (connected: boolean) => void): void`, readonly `connected: boolean`, readonly `droppedPublishes: number`.

The queue is bounded by `options.maxPublishQueue`. On overflow the **oldest** entry is dropped, because the newest value is always the one the panel needs. The drop warning is rate-limited to at most one line every 10 seconds so a sustained overflow cannot itself become the performance problem.

- [ ] **Step 1: Write the failing test**

Create `test/runtime/mqtt-client.test.ts`:

```ts
import Aedes from 'aedes';
import { expect } from 'chai';
import { createServer, type Server } from 'node:net';
import { DEFAULTS } from '../../src/config/options';
import { HomeTilesMqttClient, type Logger } from '../../src/runtime/mqtt-client';

function silentLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    info: () => undefined,
    debug: () => undefined,
    error: () => undefined,
    warn: (message: string) => {
      warnings.push(message);
    },
  };
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
}

/**
 * Polls until a condition holds, instead of sleeping a fixed interval. A fixed
 * sleep encodes an assumption about how fast a loopback round trip is, which is
 * exactly what degrades on a loaded CI runner — the classic source of a test
 * that passes locally and fails intermittently in CI.
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the expected message');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('runtime/mqtt-client', () => {
  const PORT = 18831;
  // aedes 0.51.3 ships Aedes as a class, not a callable factory, so
  // ReturnType<typeof Aedes> does not compile (TS2344). The class IS the type.
  let broker: Aedes;
  let server: Server;

  beforeEach(async () => {
    broker = new Aedes();
    server = createServer(broker.handle);
    await listen(server, PORT);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  });

  it('connects, subscribes and delivers a message to the handler', async () => {
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: PORT }, silentLogger());
    const received: Array<[string, string]> = [];
    client.onMessage((topic, payload) => received.push([topic, payload]));

    await client.connect();
    expect(client.connected).to.equal(true);
    await client.subscribe('test/topic');

    client.publish({ topic: 'test/topic', payload: 'hello', retain: false });
    await waitUntil(() => received.length > 0);

    expect(received).to.deep.equal([['test/topic', 'hello']]);
    await client.disconnect();
  });

  it('reports connection changes', async () => {
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: PORT }, silentLogger());
    const changes: boolean[] = [];
    client.onConnectionChange((connected) => changes.push(connected));

    await client.connect();
    await client.disconnect();

    expect(changes[0]).to.equal(true);
    expect(changes[changes.length - 1]).to.equal(false);
  });

  it('queues publishes made before the connection is up and flushes them afterwards', async () => {
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: PORT }, silentLogger());
    const received: string[] = [];
    client.onMessage((_topic, payload) => received.push(payload));

    client.publish({ topic: 'early/topic', payload: 'queued-before-connect', retain: false });
    await client.connect();
    await client.subscribe('early/topic');
    // Re-publish after subscribing so the assertion does not race the flush.
    client.publish({ topic: 'early/topic', payload: 'after', retain: false });
    await waitUntil(() => received.includes('after'));

    expect(received).to.include('after');
    await client.disconnect();
  });

  it('drops the oldest entry when the queue overflows and counts the drop', async () => {
    const logger = silentLogger();
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: PORT, maxPublishQueue: 100 }, logger);
    // Never connected, so nothing drains: every publish stays queued.
    for (let i = 0; i < 150; i++) {
      client.publish({ topic: 't', payload: String(i), retain: false });
    }
    expect(client.droppedPublishes).to.equal(50);
    expect(client.queueDepth).to.equal(100);
    expect(logger.warnings.length).to.be.greaterThan(0);
    expect(logger.warnings.length).to.be.lessThan(10, 'drop warnings must be rate-limited');
  });

  it('survives a throwing message handler instead of crashing the process', async () => {
    // mqtt.js emits synchronously, so an unguarded throw here escapes into the
    // library and kills the adapter. The protocol parsers these handlers feed
    // throw by design on malformed input arriving from the network.
    const logger = silentLogger();
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: PORT }, logger);
    const seen: string[] = [];
    client.onMessage((_topic, payload) => {
      seen.push(payload);
      throw new Error('handler exploded');
    });

    await client.connect();
    await client.subscribe('boom/topic');
    client.publish({ topic: 'boom/topic', payload: 'first', retain: false });
    await waitUntil(() => seen.length > 0);

    // Still alive and still delivering after the throw.
    client.publish({ topic: 'boom/topic', payload: 'second', retain: false });
    await waitUntil(() => seen.length > 1);
    expect(seen).to.deep.equal(['first', 'second']);
    expect(client.connected).to.equal(true);

    await client.disconnect();
  });

  it('is idempotent on repeated disconnect', async () => {
    const client = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: PORT }, silentLogger());
    await client.connect();
    await client.disconnect();
    await client.disconnect();
    expect(client.connected).to.equal(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx mocha test/runtime/mqtt-client.test.ts`
Expected: FAIL, `Cannot find module '../../src/runtime/mqtt-client'`

- [ ] **Step 3: Implement `src/runtime/mqtt-client.ts`**

```ts
import mqtt, { type MqttClient } from 'mqtt';
import type { AdapterOptions } from '../config/options';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface PublishRequest {
  topic: string;
  payload: string;
  retain?: boolean;
  qos?: 0 | 1;
}

const DROP_WARN_INTERVAL_MS = 10_000;

export class HomeTilesMqttClient {
  private client: MqttClient | null = null;
  private queue: PublishRequest[] = [];
  private messageHandler: ((topic: string, payload: string) => void) | null = null;
  private connectionHandler: ((connected: boolean) => void) | null = null;
  private isConnected = false;
  private dropped = 0;
  private lastDropWarnMs = 0;
  private stopping = false;

  constructor(
    private readonly options: AdapterOptions,
    private readonly log: Logger,
  ) {}

  get connected(): boolean {
    return this.isConnected;
  }

  get droppedPublishes(): number {
    return this.dropped;
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  onMessage(handler: (topic: string, payload: string) => void): void {
    this.messageHandler = handler;
  }

  onConnectionChange(handler: (connected: boolean) => void): void {
    this.connectionHandler = handler;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    this.stopping = false;

    const protocol = this.options.brokerTls ? 'mqtts' : 'mqtt';
    const url = `${protocol}://${this.options.brokerHost}:${this.options.brokerPort}`;

    const client = mqtt.connect(url, {
      clientId: `${this.options.clientId}-${Math.random().toString(16).slice(2, 8)}`,
      username: this.options.brokerUser || undefined,
      password: this.options.brokerPassword || undefined,
      clean: true,
      reconnectPeriod: 2000,
      connectTimeout: 10_000,
      resubscribe: true,
    });
    this.client = client;

    // Every dispatch into caller code is isolated. mqtt.js emits synchronously,
    // so a throw from a handler escapes into the library's emit and takes down
    // the adapter process. The protocol parsers these handlers feed THROW by
    // design on malformed input, and that input arrives from the network, so
    // this is the difference between one rejected payload and a crash loop.
    client.on('message', (topic, payload) => {
      try {
        this.messageHandler?.(topic, payload.toString('utf8'));
      } catch (error) {
        this.log.error(`[MQTT] Message handler failed for ${topic}: ${(error as Error).message}`);
      }
    });

    client.on('connect', () => {
      this.isConnected = true;
      this.log.info('[MQTT] Connected to broker');
      this.notifyConnection(true);
      this.flush();
    });

    client.on('reconnect', () => this.log.debug('[MQTT] Reconnecting'));

    client.on('close', () => {
      if (!this.isConnected) return;
      this.isConnected = false;
      this.log.warn('[MQTT] Connection closed');
      this.notifyConnection(false);
    });

    client.on('error', (error) => this.log.error(`[MQTT] ${error.message}`));

    await new Promise<void>((resolve) => {
      if (client.connected) return resolve();
      const done = (): void => {
        client.removeListener('connect', done);
        client.removeListener('error', done);
        resolve();
      };
      client.once('connect', done);
      client.once('error', done);
    });
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.stopping = true;
    this.client = null;
    await new Promise<void>((resolve) => client.end(true, {}, () => resolve()));
    if (this.isConnected) {
      this.isConnected = false;
      this.notifyConnection(false);
    }
  }

  /** Same isolation as the message path: a throwing consumer must not crash us. */
  private notifyConnection(connected: boolean): void {
    try {
      this.connectionHandler?.(connected);
    } catch (error) {
      this.log.error(`[MQTT] Connection handler failed: ${(error as Error).message}`);
    }
  }

  async subscribe(topic: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    await new Promise<void>((resolve) => {
      client.subscribe(topic, { qos: 0 }, (error) => {
        if (error) this.log.error(`[MQTT] Subscribe failed for ${topic}: ${error.message}`);
        resolve();
      });
    });
  }

  async unsubscribe(topic: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    await new Promise<void>((resolve) => client.unsubscribe(topic, () => resolve()));
  }

  publish(request: PublishRequest): void {
    if (this.stopping) return;

    if (this.queue.length >= this.options.maxPublishQueue) {
      // Drop the oldest: the newest value is the one the panel actually needs.
      this.queue.shift();
      this.dropped++;
      this.warnDropRateLimited();
    }
    this.queue.push(request);
    this.flush();
  }

  private warnDropRateLimited(): void {
    const now = Date.now();
    if (now - this.lastDropWarnMs < DROP_WARN_INTERVAL_MS) return;
    this.lastDropWarnMs = now;
    this.log.warn(`[MQTT] Publish queue full, dropped ${this.dropped} messages so far`);
  }

  private flush(): void {
    const client = this.client;
    if (!client || !this.isConnected) return;
    while (this.queue.length) {
      const request = this.queue.shift();
      if (!request) break;
      client.publish(request.topic, request.payload, {
        qos: request.qos ?? 0,
        retain: request.retain ?? false,
      });
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx mocha test/runtime/mqtt-client.test.ts`
Expected: PASS, 6 passing

- [ ] **Step 5: Commit**

```bash
git add src/runtime/mqtt-client.ts test/runtime/mqtt-client.test.ts
git commit -m "feat(runtime): MQTT client with reconnect and a bounded drop-oldest publish queue"
```

---

## Task 11: Command dispatcher

**Files:**
- Create: `src/runtime/dispatcher.ts`
- Test: `test/runtime/dispatcher.test.ts`

**Interfaces:**
- Consumes: `ServiceCall` from `src/protocol/commands`, `VirtualEntity` from `src/registry/types`, `Logger` from `src/runtime/mqtt-client`.
- Produces:
  - `StateWriter = (objectId: string, value: unknown) => Promise<void>`
  - `EntityLookup = { byId(entityId: string): VirtualEntity | undefined; bySceneAlias(alias: string): VirtualEntity | undefined }`
  - `Dispatcher` with `constructor(lookup: EntityLookup, write: StateWriter, log: Logger)` and `dispatch(call: ServiceCall): Promise<DispatchResult>`
  - `DispatchResult = { ok: true; writes: number } | { ok: false; reason: string }`

The allow-list is the security boundary named in the spec. A `ServiceCall` may only reach a state that is already a channel of an entity already in the registry, and only through the per-domain table below. An MQTT payload can never name an arbitrary ioBroker state.

| Domain | Allowed calls | Target channels |
| --- | --- | --- |
| `switch` | `turn_on`, `turn_off`, `toggle` | `set` |
| `light` | `turn_on`, `turn_off`, `toggle`, `set_light` | `set`, `dimmer`, `red`, `green`, `blue`, `temperature` |
| `scene` | `activate_scene` | `set` |
| `sensor`, `binary_sensor` | none | none |

- [ ] **Step 1: Write the failing test**

Create `test/runtime/dispatcher.test.ts`:

```ts
import { expect } from 'chai';
import { Dispatcher, type EntityLookup } from '../../src/runtime/dispatcher';
import type { VirtualEntity } from '../../src/registry/types';

function entity(over: Partial<VirtualEntity>): VirtualEntity {
  return {
    entityId: 'switch.k',
    domain: 'switch',
    source: { set: 'shelly.0.plug.on' },
    state: 'off',
    attributes: {},
    available: true,
    lastChanged: 0,
    ...over,
  };
}

const LIGHT = entity({
  entityId: 'light.d',
  domain: 'light',
  state: 'off',
  source: {
    set: 'hue.0.d.on',
    dimmer: 'hue.0.d.level',
    red: 'hue.0.d.r',
    green: 'hue.0.d.g',
    blue: 'hue.0.d.b',
    temperature: 'hue.0.d.ct',
  },
});

const SWITCH = entity({});
const SENSOR = entity({ entityId: 'sensor.t', domain: 'sensor', source: { actual: 'zigbee.0.t.value' } });
const SCENE = entity({ entityId: 'scene.nacht', domain: 'scene', source: { set: 'scene.0.nacht' } });

function lookup(entities: VirtualEntity[], aliases: Record<string, string> = {}): EntityLookup {
  const byId = new Map(entities.map((e) => [e.entityId, e]));
  return {
    byId: (id) => byId.get(id),
    bySceneAlias: (alias) => {
      const target = aliases[alias];
      return target ? byId.get(target) : undefined;
    },
  };
}

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

describe('runtime/dispatcher', () => {
  let writes: Array<[string, unknown]>;
  const write = async (objectId: string, value: unknown): Promise<void> => {
    writes.push([objectId, value]);
  };

  beforeEach(() => {
    writes = [];
  });

  it('turns a switch on through its SET channel', async () => {
    const d = new Dispatcher(lookup([SWITCH]), write, silentLog);
    const result = await d.dispatch({ kind: 'turn_on', entityId: 'switch.k' });
    expect(result).to.deep.equal({ ok: true, writes: 1 });
    expect(writes).to.deep.equal([['shelly.0.plug.on', true]]);
  });

  it('toggles from the entity current state', async () => {
    const d = new Dispatcher(lookup([entity({ state: 'on' })]), write, silentLog);
    await d.dispatch({ kind: 'toggle', entityId: 'switch.k' });
    expect(writes).to.deep.equal([['shelly.0.plug.on', false]]);
  });

  it('treats toggle from an unavailable state as turn on', async () => {
    const d = new Dispatcher(lookup([entity({ state: 'unavailable', available: false })]), write, silentLog);
    await d.dispatch({ kind: 'toggle', entityId: 'switch.k' });
    expect(writes).to.deep.equal([['shelly.0.plug.on', true]]);
  });

  it('writes brightness back as an ioBroker 0..100 percent', async () => {
    const d = new Dispatcher(lookup([LIGHT]), write, silentLog);
    await d.dispatch({ kind: 'set_light', entityId: 'light.d', state: 'on', brightnessPct: 42 });
    expect(writes).to.deep.include(['hue.0.d.level', 42]);
    expect(writes).to.deep.include(['hue.0.d.on', true]);
  });

  it('splits rgb into the three component channels', async () => {
    const d = new Dispatcher(lookup([LIGHT]), write, silentLog);
    await d.dispatch({ kind: 'set_light', entityId: 'light.d', rgb: [255, 180, 90] });
    expect(writes).to.deep.equal([
      ['hue.0.d.r', 255],
      ['hue.0.d.g', 180],
      ['hue.0.d.b', 90],
    ]);
  });

  it('writes colour temperature to the temperature channel', async () => {
    const d = new Dispatcher(lookup([LIGHT]), write, silentLog);
    await d.dispatch({ kind: 'set_light', entityId: 'light.d', kelvin: 3000 });
    expect(writes).to.deep.equal([['hue.0.d.ct', 3000]]);
  });

  it('silently skips a channel the device does not have instead of failing the whole call', async () => {
    const noColour = entity({ entityId: 'light.p', domain: 'light', source: { set: 'x.0.on', dimmer: 'x.0.level' } });
    const d = new Dispatcher(lookup([noColour]), write, silentLog);
    const result = await d.dispatch({ kind: 'set_light', entityId: 'light.p', brightnessPct: 50, rgb: [1, 2, 3] });
    expect(result).to.deep.equal({ ok: true, writes: 1 });
    expect(writes).to.deep.equal([['x.0.level', 50]]);
  });

  it('refuses an entity that is not in the registry', async () => {
    const d = new Dispatcher(lookup([]), write, silentLog);
    expect(await d.dispatch({ kind: 'turn_on', entityId: 'switch.evil' })).to.deep.equal({
      ok: false,
      reason: 'unknown_entity',
      applied: 0,
    });
    expect(writes).to.have.length(0);
  });

  it('refuses a call that is not allowed for the entity domain', async () => {
    const d = new Dispatcher(lookup([SENSOR]), write, silentLog);
    expect(await d.dispatch({ kind: 'turn_on', entityId: 'sensor.t' })).to.deep.equal({
      ok: false,
      reason: 'call_not_allowed_for_domain',
      applied: 0,
    });
    expect(writes).to.have.length(0);
  });

  it('refuses a set_light aimed at a switch', async () => {
    const d = new Dispatcher(lookup([SWITCH]), write, silentLog);
    expect(await d.dispatch({ kind: 'set_light', entityId: 'switch.k', brightnessPct: 50 })).to.deep.equal({
      ok: false,
      reason: 'call_not_allowed_for_domain',
      applied: 0,
    });
  });

  it('activates a scene through its alias', async () => {
    const d = new Dispatcher(lookup([SCENE], { 'gute nacht': 'scene.nacht' }), write, silentLog);
    const result = await d.dispatch({ kind: 'activate_scene', alias: 'gute nacht' });
    expect(result).to.deep.equal({ ok: true, writes: 1 });
    expect(writes).to.deep.equal([['scene.0.nacht', true]]);
  });

  it('refuses an unknown scene alias', async () => {
    const d = new Dispatcher(lookup([SCENE], {}), write, silentLog);
    expect(await d.dispatch({ kind: 'activate_scene', alias: 'nope' })).to.deep.equal({
      ok: false,
      reason: 'unknown_scene',
      applied: 0,
    });
  });

  it('reports a write failure without throwing into the MQTT handler', async () => {
    const failing = async (): Promise<void> => {
      throw new Error('object not writable');
    };
    const d = new Dispatcher(lookup([SWITCH]), failing, silentLog);
    expect(await d.dispatch({ kind: 'turn_on', entityId: 'switch.k' })).to.deep.equal({
      ok: false,
      reason: 'write_failed',
      applied: 0,
    });
  });

  it('reports how many writes landed before a mid-sequence failure', async () => {
    // A light turned on but not dimmed is a different problem from one that
    // was never touched, and the panel's own display cannot distinguish them.
    let calls = 0;
    const failSecond = async (objectId: string, value: unknown): Promise<void> => {
      calls++;
      if (calls === 2) throw new Error('not writable');
      writes.push([objectId, value]);
    };
    const d = new Dispatcher(lookup([LIGHT]), failSecond, silentLog);
    const result = await d.dispatch({ kind: 'set_light', entityId: 'light.d', state: 'on', brightnessPct: 42 });
    expect(result).to.deep.equal({ ok: false, reason: 'write_failed', applied: 1 });
    expect(writes).to.deep.equal([['hue.0.d.on', true]]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx mocha test/runtime/dispatcher.test.ts`
Expected: FAIL, `Cannot find module '../../src/runtime/dispatcher'`

- [ ] **Step 3: Implement `src/runtime/dispatcher.ts`**

```ts
import type { ServiceCall } from '../protocol/commands';
import type { Domain, VirtualEntity } from '../registry/types';
import { STATE_ON } from '../registry/types';
import type { Logger } from './mqtt-client';

export type StateWriter = (objectId: string, value: unknown) => Promise<void>;

export interface EntityLookup {
  byId(entityId: string): VirtualEntity | undefined;
  bySceneAlias(alias: string): VirtualEntity | undefined;
}

export type DispatchResult =
  | { ok: true; writes: number }
  /**
   * `applied` is how many writes already landed before the failure. A device
   * left half-configured — turned on but not dimmed — must be distinguishable
   * from one that was never touched, because those are different things to
   * debug and the panel's own display cannot tell them apart either.
   */
  | { ok: false; reason: string; applied: number };

type CallKind = ServiceCall['kind'];

/**
 * The security boundary. A command may only reach a channel listed here, on an
 * entity already present in the registry. Nothing else is reachable from MQTT.
 */
const ALLOWED_CALLS: Record<Domain, ReadonlySet<CallKind>> = {
  switch: new Set<CallKind>(['turn_on', 'turn_off', 'toggle']),
  light: new Set<CallKind>(['turn_on', 'turn_off', 'toggle', 'set_light']),
  scene: new Set<CallKind>(['activate_scene']),
  sensor: new Set<CallKind>(),
  binary_sensor: new Set<CallKind>(),
};

export class Dispatcher {
  constructor(
    private readonly lookup: EntityLookup,
    private readonly write: StateWriter,
    private readonly log: Logger,
  ) {}

  async dispatch(call: ServiceCall): Promise<DispatchResult> {
    const entity =
      call.kind === 'activate_scene' ? this.lookup.bySceneAlias(call.alias) : this.lookup.byId(call.entityId);

    if (!entity) {
      const reason = call.kind === 'activate_scene' ? 'unknown_scene' : 'unknown_entity';
      this.log.warn(`[Command] Rejected ${call.kind}: ${reason}`);
      return { ok: false, reason, applied: 0 };
    }

    if (!ALLOWED_CALLS[entity.domain].has(call.kind)) {
      this.log.warn(`[Command] Rejected ${call.kind} for ${entity.entityId}: not allowed for ${entity.domain}`);
      return { ok: false, reason: 'call_not_allowed_for_domain', applied: 0 };
    }

    const writes = this.plan(call, entity);
    if (!writes.length) return { ok: true, writes: 0 };

    let applied = 0;
    for (const [channel, objectId, value] of writes) {
      try {
        await this.write(objectId, value);
        applied++;
      } catch (error) {
        // Name the channel and the count: "failed on dimmer after 1 applied"
        // tells an operator the lamp is on but not dimmed. "write_failed"
        // alone sends them looking for a problem that never happened.
        this.log.error(
          `[Command] Write failed for ${entity.entityId} on channel ${channel} ` +
            `after ${applied} of ${writes.length} writes: ${(error as Error).message}`,
        );
        return { ok: false, reason: 'write_failed', applied };
      }
    }

    return { ok: true, writes: applied };
  }

  /** Resolves a call into concrete writes, skipping channels the device lacks. */
  private plan(call: ServiceCall, entity: VirtualEntity): Array<[string, string, unknown]> {
    // [channelName, objectId, value] — the channel name is carried so a failure
    // can say which capability did not apply.
    const writes: Array<[string, string, unknown]> = [];
    const push = (channel: string, value: unknown): void => {
      const objectId = entity.source[channel];
      if (objectId) writes.push([channel, objectId, value]);
    };

    switch (call.kind) {
      case 'turn_on':
        push('set', true);
        break;
      case 'turn_off':
        push('set', false);
        break;
      case 'toggle':
        // An unavailable or unknown entity toggles to on: that is what a user
        // pressing a dark tile means, and it is never a silent no-op.
        push('set', entity.state !== STATE_ON);
        break;
      case 'activate_scene':
        push('set', true);
        break;
      case 'set_light': {
        if (call.state !== undefined) push('set', call.state === 'on');
        if (call.brightnessPct !== undefined) push('dimmer', call.brightnessPct);
        if (call.rgb) {
          push('red', call.rgb[0]);
          push('green', call.rgb[1]);
          push('blue', call.rgb[2]);
        }
        if (call.kelvin !== undefined) push('temperature', call.kelvin);
        break;
      }
    }

    return writes;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx mocha test/runtime/dispatcher.test.ts`
Expected: PASS, 14 passing

- [ ] **Step 5: Commit**

```bash
git add src/runtime/dispatcher.ts test/runtime/dispatcher.test.ts
git commit -m "feat(runtime): command dispatcher with a fixed per-domain allow-list"
```

---

## Task 12: Device detection and admin overrides

**Files:**
- Create: `src/registry/detector.ts`, `src/registry/overrides.ts`
- Test: `test/registry/detector.test.ts`, `test/registry/overrides.test.ts`

**Interfaces:**
- Consumes: `DeviceInput`, `ChannelInput`, `Domain` from `src/registry/types`; `DeviceOverride` from `src/config/options`.
- Produces:
  - `DetectedChannel { id: string; name: string; write?: boolean; defaultRole?: string }`
  - `DetectedControl { type: string; states: DetectedChannel[] }`
  - `DetectorPort { detect(rootId: string): DetectedControl[] }`
  - `ObjectMeta { name: string; role?: string; unit?: string; type?: string; min?: number; max?: number; states?: Record<string, string>; write?: boolean; icon?: string }`
  - `mapControlToDevice(rootId: string, control: DetectedControl, meta: Record<string, ObjectMeta>): DeviceInput | null`
  - `DETECTOR_TYPE_TO_DOMAIN: Record<string, Domain>`
  - `createIoBrokerDetector(objects: Record<string, unknown>): DetectorPort`
  - `applyOverrides(devices: DeviceInput[], overrides: DeviceOverride[]): DeviceInput[]`

`mapControlToDevice` is the pure half and carries all the logic. `createIoBrokerDetector` is a thin wrapper around the library so the mapping stays testable without any ioBroker objects.

- [ ] **Step 1: Verify the `@iobroker/type-detector` call shape before writing the wrapper**

Run:

```bash
npm ls @iobroker/type-detector
cat node_modules/@iobroker/type-detector/build/types.d.ts | head -80
grep -n "detect" node_modules/@iobroker/type-detector/build/*.d.ts | head -20
```

Expected, and confirmed against **@iobroker/type-detector 6.0.1** while this plan was written:

- `ChannelDetector.detect(options: DetectOptions): PatternControl[] | null`
- `DetectOptions` carries `objects`, `id`, `ignoreIndicators?`, `allowedTypes?`, `limitTypesToOneOf?`, `_keysOptional?`, `_keysOptionalSorted?`, `_usedIdsOptional?`
- `PatternControl` is `{ type: Types; states: DetectorState[] }`; each `DetectorState` carries `id`, `name` (the upper-case TAG), `write?` and `defaultRole?`
- `Types` is a string enum. The members this adapter maps are exactly: `socket`, `light`, `dimmer`, `rgb`, `rgbSingle`, `rgbwSingle`, `hue`, `ct`, `cie`, `temperature`, `humidity`, `illuminance`, `pressure`, `weatherCurrent`, `info`, `window`, `windowTilt`, `door`, `contact`, `motion`, `fireAlarm`, `floodAlarm`, `coAlarm`, `warning`, `button`, `buttonSensor`
- **`ChannelDetector` is the DEFAULT export, not a named one.** `require('@iobroker/type-detector').ChannelDetector` is `undefined`; the constructor is `.default`. The module's own keys are `roleOrEnumLight`, `roleOrEnumBlind`, `roleOrEnumWindow`, `roleOrEnumDoor`, `roleOrEnumGate`, `Types`, `StateType`, `default`. Confirm with:

```bash
node -e "const m=require('@iobroker/type-detector'); console.log(Object.keys(m), typeof m.default, m.default && m.default.name)"
```

There is **no** `flood`, `occupancy`, `switch` or `brightness` member. Do not invent one; an unlisted type is simply left unmapped and its device is skipped.

If the installed version differs, adjust `DETECTOR_TYPE_TO_DOMAIN` and `createIoBrokerDetector` in Step 5 to the enum you actually find, and update the first test to match. `DetectorPort` and `mapControlToDevice` are this adapter's own types and must not change.

- [ ] **Step 2: Write the failing detector test**

Create `test/registry/detector.test.ts`:

```ts
import { expect } from 'chai';
import { DETECTOR_TYPE_TO_DOMAIN, mapControlToDevice, type DetectedControl, type ObjectMeta } from '../../src/registry/detector';

const META: Record<string, ObjectMeta> = {
  'hue.0.decke.on': { name: 'On', role: 'switch', type: 'boolean', write: true },
  'hue.0.decke.level': { name: 'Level', role: 'level.dimmer', type: 'number', min: 0, max: 100, write: true },
  'hue.0.decke.ct': { name: 'CT', role: 'level.color.temperature', type: 'number', min: 2200, max: 6500, write: true },
  'zigbee.0.temp.value': { name: 'Temperature', role: 'value.temperature', type: 'number', unit: '°C' },
  'shelly.0.plug.on': { name: 'Kaffeemaschine', role: 'switch', type: 'boolean', write: true },
};

describe('registry/detector mapping', () => {
  it('maps the type-detector 6.x enum members onto the v0.1 domains', () => {
    expect(DETECTOR_TYPE_TO_DOMAIN.socket).to.equal('switch');
    expect(DETECTOR_TYPE_TO_DOMAIN.light).to.equal('light');
    expect(DETECTOR_TYPE_TO_DOMAIN.dimmer).to.equal('light');
    expect(DETECTOR_TYPE_TO_DOMAIN.rgb).to.equal('light');
    expect(DETECTOR_TYPE_TO_DOMAIN.rgbSingle).to.equal('light');
    expect(DETECTOR_TYPE_TO_DOMAIN.rgbwSingle).to.equal('light');
    expect(DETECTOR_TYPE_TO_DOMAIN.hue).to.equal('light');
    expect(DETECTOR_TYPE_TO_DOMAIN.ct).to.equal('light');
    expect(DETECTOR_TYPE_TO_DOMAIN.cie).to.equal('light');
    expect(DETECTOR_TYPE_TO_DOMAIN.temperature).to.equal('sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.humidity).to.equal('sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.illuminance).to.equal('sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.pressure).to.equal('sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.info).to.equal('sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.window).to.equal('binary_sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.windowTilt).to.equal('binary_sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.door).to.equal('binary_sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.contact).to.equal('binary_sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.motion).to.equal('binary_sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.fireAlarm).to.equal('binary_sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.floodAlarm).to.equal('binary_sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.coAlarm).to.equal('binary_sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.warning).to.equal('binary_sensor');
    expect(DETECTOR_TYPE_TO_DOMAIN.button).to.equal('scene');
    expect(DETECTOR_TYPE_TO_DOMAIN.buttonSensor).to.equal('scene');
  });

  it('does not map enum members that do not exist in type-detector 6.x', () => {
    expect(DETECTOR_TYPE_TO_DOMAIN.flood).to.equal(undefined);
    expect(DETECTOR_TYPE_TO_DOMAIN.occupancy).to.equal(undefined);
    expect(DETECTOR_TYPE_TO_DOMAIN.switch).to.equal(undefined);
    expect(DETECTOR_TYPE_TO_DOMAIN.brightness).to.equal(undefined);
  });

  it('returns null for a detector type outside v0.1 scope rather than guessing', () => {
    const control: DetectedControl = { type: 'thermostat', states: [{ id: 'x.0.set', name: 'SET', write: true }] };
    expect(mapControlToDevice('x.0', control, META)).to.equal(null);
  });

  it('lowercases channel names and carries the ioBroker metadata across', () => {
    const control: DetectedControl = {
      type: 'dimmer',
      states: [
        { id: 'hue.0.decke.on', name: 'ON_SET', write: true },
        { id: 'hue.0.decke.level', name: 'SET', write: true },
      ],
    };
    const device = mapControlToDevice('hue.0.decke', control, META);
    expect(device).to.not.equal(null);
    expect(device!.domain).to.equal('light');
    expect(device!.detectorType).to.equal('dimmer');
    expect(device!.channels.set!.objectId).to.equal('hue.0.decke.on');
    expect(device!.channels.dimmer!.objectId).to.equal('hue.0.decke.level');
    expect(device!.channels.dimmer!.min).to.equal(0);
    expect(device!.channels.dimmer!.max).to.equal(100);
  });

  it('renames a dimmer SET channel to dimmer and its ON_SET to set', () => {
    const control: DetectedControl = {
      type: 'dimmer',
      states: [
        { id: 'hue.0.decke.level', name: 'SET', write: true },
        { id: 'hue.0.decke.on', name: 'ON_ACTUAL' },
      ],
    };
    const device = mapControlToDevice('hue.0.decke', control, META);
    expect(Object.keys(device!.channels).sort()).to.deep.equal(['actual', 'dimmer']);
  });

  it('keeps a plain switch SET channel as set', () => {
    const control: DetectedControl = {
      type: 'socket',
      states: [{ id: 'shelly.0.plug.on', name: 'SET', write: true }],
    };
    const device = mapControlToDevice('shelly.0.plug', control, META);
    expect(device!.domain).to.equal('switch');
    expect(device!.channels.set!.objectId).to.equal('shelly.0.plug.on');
    expect(device!.name).to.equal('Kaffeemaschine');
  });

  it('drops indicator channels the panel has no use for', () => {
    const control: DetectedControl = {
      type: 'socket',
      states: [
        { id: 'shelly.0.plug.on', name: 'SET', write: true },
        { id: 'shelly.0.plug.unreach', name: 'UNREACH' },
        { id: 'shelly.0.plug.lowbat', name: 'LOWBAT' },
      ],
    };
    const device = mapControlToDevice('shelly.0.plug', control, META);
    expect(Object.keys(device!.channels)).to.deep.equal(['set']);
  });

  it('returns null when the control has no usable channel left after filtering', () => {
    const control: DetectedControl = { type: 'socket', states: [{ id: 'shelly.0.plug.unreach', name: 'UNREACH' }] };
    expect(mapControlToDevice('shelly.0.plug', control, META)).to.equal(null);
  });

  it('falls back to the last object id segment when no name is known', () => {
    const control: DetectedControl = { type: 'temperature', states: [{ id: 'zigbee.0.unknown.value', name: 'ACTUAL' }] };
    const device = mapControlToDevice('zigbee.0.unknown', control, {});
    expect(device!.name).to.equal('unknown');
  });
});
```

- [ ] **Step 3: Write the failing overrides test**

Create `test/registry/overrides.test.ts`:

```ts
import { expect } from 'chai';
import { applyOverrides } from '../../src/registry/overrides';
import type { DeviceInput } from '../../src/registry/types';

const DEVICES: DeviceInput[] = [
  { objectId: 'a', name: 'A', detectorType: 'socket', domain: 'switch', channels: { set: { objectId: 'a.set' } } },
  { objectId: 'b', name: 'B', detectorType: 'temperature', domain: 'sensor', channels: { actual: { objectId: 'b.val' } } },
];

describe('registry/overrides', () => {
  it('keeps every device when no override exists', () => {
    expect(applyOverrides(DEVICES, [])).to.deep.equal(DEVICES);
  });

  it('excludes a device whose override sets include false', () => {
    const result = applyOverrides(DEVICES, [{ objectId: 'a', include: false }]);
    expect(result.map((d) => d.objectId)).to.deep.equal(['b']);
  });

  it('renames a device', () => {
    const result = applyOverrides(DEVICES, [{ objectId: 'a', include: true, name: 'Kaffee' }]);
    expect(result[0]!.name).to.equal('Kaffee');
  });

  it('forces a different domain', () => {
    const result = applyOverrides(DEVICES, [{ objectId: 'b', include: true, forcedDomain: 'binary_sensor' }]);
    expect(result.find((d) => d.objectId === 'b')!.domain).to.equal('binary_sensor');
  });

  it('ignores a forced domain that is not a v0.1 domain', () => {
    const result = applyOverrides(DEVICES, [{ objectId: 'b', include: true, forcedDomain: 'climate' }]);
    expect(result.find((d) => d.objectId === 'b')!.domain).to.equal('sensor');
  });

  it('ignores an override for an object id that no longer exists', () => {
    expect(applyOverrides(DEVICES, [{ objectId: 'gone', include: false }])).to.have.length(2);
  });

  it('matches overrides by object id, never by position', () => {
    const reordered = [...DEVICES].reverse();
    const result = applyOverrides(reordered, [{ objectId: 'a', include: true, name: 'Renamed' }]);
    expect(result.find((d) => d.objectId === 'a')!.name).to.equal('Renamed');
    expect(result.find((d) => d.objectId === 'b')!.name).to.equal('B');
  });

  it('ignores an empty name override rather than blanking the device name', () => {
    const result = applyOverrides(DEVICES, [{ objectId: 'a', include: true, name: '   ' }]);
    expect(result[0]!.name).to.equal('A');
  });
});
```

- [ ] **Step 4: Run both tests to verify they fail**

Run: `npx mocha test/registry/detector.test.ts test/registry/overrides.test.ts`
Expected: FAIL, `Cannot find module '../../src/registry/detector'`

- [ ] **Step 5: Implement `src/registry/detector.ts`**

```ts
import type { ChannelInput, DeviceInput, Domain } from './types';

export interface DetectedChannel {
  id: string;
  /** Upper-case detector channel token, e.g. SET, ACTUAL, ON_SET, DIMMER, RED. */
  name: string;
  write?: boolean;
  defaultRole?: string;
}

export interface DetectedControl {
  type: string;
  states: DetectedChannel[];
}

export interface DetectorPort {
  detect(rootId: string): DetectedControl[];
}

export interface ObjectMeta {
  name: string;
  role?: string;
  unit?: string;
  type?: string;
  min?: number;
  max?: number;
  states?: Record<string, string>;
  write?: boolean;
  icon?: string;
}

/**
 * Detector types v0.1 understands. A type that is absent here is skipped
 * entirely rather than guessed at, so an unsupported device never turns into a
 * half-working tile.
 */
export const DETECTOR_TYPE_TO_DOMAIN: Record<string, Domain> = {
  // Names are members of the Types string enum in @iobroker/type-detector 6.x.
  socket: 'switch',
  light: 'light',
  dimmer: 'light',
  rgb: 'light',
  rgbSingle: 'light',
  rgbwSingle: 'light',
  hue: 'light',
  ct: 'light',
  cie: 'light',
  temperature: 'sensor',
  humidity: 'sensor',
  illuminance: 'sensor',
  pressure: 'sensor',
  weatherCurrent: 'sensor',
  info: 'sensor',
  window: 'binary_sensor',
  windowTilt: 'binary_sensor',
  door: 'binary_sensor',
  contact: 'binary_sensor',
  motion: 'binary_sensor',
  fireAlarm: 'binary_sensor',
  floodAlarm: 'binary_sensor',
  coAlarm: 'binary_sensor',
  warning: 'binary_sensor',
  button: 'scene',
  buttonSensor: 'scene',
};

/**
 * A lamp can satisfy several lighting patterns at once. Without this the same
 * device is detected as light and dimmer and rgb, producing three tiles for one
 * bulb. The detector resolves the group to a single best match.
 */
const LIGHTING_TYPES = ['light', 'dimmer', 'ct', 'hue', 'cie', 'rgb', 'rgbSingle', 'rgbwSingle'];

/** Channels that carry diagnostics rather than anything a tile renders. */
const IGNORED_CHANNELS = new Set([
  'UNREACH',
  'LOWBAT',
  'MAINTAIN',
  'ERROR',
  'WORKING',
  'DIRECTION',
  'CONNECTED',
]);

/**
 * A dimmer's own SET is the level, and its power channel arrives as ON_SET or
 * ON_ACTUAL. Renaming here means every downstream module can rely on one set of
 * channel names regardless of the detector type.
 */
function channelName(controlType: string, detectorName: string): string | null {
  const upper = detectorName.toUpperCase();
  if (IGNORED_CHANNELS.has(upper)) return null;

  const dimmerLike = controlType === 'dimmer' || controlType === 'ct' || controlType === 'hue';
  if (dimmerLike) {
    if (upper === 'SET') return 'dimmer';
    if (upper === 'ACTUAL') return 'dimmer_actual';
    if (upper === 'ON_SET') return 'set';
    if (upper === 'ON_ACTUAL') return 'actual';
  }
  if (upper === 'ON_SET') return 'set';
  if (upper === 'ON_ACTUAL') return 'actual';

  return upper.toLowerCase();
}

function lastSegment(objectId: string): string {
  return objectId.split('.').pop() ?? objectId;
}

export function mapControlToDevice(
  rootId: string,
  control: DetectedControl,
  meta: Readonly<Record<string, ObjectMeta>>,
): DeviceInput | null {
  const domain = DETECTOR_TYPE_TO_DOMAIN[control.type];
  if (!domain) return null;

  const channels: Record<string, ChannelInput> = {};
  for (const state of control.states) {
    const name = channelName(control.type, state.name);
    if (!name) continue;
    if (channels[name]) continue;

    const info = meta[state.id];
    const channel: ChannelInput = { objectId: state.id };
    if (info?.role ?? state.defaultRole) channel.role = info?.role ?? state.defaultRole;
    if (info?.unit) channel.unit = info.unit;
    if (info?.type) channel.type = info.type as ChannelInput['type'];
    if (info?.min !== undefined) channel.min = info.min;
    if (info?.max !== undefined) channel.max = info.max;
    if (info?.states) channel.states = info.states;
    if (state.write !== undefined || info?.write !== undefined) {
      channel.write = state.write ?? info?.write;
    }
    channels[name] = channel;
  }

  if (!Object.keys(channels).length) return null;

  const primaryId = channels.set?.objectId ?? channels.actual?.objectId ?? channels.dimmer?.objectId;
  const rootMeta = meta[rootId];
  const primaryMeta = primaryId ? meta[primaryId] : undefined;
  const name = (rootMeta?.name ?? primaryMeta?.name ?? '').trim() || lastSegment(rootId);

  const device: DeviceInput = { objectId: rootId, name, detectorType: control.type, domain, channels };
  const icon = rootMeta?.icon ?? primaryMeta?.icon;
  if (icon) device.icon = icon;
  return device;
}

/**
 * Thin wrapper around @iobroker/type-detector. Kept deliberately small: all
 * behaviour lives in mapControlToDevice, which needs no library and no adapter.
 */
interface DetectRequest {
  id: string;
  objects: Record<string, unknown>;
  _keysOptional?: string[];
  _keysOptionalSorted?: boolean;
  _usedIdsOptional?: string[];
  ignoreIndicators?: string[];
  limitTypesToOneOf?: string[][];
}

type DetectorCtor = new () => { detect(options: DetectRequest): DetectedControl[] | null };

export function createIoBrokerDetector(objects: Record<string, unknown>): DetectorPort {
  // Required lazily so the pure mapping stays usable in tests without the dep.
  //
  // In 6.x ChannelDetector is the DEFAULT export, not a named one: destructuring
  // `{ ChannelDetector }` yields undefined and throws at `new`. Verified against
  // the installed 6.0.1, whose module keys are roleOrEnum*, Types, StateType and
  // default. The named fallback keeps this working if a version re-adds it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const detectorModule = require('@iobroker/type-detector') as {
    default?: DetectorCtor;
    ChannelDetector?: DetectorCtor;
  };
  const ChannelDetector = detectorModule.default ?? detectorModule.ChannelDetector;
  if (typeof ChannelDetector !== 'function') {
    throw new Error('@iobroker/type-detector: ChannelDetector constructor not found');
  }

  const detector = new ChannelDetector();
  const keys = Object.keys(objects).sort();

  return {
    detect(rootId: string): DetectedControl[] {
      const usedIds: string[] = [];
      const controls = detector.detect({
        id: rootId,
        objects,
        _keysOptional: keys,
        _keysOptionalSorted: true,
        _usedIdsOptional: usedIds,
        ignoreIndicators: ['UNREACH_STICKY'],
        limitTypesToOneOf: [LIGHTING_TYPES],
      });
      return controls ?? [];
    },
  };
}
```

- [ ] **Step 6: Implement `src/registry/overrides.ts`**

```ts
import type { DeviceOverride } from '../config/options';
import type { DeviceInput, Domain } from './types';
import { DOMAINS } from './types';

function isDomain(value: string | undefined): value is Domain {
  return !!value && (DOMAINS as readonly string[]).includes(value);
}

/**
 * Overrides are keyed by ioBroker object id, never by position, so reordering
 * or filtering the admin table can never reassign an override to another device.
 */
export function applyOverrides(devices: DeviceInput[], overrides: DeviceOverride[]): DeviceInput[] {
  const byObjectId = new Map(overrides.map((override) => [override.objectId, override]));
  const result: DeviceInput[] = [];

  for (const device of devices) {
    const override = byObjectId.get(device.objectId);
    if (override && override.include === false) continue;
    if (!override) {
      result.push(device);
      continue;
    }

    const name = (override.name ?? '').trim();
    result.push({
      ...device,
      name: name || device.name,
      domain: isDomain(override.forcedDomain) ? override.forcedDomain : device.domain,
    });
  }

  return result;
}
```

- [ ] **Step 7: Run both tests to verify they pass**

Run: `npx mocha test/registry/detector.test.ts test/registry/overrides.test.ts`
Expected: PASS, 8 + 8 passing

- [ ] **Step 8: Commit**

```bash
git add src/registry/detector.ts src/registry/overrides.ts test/registry/detector.test.ts test/registry/overrides.test.ts
git commit -m "feat(registry): type-detector mapping to v0.1 domains with object-id keyed overrides"
```

---

## Task 13: Live entity registry with coalescing

**Files:**
- Create: `src/registry/entity-registry.ts`
- Test: `test/registry/entity-registry.test.ts`

**Interfaces:**
- Consumes: `DeviceInput`, `SourceValue`, `VirtualEntity` from `src/registry/types`; `synthesise` from `src/registry/synth/index`; `resolveEntityIds` from `src/registry/entity-id`.
- Produces:
  - `RegistryEvents { onEntityChanged(entity: VirtualEntity): void; onMembershipChanged(): void }`
  - `EntityRegistry` with:
    - `constructor(events: RegistryEvents, coalesceMs: number)`
    - `rebuild(devices: DeviceInput[], persistedIds: Record<string, string>): { entityIds: Record<string, string>; removed: string[]; subscribe: string[]; unsubscribe: string[] }`
    - `applyStateChange(objectId: string, value: SourceValue | null): void`
    - `flush(): void`
    - `all(): VirtualEntity[]`
    - `byId(entityId: string): VirtualEntity | undefined`
    - `bySceneAlias(alias: string): VirtualEntity | undefined`
    - `setSceneAliases(aliases: Record<string, string>): void`
    - `dispose(): void`

Coalescing rule from the Global Constraints: a chatty source cannot flood a panel, and the trailing edge is always delivered so the final value is never lost. The registry schedules one timer per entity; the timer fires with whatever the newest value is at that moment.

`now` is injectable so the tests do not depend on wall-clock timing.

- [ ] **Step 1: Write the failing test**

Create `test/registry/entity-registry.test.ts`:

```ts
import { expect } from 'chai';
import { EntityRegistry } from '../../src/registry/entity-registry';
import type { DeviceInput, SourceValue, VirtualEntity } from '../../src/registry/types';

const NOW = 1_757_000_000_000;
const value = (val: unknown, ts = NOW): SourceValue => ({ val, ack: true, q: 0, ts });

const TEMP: DeviceInput = {
  objectId: 'zigbee.0.temp',
  name: 'Wohnzimmer',
  detectorType: 'temperature',
  domain: 'sensor',
  channels: { actual: { objectId: 'zigbee.0.temp.value', type: 'number', unit: '°C' } },
};

const PLUG: DeviceInput = {
  objectId: 'shelly.0.plug',
  name: 'Kaffee',
  detectorType: 'socket',
  domain: 'switch',
  channels: { set: { objectId: 'shelly.0.plug.on', type: 'boolean', write: true } },
};

function harness(coalesceMs = 0) {
  const changed: VirtualEntity[] = [];
  let membership = 0;
  const registry = new EntityRegistry(
    {
      onEntityChanged: (entity) => changed.push(entity),
      onMembershipChanged: () => {
        membership++;
      },
    },
    coalesceMs,
  );
  return { registry, changed, membership: () => membership };
}

describe('registry/entity-registry', () => {
  it('builds entities and reports which object ids to subscribe to', () => {
    const { registry } = harness();
    const result = registry.rebuild([TEMP, PLUG], {});
    expect(result.subscribe.sort()).to.deep.equal(['shelly.0.plug.on', 'zigbee.0.temp.value']);
    expect(result.unsubscribe).to.deep.equal([]);
    expect(Object.values(result.entityIds).sort()).to.deep.equal(['sensor.wohnzimmer', 'switch.kaffee']);
  });

  it('starts every entity unavailable until a value arrives', () => {
    const { registry } = harness();
    registry.rebuild([TEMP], {});
    expect(registry.byId('sensor.wohnzimmer')!.state).to.equal('unavailable');
  });

  it('emits a change when a subscribed value arrives', () => {
    const { registry, changed } = harness();
    registry.rebuild([TEMP], {});
    changed.length = 0;
    registry.applyStateChange('zigbee.0.temp.value', value(21.5));
    expect(changed).to.have.length(1);
    expect(changed[0]!.state).to.equal('21.5');
  });

  it('does not emit when the recomputed entity is identical', () => {
    const { registry, changed } = harness();
    registry.rebuild([TEMP], {});
    registry.applyStateChange('zigbee.0.temp.value', value(21.5));
    changed.length = 0;
    registry.applyStateChange('zigbee.0.temp.value', value(21.5, NOW + 1000));
    expect(changed).to.have.length(0);
  });

  it('ignores a value for an object id nothing subscribes to', () => {
    const { registry, changed } = harness();
    registry.rebuild([TEMP], {});
    changed.length = 0;
    registry.applyStateChange('some.other.state', value(1));
    expect(changed).to.have.length(0);
  });

  it('coalesces a burst into a single emission carrying the newest value', () => {
    const { registry, changed } = harness(200);
    registry.rebuild([TEMP], {});
    changed.length = 0;
    registry.applyStateChange('zigbee.0.temp.value', value(1));
    registry.applyStateChange('zigbee.0.temp.value', value(2));
    registry.applyStateChange('zigbee.0.temp.value', value(3));
    expect(changed, 'nothing emitted before the window closes').to.have.length(0);
    registry.flush();
    expect(changed).to.have.length(1);
    expect(changed[0]!.state).to.equal('3');
  });

  it('always delivers the trailing edge so the final value is never lost', () => {
    const { registry, changed } = harness(200);
    registry.rebuild([TEMP], {});
    changed.length = 0;
    for (let i = 0; i < 50; i++) registry.applyStateChange('zigbee.0.temp.value', value(i));
    registry.applyStateChange('zigbee.0.temp.value', value(99));
    registry.flush();
    expect(changed[changed.length - 1]!.state).to.equal('99');
  });

  it('reports removed entities and the object ids to unsubscribe when a device disappears', () => {
    const { registry } = harness();
    const first = registry.rebuild([TEMP, PLUG], {});
    const second = registry.rebuild([TEMP], first.entityIds);
    expect(second.removed).to.deep.equal(['switch.kaffee']);
    expect(second.unsubscribe).to.deep.equal(['shelly.0.plug.on']);
    expect(registry.byId('switch.kaffee')).to.equal(undefined);
  });

  it('keeps a persisted entity id when the device is renamed', () => {
    const { registry } = harness();
    const first = registry.rebuild([TEMP], {});
    const renamed = { ...TEMP, name: 'Ganz Anders' };
    const second = registry.rebuild([renamed], first.entityIds);
    expect(second.entityIds['zigbee.0.temp']).to.equal('sensor.wohnzimmer');
    expect(registry.byId('sensor.wohnzimmer')!.attributes.friendly_name).to.equal('Ganz Anders');
  });

  it('signals a membership change only when the entity set actually changes', () => {
    const { registry, membership } = harness();
    registry.rebuild([TEMP], {});
    const after = membership();
    registry.rebuild([TEMP], { 'zigbee.0.temp': 'sensor.wohnzimmer' });
    expect(membership()).to.equal(after);
  });

  it('resolves a scene by its configured alias, case-insensitively', () => {
    const { registry } = harness();
    const scene: DeviceInput = {
      objectId: 'scene.0.nacht',
      name: 'Gute Nacht',
      detectorType: 'button',
      domain: 'scene',
      channels: { set: { objectId: 'scene.0.nacht', write: true } },
    };
    registry.rebuild([scene], {});
    registry.setSceneAliases({ 'Gute Nacht': 'scene.gute_nacht' });
    expect(registry.bySceneAlias('gute nacht')!.entityId).to.equal('scene.gute_nacht');
    expect(registry.bySceneAlias('unknown')).to.equal(undefined);
  });

  it('cancels pending timers on dispose', () => {
    const { registry, changed } = harness(200);
    registry.rebuild([TEMP], {});
    changed.length = 0;
    registry.applyStateChange('zigbee.0.temp.value', value(5));
    registry.dispose();
    registry.flush();
    expect(changed).to.have.length(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx mocha test/registry/entity-registry.test.ts`
Expected: FAIL, `Cannot find module '../../src/registry/entity-registry'`

- [ ] **Step 3: Implement `src/registry/entity-registry.ts`**

```ts
import { resolveEntityIds } from './entity-id';
import { synthesise } from './synth/index';
import type { DeviceInput, SourceValue, VirtualEntity } from './types';

export interface RegistryEvents {
  onEntityChanged(entity: VirtualEntity): void;
  onMembershipChanged(): void;
}

export interface RebuildResult {
  entityIds: Record<string, string>;
  removed: string[];
  subscribe: string[];
  unsubscribe: string[];
}

interface Slot {
  device: DeviceInput;
  entity: VirtualEntity;
}

export class EntityRegistry {
  /** entityId -> slot */
  private slots = new Map<string, Slot>();
  /** ioBroker object id -> entity ids that read it */
  private watchers = new Map<string, Set<string>>();
  /** ioBroker object id -> newest value */
  private values = new Map<string, SourceValue | null>();
  /** entityId -> pending coalesce timer */
  private timers = new Map<string, NodeJS.Timeout>();
  private sceneAliases = new Map<string, string>();
  private disposed = false;

  constructor(
    private readonly events: RegistryEvents,
    private readonly coalesceMs: number,
  ) {}

  rebuild(devices: DeviceInput[], persistedIds: Record<string, string>): RebuildResult {
    const entityIds = resolveEntityIds(devices, persistedIds);
    const previousEntityIds = new Set(this.slots.keys());
    const previousObjectIds = new Set(this.watchers.keys());

    const nextSlots = new Map<string, Slot>();
    const nextWatchers = new Map<string, Set<string>>();

    for (const device of devices) {
      const entityId = entityIds[device.objectId];
      if (!entityId) continue;

      const entity = synthesise(device, entityId, this.valuesFor(device));
      nextSlots.set(entityId, { device, entity });

      for (const channel of Object.values(device.channels)) {
        let watchers = nextWatchers.get(channel.objectId);
        if (!watchers) {
          watchers = new Set();
          nextWatchers.set(channel.objectId, watchers);
        }
        watchers.add(entityId);
      }
    }

    const removed = [...previousEntityIds].filter((id) => !nextSlots.has(id)).sort();
    const subscribe = [...nextWatchers.keys()].filter((id) => !previousObjectIds.has(id)).sort();
    const unsubscribe = [...previousObjectIds].filter((id) => !nextWatchers.has(id)).sort();

    for (const entityId of removed) this.cancelTimer(entityId);
    for (const objectId of unsubscribe) this.values.delete(objectId);

    this.slots = nextSlots;
    this.watchers = nextWatchers;

    const membershipChanged =
      removed.length > 0 ||
      subscribe.length > 0 ||
      unsubscribe.length > 0 ||
      [...nextSlots.keys()].some((id) => !previousEntityIds.has(id));
    if (membershipChanged) this.events.onMembershipChanged();

    return { entityIds, removed, subscribe, unsubscribe };
  }

  applyStateChange(objectId: string, value: SourceValue | null): void {
    if (this.disposed) return;
    const watchers = this.watchers.get(objectId);
    if (!watchers) return;

    this.values.set(objectId, value);
    for (const entityId of watchers) this.schedule(entityId);
  }

  /** Fires every pending coalesce timer immediately. Used at shutdown and in tests. */
  flush(): void {
    if (this.disposed) return;
    for (const entityId of [...this.timers.keys()]) {
      this.cancelTimer(entityId);
      this.recompute(entityId);
    }
  }

  all(): VirtualEntity[] {
    return [...this.slots.values()].map((slot) => slot.entity);
  }

  byId(entityId: string): VirtualEntity | undefined {
    return this.slots.get(entityId)?.entity;
  }

  setSceneAliases(aliases: Record<string, string>): void {
    this.sceneAliases = new Map(Object.entries(aliases).map(([alias, target]) => [alias.toLowerCase(), target]));
  }

  bySceneAlias(alias: string): VirtualEntity | undefined {
    const target = this.sceneAliases.get(alias.toLowerCase());
    return target ? this.byId(target) : undefined;
  }

  dispose(): void {
    this.disposed = true;
    for (const entityId of [...this.timers.keys()]) this.cancelTimer(entityId);
  }

  private valuesFor(device: DeviceInput): Record<string, SourceValue | null> {
    const values: Record<string, SourceValue | null> = {};
    for (const channel of Object.values(device.channels)) {
      values[channel.objectId] = this.values.get(channel.objectId) ?? null;
    }
    return values;
  }

  private schedule(entityId: string): void {
    if (this.coalesceMs <= 0) {
      this.recompute(entityId);
      return;
    }
    // One timer per entity. A burst restarts nothing: the existing timer fires
    // with whatever the newest value is by then, so the trailing edge always
    // wins and the last value is never lost.
    if (this.timers.has(entityId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(entityId);
      this.recompute(entityId);
    }, this.coalesceMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(entityId, timer);
  }

  private cancelTimer(entityId: string): void {
    const timer = this.timers.get(entityId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(entityId);
  }

  private recompute(entityId: string): void {
    const slot = this.slots.get(entityId);
    if (!slot) return;

    const next = synthesise(slot.device, entityId, this.valuesFor(slot.device));
    if (sameEntity(slot.entity, next)) return;

    slot.entity = next;
    this.events.onEntityChanged(next);
  }
}

/** lastChanged deliberately excluded: a repeated identical value is not a change. */
function sameEntity(a: VirtualEntity, b: VirtualEntity): boolean {
  return (
    a.state === b.state &&
    a.available === b.available &&
    JSON.stringify(a.attributes) === JSON.stringify(b.attributes)
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx mocha test/registry/entity-registry.test.ts`
Expected: PASS, 12 passing

- [ ] **Step 5: Run the whole suite**

Run: `npm run lint && npm test && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/registry/entity-registry.ts test/registry/entity-registry.test.ts
git commit -m "feat(registry): live entity registry with per-entity coalescing and trailing-edge delivery"
```

---

## Task 14: Panel session and panel manager

**Files:**
- Create: `src/runtime/panel-session.ts`, `src/runtime/panel-manager.ts`
- Test: `test/runtime/panel-session.test.ts`

**Interfaces:**
- Consumes: `Announcement` from `src/protocol/announce`; `buildApplyPayload`, `configSignature`, `buildIconsPayload` from `src/protocol/apply`; `buildStatePublish`, `buildStateClear` from `src/protocol/state-payload`; `parseCommand` from `src/protocol/commands`; topic builders from `src/protocol/topics`; `Dispatcher` from `src/runtime/dispatcher`; `Logger`, `PublishRequest` from `src/runtime/mqtt-client`; `VirtualEntity` from `src/registry/types`.
- Produces:
  - `PanelTransport { publish(request: PublishRequest): void; subscribe(topic: string): Promise<void>; unsubscribe(topic: string): Promise<void> }`
  - `PanelSession` with `constructor(announcement, transport, dispatcher, log)`, `readonly deviceId`, `readonly baseTopic`, `readonly haPrefix`, `start(): Promise<void>`, `stop(): Promise<void>`, `updateAnnouncement(a: Announcement): void`, `pushConfig(entities: VirtualEntity[], force?: boolean): boolean`, `pushEntityState(entity: VirtualEntity): void`, `clearEntityState(entityId: string): void`, `handleMessage(topic: string, payload: string): Promise<void>`, `commandTopics(): string[]`
  - `PanelManager` with `constructor(deps)`, `handleAnnouncement(deviceId, payload): Promise<void>`, `handleMessage(topic, payload): Promise<void>`, `sessions(): PanelSession[]`, `get(deviceId): PanelSession | undefined`, `remove(deviceId): Promise<void>`, `stopAll(): Promise<void>`

`pushConfig` returns `true` when it actually published. It returns `false` when the config signature is unchanged, which is the Global Constraint that an unchanged configuration is never re-pushed.

- [ ] **Step 1: Write the failing test**

Create `test/runtime/panel-session.test.ts`:

```ts
import { expect } from 'chai';
import { parseAnnouncement } from '../../src/protocol/announce';
import type { PublishRequest } from '../../src/runtime/mqtt-client';
import { Dispatcher } from '../../src/runtime/dispatcher';
import { PanelSession, type PanelTransport } from '../../src/runtime/panel-session';
import type { VirtualEntity } from '../../src/registry/types';

const ANNOUNCE = JSON.stringify({
  device_id: 'a1',
  base_topic: 'hometiles',
  ha_prefix: 'ha/statestream',
  device_name: 'Panel',
  model: 'waveshare_touch_lcd_8',
  sensors: [],
  binary_sensors: [],
  scene_map: { 'gute nacht': 'scene.nacht' },
  local_io: [{ id: 'relay_1', entity_id: 'switch.p_relay_1', name: 'Relay 1', type: 'relay' }],
});

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

function entity(over: Partial<VirtualEntity>): VirtualEntity {
  return {
    entityId: 'sensor.t',
    domain: 'sensor',
    source: {},
    state: '21',
    attributes: { friendly_name: 'T' },
    available: true,
    lastChanged: 1_757_000_000_000,
    ...over,
  };
}

function harness() {
  const published: PublishRequest[] = [];
  const subscribed: string[] = [];
  const transport: PanelTransport = {
    publish: (request) => published.push(request),
    subscribe: async (topic) => {
      subscribed.push(topic);
    },
    unsubscribe: async () => undefined,
  };
  const writes: Array<[string, unknown]> = [];
  const registryEntities = new Map<string, VirtualEntity>();
  const dispatcher = new Dispatcher(
    {
      byId: (id) => registryEntities.get(id),
      bySceneAlias: (alias) => (alias === 'gute nacht' ? registryEntities.get('scene.nacht') : undefined),
    },
    async (objectId, value) => {
      writes.push([objectId, value]);
    },
    silentLog,
  );
  const session = new PanelSession(parseAnnouncement('a1', ANNOUNCE), transport, dispatcher, silentLog);
  return { session, published, subscribed, writes, registryEntities };
}

describe('runtime/panel-session', () => {
  it('subscribes to every topic the panel talks on', async () => {
    const { session, subscribed } = harness();
    await session.start();
    expect(subscribed).to.include('hometiles/cmnd/light');
    expect(subscribed).to.include('hometiles/cmnd/switch');
    expect(subscribed).to.include('hometiles/cmnd/scene');
    expect(subscribed).to.include('hometiles/stat/connected');
    expect(subscribed).to.include('hometiles/stat/ip');
    expect(subscribed).to.include('tab5_lvgl/config/a1/bridge/request');
  });

  it('does not subscribe to the domains v0.1 does not implement', async () => {
    const { session, subscribed } = harness();
    await session.start();
    expect(subscribed).to.not.include('hometiles/cmnd/climate');
    expect(subscribed).to.not.include('hometiles/cmnd/cover');
    expect(subscribed).to.not.include('hometiles/cmnd/media');
    expect(subscribed).to.not.include('hometiles/cmnd/camera');
  });

  it('publishes the configuration retained to the apply topic', () => {
    const { session, published } = harness();
    expect(session.pushConfig([entity({})])).to.equal(true);
    const apply = published.find((p) => p.topic === 'tab5_lvgl/config/a1/bridge/apply');
    expect(apply).to.not.equal(undefined);
    expect(apply!.retain).to.equal(true);
    expect(JSON.parse(apply!.payload).sensors).to.deep.equal(['sensor.t']);
  });

  it('does not re-push an unchanged configuration', () => {
    const { session, published } = harness();
    const entities = [entity({})];
    expect(session.pushConfig(entities)).to.equal(true);
    published.length = 0;
    expect(session.pushConfig(entities)).to.equal(false);
    expect(published).to.have.length(0);
  });

  it('re-pushes an unchanged configuration when forced', () => {
    const { session, published } = harness();
    const entities = [entity({})];
    session.pushConfig(entities);
    published.length = 0;
    expect(session.pushConfig(entities, true)).to.equal(true);
    expect(published.some((p) => p.topic === 'tab5_lvgl/config/a1/bridge/apply')).to.equal(true);
  });

  it('re-pushes when the configuration actually changed', () => {
    const { session, published } = harness();
    session.pushConfig([entity({})]);
    published.length = 0;
    expect(session.pushConfig([entity({}), entity({ entityId: 'sensor.u' })])).to.equal(true);
    expect(published).to.have.length(1);
  });

  it('honours a forced bridge/request from the panel', async () => {
    const { session, published } = harness();
    await session.start();
    session.pushConfig([entity({})]);
    published.length = 0;
    await session.handleMessage('tab5_lvgl/config/a1/bridge/request', 'force');
    expect(published.some((p) => p.topic === 'tab5_lvgl/config/a1/bridge/apply')).to.equal(true);
  });

  it('publishes a sensor state retained as a bare string', () => {
    const { session, published } = harness();
    session.pushEntityState(entity({ entityId: 'sensor.t', state: '21.5' }));
    expect(published[0]).to.deep.equal({
      topic: 'ha/statestream/sensor/t/state',
      payload: '21.5',
      retain: true,
    });
  });

  it('publishes nothing for a scene entity', () => {
    const { session, published } = harness();
    session.pushEntityState(entity({ entityId: 'scene.nacht', domain: 'scene' }));
    expect(published).to.have.length(0);
  });

  it('clears a removed entity with an empty retained payload', () => {
    const { session, published } = harness();
    session.clearEntityState('sensor.gone');
    expect(published[0]).to.deep.equal({
      topic: 'ha/statestream/sensor/gone/state',
      payload: '',
      retain: true,
    });
  });

  it('routes a switch command to the dispatcher', async () => {
    const { session, writes, registryEntities } = harness();
    registryEntities.set(
      'switch.k',
      entity({ entityId: 'switch.k', domain: 'switch', state: 'off', source: { set: 'shelly.0.on' } }),
    );
    await session.start();
    await session.handleMessage('hometiles/cmnd/switch', '{"entity_id":"switch.k","state":"on"}');
    expect(writes).to.deep.equal([['shelly.0.on', true]]);
  });

  it('routes a plain-text scene command to the dispatcher', async () => {
    const { session, writes, registryEntities } = harness();
    registryEntities.set(
      'scene.nacht',
      entity({ entityId: 'scene.nacht', domain: 'scene', source: { set: 'scene.0.nacht' } }),
    );
    await session.start();
    await session.handleMessage('hometiles/cmnd/scene', 'Gute Nacht');
    expect(writes).to.deep.equal([['scene.0.nacht', true]]);
  });

  it('swallows a malformed command without throwing into the MQTT handler', async () => {
    const { session, writes } = harness();
    await session.start();
    await session.handleMessage('hometiles/cmnd/switch', 'not json');
    expect(writes).to.have.length(0);
  });

  it('tracks panel presence and IP from the retained stat topics', async () => {
    const { session } = harness();
    await session.start();
    await session.handleMessage('hometiles/stat/connected', 'online');
    expect(session.online).to.equal(true);
    await session.handleMessage('hometiles/stat/ip', '192.168.1.40');
    expect(session.ip).to.equal('192.168.1.40');
    await session.handleMessage('hometiles/stat/connected', 'offline');
    expect(session.online).to.equal(false);
  });

  it('exposes the local I/O channels the panel announced', () => {
    const { session } = harness();
    expect(session.localIo.map((channel) => channel.id)).to.deep.equal(['relay_1']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx mocha test/runtime/panel-session.test.ts`
Expected: FAIL, `Cannot find module '../../src/runtime/panel-session'`

- [ ] **Step 3: Implement `src/runtime/panel-session.ts`**

```ts
import type { Announcement, LocalIoChannel } from '../protocol/announce';
import { buildApplyPayload, buildIconsPayload, configSignature } from '../protocol/apply';
import { CommandError, parseCommand } from '../protocol/commands';
import { buildStateClear, buildStatePublish } from '../protocol/state-payload';
import {
  applyTopic,
  bridgeRequestTopic,
  commandTopic,
  iconsTopic,
  stateTopic,
} from '../protocol/topics';
import type { VirtualEntity } from '../registry/types';
import type { Dispatcher } from './dispatcher';
import type { Logger, PublishRequest } from './mqtt-client';

export interface PanelTransport {
  publish(request: PublishRequest): void;
  subscribe(topic: string): Promise<void>;
  unsubscribe(topic: string): Promise<void>;
}

/** Command leaves v0.1 implements. Everything else is deliberately not subscribed. */
const COMMAND_LEAVES = ['light', 'switch', 'scene'] as const;
type CommandLeaf = (typeof COMMAND_LEAVES)[number];

export class PanelSession {
  private lastSignature: string | null = null;
  private lastIconsPayload: string | null = null;
  private started = false;

  online = false;
  ip: string | null = null;

  constructor(
    private announcement: Announcement,
    private readonly transport: PanelTransport,
    private readonly dispatcher: Dispatcher,
    private readonly log: Logger,
  ) {}

  get deviceId(): string {
    return this.announcement.deviceId;
  }

  get baseTopic(): string {
    return this.announcement.baseTopic;
  }

  get haPrefix(): string {
    return this.announcement.haPrefix;
  }

  get localIo(): LocalIoChannel[] {
    return this.announcement.localIo;
  }

  get sceneMap(): Record<string, string> {
    return this.announcement.sceneMap;
  }

  commandTopics(): string[] {
    const topics = COMMAND_LEAVES.map((leaf) => commandTopic(this.baseTopic, leaf));
    topics.push(stateTopic(this.baseTopic, 'connected'));
    topics.push(stateTopic(this.baseTopic, 'ip'));
    topics.push(bridgeRequestTopic(this.deviceId));
    return topics;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const topic of this.commandTopics()) {
      await this.transport.subscribe(topic);
    }
    this.log.info(`[Panel ${this.deviceId}] Session started on base topic ${this.baseTopic}`);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const topic of this.commandTopics()) {
      await this.transport.unsubscribe(topic);
    }
  }

  /**
   * A base topic change means the panel now listens somewhere else, so the old
   * subscriptions have to go before the new ones are taken.
   */
  async updateAnnouncement(next: Announcement): Promise<void> {
    const rewired = next.baseTopic !== this.baseTopic || next.haPrefix !== this.haPrefix;
    if (!rewired) {
      this.announcement = next;
      return;
    }
    await this.stop();
    this.announcement = next;
    this.lastSignature = null;
    this.lastIconsPayload = null;
    await this.start();
  }

  pushConfig(entities: VirtualEntity[], force = false): boolean {
    const payload = buildApplyPayload({ entities, sceneMap: this.sceneMap });
    const signature = configSignature(payload);
    if (!force && signature === this.lastSignature) return false;

    this.lastSignature = signature;
    this.transport.publish({ topic: applyTopic(this.deviceId), payload, retain: true });

    const icons = buildIconsPayload(entities);
    if (icons !== this.lastIconsPayload) {
      this.lastIconsPayload = icons;
      this.transport.publish({ topic: iconsTopic(this.deviceId), payload: icons, retain: true });
    }

    this.log.info(`[Panel ${this.deviceId}] Configuration pushed, ${entities.length} entities`);
    return true;
  }

  pushEntityState(entity: VirtualEntity): void {
    const publish = buildStatePublish(this.haPrefix, entity);
    if (!publish) return;
    this.transport.publish(publish);
  }

  clearEntityState(entityId: string): void {
    this.transport.publish(buildStateClear(this.haPrefix, entityId));
  }

  publishPanelCommand(leaf: string, payload: string): void {
    this.transport.publish({ topic: commandTopic(this.baseTopic, leaf), payload, retain: false });
  }

  async handleMessage(topic: string, payload: string): Promise<void> {
    if (topic === bridgeRequestTopic(this.deviceId)) {
      // Signature reset makes the next pushConfig unconditional.
      this.lastSignature = null;
      this.lastIconsPayload = null;
      this.onRefreshRequested?.(payload.trim() === 'force');
      return;
    }

    if (topic === stateTopic(this.baseTopic, 'connected')) {
      const text = payload.trim().toLowerCase();
      this.online = text === 'online' || text === 'true' || text === '1' || text === 'on';
      return;
    }

    if (topic === stateTopic(this.baseTopic, 'ip')) {
      this.ip = payload.trim() || null;
      return;
    }

    const leaf = COMMAND_LEAVES.find((candidate) => topic === commandTopic(this.baseTopic, candidate));
    if (!leaf) return;

    await this.executeCommand(leaf, payload);
  }

  /** Set by the manager so a forced refresh can reach the entity registry. */
  onRefreshRequested?: (forced: boolean) => void;

  private async executeCommand(leaf: CommandLeaf, payload: string): Promise<void> {
    try {
      const call = parseCommand(leaf, payload);
      const result = await this.dispatcher.dispatch(call);
      if (!result.ok) {
        this.log.warn(`[Panel ${this.deviceId}] Command on ${leaf} rejected: ${result.reason}`);
      }
    } catch (error) {
      const code = error instanceof CommandError ? error.code : (error as Error).message;
      this.log.warn(`[Panel ${this.deviceId}] Invalid command on ${leaf}: ${code}`);
    }
  }
}
```

- [ ] **Step 4: Implement `src/runtime/panel-manager.ts`**

```ts
import { AnnounceError, parseAnnouncement } from '../protocol/announce';
import type { VirtualEntity } from '../registry/types';
import type { Dispatcher } from './dispatcher';
import type { Logger } from './mqtt-client';
import { PanelSession, type PanelTransport } from './panel-session';

export interface PanelManagerDeps {
  transport: PanelTransport;
  dispatcher: Dispatcher;
  log: Logger;
  /** Current registry contents, used for the initial push to a new panel. */
  entities(): VirtualEntity[];
  /** Called after a session is created, updated or removed. */
  onSessionsChanged(): void | Promise<void>;
}

export class PanelManager {
  private readonly panels = new Map<string, PanelSession>();

  constructor(private readonly deps: PanelManagerDeps) {}

  sessions(): PanelSession[] {
    return [...this.panels.values()];
  }

  get(deviceId: string): PanelSession | undefined {
    return this.panels.get(deviceId);
  }

  async handleAnnouncement(deviceId: string, payload: string): Promise<void> {
    if (!payload.trim()) {
      // An empty retained announcement is how a panel withdraws itself.
      await this.remove(deviceId);
      return;
    }

    let announcement;
    try {
      announcement = parseAnnouncement(deviceId, payload);
    } catch (error) {
      const code = error instanceof AnnounceError ? error.code : (error as Error).message;
      this.deps.log.warn(`[Panel ${deviceId}] Rejected announcement: ${code}`);
      return;
    }

    const existing = this.panels.get(deviceId);
    if (existing) {
      await existing.updateAnnouncement(announcement);
      existing.pushConfig(this.deps.entities(), true);
      await this.deps.onSessionsChanged();
      return;
    }

    const session = new PanelSession(announcement, this.deps.transport, this.deps.dispatcher, this.deps.log);
    session.onRefreshRequested = (): void => {
      session.pushConfig(this.deps.entities(), true);
      for (const entity of this.deps.entities()) session.pushEntityState(entity);
    };

    this.panels.set(deviceId, session);
    await session.start();
    session.pushConfig(this.deps.entities(), true);
    for (const entity of this.deps.entities()) session.pushEntityState(entity);
    await this.deps.onSessionsChanged();
  }

  async handleMessage(topic: string, payload: string): Promise<void> {
    for (const session of this.panels.values()) {
      await session.handleMessage(topic, payload);
    }
  }

  async remove(deviceId: string): Promise<void> {
    const session = this.panels.get(deviceId);
    if (!session) return;
    await session.stop();
    this.panels.delete(deviceId);
    this.deps.log.info(`[Panel ${deviceId}] Session removed`);
    await this.deps.onSessionsChanged();
  }

  async stopAll(): Promise<void> {
    for (const session of this.panels.values()) await session.stop();
    this.panels.clear();
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx mocha test/runtime/panel-session.test.ts`
Expected: PASS, 15 passing

- [ ] **Step 6: Commit**

```bash
git add src/runtime/panel-session.ts src/runtime/panel-manager.ts test/runtime/panel-session.test.ts
git commit -m "feat(runtime): panel sessions with signature-gated config push and command routing"
```

---

## Task 15: Panel object tree and local Hardware I/O

**Files:**
- Create: `src/runtime/panel-objects.ts`
- Test: `test/runtime/panel-objects.test.ts`

**Interfaces:**
- Consumes: `PanelSession` from `src/runtime/panel-session`; `LocalIoChannel` from `src/protocol/announce`; topic builders from `src/protocol/topics`; `Logger` from `src/runtime/mqtt-client`.
- Produces:
  - `ObjectStore { setObject(id: string, obj: unknown): Promise<void>; deleteObject(id: string, recursive: boolean): Promise<void>; setState(id: string, value: unknown, ack: boolean): Promise<void> }`
  - `PANEL_SETTING_DEFS: readonly PanelSettingDef[]` where `PanelSettingDef = { leaf: string; type: 'number' | 'string'; role: string; name: string; min?: number; max?: number; unit?: string }`
  - `panelObjectDefs(session: PanelSession): Array<{ id: string; obj: Record<string, unknown> }>`
  - `PanelObjects` with `sync(session): Promise<void>`, `remove(deviceId): Promise<void>`, `applyPanelStat(session, leaf, payload): Promise<void>`, `applyIoStat(session, channelId, payload): Promise<void>`, `handleControlWrite(session, path, value): void`, `ioStateDef(channel): Record<string, unknown>`

Brightness decoding is a real firmware quirk that must not be lost: a `stat` value above 100 is the legacy 121..255 encoding and is rescaled to 1..100.

- [ ] **Step 1: Write the failing test**

Create `test/runtime/panel-objects.test.ts`:

```ts
import { expect } from 'chai';
import { parseAnnouncement } from '../../src/protocol/announce';
import { Dispatcher } from '../../src/runtime/dispatcher';
import type { PublishRequest } from '../../src/runtime/mqtt-client';
import { PanelObjects, panelObjectDefs, type ObjectStore } from '../../src/runtime/panel-objects';
import { PanelSession, type PanelTransport } from '../../src/runtime/panel-session';

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

const ANNOUNCE = JSON.stringify({
  device_id: 'a1',
  base_topic: 'hometiles',
  ha_prefix: 'ha/statestream',
  device_name: 'Flur Panel',
  manufacturer: 'HomeTiles',
  model: 'waveshare_touch_lcd_8',
  local_io: [
    { id: 'relay_1', entity_id: 'switch.p_relay_1', name: 'Relay 1', type: 'relay' },
    { id: 'temp_1', entity_id: 'sensor.p_temp_1', name: 'Aussen', type: 'temperature' },
  ],
});

function harness() {
  const published: PublishRequest[] = [];
  const transport: PanelTransport = {
    publish: (request) => published.push(request),
    subscribe: async () => undefined,
    unsubscribe: async () => undefined,
  };
  const dispatcher = new Dispatcher({ byId: () => undefined, bySceneAlias: () => undefined }, async () => undefined, silentLog);
  const session = new PanelSession(parseAnnouncement('a1', ANNOUNCE), transport, dispatcher, silentLog);

  const objects: Array<[string, unknown]> = [];
  const states: Array<[string, unknown, boolean]> = [];
  const deleted: string[] = [];
  const store: ObjectStore = {
    setObject: async (id, obj) => {
      objects.push([id, obj]);
    },
    deleteObject: async (id) => {
      deleted.push(id);
    },
    setState: async (id, value, ack) => {
      states.push([id, value, ack]);
    },
  };
  return { session, published, objects, states, deleted, panelObjects: new PanelObjects(store, silentLog) };
}

describe('runtime/panel-objects', () => {
  it('creates the device, info, control and io objects for a panel', async () => {
    const { session, panelObjects, objects } = harness();
    await panelObjects.sync(session);
    const ids = objects.map(([id]) => id);
    expect(ids).to.include('panels.a1');
    expect(ids).to.include('panels.a1.info.connected');
    expect(ids).to.include('panels.a1.info.ip');
    expect(ids).to.include('panels.a1.control.display_brightness');
    expect(ids).to.include('panels.a1.control.screensaver_brightness');
    expect(ids).to.include('panels.a1.control.display_sleep');
    expect(ids).to.include('panels.a1.control.pair');
    expect(ids).to.include('panels.a1.control.refresh');
    expect(ids).to.include('panels.a1.io.relay_1');
    expect(ids).to.include('panels.a1.io.temp_1');
  });

  it('names the device from the announcement', async () => {
    const { session, panelObjects, objects } = harness();
    await panelObjects.sync(session);
    const device = objects.find(([id]) => id === 'panels.a1');
    expect((device![1] as { common: { name: string } }).common.name).to.equal('Flur Panel');
  });

  it('types a relay channel as a writable boolean and a temperature channel as a read-only number', async () => {
    const { session, panelObjects, objects } = harness();
    await panelObjects.sync(session);
    const relay = objects.find(([id]) => id === 'panels.a1.io.relay_1')![1] as { common: Record<string, unknown> };
    const temp = objects.find(([id]) => id === 'panels.a1.io.temp_1')![1] as { common: Record<string, unknown> };
    expect(relay.common.type).to.equal('boolean');
    expect(relay.common.write).to.equal(true);
    expect(temp.common.type).to.equal('number');
    expect(temp.common.write).to.equal(false);
    expect(temp.common.unit).to.equal('°C');
  });

  it('bounds the brightness controls to the visible 1..100 range', () => {
    const defs = panelObjectDefs(harness().session);
    const brightness = defs.find((d) => d.id === 'panels.a1.control.display_brightness')!;
    const common = (brightness.obj as { common: Record<string, unknown> }).common;
    expect(common.min).to.equal(1);
    expect(common.max).to.equal(100);
    expect(common.unit).to.equal('%');
  });

  it('writes a panel stat back with ack true', async () => {
    const { session, panelObjects, states } = harness();
    await panelObjects.applyPanelStat(session, 'display_brightness', '65');
    expect(states).to.deep.equal([['panels.a1.control.display_brightness', 65, true]]);
  });

  it('rescales a legacy 121..255 brightness stat onto 1..100', async () => {
    const { session, panelObjects, states } = harness();
    await panelObjects.applyPanelStat(session, 'display_brightness', '255');
    expect(states[0]![1]).to.equal(100);
    states.length = 0;
    await panelObjects.applyPanelStat(session, 'display_brightness', '121');
    expect(states[0]![1]).to.equal(1);
  });

  it('ignores a blank numeric stat rather than writing zero', async () => {
    // Number('') is 0 and 0 is finite, so a bare isFinite guard would write a
    // confident 0 % brightness for a panel that reported nothing.
    const { session, panelObjects, states } = harness();
    await panelObjects.applyPanelStat(session, 'display_brightness', '   ');
    expect(states).to.have.length(0);
  });

  it('writes null, not zero, for a blank temperature io stat', async () => {
    // 0 is a plausible temperature. A DS18B20 that reported nothing must not
    // render as 0 degrees on a wall panel.
    const { session, panelObjects, states } = harness();
    await panelObjects.applyIoStat(session, 'temp_1', '  ');
    expect(states[0]).to.deep.equal(['panels.a1.io.temp_1', null, true]);
  });

  it('ignores a blank control write rather than clamping it to the minimum', () => {
    const { session, panelObjects, published } = harness();
    panelObjects.handleControlWrite(session, 'control.display_brightness', '   ');
    expect(published).to.have.length(0);
  });

  it('ignores an unparseable numeric stat rather than writing zero', async () => {
    const { session, panelObjects, states } = harness();
    await panelObjects.applyPanelStat(session, 'display_brightness', 'nonsense');
    expect(states).to.have.length(0);
  });

  it('passes an enum stat through as a string', async () => {
    const { session, panelObjects, states } = harness();
    await panelObjects.applyPanelStat(session, 'display_sleep', '15 min');
    expect(states).to.deep.equal([['panels.a1.control.display_sleep', '15 min', true]]);
  });

  it('maps a relay io stat onto a boolean and a temperature io stat onto a number', async () => {
    const { session, panelObjects, states } = harness();
    await panelObjects.applyIoStat(session, 'relay_1', 'ON');
    expect(states[0]).to.deep.equal(['panels.a1.io.relay_1', true, true]);
    states.length = 0;
    await panelObjects.applyIoStat(session, 'temp_1', '21.5');
    expect(states[0]).to.deep.equal(['panels.a1.io.temp_1', 21.5, true]);
  });

  it('writes null rather than zero for an unavailable temperature channel', async () => {
    const { session, panelObjects, states } = harness();
    await panelObjects.applyIoStat(session, 'temp_1', 'unavailable');
    expect(states[0]).to.deep.equal(['panels.a1.io.temp_1', null, true]);
  });

  it('ignores an io stat for a channel the panel never announced', async () => {
    const { session, panelObjects, states } = harness();
    await panelObjects.applyIoStat(session, 'ghost', 'ON');
    expect(states).to.have.length(0);
  });

  it('turns a control write into the matching cmnd publish', () => {
    const { session, panelObjects, published } = harness();
    panelObjects.handleControlWrite(session, 'control.display_brightness', 42);
    expect(published[0]).to.deep.equal({ topic: 'hometiles/cmnd/display_brightness', payload: '42', retain: false });
  });

  it('clamps a control write outside the allowed range', () => {
    const { session, panelObjects, published } = harness();
    panelObjects.handleControlWrite(session, 'control.display_brightness', 900);
    expect(published[0]!.payload).to.equal('100');
  });

  it('turns an io write into an ON or OFF command', () => {
    const { session, panelObjects, published } = harness();
    panelObjects.handleControlWrite(session, 'io.relay_1', true);
    expect(published[0]).to.deep.equal({ topic: 'hometiles/cmnd/io/relay_1', payload: 'ON', retain: false });
  });

  it('refuses to command a temperature io channel', () => {
    const { session, panelObjects, published } = harness();
    panelObjects.handleControlWrite(session, 'io.temp_1', true);
    expect(published).to.have.length(0);
  });

  it('deletes the whole panel branch on removal', async () => {
    const { panelObjects, deleted } = harness();
    await panelObjects.remove('a1');
    expect(deleted).to.deep.equal(['panels.a1']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx mocha test/runtime/panel-objects.test.ts`
Expected: FAIL, `Cannot find module '../../src/runtime/panel-objects'`

- [ ] **Step 3: Implement `src/runtime/panel-objects.ts`**

```ts
import type { LocalIoChannel } from '../protocol/announce';
import { ioCommandTopic } from '../protocol/topics';
import type { Logger } from './mqtt-client';
import type { PanelSession } from './panel-session';

export interface ObjectStore {
  setObject(id: string, obj: unknown): Promise<void>;
  deleteObject(id: string, recursive: boolean): Promise<void>;
  setState(id: string, value: unknown, ack: boolean): Promise<void>;
}

export interface PanelSettingDef {
  leaf: string;
  type: 'number' | 'string';
  role: string;
  name: string;
  min?: number;
  max?: number;
  unit?: string;
  states?: string[];
}

/** Matches the enum the firmware offers in its own settings dialog. */
const SLEEP_OPTIONS = ['5 s', '15 s', '30 s', '60 s', '5 min', '15 min', '30 min', '60 min', 'Nie'];

export const PANEL_SETTING_DEFS: readonly PanelSettingDef[] = [
  { leaf: 'display_brightness', type: 'number', role: 'level.dimmer', name: 'Display brightness', min: 1, max: 100, unit: '%' },
  { leaf: 'screensaver_brightness', type: 'number', role: 'level.dimmer', name: 'Screensaver brightness', min: 1, max: 100, unit: '%' },
  { leaf: 'display_rotate', type: 'number', role: 'level', name: 'Display rotation', min: 0, max: 3 },
  { leaf: 'display_sleep', type: 'string', role: 'text', name: 'Display sleep timeout', states: SLEEP_OPTIONS },
  { leaf: 'sleep_mains', type: 'string', role: 'text', name: 'Sleep timeout on mains', states: SLEEP_OPTIONS },
  { leaf: 'sleep_battery', type: 'string', role: 'text', name: 'Sleep timeout on battery', states: SLEEP_OPTIONS },
];

const LEGACY_BRIGHTNESS_MIN = 121;
const LEGACY_BRIGHTNESS_MAX = 255;

/**
 * Number('') and Number('   ') are both 0, and 0 is finite, so a bare
 * Number()+isFinite guard silently turns a blank payload into a confident zero.
 * That is the same defect class already fixed in the synthesis helpers: here it
 * would write 0 % brightness, or 0 °C for a temperature channel that reported
 * nothing. Blank means unknown, so it yields undefined and the caller decides.
 */
function parseFiniteNumber(raw: string): number | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : undefined;
}

/** The firmware's older protocol encoded 1..100 percent as 121..255. */
function decodeBrightness(raw: number): number {
  if (raw <= 100) return Math.round(raw);
  const clamped = Math.min(LEGACY_BRIGHTNESS_MAX, Math.max(LEGACY_BRIGHTNESS_MIN, raw));
  return Math.round(1 + ((clamped - LEGACY_BRIGHTNESS_MIN) * 99) / (LEGACY_BRIGHTNESS_MAX - LEGACY_BRIGHTNESS_MIN));
}

function stateObject(name: string, common: Record<string, unknown>): Record<string, unknown> {
  return { type: 'state', common: { name, read: true, ...common }, native: {} };
}

export function ioStateDef(channel: LocalIoChannel): Record<string, unknown> {
  if (channel.type === 'relay') {
    return stateObject(channel.name, { type: 'boolean', role: 'switch', write: true, def: false });
  }
  return stateObject(channel.name, { type: 'number', role: 'value.temperature', write: false, unit: '°C' });
}

export function panelObjectDefs(session: PanelSession): Array<{ id: string; obj: Record<string, unknown> }> {
  const root = `panels.${session.deviceId}`;
  const defs: Array<{ id: string; obj: Record<string, unknown> }> = [
    { id: root, obj: { type: 'device', common: { name: session.deviceName || session.deviceId }, native: { deviceId: session.deviceId } } },
    { id: `${root}.info`, obj: { type: 'channel', common: { name: 'Information' }, native: {} } },
    { id: `${root}.info.connected`, obj: stateObject('Panel connected', { type: 'boolean', role: 'indicator.reachable', write: false, def: false }) },
    { id: `${root}.info.ip`, obj: stateObject('IP address', { type: 'string', role: 'info.ip', write: false }) },
    { id: `${root}.info.baseTopic`, obj: stateObject('Base topic', { type: 'string', role: 'text', write: false }) },
    { id: `${root}.info.model`, obj: stateObject('Model', { type: 'string', role: 'text', write: false }) },
    { id: `${root}.control`, obj: { type: 'channel', common: { name: 'Control' }, native: {} } },
  ];

  for (const def of PANEL_SETTING_DEFS) {
    const common: Record<string, unknown> = { type: def.type, role: def.role, write: true };
    if (def.min !== undefined) common.min = def.min;
    if (def.max !== undefined) common.max = def.max;
    if (def.unit) common.unit = def.unit;
    if (def.states) common.states = Object.fromEntries(def.states.map((value) => [value, value]));
    defs.push({ id: `${root}.control.${def.leaf}`, obj: stateObject(def.name, common) });
  }

  defs.push({ id: `${root}.control.pair`, obj: stateObject('Send broker credentials', { type: 'boolean', role: 'button', write: true }) });
  defs.push({ id: `${root}.control.refresh`, obj: stateObject('Force configuration push', { type: 'boolean', role: 'button', write: true }) });

  if (session.localIo.length) {
    defs.push({ id: `${root}.io`, obj: { type: 'channel', common: { name: 'Local Hardware I/O' }, native: {} } });
    for (const channel of session.localIo) {
      defs.push({ id: `${root}.io.${channel.id}`, obj: ioStateDef(channel) });
    }
  }

  return defs;
}

export class PanelObjects {
  constructor(
    private readonly store: ObjectStore,
    private readonly log: Logger,
  ) {}

  async sync(session: PanelSession): Promise<void> {
    for (const def of panelObjectDefs(session)) {
      await this.store.setObject(def.id, def.obj);
    }
    const root = `panels.${session.deviceId}`;
    await this.store.setState(`${root}.info.baseTopic`, session.baseTopic, true);
    await this.store.setState(`${root}.info.model`, session.model, true);
  }

  async remove(deviceId: string): Promise<void> {
    await this.store.deleteObject(`panels.${deviceId}`, true);
  }

  async applyPanelStat(session: PanelSession, leaf: string, payload: string): Promise<void> {
    const def = PANEL_SETTING_DEFS.find((candidate) => candidate.leaf === leaf);
    if (!def) return;
    const id = `panels.${session.deviceId}.control.${def.leaf}`;

    if (def.type === 'string') {
      const text = payload.trim();
      if (!text) return;
      await this.store.setState(id, text, true);
      return;
    }

    const numeric = parseFiniteNumber(payload);
    if (numeric === undefined) return;
    const value = def.leaf.endsWith('brightness') ? decodeBrightness(numeric) : Math.round(numeric);
    await this.store.setState(id, value, true);
  }

  async applyIoStat(session: PanelSession, channelId: string, payload: string): Promise<void> {
    const channel = session.localIo.find((candidate) => candidate.id === channelId);
    if (!channel) return;
    const id = `panels.${session.deviceId}.io.${channel.id}`;
    const text = payload.trim();

    if (channel.type === 'relay') {
      await this.store.setState(id, text.toUpperCase() === 'ON', true);
      return;
    }

    // An unavailable sensor must stay null. Zero is a plausible temperature, so
    // a blank or non-numeric payload must never be coerced into one.
    const numeric = parseFiniteNumber(text);
    await this.store.setState(id, numeric ?? null, true);
  }

  handleControlWrite(session: PanelSession, path: string, value: unknown): void {
    if (path.startsWith('io.')) {
      const channelId = path.slice(3);
      const channel = session.localIo.find((candidate) => candidate.id === channelId);
      if (!channel || channel.type !== 'relay') {
        this.log.warn(`[Panel ${session.deviceId}] Ignored write to non-commandable channel ${path}`);
        return;
      }
      session.publishRaw(ioCommandTopic(session.baseTopic, channel.id), value ? 'ON' : 'OFF');
      return;
    }

    const leaf = path.startsWith('control.') ? path.slice('control.'.length) : '';
    const def = PANEL_SETTING_DEFS.find((candidate) => candidate.leaf === leaf);
    if (!def) return;

    if (def.type === 'string') {
      const text = String(value ?? '').trim();
      if (!text) return;
      session.publishPanelCommand(def.leaf, text);
      return;
    }

    const numeric = typeof value === 'number' ? value : parseFiniteNumber(String(value ?? ''));
    if (numeric === undefined || !Number.isFinite(numeric)) return;
    const min = def.min ?? Number.NEGATIVE_INFINITY;
    const max = def.max ?? Number.POSITIVE_INFINITY;
    session.publishPanelCommand(def.leaf, String(Math.round(Math.min(max, Math.max(min, numeric)))));
  }
}
```

- [ ] **Step 4: Add the accessors `panel-objects.ts` needs to `PanelSession`**

Add to `src/runtime/panel-session.ts`, next to the other getters:

```ts
  get deviceName(): string {
    return this.announcement.deviceName;
  }

  get model(): string {
    return this.announcement.model;
  }

  publishRaw(topic: string, payload: string): void {
    this.transport.publish({ topic, payload, retain: false });
  }
```

Also extend `commandTopics()` so the panel's setting echoes and local I/O states are subscribed. Replace the existing body with:

```ts
  commandTopics(): string[] {
    const topics = COMMAND_LEAVES.map((leaf) => commandTopic(this.baseTopic, leaf));
    topics.push(stateTopic(this.baseTopic, 'connected'));
    topics.push(stateTopic(this.baseTopic, 'ip'));
    topics.push(bridgeRequestTopic(this.deviceId));
    for (const leaf of PANEL_SETTING_LEAVES) topics.push(stateTopic(this.baseTopic, leaf));
    for (const channel of this.announcement.localIo) topics.push(ioStateTopic(this.baseTopic, channel.id));
    return topics;
  }
```

and extend the imports at the top of the file:

```ts
import {
  applyTopic,
  bridgeRequestTopic,
  commandTopic,
  iconsTopic,
  ioStateTopic,
  PANEL_SETTING_LEAVES,
  stateTopic,
} from '../protocol/topics';
```

- [ ] **Step 5: Run both affected suites to verify they pass**

Run: `npx mocha test/runtime/panel-objects.test.ts test/runtime/panel-session.test.ts`
Expected: PASS. The panel-session subscription tests still pass because they assert with `include`, not exact equality.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/panel-objects.ts src/runtime/panel-session.ts test/runtime/panel-objects.test.ts
git commit -m "feat(runtime): panel object tree, settings echo decoding and local Hardware I/O"
```

---

## Task 16: Panel pairing over HTTP

**Files:**
- Create: `src/runtime/pairing.ts`
- Test: `test/runtime/pairing.test.ts`

**Interfaces:**
- Consumes: `AdapterOptions` from `src/config/options`; `Logger` from `src/runtime/mqtt-client`.
- Produces: `PairingCredentials`, `PairingResult = { ok: true } | { ok: false; reason: string }`, `pushCredentials(host: string, credentials: PairingCredentials, log: Logger, fetchImpl?: typeof fetch): Promise<PairingResult>`, `credentialsFromOptions(options: AdapterOptions): PairingCredentials`.

**Verified provisioning contract**, read from both sides (`web_admin.cpp` route table and `HomeTiles-Bridge/config_flow.py::_push_credentials_to_device`):

1. `POST http://{host}/mqtt`, `application/x-www-form-urlencoded`, fields `mqtt_host`, `mqtt_port`, `mqtt_user`, `mqtt_pass`, `mqtt_base`, `ha_prefix`. Accept status 200 or 303.
2. `POST http://{host}/restart` with an empty body. Accept 200 or 303.

The restart is **not optional**. Without it the firmware's `mqtt_enabled` stays latched at its boot value and the new credentials never take effect.

Redirects must not be followed, and each request has a 5 second timeout.

Discovery of a panel that has never had credentials is out of scope for v0.1: the firmware advertises mDNS `_hometiles._tcp` on port 80 only while unconfigured, and adding an mDNS dependency is deferred. The admin supplies the panel's host or IP directly.

- [ ] **Step 1: Write the failing test**

Create `test/runtime/pairing.test.ts`:

```ts
import { expect } from 'chai';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { credentialsFromOptions, pushCredentials } from '../../src/runtime/pairing';
import { DEFAULTS } from '../../src/config/options';

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

const CREDS = {
  host: '10.0.0.5',
  port: 1883,
  username: 'iob',
  password: 'secret',
  baseTopic: 'hometiles',
  haPrefix: 'ha/statestream',
};

interface Captured {
  path: string;
  contentType: string;
  body: string;
}

function startPanel(handler: (path: string) => number): {
  server: Server;
  port: number;
  captured: Captured[];
  ready: Promise<void>;
} {
  const captured: Captured[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      captured.push({
        path: request.url ?? '',
        contentType: String(request.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(handler(request.url ?? ''));
      response.end();
    });
  });
  const port = 18900 + Math.floor(Math.random() * 500);
  const ready = new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, port, captured, ready };
}

describe('runtime/pairing', () => {
  it('posts the credentials form and then the restart', async () => {
    const panel = startPanel(() => 200);
    await panel.ready;

    const result = await pushCredentials(`127.0.0.1:${panel.port}`, CREDS, silentLog);
    expect(result).to.deep.equal({ ok: true });
    expect(panel.captured.map((c) => c.path)).to.deep.equal(['/mqtt', '/restart']);
    expect(panel.captured[0]!.contentType).to.contain('application/x-www-form-urlencoded');

    const form = new URLSearchParams(panel.captured[0]!.body);
    expect(form.get('mqtt_host')).to.equal('10.0.0.5');
    expect(form.get('mqtt_port')).to.equal('1883');
    expect(form.get('mqtt_user')).to.equal('iob');
    expect(form.get('mqtt_pass')).to.equal('secret');
    expect(form.get('mqtt_base')).to.equal('hometiles');
    expect(form.get('ha_prefix')).to.equal('ha/statestream');

    await new Promise<void>((resolve) => panel.server.close(() => resolve()));
  });

  it('accepts a 303 redirect status without following it', async () => {
    const panel = startPanel(() => 303);
    await panel.ready;
    expect(await pushCredentials(`127.0.0.1:${panel.port}`, CREDS, silentLog)).to.deep.equal({ ok: true });
    await new Promise<void>((resolve) => panel.server.close(() => resolve()));
  });

  it('fails without attempting the restart when the credentials post is rejected', async () => {
    const panel = startPanel(() => 401);
    await panel.ready;
    const result = await pushCredentials(`127.0.0.1:${panel.port}`, CREDS, silentLog);
    expect(result).to.deep.equal({ ok: false, reason: 'credentials_rejected_401' });
    expect(panel.captured.map((c) => c.path)).to.deep.equal(['/mqtt']);
    await new Promise<void>((resolve) => panel.server.close(() => resolve()));
  });

  it('reports a failed restart distinctly, because the credentials did land', async () => {
    const panel = startPanel((path) => (path === '/restart' ? 500 : 200));
    await panel.ready;
    const result = await pushCredentials(`127.0.0.1:${panel.port}`, CREDS, silentLog);
    expect(result).to.deep.equal({ ok: false, reason: 'restart_failed_500' });
    await new Promise<void>((resolve) => panel.server.close(() => resolve()));
  });

  it('reports an unreachable panel rather than throwing', async () => {
    const result = await pushCredentials('127.0.0.1:9', CREDS, silentLog);
    expect(result.ok).to.equal(false);
    expect((result as { reason: string }).reason).to.equal('unreachable');
  });

  it('strips a scheme and a trailing slash from the supplied host', async () => {
    const panel = startPanel(() => 200);
    await panel.ready;
    expect(await pushCredentials(`http://127.0.0.1:${panel.port}/`, CREDS, silentLog)).to.deep.equal({ ok: true });
    await new Promise<void>((resolve) => panel.server.close(() => resolve()));
  });

  it('rejects an empty host without making a request', async () => {
    expect(await pushCredentials('   ', CREDS, silentLog)).to.deep.equal({ ok: false, reason: 'invalid_host' });
  });

  it('derives credentials from the adapter options', () => {
    const creds = credentialsFromOptions({
      ...DEFAULTS,
      brokerHost: 'broker.lan',
      brokerPort: 8883,
      brokerUser: 'u',
      brokerPassword: 'p',
    });
    expect(creds).to.deep.equal({
      host: 'broker.lan',
      port: 8883,
      username: 'u',
      password: 'p',
      baseTopic: 'hometiles',
      haPrefix: 'ha/statestream',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx mocha test/runtime/pairing.test.ts`
Expected: FAIL, `Cannot find module '../../src/runtime/pairing'`

- [ ] **Step 3: Implement `src/runtime/pairing.ts`**

```ts
import type { AdapterOptions } from '../config/options';
import type { Logger } from './mqtt-client';

export interface PairingCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  baseTopic: string;
  haPrefix: string;
}

export type PairingResult = { ok: true } | { ok: false; reason: string };

const REQUEST_TIMEOUT_MS = 5000;
const ACCEPTED_STATUS = new Set([200, 303]);

export function credentialsFromOptions(options: AdapterOptions): PairingCredentials {
  return {
    host: options.brokerHost,
    port: options.brokerPort,
    username: options.brokerUser,
    password: options.brokerPassword,
    baseTopic: options.baseTopic,
    haPrefix: options.haPrefix,
  };
}

function normaliseHost(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

async function post(
  url: string,
  body: string | undefined,
  fetchImpl: typeof fetch,
): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      // The firmware answers the save with a redirect to its own admin page.
      // Following it would turn a success into a spurious second request.
      redirect: 'manual',
      headers: body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' },
      body: body ?? '',
      signal: controller.signal,
    });
    return response.status;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pushes broker credentials to a panel that has none, then restarts it.
 *
 * The restart is mandatory: the firmware latches mqtt_enabled at boot, so
 * without it the credentials sit in NVS and never take effect.
 */
export async function pushCredentials(
  host: string,
  credentials: PairingCredentials,
  log: Logger,
  fetchImpl: typeof fetch = fetch,
): Promise<PairingResult> {
  const target = normaliseHost(host);
  if (!target) return { ok: false, reason: 'invalid_host' };

  const form = new URLSearchParams({
    mqtt_host: credentials.host,
    mqtt_port: String(credentials.port),
    mqtt_user: credentials.username,
    mqtt_pass: credentials.password,
    mqtt_base: credentials.baseTopic,
    ha_prefix: credentials.haPrefix,
  }).toString();

  let status: number;
  try {
    status = await post(`http://${target}/mqtt`, form, fetchImpl);
  } catch {
    log.warn(`[Pairing] Panel at ${target} is unreachable`);
    return { ok: false, reason: 'unreachable' };
  }

  if (!ACCEPTED_STATUS.has(status)) {
    log.warn(`[Pairing] Panel at ${target} rejected the credentials with status ${status}`);
    return { ok: false, reason: `credentials_rejected_${status}` };
  }

  let restartStatus: number;
  try {
    restartStatus = await post(`http://${target}/restart`, undefined, fetchImpl);
  } catch {
    log.warn(`[Pairing] Panel at ${target} accepted credentials but did not restart`);
    return { ok: false, reason: 'restart_unreachable' };
  }

  if (!ACCEPTED_STATUS.has(restartStatus)) {
    log.warn(`[Pairing] Panel at ${target} refused the restart with status ${restartStatus}`);
    return { ok: false, reason: `restart_failed_${restartStatus}` };
  }

  log.info(`[Pairing] Credentials pushed to panel at ${target}, restart requested`);
  return { ok: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx mocha test/runtime/pairing.test.ts`
Expected: PASS, 8 passing

- [ ] **Step 5: Commit**

```bash
git add src/runtime/pairing.ts test/runtime/pairing.test.ts
git commit -m "feat(runtime): push broker credentials to an unconfigured panel and restart it"
```

---

## Task 17: Adapter main wiring

**Files:**
- Create: `src/main.ts`
- Test: `test/main.startup.test.ts`

**Interfaces:**
- Consumes: everything built so far.
- Produces: the adapter class `HomeTiles` and its `onMessage` handlers `listDetected`, `testBroker`, `previewEntity`, `pairPanel`.

The persisted entity-id map lives in the adapter's own state `hometiles.0.info.entityIds` as JSON. This is the storage behind the Global Constraint that ids survive an ioBroker rename.

- [ ] **Step 1: Write the failing package and startup tests**

`@iobroker/testing` 5.3.0 marks `tests.unit` deprecated — "Adapter startup unit
tests are no longer supported" — and its `defineAdditionalTests` takes no
arguments. The `{ suite }` / `getHarness` API belongs to `tests.integration`,
which downloads and runs a real js-controller. So the always-on gate here is
`tests.packageFiles`, and the real adapter startup goes behind an opt-in
integration suite. The wiring `main.ts` performs is already proven end to end
by Task 19 against a real broker.

Create `test/package.test.ts`:

```ts
import { tests } from '@iobroker/testing';
import path from 'node:path';

// Validates package.json against io-package.json: name, version, licence,
// native/instanceObjects shape, and the adapter naming rules.
tests.packageFiles(path.join(__dirname, '..'));
```

Create `test/main.integration.test.ts`:

```ts
import { expect } from 'chai';
import { tests } from '@iobroker/testing';
import path from 'node:path';

// Opt-in: this downloads and runs a real js-controller, so it stays out of the
// default suite. Run it with HOMETILES_INTEGRATION=1 npm test.
if (process.env.HOMETILES_INTEGRATION === '1') {
  tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
      suite('startup', (getHarness) => {
        it('starts with no reachable broker and reports info.connection false', async function () {
          this.timeout(120000);
          const harness = getHarness();
          await harness.startAdapterAndWait();
          const state = await harness.states.getStateAsync('hometiles.0.info.connection');
          expect(state?.val).to.equal(false);
        });
      });
    },
  });
}
```

- [ ] **Step 2: Run the package test to verify it fails**

Run: `npx mocha test/package.test.ts`
Expected: FAIL. `main` points at `build/main.js`, which does not exist yet.

- [ ] **Step 3: Implement `src/main.ts`**

```ts
import * as utils from '@iobroker/adapter-core';
import { validateOptions, type AdapterOptions, type DeviceOverride } from './config/options';
import { AnnounceError } from './protocol/announce';
import { buildStatePublish } from './protocol/state-payload';
import {
  ANNOUNCE_TOPIC_PATTERN,
  deviceIdFromAnnounceTopic,
  ioStateTopic,
  PANEL_SETTING_LEAVES,
  stateTopic,
} from './protocol/topics';
import { createIoBrokerDetector, mapControlToDevice, type ObjectMeta } from './registry/detector';
import { EntityRegistry } from './registry/entity-registry';
import { applyOverrides } from './registry/overrides';
import { synthesise } from './registry/synth/index';
import type { DeviceInput, SourceValue, VirtualEntity } from './registry/types';
import { Dispatcher } from './runtime/dispatcher';
import { HomeTilesMqttClient, type Logger } from './runtime/mqtt-client';
import { PanelManager } from './runtime/panel-manager';
import { PanelObjects } from './runtime/panel-objects';
import type { PanelSession } from './runtime/panel-session';
import { credentialsFromOptions, pushCredentials } from './runtime/pairing';

const ENTITY_ID_STATE = 'info.entityIds';

class HomeTiles extends utils.Adapter {
  private options!: AdapterOptions;
  private mqtt!: HomeTilesMqttClient;
  private registry!: EntityRegistry;
  private panels!: PanelManager;
  private panelObjects!: PanelObjects;
  private dispatcher!: Dispatcher;
  private persistedIds: Record<string, string> = {};
  private devices: DeviceInput[] = [];

  constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({ ...options, name: 'hometiles' });
    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('message', this.onMessage.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  private get log4(): Logger {
    return {
      info: (message) => this.log.info(message),
      warn: (message) => this.log.warn(message),
      error: (message) => this.log.error(message),
      debug: (message) => this.log.debug(message),
    };
  }

  private async onReady(): Promise<void> {
    const { options, errors } = validateOptions(this.config as unknown as Partial<AdapterOptions>);
    for (const error of errors) this.log.error(`[Config] ${error}`);
    this.options = options;

    await this.setState('info.connection', false, true);
    this.persistedIds = await this.loadPersistedIds();

    this.mqtt = new HomeTilesMqttClient(options, this.log4);
    this.registry = new EntityRegistry(
      {
        onEntityChanged: (entity) => this.publishEntity(entity),
        onMembershipChanged: () => this.pushConfigToAllPanels(),
      },
      options.coalesceMs,
    );
    this.dispatcher = new Dispatcher(
      {
        byId: (entityId) => this.registry.byId(entityId),
        bySceneAlias: (alias) => this.registry.bySceneAlias(alias),
      },
      async (objectId, value) => {
        await this.setForeignStateAsync(objectId, value as ioBroker.StateValue, false);
      },
      this.log4,
    );
    this.panelObjects = new PanelObjects(
      {
        setObject: async (id, obj) => {
          await this.setObjectNotExistsAsync(id, obj as ioBroker.SettableObject);
        },
        deleteObject: async (id, recursive) => {
          await this.delObjectAsync(id, { recursive });
        },
        setState: async (id, value, ack) => {
          await this.setState(id, value as ioBroker.StateValue, ack);
        },
      },
      this.log4,
    );
    this.panels = new PanelManager({
      transport: {
        publish: (request) => this.mqtt.publish(request),
        subscribe: (topic) => this.mqtt.subscribe(topic),
        unsubscribe: (topic) => this.mqtt.unsubscribe(topic),
      },
      dispatcher: this.dispatcher,
      log: this.log4,
      entities: () => this.registry.all(),
      onSessionsChanged: async () => {
        await this.syncPanelObjects();
      },
    });

    this.mqtt.onConnectionChange((connected) => {
      void this.setState('info.connection', connected, true);
      if (connected) void this.mqtt.subscribe(ANNOUNCE_TOPIC_PATTERN);
    });
    this.mqtt.onMessage((topic, payload) => void this.onMqttMessage(topic, payload));

    await this.rebuildRegistry();
    await this.subscribeStatesAsync('panels.*');

    // A broker that is down must not stop the adapter: the client reconnects.
    await this.mqtt.connect();
    this.log.info(
      `[HomeTiles] Ready. ${this.devices.length} devices detected, ${this.registry.all().length} entities published`,
    );
  }

  private async onUnload(callback: () => void): Promise<void> {
    try {
      this.registry?.flush();
      this.registry?.dispose();
      await this.panels?.stopAll();
      await this.mqtt?.disconnect();
      await this.setState('info.connection', false, true);
    } catch (error) {
      this.log.warn(`[HomeTiles] Unload: ${(error as Error).message}`);
    } finally {
      callback();
    }
  }

  // ---- MQTT ----

  private async onMqttMessage(topic: string, payload: string): Promise<void> {
    const announceDeviceId = deviceIdFromAnnounceTopic(topic);
    if (announceDeviceId) {
      try {
        await this.panels.handleAnnouncement(announceDeviceId, payload);
      } catch (error) {
        const code = error instanceof AnnounceError ? error.code : (error as Error).message;
        this.log.warn(`[Panel ${announceDeviceId}] Announcement failed: ${code}`);
      }
      return;
    }

    // The manager owns command routing; main only mirrors the panel's own
    // retained echoes into the object tree afterwards.
    await this.panels.handleMessage(topic, payload);
    for (const session of this.panels.sessions()) {
      await this.mirrorPanelStat(session, topic, payload);
    }
  }

  /** Mirrors the panel's own retained echoes into the adapter object tree. */
  private async mirrorPanelStat(session: PanelSession, topic: string, payload: string): Promise<void> {
    const root = `panels.${session.deviceId}`;

    if (topic === stateTopic(session.baseTopic, 'connected')) {
      await this.setState(`${root}.info.connected`, session.online, true);
      return;
    }
    if (topic === stateTopic(session.baseTopic, 'ip')) {
      await this.setState(`${root}.info.ip`, session.ip, true);
      return;
    }
    for (const leaf of PANEL_SETTING_LEAVES) {
      if (topic === stateTopic(session.baseTopic, leaf)) {
        await this.panelObjects.applyPanelStat(session, leaf, payload);
        return;
      }
    }
    for (const channel of session.localIo) {
      if (topic === ioStateTopic(session.baseTopic, channel.id)) {
        await this.panelObjects.applyIoStat(session, channel.id, payload);
        return;
      }
    }
  }

  // ---- ioBroker state changes ----

  private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
    if (!state) {
      this.registry.applyStateChange(id, null);
      return;
    }

    if (id.startsWith(`${this.namespace}.panels.`)) {
      if (state.ack) return;
      await this.handlePanelWrite(id, state);
      return;
    }

    this.registry.applyStateChange(id, { val: state.val, ack: state.ack, q: state.q ?? 0, ts: state.ts });
  }

  private async handlePanelWrite(id: string, state: ioBroker.State): Promise<void> {
    const rest = id.slice(`${this.namespace}.panels.`.length);
    const separator = rest.indexOf('.');
    if (separator < 0) return;
    const deviceId = rest.slice(0, separator);
    const path = rest.slice(separator + 1);

    const session = this.panels.get(deviceId);
    if (!session) return;

    if (path === 'control.refresh') {
      session.pushConfig(this.registry.all(), true);
      for (const entity of this.registry.all()) session.pushEntityState(entity);
      await this.setState(id, false, true);
      return;
    }

    if (path === 'control.pair') {
      const host = session.ip;
      if (!host) {
        this.log.warn(`[Panel ${deviceId}] Pairing skipped: the panel has not reported an IP address`);
      } else {
        await pushCredentials(host, credentialsFromOptions(this.options), this.log4);
      }
      await this.setState(id, false, true);
      return;
    }

    this.panelObjects.handleControlWrite(session, path, state.val);
  }

  // ---- Registry ----

  private async rebuildRegistry(): Promise<void> {
    const detected = await this.detectDevices();
    this.devices = applyOverrides(detected, (this.options.deviceOverrides ?? []) as DeviceOverride[]);

    const result = this.registry.rebuild(this.devices, this.persistedIds);
    this.persistedIds = result.entityIds;
    await this.savePersistedIds(result.entityIds);

    for (const objectId of result.unsubscribe) await this.unsubscribeForeignStatesAsync(objectId);
    for (const objectId of result.subscribe) await this.subscribeForeignStatesAsync(objectId);

    // Seed the registry with the values the sources already hold, so a panel
    // that connects later finds retained state rather than an empty dashboard.
    for (const objectId of result.subscribe) {
      const state = await this.getForeignStateAsync(objectId);
      this.registry.applyStateChange(
        objectId,
        state ? { val: state.val, ack: state.ack, q: state.q ?? 0, ts: state.ts } : null,
      );
    }
    this.registry.flush();

    for (const entityId of result.removed) {
      for (const session of this.panels.sessions()) session.clearEntityState(entityId);
    }

    await this.setState('info.entities', this.registry.all().length, true);
  }

  private async detectDevices(): Promise<DeviceInput[]> {
    const objects = (await this.getForeignObjectsAsync('*', 'state')) as Record<string, ioBroker.Object>;
    const channels = (await this.getForeignObjectsAsync('*', 'channel')) as Record<string, ioBroker.Object>;
    const devices = (await this.getForeignObjectsAsync('*', 'device')) as Record<string, ioBroker.Object>;
    const all: Record<string, ioBroker.Object> = { ...objects, ...channels, ...devices };

    const detector = createIoBrokerDetector(all as unknown as Record<string, unknown>);
    const meta: Record<string, ObjectMeta> = {};
    for (const [id, obj] of Object.entries(all)) {
      const common = (obj.common ?? {}) as Record<string, unknown>;
      meta[id] = {
        name: typeof common.name === 'string' ? common.name : id.split('.').pop() ?? id,
        role: typeof common.role === 'string' ? common.role : undefined,
        unit: typeof common.unit === 'string' ? common.unit : undefined,
        type: typeof common.type === 'string' ? common.type : undefined,
        min: typeof common.min === 'number' ? common.min : undefined,
        max: typeof common.max === 'number' ? common.max : undefined,
        states: (common.states as Record<string, string>) ?? undefined,
        write: typeof common.write === 'boolean' ? common.write : undefined,
        icon: typeof common.icon === 'string' ? common.icon : undefined,
      };
    }

    const result: DeviceInput[] = [];
    const seen = new Set<string>();
    for (const rootId of [...Object.keys(devices), ...Object.keys(channels)]) {
      // Never detect inside our own namespace: the panel objects are not
      // devices to publish back to the panels.
      if (rootId.startsWith(`${this.namespace}.`)) continue;
      for (const control of detector.detect(rootId)) {
        const device = mapControlToDevice(rootId, control, meta);
        if (!device || seen.has(device.objectId)) continue;
        seen.add(device.objectId);
        result.push(device);
      }
    }
    return result;
  }

  private publishEntity(entity: VirtualEntity): void {
    for (const session of this.panels.sessions()) session.pushEntityState(entity);
  }

  private pushConfigToAllPanels(): void {
    for (const session of this.panels.sessions()) session.pushConfig(this.registry.all());
  }

  private async syncPanelObjects(): Promise<void> {
    for (const session of this.panels.sessions()) {
      await this.panelObjects.sync(session);
      this.registry.setSceneAliases(session.sceneMap);
    }
    await this.setState('info.panels', this.panels.sessions().length, true);
  }

  private async loadPersistedIds(): Promise<Record<string, string>> {
    const state = await this.getStateAsync(ENTITY_ID_STATE);
    if (!state || typeof state.val !== 'string') return {};
    try {
      return JSON.parse(state.val) as Record<string, string>;
    } catch {
      this.log.warn('[Registry] Stored entity id map is corrupt, starting from scratch');
      return {};
    }
  }

  private async savePersistedIds(map: Record<string, string>): Promise<void> {
    await this.setObjectNotExistsAsync(ENTITY_ID_STATE, {
      type: 'state',
      common: { name: 'Persisted entity ids', type: 'string', role: 'json', read: true, write: false, def: '{}' },
      native: {},
    } as ioBroker.SettableObject);
    await this.setState(ENTITY_ID_STATE, JSON.stringify(map), true);
  }

  // ---- Admin messages ----

  private async onMessage(message: ioBroker.Message): Promise<void> {
    const reply = (payload: unknown): void => {
      if (message.callback) this.sendTo(message.from, message.command, payload, message.callback);
    };

    switch (message.command) {
      case 'listDetected': {
        const detected = await this.detectDevices();
        reply(
          detected.map((device) => ({
            objectId: device.objectId,
            name: device.name,
            detectorType: device.detectorType,
            domain: device.domain,
            entityId: this.persistedIds[device.objectId] ?? '',
            channels: Object.keys(device.channels).join(', '),
          })),
        );
        return;
      }

      case 'previewEntity': {
        const objectId = String((message.message as { objectId?: string })?.objectId ?? '');
        const device = this.devices.find((candidate) => candidate.objectId === objectId);
        if (!device) return reply({ error: 'device_not_detected' });

        const entityId = this.persistedIds[objectId] ?? `${device.domain}.preview`;
        const values: Record<string, SourceValue | null> = {};
        for (const channel of Object.values(device.channels)) {
          const state = await this.getForeignStateAsync(channel.objectId);
          values[channel.objectId] = state
            ? { val: state.val, ack: state.ack, q: state.q ?? 0, ts: state.ts }
            : null;
        }
        const entity = synthesise(device, entityId, values);
        const publish = buildStatePublish(this.options.haPrefix, entity);
        return reply({ entity, publish: publish ?? { note: 'this domain publishes no state' } });
      }

      case 'testBroker': {
        const probe = new HomeTilesMqttClient(this.options, this.log4);
        await probe.connect();
        const connected = probe.connected;
        await probe.disconnect();
        return reply({ connected });
      }

      case 'pairPanel': {
        const host = String((message.message as { host?: string })?.host ?? '');
        const result = await pushCredentials(host, credentialsFromOptions(this.options), this.log4);
        return reply(result);
      }

      default:
        return reply({ error: `unknown_command_${message.command}` });
    }
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new HomeTiles(options);
} else {
  ((): HomeTiles => new HomeTiles())();
}
```

- [ ] **Step 4: Build and run the package test**

Run: `npm run build && npx mocha test/package.test.ts`
Expected: PASS. `build/main.js` now exists and package metadata validates.

The opt-in integration suite is not part of this gate. Note in the report
whether `HOMETILES_INTEGRATION=1 npx mocha test/main.integration.test.ts` was
attempted and what happened; a failure there caused by no network access is
reported, not fixed.

- [ ] **Step 5: Run the whole suite and lint**

Run: `npm run lint && npm test && npm run build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts test/package.test.ts test/main.integration.test.ts
git commit -m "feat: adapter main wiring, panel object sync and admin message handlers"
```

---

## Task 18: Admin UI

**Files:**
- Create: `admin/jsonConfig.json`, `admin/i18n/en.json`, `admin/i18n/de.json`
- Test: `test/admin/jsonconfig.test.ts`

**Interfaces:**
- Consumes: the native keys defined in `io-package.json` (Task 1) and the `onMessage` commands from Task 17.
- Produces: no code interface. The test guards the contract between the UI and the adapter.

The overrides table binds to the `deviceOverrides` native array and stores `objectId` on every row. That is what makes the Global Constraint hold: overrides are keyed by object id, never by row index.

- [ ] **Step 1: Write the failing test**

Create `test/admin/jsonconfig.test.ts`:

```ts
import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const config = JSON.parse(readFileSync(path.join(__dirname, '../../admin/jsonConfig.json'), 'utf8'));
const ioPackage = JSON.parse(readFileSync(path.join(__dirname, '../../io-package.json'), 'utf8'));

/**
 * In a jsonConfig panel the native binding is the KEY of each entry in `items`.
 * Keys starting with an underscore are actions, not bindings.
 */
function boundNativeKeys(): string[] {
  const keys: string[] = [];
  for (const panel of Object.values(config.items) as Array<{ items: Record<string, unknown> }>) {
    for (const key of Object.keys(panel.items)) {
      if (key.startsWith('_')) continue;
      keys.push(key);
    }
  }
  return keys;
}

describe('admin/jsonConfig', () => {
  it('declares the json config version the admin expects', () => {
    expect(config.i18n).to.equal(true);
    expect(config.type).to.equal('tabs');
  });

  it('has the four tabs the design specifies', () => {
    expect(Object.keys(config.items)).to.deep.equal(['connection', 'devices', 'panels', 'advanced']);
  });

  it('binds every field to a native key that io-package.json defines', () => {
    const keys = boundNativeKeys();
    expect(keys.length, 'the UI must bind at least the connection fields').to.be.greaterThan(5);
    for (const key of keys) {
      expect(ioPackage.native, `native is missing ${key}`).to.have.property(key);
    }
  });

  it('covers every native key with a field so nothing is silently unconfigurable', () => {
    const keys = new Set(boundNativeKeys());
    for (const key of Object.keys(ioPackage.native)) {
      expect(keys, `no UI field binds native.${key}`).to.include(key);
    }
  });

  it('stores the broker password as a password field so it is encrypted', () => {
    const field = config.items.connection.items.brokerPassword;
    expect(field.type).to.equal('password');
  });

  it('keys the device overrides table by objectId', () => {
    const table = config.items.devices.items.deviceOverrides;
    expect(table.type).to.equal('table');
    expect(table.items.map((column: { attr: string }) => column.attr)).to.include('objectId');
  });

  it('offers only the v0.1 domains in the forced-domain column', () => {
    const table = config.items.devices.items.deviceOverrides;
    const column = table.items.find((item: { attr: string }) => item.attr === 'forcedDomain');
    const values = column.options.map((option: { value: string }) => option.value);
    expect(values).to.deep.equal(['', 'sensor', 'binary_sensor', 'switch', 'light', 'scene']);
  });

  it('wires each action button to a command the adapter implements', () => {
    const commands = new Set(['listDetected', 'testBroker', 'previewEntity', 'pairPanel']);
    const found = new Set<string>();
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (record.type === 'sendTo' && typeof record.command === 'string') found.add(record.command);
      for (const value of Object.values(record)) walk(value);
    };
    walk(config.items);
    expect(found.size).to.be.greaterThan(0);
    for (const command of found) expect(commands, `unknown command ${command}`).to.include(command);
  });

  it('ships both translation files with matching key sets', () => {
    const en = JSON.parse(readFileSync(path.join(__dirname, '../../admin/i18n/en.json'), 'utf8'));
    const de = JSON.parse(readFileSync(path.join(__dirname, '../../admin/i18n/de.json'), 'utf8'));
    expect(Object.keys(de).sort()).to.deep.equal(Object.keys(en).sort());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx mocha test/admin/jsonconfig.test.ts`
Expected: FAIL, `ENOENT ... admin/jsonConfig.json`

- [ ] **Step 3: Create `admin/jsonConfig.json`**

```json
{
  "i18n": true,
  "type": "tabs",
  "items": {
    "connection": {
      "type": "panel",
      "label": "tab_connection",
      "items": {
        "brokerHost": { "type": "text", "label": "broker_host", "newLine": true, "sm": 12, "md": 6, "lg": 4 },
        "brokerPort": { "type": "number", "label": "broker_port", "min": 1, "max": 65535, "sm": 12, "md": 3, "lg": 2 },
        "brokerTls": { "type": "checkbox", "label": "broker_tls", "sm": 12, "md": 3, "lg": 2 },
        "brokerUser": { "type": "text", "label": "broker_user", "newLine": true, "sm": 12, "md": 6, "lg": 4 },
        "brokerPassword": { "type": "password", "label": "broker_password", "visible": true, "sm": 12, "md": 6, "lg": 4 },
        "clientId": { "type": "text", "label": "client_id", "newLine": true, "sm": 12, "md": 6, "lg": 4 },
        "baseTopic": { "type": "text", "label": "base_topic", "newLine": true, "sm": 12, "md": 6, "lg": 4, "help": "base_topic_help" },
        "haPrefix": { "type": "text", "label": "ha_prefix", "sm": 12, "md": 6, "lg": 4, "help": "ha_prefix_help" },
        "_testBroker": {
          "type": "sendTo",
          "label": "test_broker",
          "command": "testBroker",
          "newLine": true,
          "variant": "contained",
          "useNative": true,
          "sm": 12,
          "md": 4,
          "lg": 3
        }
      }
    },
    "devices": {
      "type": "panel",
      "label": "tab_devices",
      "items": {
        "_detected": {
          "type": "sendTo",
          "label": "list_detected",
          "command": "listDetected",
          "variant": "contained",
          "useNative": true,
          "sm": 12,
          "md": 4,
          "lg": 3
        },
        "deviceOverrides": {
          "type": "table",
          "label": "device_overrides",
          "newLine": true,
          "sm": 12,
          "md": 12,
          "lg": 12,
          "items": [
            { "type": "text", "attr": "objectId", "title": "column_object_id", "width": "40%", "filter": true, "sort": true },
            { "type": "checkbox", "attr": "include", "title": "column_include", "width": "10%", "default": true },
            { "type": "text", "attr": "name", "title": "column_name", "width": "25%" },
            {
              "type": "select",
              "attr": "forcedDomain",
              "title": "column_forced_domain",
              "width": "25%",
              "options": [
                { "label": "domain_auto", "value": "" },
                { "label": "domain_sensor", "value": "sensor" },
                { "label": "domain_binary_sensor", "value": "binary_sensor" },
                { "label": "domain_switch", "value": "switch" },
                { "label": "domain_light", "value": "light" },
                { "label": "domain_scene", "value": "scene" }
              ]
            }
          ]
        },
        "_preview": {
          "type": "sendTo",
          "label": "preview_entity",
          "command": "previewEntity",
          "newLine": true,
          "variant": "outlined",
          "useNative": true,
          "sm": 12,
          "md": 4,
          "lg": 3,
          "help": "preview_entity_help"
        }
      }
    },
    "panels": {
      "type": "panel",
      "label": "tab_panels",
      "items": {
        "_pairInfo": { "type": "staticText", "text": "pair_info", "sm": 12, "md": 12, "lg": 12 },
        "_pairPanel": {
          "type": "sendTo",
          "label": "pair_panel",
          "command": "pairPanel",
          "newLine": true,
          "variant": "contained",
          "useNative": true,
          "sm": 12,
          "md": 4,
          "lg": 3
        }
      }
    },
    "advanced": {
      "type": "panel",
      "label": "tab_advanced",
      "items": {
        "coalesceMs": { "type": "number", "label": "coalesce_ms", "min": 0, "max": 5000, "sm": 12, "md": 4, "lg": 3, "help": "coalesce_ms_help" },
        "maxPublishQueue": { "type": "number", "label": "max_publish_queue", "min": 100, "max": 100000, "sm": 12, "md": 4, "lg": 3, "help": "max_publish_queue_help" },
        "protocolTrace": { "type": "checkbox", "label": "protocol_trace", "newLine": true, "sm": 12, "md": 4, "lg": 3, "help": "protocol_trace_help" }
      }
    }
  }
}
```

- [ ] **Step 4: Create `admin/i18n/en.json`**

```json
{
  "tab_connection": "Connection",
  "tab_devices": "Devices",
  "tab_panels": "Panels",
  "tab_advanced": "Advanced",
  "broker_host": "MQTT broker host",
  "broker_port": "Port",
  "broker_tls": "Use TLS",
  "broker_user": "Username",
  "broker_password": "Password",
  "client_id": "MQTT client id",
  "base_topic": "Panel base topic",
  "base_topic_help": "Must match the device topic base configured on the panel. Unique per panel.",
  "ha_prefix": "Entity state prefix",
  "ha_prefix_help": "Topic prefix the panel listens on for entity state. Same on every panel.",
  "test_broker": "Test broker connection",
  "list_detected": "Scan for devices",
  "device_overrides": "Device overrides",
  "column_object_id": "Object ID",
  "column_include": "Include",
  "column_name": "Name override",
  "column_forced_domain": "Forced type",
  "domain_auto": "Auto",
  "domain_sensor": "Sensor",
  "domain_binary_sensor": "Binary sensor",
  "domain_switch": "Switch",
  "domain_light": "Light",
  "domain_scene": "Scene",
  "preview_entity": "Preview MQTT payload",
  "preview_entity_help": "Shows the exact topic and payload this object would publish to a panel.",
  "pair_info": "A panel with no broker credentials cannot announce itself over MQTT. Enter its IP address or hostname to push the credentials configured above and restart it. Panels that already announced themselves can be re-paired from their control.pair button.",
  "pair_panel": "Pair a panel by address",
  "coalesce_ms": "State coalescing window (ms)",
  "coalesce_ms_help": "Bursts inside this window publish once. The final value is always delivered.",
  "max_publish_queue": "Maximum queued publishes",
  "max_publish_queue_help": "When the queue is full the oldest message is dropped.",
  "protocol_trace": "Log protocol traffic",
  "protocol_trace_help": "Verbose per-message logging. Use only while diagnosing."
}
```

- [ ] **Step 5: Create `admin/i18n/de.json` with the same key set**

```json
{
  "tab_connection": "Verbindung",
  "tab_devices": "Geräte",
  "tab_panels": "Panels",
  "tab_advanced": "Erweitert",
  "broker_host": "MQTT-Broker-Host",
  "broker_port": "Port",
  "broker_tls": "TLS verwenden",
  "broker_user": "Benutzername",
  "broker_password": "Passwort",
  "client_id": "MQTT-Client-ID",
  "base_topic": "Basis-Topic des Panels",
  "base_topic_help": "Muss mit dem am Panel eingestellten Device-Topic übereinstimmen. Pro Panel eindeutig.",
  "ha_prefix": "Präfix für Entity-Status",
  "ha_prefix_help": "Topic-Präfix, auf dem das Panel Entity-Status erwartet. Auf allen Panels gleich.",
  "test_broker": "Broker-Verbindung testen",
  "list_detected": "Geräte suchen",
  "device_overrides": "Geräte-Overrides",
  "column_object_id": "Objekt-ID",
  "column_include": "Übernehmen",
  "column_name": "Name überschreiben",
  "column_forced_domain": "Typ erzwingen",
  "domain_auto": "Automatisch",
  "domain_sensor": "Sensor",
  "domain_binary_sensor": "Binärsensor",
  "domain_switch": "Schalter",
  "domain_light": "Licht",
  "domain_scene": "Szene",
  "preview_entity": "MQTT-Payload anzeigen",
  "preview_entity_help": "Zeigt Topic und Payload, die dieses Objekt an ein Panel senden würde.",
  "pair_info": "Ein Panel ohne Broker-Zugangsdaten kann sich nicht über MQTT melden. IP-Adresse oder Hostname eintragen, um die oben konfigurierten Zugangsdaten zu übertragen und das Panel neu zu starten. Bereits gemeldete Panels lassen sich über ihren Button control.pair erneut koppeln.",
  "pair_panel": "Panel über Adresse koppeln",
  "coalesce_ms": "Sammelfenster für Statusänderungen (ms)",
  "coalesce_ms_help": "Änderungen innerhalb dieses Fensters werden einmal gesendet. Der letzte Wert wird immer zugestellt.",
  "max_publish_queue": "Maximale Warteschlange",
  "max_publish_queue_help": "Ist die Warteschlange voll, wird die älteste Nachricht verworfen.",
  "protocol_trace": "Protokollverkehr loggen",
  "protocol_trace_help": "Ausführliches Logging pro Nachricht. Nur zur Fehlersuche verwenden."
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx mocha test/admin/jsonconfig.test.ts`
Expected: PASS, 9 passing

- [ ] **Step 7: Commit**

```bash
git add admin/ test/admin/jsonconfig.test.ts
git commit -m "feat(admin): JSON config UI with object-id keyed overrides and payload preview"
```

---

## Task 19: End-to-end round trip

**Files:**
- Test: `test/integration/round-trip.test.ts`

**Interfaces:**
- Consumes: every module. Adds no production code.

This is the test that would have caught the bare-string versus JSON payload asymmetry, and it is the one that proves the whole chain: announcement, configuration push, state publish, command, ioBroker write.

- [ ] **Step 1: Write the failing test**

Create `test/integration/round-trip.test.ts`:

```ts
import Aedes from 'aedes';
import { expect } from 'chai';
import mqtt, { type MqttClient } from 'mqtt';
import { createServer, type Server } from 'node:net';
import { DEFAULTS } from '../../src/config/options';
import { EntityRegistry } from '../../src/registry/entity-registry';
import type { DeviceInput } from '../../src/registry/types';
import { Dispatcher } from '../../src/runtime/dispatcher';
import { HomeTilesMqttClient } from '../../src/runtime/mqtt-client';
import { PanelManager } from '../../src/runtime/panel-manager';
import { ANNOUNCE_TOPIC_PATTERN, deviceIdFromAnnounceTopic } from '../../src/protocol/topics';

const PORT = 18841;
const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

const PLUG: DeviceInput = {
  objectId: 'shelly.0.plug',
  name: 'Kaffee',
  detectorType: 'socket',
  domain: 'switch',
  channels: { set: { objectId: 'shelly.0.plug.on', type: 'boolean', write: true } },
};

const LAMP: DeviceInput = {
  objectId: 'hue.0.decke',
  name: 'Decke',
  detectorType: 'dimmer',
  domain: 'light',
  channels: {
    set: { objectId: 'hue.0.decke.on', type: 'boolean', write: true },
    dimmer: { objectId: 'hue.0.decke.level', type: 'number', min: 0, max: 100, write: true },
  },
};

const ANNOUNCE = JSON.stringify({
  device_id: 'e2e1',
  base_topic: 'hometiles-e2e',
  ha_prefix: 'ha/e2e',
  device_name: 'E2E Panel',
  model: 'waveshare_touch_lcd_8',
  sensors: [],
  binary_sensors: [],
  scene_map: {},
  local_io: [],
});

function waitFor<T>(predicate: () => T | undefined, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      const value = predicate();
      if (value !== undefined) return resolve(value);
      if (Date.now() > deadline) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('integration round trip', function () {
  this.timeout(20000);

  // aedes 0.51.3 ships Aedes as a class, not a callable factory, so
  // ReturnType<typeof Aedes> does not compile (TS2344). The class IS the type.
  let broker: Aedes;
  let server: Server;
  let adapterMqtt: HomeTilesMqttClient;
  let panelMqtt: MqttClient;
  let registry: EntityRegistry;
  let manager: PanelManager;
  let writes: Array<[string, unknown]>;
  const panelInbox = new Map<string, string>();

  beforeEach(async () => {
    broker = new Aedes();
    server = createServer(broker.handle);
    await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));

    writes = [];
    adapterMqtt = new HomeTilesMqttClient({ ...DEFAULTS, brokerPort: PORT, coalesceMs: 0 }, silentLog);

    registry = new EntityRegistry(
      {
        onEntityChanged: (entity) => {
          for (const session of manager.sessions()) session.pushEntityState(entity);
        },
        onMembershipChanged: () => {
          for (const session of manager.sessions()) session.pushConfig(registry.all());
        },
      },
      0,
    );

    const dispatcher = new Dispatcher(
      { byId: (id) => registry.byId(id), bySceneAlias: (alias) => registry.bySceneAlias(alias) },
      async (objectId, value) => {
        writes.push([objectId, value]);
      },
      silentLog,
    );

    manager = new PanelManager({
      transport: {
        publish: (request) => adapterMqtt.publish(request),
        subscribe: (topic) => adapterMqtt.subscribe(topic),
        unsubscribe: (topic) => adapterMqtt.unsubscribe(topic),
      },
      dispatcher,
      log: silentLog,
      entities: () => registry.all(),
      onSessionsChanged: async () => undefined,
    });

    adapterMqtt.onMessage((topic, payload) => {
      const deviceId = deviceIdFromAnnounceTopic(topic);
      if (deviceId) void manager.handleAnnouncement(deviceId, payload);
      else void manager.handleMessage(topic, payload);
    });

    await adapterMqtt.connect();
    await adapterMqtt.subscribe(ANNOUNCE_TOPIC_PATTERN);

    registry.rebuild([PLUG, LAMP], {});
    registry.applyStateChange('shelly.0.plug.on', { val: false, ack: true, q: 0, ts: Date.now() });
    registry.applyStateChange('hue.0.decke.on', { val: true, ack: true, q: 0, ts: Date.now() });
    registry.applyStateChange('hue.0.decke.level', { val: 60, ack: true, q: 0, ts: Date.now() });

    panelInbox.clear();
    panelMqtt = mqtt.connect(`mqtt://127.0.0.1:${PORT}`, { clientId: 'fake-panel' });
    await new Promise<void>((resolve) => panelMqtt.once('connect', () => resolve()));
    panelMqtt.on('message', (topic, payload) => panelInbox.set(topic, payload.toString('utf8')));
    await new Promise<void>((resolve) => {
      panelMqtt.subscribe(['tab5_lvgl/config/e2e1/bridge/apply', 'ha/e2e/#'], () => resolve());
    });
  });

  afterEach(async () => {
    await manager.stopAll();
    registry.dispose();
    await adapterMqtt.disconnect();
    await new Promise<void>((resolve) => panelMqtt.end(true, {}, () => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  });

  it('answers an announcement with a configuration push and the current state', async () => {
    panelMqtt.publish('tab5_lvgl/config/e2e1/bridge', ANNOUNCE, { retain: true });

    const apply = await waitFor(() => panelInbox.get('tab5_lvgl/config/e2e1/bridge/apply'));
    const parsed = JSON.parse(apply);
    expect(parsed.switches).to.deep.equal(['switch.kaffee']);
    expect(parsed.lights).to.deep.equal(['light.decke']);

    const switchState = await waitFor(() => panelInbox.get('ha/e2e/switch/kaffee/state'));
    expect(switchState, 'a switch must arrive as a bare string').to.equal('off');

    const lightState = await waitFor(() => panelInbox.get('ha/e2e/light/decke/state'));
    const lightPayload = JSON.parse(lightState);
    expect(lightPayload.state).to.equal('on');
    expect(lightPayload.brightness_pct).to.equal(60);
  });

  it('turns a panel command into an ioBroker write', async () => {
    panelMqtt.publish('tab5_lvgl/config/e2e1/bridge', ANNOUNCE, { retain: true });
    await waitFor(() => panelInbox.get('tab5_lvgl/config/e2e1/bridge/apply'));

    panelMqtt.publish('hometiles-e2e/cmnd/switch', '{"entity_id":"switch.kaffee","state":"on"}');
    await waitFor(() => (writes.length ? writes : undefined));
    expect(writes).to.deep.equal([['shelly.0.plug.on', true]]);
  });

  it('propagates a later ioBroker change to the panel', async () => {
    panelMqtt.publish('tab5_lvgl/config/e2e1/bridge', ANNOUNCE, { retain: true });
    await waitFor(() => panelInbox.get('ha/e2e/light/decke/state'));

    registry.applyStateChange('hue.0.decke.level', { val: 20, ack: true, q: 0, ts: Date.now() });

    const updated = await waitFor(() => {
      const raw = panelInbox.get('ha/e2e/light/decke/state');
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as { brightness_pct?: number };
      return parsed.brightness_pct === 20 ? parsed : undefined;
    });
    expect(updated.brightness_pct).to.equal(20);
  });

  it('delivers retained state to a panel that connects afterwards', async () => {
    panelMqtt.publish('tab5_lvgl/config/e2e1/bridge', ANNOUNCE, { retain: true });
    await waitFor(() => panelInbox.get('ha/e2e/switch/kaffee/state'));

    const late = mqtt.connect(`mqtt://127.0.0.1:${PORT}`, { clientId: 'late-panel' });
    await new Promise<void>((resolve) => late.once('connect', () => resolve()));
    const lateInbox = new Map<string, string>();
    late.on('message', (topic, payload) => lateInbox.set(topic, payload.toString('utf8')));
    await new Promise<void>((resolve) => late.subscribe('ha/e2e/#', () => resolve()));

    const retained = await waitFor(() => lateInbox.get('ha/e2e/switch/kaffee/state'));
    expect(retained).to.equal('off');
    await new Promise<void>((resolve) => late.end(true, {}, () => resolve()));
  });

  it('ignores a malformed announcement without creating a session', async () => {
    panelMqtt.publish('tab5_lvgl/config/bad1/bridge', '{"local_io":[{"id":""}]}', { retain: false });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(manager.get('bad1')).to.equal(undefined);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx mocha test/integration/round-trip.test.ts`
Expected: PASS, 5 passing. If the bare-string versus JSON distinction from Task 7 were wrong, the first test fails here with a switch payload of `{"state":"off",...}`.

- [ ] **Step 3: Run the whole suite**

Run: `npm run lint && npm test && npm run build`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add test/integration/round-trip.test.ts
git commit -m "test: end-to-end announce, configure, publish and command round trip"
```

---

## Task 20: Documentation and release readiness

**Files:**
- Create: `README.md`, `LICENSE`, `docs/protocol.md`, `.github/workflows/test-and-release.yml`
- Modify: `io-package.json` (news entry), `package.json` (repository field)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by code.

- [ ] **Step 1: Write `docs/protocol.md`**

Copy the **Verified Firmware Contract** section of this plan verbatim into `docs/protocol.md`, under the heading `# HomeTiles MQTT contract`, and add this note at the top:

```markdown
This document records the wire contract of the HomeTiles firmware, which this
adapter must satisfy exactly. The firmware is the fixed side: it is never
modified for this project. Every value here was read out of the firmware source
at the commit named below, not inferred from documentation.

Firmware reference: HomeTiles v0.6.9, files `src/network/mqtt_handlers.cpp`,
`src/network/mqtt_topics.cpp`, `src/network/ha_bridge_config.cpp`,
`src/network/network_manager.cpp`, `src/io/hardware_io.cpp`,
`src/web/web_admin.cpp`.

The single most dangerous asymmetry: `sensor`, `binary_sensor` and `switch`
state topics carry a bare string, while `light` carries a JSON object.
```

- [ ] **Step 2: Write `README.md`**

```markdown
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

## License

MIT
```

- [ ] **Step 3: Add the MIT `LICENSE` file**

Use the standard MIT text with `Copyright (c) 2026 Evgenij Cjura`.

- [ ] **Step 4: Add `.github/workflows/test-and-release.yml`**

```yaml
name: Test and release

on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20.x, 22.x]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run build
      - run: npm test
```

- [ ] **Step 5: Add the repository field to `package.json`**

```json
  "repository": { "type": "git", "url": "git+https://github.com/GalusPeres/ioBroker.hometiles.git" },
  "bugs": { "url": "https://github.com/GalusPeres/ioBroker.hometiles/issues" },
  "homepage": "https://github.com/GalusPeres/ioBroker.hometiles#readme",
```

Adjust the owner if this repository lives elsewhere.

- [ ] **Step 6: Verify the whole project one last time**

Run: `npm run lint && npm run build && npm test`
Expected: all green, no lint findings, every suite passing.

- [ ] **Step 7: Commit**

```bash
git add README.md LICENSE docs/protocol.md .github/ package.json io-package.json
git commit -m "docs: README, firmware protocol reference and CI workflow"
```

---

## Definition of Done

- `npm run lint && npm run build && npm test` is green.
- A stock HomeTiles panel pointed at the same broker announces itself, appears
  under `hometiles.0.panels.*`, and renders sensor, binary sensor, switch,
  light and scene tiles with live values.
- Pressing a switch or light tile on the panel changes the ioBroker state, and
  changing the ioBroker state updates the tile.
- Panel brightness and sleep settings are controllable from ioBroker and echo
  back with `ack: true`.
- Renaming a source object in ioBroker does not blank a configured tile.
- The firmware repository contains no changes whatsoever.

## Hardware Verification Still Required

The suite proves protocol correctness against the firmware's parser rules and
an in-process broker. It does **not** prove behaviour on a real panel. Before
calling v0.1 released, verify on hardware:

1. Announcement and configuration push against a real panel, including the
   Web Admin entity dropdowns being populated.
2. Slider interaction on a Light popup, including the final release value.
3. Retained state after a panel reboot with the adapter running.
4. Pairing a factory-fresh panel by IP.
5. Local relay and DS18B20 channels on a panel that has them.
