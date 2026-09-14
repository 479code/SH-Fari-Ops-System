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

export const EXPENSE_STATUSES = ["pending", "approved", "rejected", "cancelled"] as const;

export const expenseCreateSchema = z.object({
  stationId: idSchema,
  /** Narration must come from the controlled list — free text is not accepted. */
  narrationId: idSchema,
  amount: moneyAmount("Amount"),
  payee: requiredText("Payee", 120),
  businessDate: isoDate.optional(),
  reference: optionalText(60),
  note: optionalText(255),
  paymentMethod: z.enum(["cash", "transfer"]).default("cash"),
});

export const expenseListQuery = z.object({
  ...rangeQuery,
  stationId: optionalIdQuery,
  narrationId: optionalIdQuery,
  status: optionalEnumQuery(EXPENSE_STATUSES),
  search: searchQuery,
  ...paginationQuery,
});

export const approveSchema = z.object({ note: optionalText(255) });
