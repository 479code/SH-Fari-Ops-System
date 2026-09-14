/**
 * numbers.ts — rounding for money and litres.
 *
 * Quantities are stored as DECIMAL in MariaDB and aggregated there. JS doubles
 * are only used for per-row arithmetic (litres × price), and every such result
 * is rounded to the column scale before it is stored or compared.
 */

export function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round((value + Number.EPSILON * Math.sign(value)) * f) / f;
}

/** Money: naira and kobo. */
export const money = (value: number) => round(value, 2);

/** Volumes and meter readings. */
export const litres = (value: number) => round(value, 2);

/** Coerces a nullable SQL aggregate (SUM over zero rows is NULL) to a number. */
export function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}
