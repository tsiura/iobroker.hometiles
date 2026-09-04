# ioBroker.hometiles

Connects [HomeTiles](https://github.com/GalusPeres/HomeTiles) ESP32-P4/S3 touch
panels to ioBroker over MQTT.

## Status

Version `0.1.0` is an early scaffold: project setup, build/test/lint harness,
and the typed adapter options module. Protocol handling, the state registry,
and the adapter runtime are not implemented yet.

## Development

```bash
npm install
npm run build   # compile TypeScript to build/
npm test        # run the mocha test suite
npm run lint    # run eslint
npm run check   # lint + build + test
```

## Configuration defaults

| Option           | Default            |
| ----------------- | ------------------ |
| `brokerHost`       | `127.0.0.1`         |
| `brokerPort`       | `1883`               |
| `baseTopic`        | `hometiles`          |
| `haPrefix`          | `ha/statestream`      |
| `coalesceMs`        | `200`                 |
| `maxPublishQueue`   | `2000`                |

## License

MIT © Evgenij Cjura
