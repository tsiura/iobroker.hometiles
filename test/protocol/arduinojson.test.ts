import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readByPanel, sentByPanel } from '../../src/protocol/arduinojson';

/*
 * The panel's JSON library, ArduinoJson 7.4.3 (HomeTiles
 * .github/workflows/firmware.yml:96), as it handles the numbers of an
 * editable value (Task 15). Every expected value below is what the library
 * itself printed, compiled from its own headers and fed the same text: the
 * two tables by hand, the fixture by tools/arduinojson-fixture.cjs, which
 * runs tools/arduinojson-probe.cpp (see there to regenerate it).
 */

interface Golden {
  library: string;
  read: Array<[string, string]>;
  print: Array<[string, string]>;
}
const GOLDEN = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/arduinojson-golden.json'), 'utf8')) as Golden;
/** The number the panel's strtod reads from a text the library printed: a float past its range prints null, read as 0. */
const strtod = (text: string): number => (text === 'null' ? 0 : Number(text));

describe('protocol/arduinojson', () => {
  it('is the library the port follows, and the fixture says what it made of each number', () => {
    expect(GOLDEN.library).to.equal('7.4.3');
    expect(GOLDEN.read.length).to.be.above(400);
    expect(GOLDEN.print.length).to.be.above(200);
  });

  it('reads every published number of the fixture as the library does, the ones a correctly rounded float gets wrong among them (review m4)', () => {
    const wrong = GOLDEN.read.filter(([published, read]) => readByPanel(Number(published)) !== strtod(read));
    expect(wrong, JSON.stringify(wrong.slice(0, 5))).to.deep.equal([]);
  });

  it('prints every held double of the fixture as the library does', () => {
    const wrong = GOLDEN.print.filter(([held, sent]) => sentByPanel(Number(held)) !== Number(sent));
    expect(wrong, JSON.stringify(wrong.slice(0, 5))).to.deep.equal([]);
  });

  it("reads a published min, max or step as finite_json does: a float's 6 decimals, a double's 9 (value_control.cpp:28-34)", () => {
    const cases: Array<[number, number]> = [
      // Integers are integers.
      [15, 15],
      [28, 28],
      [16777218, 16777218],
      // Up to 23 bits of digits: parsed as a float, printed with 6 decimals.
      [0.5, 0.5],
      [0.1, 0.1],
      [0.08197082, 0.081971],
      [-0.08197082, -0.081971],
      [0.0819705, 0.08197],
      [0.001953125, 0.001953],
      [0.1234567, 0.123457],
      [0.00001234, 0.000012],
      [1e-7, 1e-7],
      // More digits: a double, 9 decimals, fewer as the integral part grows.
      [0.1234567896, 0.12345679],
      [0.1234567894, 0.123456789],
      [0.9999999996, 1],
      [21.123456789, 21.12345679],
      [0.3333333333333333, 0.333333333],
      [0.30000000000000004, 0.3],
      [12345678.91, 12345678.91],
      [8833.3333245, 8833.333325],
      // A double a float holds exactly is kept as a float: 6 decimals again.
      [1234567.5, 1234568],
    ];
    for (const [published, read] of cases) expect(readByPanel(published), String(published)).to.equal(read);
  });

  it('prints the value of a command as the panel does: a double with 9 decimals, one a float holds with 6 (:306)', () => {
    const cases: Array<[number, number]> = [
      [15, 15],
      [21.5, 21.5],
      [0.1, 0.1],
      [0.3, 0.3],
      [0.08197082, 0.08197082],
      [0.0819705, 0.0819705],
      [0.1234567, 0.1234567],
      [0.9999999996, 1],
      [21.123456789, 21.12345679],
      // Just below the midpoint in binary, where the read above rounds up from the text.
      [8833.3333245, 8833.333324],
      // Held exactly by a float: 0.001953125 is 2^-9.
      [0.001953125, 0.001953],
      [1234567.5, 1234568],
      [16777218, 16777220],
    ];
    for (const [held, sent] of cases) expect(sentByPanel(held), String(held)).to.equal(sent);
  });
});
