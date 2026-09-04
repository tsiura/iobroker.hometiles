import { tests } from '@iobroker/testing';
import path from 'node:path';

// Validates package.json against io-package.json: name, version, licence,
// native/instanceObjects shape, and the adapter naming rules.
tests.packageFiles(path.join(__dirname, '..'));
