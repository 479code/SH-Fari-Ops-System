import { z } from "zod";
import {
  idSchema,
  isoDate,
  litresAmount,
  optionalIdQuery,
  optionalIsoDateQuery,
  optionalText,
  paginationQuery,
  requiredText,
} from "./common.ts";

export const dipSchema = z.object({
  tankId: idSchema,
  businessDate: isoDate,
  dipLitres: litresAmount("Physical dip reading", { allowZero: true }),
  note: optionalText(255),
});

export const adjustmentSchema = z.object({
  tankId: idSchema,
  businessDate: isoDate,
  quantity: litresAmount("Adjustment quantity", { signed: true }),
  reason: requiredText("Reason", 255),
});

export const movementQuery = z.object({
  stationId: idSchema,
  productId: idSchema,
  tankId: optionalIdQuery,
  date: optionalIsoDateQuery,
});

export const ledgerQuery = z.object({
  stationId: optionalIdQuery,
  productId: optionalIdQuery,
  tankId: optionalIdQuery,
  from: optionalIsoDateQuery,
  to: optionalIsoDateQuery,
  ...paginationQuery,
});

export const tanksQuery = z.object({ stationId: optionalIdQuery });

export const systemClosingQuery = z.object({ tankId: idSchema, date: optionalIsoDateQuery });
