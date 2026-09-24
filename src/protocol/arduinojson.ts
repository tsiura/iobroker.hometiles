/**
 * The numbers of an editable value as the panel's JSON library handles them:
 * ArduinoJson 7.4.3 (HomeTiles .github/workflows/firmware.yml:96), ported line
 * by line and checked against the library itself on 180,000 numbers
 * (task-15-report.md). A value command is checked against the range and step
 * the panel works with, which are not always the ones published (Task 15,
 * Task 14 O4):
 *
 * - A decimal whose digits fit 23 bits and whose exponent fits a float is
 *   parsed as a float (parseNumber.hpp:217-229), a double a float holds
 *   exactly is kept as one (VariantImpl.hpp:73-98), and a float is printed
 *   with 6 decimals, a double with 9, fewer as the integral part grows
 *   (TextFormatter.hpp:67-104, FloatParts.hpp:56-93).
 * - finite_json reads min, max and step back through that print
 *   (value_control.cpp:28-34): a step of 0.08197082 is 0.081971 on the panel.
 * - A command's value is a double, printed the same way (value_control.cpp:306):
 *   1234567.5, which a float holds, goes out as 1234568.
 */

/** FloatTraits.hpp: the binary powers of ten, 1e1 to 1e256, and their inverses. */
const TEN = [1e1, 1e2, 1e4, 1e8, 1e16, 1e32, 1e64, 1e128, 1e256];
const TENTH = [1e-1, 1e-2, 1e-4, 1e-8, 1e-16, 1e-32, 1e-64, 1e-128, 1e-256];
/** A float has the first six, each the float nearest (FloatTraits.hpp:110-150). */
const FLOAT_TEN = TEN.slice(0, 6).map((power) => Math.fround(power));
const FLOAT_TENTH = TENTH.slice(0, 6).map((power) => Math.fround(power));

const U64_MAX = 2n ** 64n - 1n;
const DOUBLE_MANTISSA_MAX = 2n ** 52n - 1n;
const FLOAT_MANTISSA_MAX = 2n ** 23n - 1n;
const FLOAT_EXPONENT_MAX = 38;

/** make_float (FloatTraits.hpp:199-217): the mantissa times powers of ten, rounded to the type at each step. */
function makeFloat(mantissa: number, exponent: number, float: boolean): number {
  const powers = float ? (exponent > 0 ? FLOAT_TEN : FLOAT_TENTH) : exponent > 0 ? TEN : TENTH;
  let value = mantissa;
  for (let rest = Math.abs(exponent), index = 0; rest !== 0; index++, rest >>= 1) {
    const power = powers[index];
    if (power === undefined) return Number.NaN;
    if (rest & 1) value = float ? Math.fround(value * power) : value * power;
  }
  return value;
}

/**
 * The number a JSON text becomes (parseNumber.hpp:104-230), and how it is
 * printed again: an integer as it is, a float with 6 decimals, a double with
 * 9 (JsonDeserializer.hpp:520-545, VariantImpl.hpp:73-98).
 */
function parse(text: string): { value: number; decimals: 0 | 6 | 9 } {
  let at = 0;
  const negative = text[at] === '-';
  if (negative) at++;
  const digit = (): number | undefined => {
    const code = text.charCodeAt(at) - 48;
    return code >= 0 && code <= 9 ? code : undefined;
  };
  let mantissa = 0n;
  let offset = 0;
  for (let d = digit(); d !== undefined; d = digit()) {
    if (mantissa > U64_MAX / 10n) break;
    mantissa *= 10n;
    if (mantissa > U64_MAX - BigInt(d)) break;
    mantissa += BigInt(d);
    at++;
  }
  if (at === text.length && (!negative || mantissa <= 2n ** 63n)) {
    return { value: Number(negative ? -mantissa : mantissa), decimals: 0 };
  }
  while (mantissa > DOUBLE_MANTISSA_MAX) {
    mantissa /= 10n;
    offset++;
  }
  for (; digit() !== undefined; at++) offset++;
  if (text[at] === '.') {
    for (at++; digit() !== undefined; at++) {
      if (mantissa < DOUBLE_MANTISSA_MAX / 10n) {
        mantissa = mantissa * 10n + BigInt(digit()!);
        offset--;
      }
    }
  }
  let exponent = 0;
  if (text[at] === 'e' || text[at] === 'E') {
    at++;
    const below = text[at] === '-';
    if (below || text[at] === '+') at++;
    for (let d = digit(); d !== undefined; at++, d = digit()) {
      exponent = exponent * 10 + d;
      // Out of a double's range: zero, or an infinity printed as null.
      if (exponent + offset > 308) return { value: below ? 0 : Infinity, decimals: 6 };
    }
    if (below) exponent = -exponent;
  }
  exponent += offset;
  const double = exponent < -FLOAT_EXPONENT_MAX || exponent > FLOAT_EXPONENT_MAX || mantissa > FLOAT_MANTISSA_MAX;
  const magnitude = double ? makeFloat(Number(mantissa), exponent, false) : makeFloat(Math.fround(Number(mantissa)), exponent, true);
  const value = negative ? -magnitude : magnitude;
  return { value, decimals: !double || Math.fround(value) === value ? 6 : 9 };
}

/** writeFloat and decomposeFloat (TextFormatter.hpp:67-104, FloatParts.hpp:21-93), in double as the library computes. */
function print(number: number, places: 6 | 9): string {
  // ARDUINOJSON_ENABLE_NAN and _INFINITY are off by default (Configuration.hpp).
  if (!Number.isFinite(number)) return 'null';
  let value = Math.abs(number);
  const sign = number < 0 ? '-' : '';
  let exponent = 0;
  if (value >= 1e7) {
    for (let index = 8, bit = 256; index >= 0; index--, bit >>= 1) {
      if (value >= TEN[index]!) {
        value *= TENTH[index]!;
        exponent += bit;
      }
    }
  }
  if (value > 0 && value <= 1e-5) {
    for (let index = 8, bit = 256; index >= 0; index--, bit >>= 1) {
      if (value < TENTH[index]! * 10) {
        value *= TEN[index]!;
        exponent -= bit;
      }
    }
  }
  let most = 10 ** places;
  let decimals: number = places;
  let integral = Math.trunc(value);
  for (let rest = integral; rest >= 10; rest = Math.trunc(rest / 10)) {
    most /= 10;
    decimals--;
  }
  let remainder = (value - integral) * most;
  let decimal = Math.trunc(remainder);
  remainder -= decimal;
  decimal += Math.trunc(remainder * 2);
  if (decimal >= most) {
    decimal = 0;
    integral++;
    if (exponent && integral >= 10) {
      exponent++;
      integral = 1;
    }
  }
  while (decimal % 10 === 0 && decimals > 0) {
    decimal /= 10;
    decimals--;
  }
  const fraction = decimals > 0 ? `.${String(decimal).padStart(decimals, '0')}` : '';
  return `${sign}${integral}${fraction}${exponent ? `e${exponent}` : ''}`;
}

/** The number the panel works with for one we publish: finite_json's re-read (value_control.cpp:28-34). */
export function readByPanel(published: number): number {
  const { value, decimals } = parse(JSON.stringify(published));
  return decimals === 0 ? value : Number(print(value, decimals));
}

/** The number a command carries for a double the panel holds (value_control.cpp:306), as JSON.parse reads it. */
export function sentByPanel(held: number): number {
  return Number(print(held, Math.fround(held) === held ? 6 : 9));
}
