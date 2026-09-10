/**
 * Rounding helpers.
 *
 * Python's `round()` is half-to-even, and on floats it rounds the binary
 * representation rather than the decimal you typed (round(2.675, 2) is 2.67).
 * Reproducing that exactly would mean reimplementing CPython's float repr, for
 * a case that float noise makes vanishingly rare in this data: the inputs are
 * quotients and differences of market values, so exact ties essentially never
 * occur.
 *
 * These round half away from zero instead. The parity diff against the Python
 * collector is what would surface a real discrepancy.
 */

/** Round to `digits` decimal places, half away from zero. */
export function round(x: number, digits = 0): number {
  const f = 10 ** digits;
  return (Math.sign(x) * Math.round(Math.abs(x) * f)) / f;
}

export const round2 = (x: number): number => round(x, 2);
export const round4 = (x: number): number => round(x, 4);
