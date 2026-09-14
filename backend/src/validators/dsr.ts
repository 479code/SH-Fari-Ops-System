import { z } from "zod";
import {
  idSchema,
  isoDate,
  litresAmount,
  optionalEnumQuery,
  optionalIdQuery,
  optionalIsoDateQuery,
  paginationQuery,
  rangeQuery,
} from "./common.ts";

export const dsrDayQuery = z.object({ stationId: optionalIdQuery, date: optionalIsoDateQuery });

export const dsrOpenSchema = z.object({ stationId: idSchema, businessDate: isoDate });

const reading = z.object({
  pumpId: idSchema,
  openingReading: litresAmount("Opening reading", { allowZero: true }).optional(),
  closingReading: z
    .preprocess((v) => (v === "" ? null : v), litresAmount("Closing reading", { allowZero: true }).nullable())
    .optional(),
});

export const dsrReadingsSchema = z.object({
  readings: z.array(reading).min(1, "Enter at least one reading.").max(200),
});

export const dsrListQuery = z.object({
  stationId: optionalIdQuery,
  status: optionalEnumQuery(["open", "closed"] as const),
  ...rangeQuery,
  ...paginationQuery,
});
