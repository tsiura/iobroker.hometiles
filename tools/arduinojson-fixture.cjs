'use strict';

/*
 * Regenerates test/fixtures/arduinojson-golden.json, the ground truth that
 * test/protocol/arduinojson.test.ts holds src/protocol/arduinojson.ts to:
 * what the panel's ArduinoJson 7.4.3 itself makes of the numbers of an
 * editable value (Task 15). Not run in CI: it needs g++ and the library's
 * source. To regenerate, from the repository root:
 *
 *   ARDUINOJSON_SRC=<ArduinoJson>/src node tools/arduinojson-fixture.cjs
 *
 * ARDUINOJSON_SRC defaults to ~/Arduino/libraries/ArduinoJson/src, where
 * `arduino-cli lib install "ArduinoJson@7.4.3"` puts it (the version
 * HomeTiles .github/workflows/firmware.yml:96 pins). Any other version is
 * refused: the port follows 7.4.3 line by line, and a library bump means
 * reading the new source first.
 *
 * Candidates come from a fixed-seed generator, so a run on the same library
 * writes the same file. The fixture keeps the hand-picked edge cases; every
 * published number the float shortcut gets wrong -- Math.fround, a correctly
 * rounded float, where the library parses a float with arithmetic of its own
 * (review m4) -- and a spread of the rest; and a spread of the doubles that
 * 9 decimals for every print get wrong, and of the rest. Negative numbers
 * mirror positive ones, so only a sample of them is kept.
 */

const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { homedir, tmpdir } = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SOURCE = process.env.ARDUINOJSON_SRC || path.join(homedir(), 'Arduino/libraries/ArduinoJson/src');
const VERSION = '7.4.3';
const FIXTURE = path.join(ROOT, 'test/fixtures/arduinojson-golden.json');

// mulberry32: a fixed seed, the same candidates every run.
let seed = 0x5eed1507;
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const integer = (below) => Math.floor(random() * below);

/** Hand-picked published numbers: the edges of the float parse, of the exponent forms, of a float's range. */
const READ_EDGES = [
  8388607, 8388608, 0.8388607, 0.8388608, 1e-5, 1.5e-5, 0.00001234, 1e-7, 1e7, 9999999.5, 12345678.91,
  // Past a float's range, parsed as one: printed null, which strtod reads as 0.
  3.4e38, 3.5e38, 5e38, 1e39, 1e-38, 1e-39, 0.9999999996, 0.1234567894, 0.1234567896, 21.123456789,
  // The review's example of the float shortcut going wrong (m4), and the report's.
  0.30000000000000004, 1 / 3, 2 / 3, 0.08197082, 0.0819705, 0.001953125, 1234567.5, 16777218, 0.6630725,
].flatMap((number) => [number, -number]);

/** Hand-picked held doubles: the report's and the review's (m1). */
const PRINT_EDGES = [
  20000002, 10307966, 1000000.5, 999999.75, 12345.125, 16777216, 16777217, 16777218, 9999999.9999, 8833.3333245,
  0.001953125, 1e-5, 1.5e-5, 1e7, 0.9999999996, 21.123456789, 1234567.5,
].flatMap((number) => [number, -number]);

/** Every number, and the negation of every 50th. */
const withSomeNegatives = (numbers) => [...numbers, ...numbers.filter((_, index) => index % 50 === 0).map((number) => -number)];

/** Numbers published as min, max or step: the text is JSON.stringify's, as the adapter sends it. */
function readCandidates() {
  const numbers = [];
  // 7 significant digits fit a float's 23 bits: parsed as floats, where the
  // library's arithmetic and a correctly rounded float part.
  for (let i = 0; i < 20000; i++) numbers.push((1000000 + integer(7388608)) * 10 ** (integer(24) - 15));
  // Anything, 1 to 17 digits, 1e-15 to 1e15.
  for (let i = 0; i < 10000; i++) {
    const digits = 1 + integer(17);
    numbers.push(Math.floor(random() * 10 ** digits) * 10 ** (integer(31) - 15 - digits));
  }
  return withSomeNegatives(numbers);
}

