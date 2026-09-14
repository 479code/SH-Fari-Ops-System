/**
 * dates.ts — business-date arithmetic.
 *
 * A business date is a calendar day at a station ('YYYY-MM-DD'), evaluated in
 * BUSINESS_TIMEZONE. It is stored in DATE columns and handled as a string end to
 * end so no timezone conversion can shift a DSR onto the wrong day. Instants
 * (created_at, verified_at) are DATETIME in UTC.
 */
import { env } from "../config/env.ts";
import { AppError } from "./errors.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function isIsoMonth(value: string): boolean {
  return ISO_MONTH.test(value) && isIsoDate(`${value}-01`);
}

/** Today's business date in the configured zone. */
export function today(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: env.BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function currentMonth(now: Date = new Date()): string {
  return today(now).slice(0, 7);
}

function toUtc(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function addDays(date: string, days: number): string {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const from = `${month}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from, to: `${month}-${String(last).padStart(2, "0")}` };
}

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** Monday of the ISO week containing `date`. */
export function startOfWeek(date: string): string {
  const d = toUtc(date);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return addDays(date, -dow);
}

/**
 * Resolves list/report date filters: explicit from/to wins, otherwise a month
 * (default: the current month).
 */
export function resolveRange(q: { month?: string; from?: string; to?: string }, maxDays = 400): { from: string; to: string } {
  if (q.from || q.to) {
    const to = q.to ?? today();
    const from = q.from ?? monthBounds(to.slice(0, 7)).from;
    if (from > to) {
      throw new AppError("VALIDATION_ERROR", "'From' date must be on or before 'to' date.", { fields: { from: "Must be on or before the 'to' date." } });
    }
    if (daysBetween(from, to) > maxDays) {
      throw new AppError("VALIDATION_ERROR", `Date range cannot exceed ${maxDays} days.`, { fields: { from: `Range cannot exceed ${maxDays} days.` } });
    }
    return { from, to };
  }
  return monthBounds(q.month ?? currentMonth());
}

export function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

/**
 * Converts a wall-clock date + 'HH:MM' in the business zone to a UTC instant.
 * Two passes of offset correction handle zones with DST transitions.
 */
export function businessInstant(date: string, time: string): Date {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: env.BUSINESS_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    guess += wanted - shown;
  }
  return new Date(guess);
}

/** Converts a UTC instant to 'HH:MM' in the business zone. */
export function businessTime(instant: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: env.BUSINESS_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(instant);
}
