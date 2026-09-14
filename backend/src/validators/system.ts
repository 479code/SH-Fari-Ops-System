import { z } from "zod";
import { EXCEPTION_TYPES } from "../db/schema/index.ts";
import {
  optionalEnumQuery,
  optionalIdQuery,
  optionalIsoDateQuery,
  optionalMonthQuery,
  paginationQuery,
  rangeQuery,
  requiredText,
  searchQuery,
} from "./common.ts";

const optionalString = (max: number) =>
  z.preprocess((v) => (v === "" || v === "all" ? undefined : v), z.string().trim().max(max).optional());

export const exceptionListQuery = z.object({
  status: optionalEnumQuery(["open", "reviewed", "closed", "active"] as const),
  type: optionalEnumQuery(EXCEPTION_TYPES),
  stationId: optionalIdQuery,
  ...paginationQuery,
});

export const exceptionReviewSchema = z.object({ comment: requiredText("Comment", 500) });
export const exceptionCloseSchema = z.object({ resolution: requiredText("Resolution", 500) });

export const auditListQuery = z.object({
  action: optionalString(40),
  resource: optionalString(40),
  userId: optionalIdQuery,
  search: searchQuery,
  from: optionalIsoDateQuery,
  to: optionalIsoDateQuery,
  ...paginationQuery,
});

export const dashboardQuery = z.object({ stationId: optionalIdQuery });
export const comparisonQuery = z.object({ month: optionalMonthQuery });

export const globalSearchQuery = z.object({
  q: z.string({ error: "Enter something to search for." }).trim().min(2, "Enter at least 2 characters.").max(60),
});

export const reportQuery = z.object({
  ...rangeQuery,
  date: optionalIsoDateQuery,
  stationId: optionalIdQuery,
  productId: optionalIdQuery,
  pumpId: optionalIdQuery,
  bankId: optionalIdQuery,
  narrationId: optionalIdQuery,
  userId: optionalIdQuery,
  status: optionalString(30),
  action: optionalString(40),
  search: searchQuery,
  format: z.enum(["json", "csv"]).default("json"),
});