/** Doubles the panel holds and sends: the text is JSON.stringify's, which reads back as the same double. */
function printCandidates() {
  const numbers = [];
  // Doubles a float holds exactly: kept as floats, printed with 6 decimals.
  for (let i = 0; i < 10000; i++) numbers.push(Math.fround(random() * 10 ** (integer(16) - 6)));
  // The panel's drafts, min + k * step printed %.15g (value_control.cpp:318, :462, :504).
  for (let i = 0; i < 10000; i++) {
    const step = Number((random() * 10 ** (integer(8) - 4)).toPrecision(1 + integer(9)));
    numbers.push(Number((integer(100000) * step).toPrecision(15)));
  }
  for (let i = 0; i < 5000; i++) numbers.push(random() * 10 ** (integer(24) - 12));
  return withSomeNegatives(numbers);
}

function probe(cases) {
  const work = mkdtempSync(path.join(tmpdir(), 'arduinojson-probe-'));
  try {
    const binary = path.join(work, 'probe');
    execFileSync('g++', ['-std=c++17', '-O1', '-I', SOURCE, path.join(__dirname, 'arduinojson-probe.cpp'), '-o', binary], { stdio: 'inherit' });
    const input = `${cases.map(([kind, text]) => `${kind} ${text}`).join('\n')}\n`;
    const [header, ...lines] = execFileSync(binary, { input, maxBuffer: 1 << 28 }).toString().trim().split('\n');
    if (header !== `version ${VERSION}`) throw new Error(`${SOURCE} is ArduinoJson ${header}, not ${VERSION}`);
    if (lines.length !== cases.length || lines.includes('ERR')) throw new Error('the probe did not answer every case');
    return lines.map((line) => line.split(' '));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Up to `count` items, evenly spread. */
const spread = (items, count) => items.filter((_, index) => index % Math.max(1, Math.floor(items.length / count)) === 0).slice(0, count);
const unique = (numbers) => [...new Set(numbers.filter(Number.isFinite).map((number) => JSON.stringify(number)))];
/** The number the panel's strtod reads from a printed text: null, a float past its range, is 0. */
const strtod = (text) => (text === 'null' ? 0 : Number(text));

const reads = unique([...READ_EDGES, ...readCandidates()]);
const prints = unique([...PRINT_EDGES, ...printCandidates()]);
const answers = probe([...reads.map((text) => ['r', text]), ...prints.map((text) => ['p', text])]);
const read = reads.map((text, index) => ({ text, library: answers[index][0], shortcut: answers[index][1] }));
const print = prints.map((text, index) => ({ text, library: answers[reads.length + index][0], nine: answers[reads.length + index][1] }));

// A shortcut is wrong where the number it gives differs, not the text.
const readEdges = read.slice(0, unique(READ_EDGES).length);
const readWrong = read.filter((entry) => !readEdges.includes(entry) && entry.shortcut !== '-' && strtod(entry.shortcut) !== strtod(entry.library));
const readRest = read.filter((entry) => !readEdges.includes(entry) && !readWrong.includes(entry));
const printEdges = print.slice(0, unique(PRINT_EDGES).length);
const printWrong = print.filter((entry) => !printEdges.includes(entry) && strtod(entry.nine) !== strtod(entry.library));
const printRest = print.filter((entry) => !printEdges.includes(entry) && !printWrong.includes(entry));

const fixture = {
  about:
    `What ArduinoJson ${VERSION} makes of numbers, printed by the library itself. Generated by ` +
    'tools/arduinojson-fixture.cjs from tools/arduinojson-probe.cpp; do not edit. read: [the JSON number the ' +
    "adapter publishes, the text the panel's finite_json reads it back as]. print: [the double the panel holds, " +
    'the text its command carries].',
  library: VERSION,
  read: [...readEdges, ...readWrong, ...spread(readRest, 150)].map(({ text, library }) => [text, library]),
  print: [...printEdges, ...spread(printWrong, 150), ...spread(printRest, 150)].map(({ text, library }) => [text, library]),
};
writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 0).replace(/\],\[/g, '],\n[')}\n`);
const size = readFileSync(FIXTURE).length;
process.stdout.write(
  `${path.relative(ROOT, FIXTURE)}: ${fixture.read.length} reads (${readEdges.length} edges, all ${readWrong.length} the float ` +
    `shortcut gets wrong, of ${read.length}), ${fixture.print.length} prints (${printEdges.length} edges, ` +
    `${Math.min(printWrong.length, 150)} of ${printWrong.length} 9 decimals get wrong, of ${print.length}), ${size} bytes\n`,
);
