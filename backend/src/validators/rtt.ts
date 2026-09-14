import { z } from "zod";
import {
  idSchema,
  isoDate,
  litresAmount,
  optionalEnumQuery,
  optionalIdQuery,
  paginationQuery,
  rangeQuery,
  requiredText,
} from "./common.ts";

export const rttCreateSchema = z.object({
  stationId: idSchema,
  pumpId: idSchema,
  productId: idSchema.optional(),
  quantity: litresAmount("Quantity"),
  reason: requiredText("Reason", 255),
  businessDate: isoDate.optional(),
});

export const rttListQuery = z.object({
  ...rangeQuery,
  stationId: optionalIdQuery,
  pumpId: optionalIdQuery,
  productId: optionalIdQuery,
  status: optionalEnumQuery(["active", "cancelled"] as const),
  ...paginationQuery,
});
