import { z } from "zod";
import {
  documentRef,
  idSchema,
  isoDate,
  litresAmount,
  optionalEnumQuery,
  optionalIdQuery,
  paginationQuery,
  plateSchema,
  rangeQuery,
  searchQuery,
  unitPriceAmount,
} from "./common.ts";

export const RECEIPT_STATUSES = ["received", "verified", "disputed", "cancelled"] as const;

export const receiptCreateSchema = z.object({
  stationId: idSchema,
  productId: idSchema,
  tankId: idSchema.nullable().optional(),
  quantity: litresAmount("Quantity"),
  orderPrice: unitPriceAmount("Order price"),
  landingPrice: unitPriceAmount("Landing price"),
  waybillRef: documentRef("Waybill reference"),
  truckPlate: plateSchema,
  gitDeliveryId: idSchema.nullable().optional(),
  businessDate: isoDate.optional(),
});

export const receiptListQuery = z.object({
  ...rangeQuery,
  stationId: optionalIdQuery,
  productId: optionalIdQuery,
  status: optionalEnumQuery(RECEIPT_STATUSES),
  search: searchQuery,
  sortBy: z.enum(["businessDate", "quantity", "createdAt"]).default("businessDate"),
  ...paginationQuery,
});
