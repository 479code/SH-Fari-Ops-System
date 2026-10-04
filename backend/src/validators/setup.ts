import { z } from "zod";
import { ALL_PERMISSIONS } from "../auth/permissions.ts";
import { passwordPolicy } from "./auth.ts";
import {
  idSchema,
  isoDate,
  litresAmount,
  moneyAmount,
  optionalEnumQuery,
  optionalIdQuery,
  optionalText,
  paginationQuery,
  requiredText,
  searchQuery,
  unitPriceAmount,
} from "./common.ts";

const status = z.enum(["active", "inactive"]);
const code = (label: string) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,10}$/, `${label} must be 2–10 letters or digits.`);

const nullableMoney = (label: string) =>
  z.preprocess((v) => (v === "" || v === undefined ? null : v), moneyAmount(label, { allowZero: true }).nullable());
const nullableLitres = (label: string) =>
  z.preprocess((v) => (v === "" || v === undefined ? null : v), litresAmount(label).nullable());
const zeroDefault = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" || v === null || v === undefined ? 0 : v), schema);

const atLeastOne = (d: Record<string, unknown>) => Object.values(d).some((v) => v !== undefined);

/* Stations, tanks, pumps ---------------------------------------------------- */

export const stationCreateSchema = z.object({
  code: code("Station code"),
  name: requiredText("Station name", 120),
  address: optionalText(255),
  managerUserId: idSchema.nullable().optional(),
  cashTolerance: zeroDefault(moneyAmount("Cash tolerance", { allowZero: true })),
  stockTolerance: zeroDefault(litresAmount("Stock tolerance", { allowZero: true })),
});

export const stationUpdateSchema = z
  .object({
    name: requiredText("Station name", 120).optional(),
    address: optionalText(255),
    managerUserId: idSchema.nullable().optional(),
    cashTolerance: moneyAmount("Cash tolerance", { allowZero: true }).optional(),
    stockTolerance: litresAmount("Stock tolerance", { allowZero: true }).optional(),
    status: status.optional(),
  })
  .refine(atLeastOne, "Nothing to update.");

export const tankCreateSchema = z.object({
  productId: idSchema,
  name: requiredText("Tank name", 60),
  capacity: nullableLitres("Capacity").optional(),
  openingStock: zeroDefault(litresAmount("Opening stock", { allowZero: true })),
  openingDate: isoDate.optional(),
});

export const tankUpdateSchema = z
  .object({ name: requiredText("Tank name", 60).optional(), capacity: nullableLitres("Capacity").optional(), status: status.optional() })
  .refine(atLeastOne, "Nothing to update.");

export const pumpCreateSchema = z.object({
  tankId: idSchema,
  name: requiredText("Pump name", 60),
  meterLabel: optionalText(40),
  initialReading: zeroDefault(litresAmount("Initial meter reading", { allowZero: true })),
});

export const pumpUpdateSchema = z
  .object({
    tankId: idSchema.optional(),
    name: requiredText("Pump name", 60).optional(),
    meterLabel: optionalText(40),
    initialReading: litresAmount("Initial meter reading", { allowZero: true }).optional(),
    status: status.optional(),
  })
  .refine(atLeastOne, "Nothing to update.");

/* Products, prices, narrations, banks -------------------------------------- */

export const productCreateSchema = z.object({
  code: code("Product code"),
  name: requiredText("Product name", 60),
  price: unitPriceAmount("Pump price").optional(),
  effectiveFrom: isoDate.optional(),
});

export const productUpdateSchema = z
  .object({ name: requiredText("Product name", 60).optional(), status: status.optional() })
  .refine(atLeastOne, "Nothing to update.");

export const priceCreateSchema = z.object({
  stationId: idSchema.nullable().optional(),
  price: unitPriceAmount("Pump price"),
  effectiveFrom: isoDate,
});

export const narrationCreateSchema = z.object({
  name: requiredText("Narration", 80),
  approvalThreshold: nullableMoney("Approval threshold").optional(),
});

export const narrationUpdateSchema = z
  .object({ name: requiredText("Narration", 80).optional(), approvalThreshold: nullableMoney("Approval threshold").optional(), status: status.optional() })
  .refine(atLeastOne, "Nothing to update.");

export const bankCreateSchema = z.object({ name: requiredText("Bank name", 80) });
export const bankUpdateSchema = z
  .object({ name: requiredText("Bank name", 80).optional(), status: status.optional() })
  .refine(atLeastOne, "Nothing to update.");

/* Users & roles --------------------------------------------------------------- */

const email = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : typeof v === "string" ? v.trim().toLowerCase() : v),
  z.email("Enter a valid email address.").max(190).nullable(),
);

export const userCreateSchema = z.object({
  username: z
    .string({ error: "Username is required." })
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._-]{3,60}$/, "Username must be 3–60 characters: letters, numbers, dot, dash or underscore."),
  fullName: requiredText("Full name", 120),
  email: email.optional(),
  phone: optionalText(30),
  stationId: idSchema.nullable().optional(),
  roleIds: z.array(idSchema).min(1, "Assign at least one role.").max(10),
  password: passwordPolicy,
});

export const userUpdateSchema = z
  .object({
    fullName: requiredText("Full name", 120).optional(),
    email: email.optional(),
    phone: optionalText(30),
    stationId: idSchema.nullable().optional(),
    roleIds: z.array(idSchema).min(1, "Assign at least one role.").max(10).optional(),
    status: z.enum(["active", "suspended"]).optional(),
  })
  .refine(atLeastOne, "Nothing to update.");

export const userListQuery = z.object({
  search: searchQuery,
  stationId: optionalIdQuery,
  roleId: optionalIdQuery,
  status: optionalEnumQuery(["active", "suspended"] as const),
  ...paginationQuery,
});

const permissionCodes = z
  .array(z.string())
  .max(200)
  .refine((codes) => codes.every((c) => (ALL_PERMISSIONS as string[]).includes(c)), "Contains an unknown permission.");

export const roleCreateSchema = z.object({
  name: requiredText("Role name", 80),
  description: optionalText(255),
  permissions: permissionCodes,
});

export const roleUpdateSchema = z
  .object({ name: requiredText("Role name", 80).optional(), description: optionalText(255), permissions: permissionCodes.optional() })
  .refine(atLeastOne, "Nothing to update.");
