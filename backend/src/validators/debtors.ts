import { z } from "zod";
import {
  idSchema,
  isoDate,
  moneyAmount,
  optionalEnumQuery,
  optionalIdQuery,
  optionalText,
  paginationQuery,
  rangeQuery,
  requiredText,
  searchQuery,
} from "./common.ts";

const optionalMoney = (label: string) =>
  z.preprocess((v) => (v === "" || v === undefined ? null : v), moneyAmount(label, { allowZero: true }).nullable());

export const debtorCreateSchema = z.object({
  stationId: idSchema,
  name: requiredText("Customer name", 160),
  phone: optionalText(30),
  creditLimit: optionalMoney("Credit limit").optional(),
  openingBalance: z.preprocess((v) => (v === "" || v === null || v === undefined ? 0 : v), moneyAmount("Opening balance", { allowZero: true })),
  openingDate: isoDate.optional(),
});

export const debtorUpdateSchema = z
  .object({
    name: requiredText("Customer name", 160).optional(),
    phone: optionalText(30),
    creditLimit: optionalMoney("Credit limit").optional(),
    status: z.enum(["active", "inactive"]).optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), "Nothing to update.");

export const debtorTransactionSchema = z
  .object({
    type: z.enum(["credit_sale", "repayment"]),
    amount: moneyAmount("Amount"),
    businessDate: isoDate.optional(),
    reference: optionalText(60),
    paymentMethod: z.enum(["cash", "transfer", "pos"]).optional(),
    note: optionalText(255),
  })
  .superRefine((d, ctx) => {
    if (d.type === "repayment" && !d.paymentMethod) {
      ctx.addIssue({ code: "custom", path: ["paymentMethod"], message: "Select how the repayment was made." });
    }
  });

export const debtorListQuery = z.object({
  search: searchQuery,
  stationId: optionalIdQuery,
  status: optionalEnumQuery(["active", "inactive"] as const),
  hasBalance: z.preprocess((v) => v === "true" || v === "1" || v === true, z.boolean()),
  sortBy: z.enum(["name", "balance", "closing"]).default("balance"),
  ...rangeQuery,
  ...paginationQuery,
});

export const debtorSummaryQuery = z.object({ stationId: optionalIdQuery });
