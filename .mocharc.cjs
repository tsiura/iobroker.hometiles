'use strict';

// Node >= 22.6 (default-on since 23.6, later backported to 22.18) natively
// recognises `.ts` files. With no `type` field in package.json it sniffs
// `import`/`export` syntax to decide a file is an ES module. Mocha's loader
// always tries a dynamic `import()` before falling back to `require()`, so on
// those Node versions a CommonJS-authored test file (e.g. one that uses
// `__dirname`, as `tests.packageFiles`/`tests.integration` callers do) gets
// misloaded as ESM and crashes instead of taking the old, correct
// fallback-to-require path that `ts-node/register` handles.
//
// Disabling native type stripping restores that fallback: `.ts` again becomes
// an extension Node's own loader does not recognise, `import()` throws
// ERR_UNKNOWN_FILE_EXTENSION, and Mocha retries with `require()`.
//
// Guarded by Node's own flag registry (not a version-number guess) so this
// stays a no-op on the officially supported Node 20 line and any other build
// that has never heard of the flag.
const nodeOption = process.allowedNodeEnvironmentFlags.has('--no-strip-types')
  ? ['no-strip-types']
  : [];

module.exports = {
  require: ['ts-node/register'],
  spec: ['test/**/*.test.ts'],
  timeout: 10000,
  recursive: true,
  ...(nodeOption.length ? { 'node-option': nodeOption } : {}),
};
