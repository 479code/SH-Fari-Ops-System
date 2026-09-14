/** Reusable Zod building blocks shared by every module's validators. */
import { z } from "zod";
import { isIsoDate, isIsoMonth } from "../utils/dates.ts";

export const idSchema = z.coerce
  .number({ error: "Must be a valid id." })
  .int("Must be a valid id.")
  .positive("Must be a valid id.")
  .max(4_294_967_295, "Must be a valid id.");

/** Optional id filter from a query string; "" and "all" mean no filter. */
export const optionalIdQuery = z.preprocess(
  (v) => (v === "" || v === "all" || v === undefined || v === null ? undefined : v),
  idSchema.optional(),
);

export const isoDate = z.string({ error: "Date is required." }).refine(isIsoDate, "Must be a valid date (YYYY-MM-DD).");
export const optionalIsoDateQuery = z.preprocess((v) => (v === "" ? undefined : v), isoDate.optional());
export const isoMonth = z.string().refine(isIsoMonth, "Must be a valid month (YYYY-MM).");
export const optionalMonthQuery = z.preprocess((v) => (v === "" ? undefined : v), isoMonth.optional());

const trimmed = (max: number) => z.string().trim().max(max, `Must be at most ${max} characters.`);

export const requiredText = (label: string, max = 255) =>
  trimmed(max).min(1, `${label} is required.`);

/** Optional free text: blank becomes null so it is stored as NULL, not ''. */
export const optionalText = (max = 255) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), trimmed(max).nullable().optional());

/** Accepts numbers or numeric strings with thousands separators / ₦ / L suffixes typed into inputs. */
const numeric = z.preprocess((v) => {
  if (typeof v === "string") {
    const cleaned = v.replace(/[₦,\s]/g, "").replace(/L$/i, "");
    return cleaned === "" ? undefined : Number(cleaned);
  }
  return v;
}, z.number({ error: "Must be a number." }).finite("Must be a number."));

const decimals = (dp: number) => (v: number) => Math.abs(Math.round(v * 10 ** dp) - v * 10 ** dp) < 1e-6;

export const moneyAmount = (label = "Amount", { allowZero = false } = {}) =>
  numeric
    .pipe(z.number())
    .refine((v) => (allowZero ? v >= 0 : v > 0), `${label} must be ${allowZero ? "zero or more" : "greater than zero"}.`)
    .refine((v) => v <= 99_999_999_999_999, `${label} is too large.`)
    .refine(decimals(2), `${label} can have at most 2 decimal places.`);

export const litresAmount = (label = "Quantity", { allowZero = false, signed = false } = {}) =>
  numeric
    .pipe(z.number())
    .refine((v) => signed || (allowZero ? v >= 0 : v > 0), `${label} must be ${allowZero ? "zero or more" : "greater than zero"}.`)
    .refine((v) => (signed ? v !== 0 : true), `${label} cannot be zero.`)
    .refine((v) => Math.abs(v) <= 999_999_999_999, `${label} is too large.`)
    .refine(decimals(2), `${label} can have at most 2 decimal places.`);

export const unitPriceAmount = (label = "Price") =>
  numeric
    .pipe(z.number())
    .refine((v) => v > 0, `${label} must be greater than zero.`)
    .refine((v) => v <= 9_999_999_999, `${label} is too large.`)
    .refine(decimals(2), `${label} can have at most 2 decimal places.`);

export const paginationQuery = {
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
};

export const searchQuery = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().trim().max(100).optional(),
);

export const reasonSchema = z.object({ reason: requiredText("Reason", 255) });

/** Enum filter from a query string; "" and "all" mean no filter. */
export const optionalEnumQuery = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (v === "" || v === "all" ? undefined : v), z.enum(values).optional());

/** Normalises "ngr 201 kj" → "NGR-201-KJ". */
export const plateSchema = z
  .string({ error: "Truck plate is required." })
  .trim()
  .min(1, "Truck plate is required.")
  .transform((v) => v.toUpperCase().replace(/\s+/g, "-"))
  .pipe(z.string().regex(/^[A-Z0-9-]{3,20}$/, "Enter a valid truck plate, e.g. NGR-201-KJ."));

export const optionalPlate = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  plateSchema.nullable().optional(),
);

/** Upper-cased document reference (waybill, teller slip). */
export const documentRef = (label: string) =>
  requiredText(label, 60)
    .transform((v) => v.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9/._-]*$/, `${label} may contain only letters, numbers and - / . _`));

export const rangeQuery = {
  month: optionalMonthQuery,
  from: optionalIsoDateQuery,
  to: optionalIsoDateQuery,
};

export const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour time, e.g. 14:30.");
