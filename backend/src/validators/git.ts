import { z } from "zod";
import { GIT_STATUSES } from "../db/schema/index.ts";
import { litres } from "../utils/numbers.ts";
import {
  idSchema,
  isoDate,
  litresAmount,
  optionalEnumQuery,
  optionalIdQuery,
  optionalPlate,
  optionalText,
  paginationQuery,
  rangeQuery,
  requiredText,
  searchQuery,
  unitPriceAmount,
} from "./common.ts";

const destination = z.object({
  stationId: idSchema,
  quantity: litresAmount("Destination quantity").optional(),
});

function checkDestinations(
  d: { destinations: { stationId: number; quantity?: number }[]; isMultiDelivery: boolean; quantity: number },
  ctx: z.RefinementCtx,
) {
  const ids = d.destinations.map((x) => x.stationId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", path: ["destinations"], message: "Each destination station can appear only once." });
  }
  if (!d.isMultiDelivery && d.destinations.length !== 1) {
    ctx.addIssue({ code: "custom", path: ["destinations"], message: "A single-delivery order has exactly one destination." });
  }
  if (d.isMultiDelivery) {
    if (d.destinations.length < 2) {
      ctx.addIssue({ code: "custom", path: ["destinations"], message: "A multi-delivery order needs at least two destinations." });
    }
    if (d.destinations.some((x) => x.quantity === undefined)) {
      ctx.addIssue({ code: "custom", path: ["destinations"], message: "Enter a quantity for every destination." });
    } else {
      const sum = litres(d.destinations.reduce((s, x) => s + (x.quantity ?? 0), 0));
      if (sum !== litres(d.quantity)) {
        ctx.addIssue({
          code: "custom",
          path: ["destinations"],
          message: `Destination quantities (${sum.toLocaleString("en-NG")} L) must add up to the order quantity (${d.quantity.toLocaleString("en-NG")} L).`,
        });
      }
    }
  }
}

export const gitCreateSchema = z
  .object({
    productId: idSchema,
    quantity: litresAmount("Quantity"),
    orderPrice: unitPriceAmount("Order price"),
    truckPlate: optionalPlate,
    source: optionalText(120),
    orderDate: isoDate.optional(),
    expectedArrivalDate: isoDate.nullable().optional(),
    notes: optionalText(255),
    isMultiDelivery: z.boolean().default(false),
    destinations: z.array(destination).min(1, "Add a destination station.").max(20),
  })
  .superRefine(checkDestinations);

export const gitUpdateSchema = z
  .object({
    truckPlate: optionalPlate,
    expectedArrivalDate: isoDate.nullable().optional(),
    source: optionalText(120),
    notes: optionalText(255),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), "Nothing to update.");

export const gitStatusSchema = z.object({
  status: z.enum(["truck_assigned", "in_transit", "arrived", "discharging", "completed", "cancelled"]),
  note: optionalText(255),
});

export const gitDeliveriesSchema = z.object({
  destinations: z.array(destination).min(1).max(20),
});

export const gitExceptionSchema = z.object({
  type: z.enum(["shortage", "delay", "price", "other"]),
  note: requiredText("Note", 255),
});

export const gitResolveSchema = z.object({ note: requiredText("Resolution", 255) });

export const gitListQuery = z.object({
  status: optionalEnumQuery([...GIT_STATUSES, "open", "exception"] as const),
  stationId: optionalIdQuery,
  productId: optionalIdQuery,
  search: searchQuery,
  ...rangeQuery,
  ...paginationQuery,
});

export const openDeliveriesQuery = z.object({ stationId: idSchema, productId: optionalIdQuery });
