import { z } from "zod";
import {
  clockTime,
  documentRef,
  idSchema,
  isoDate,
  moneyAmount,
  optionalIdQuery,
  optionalIsoDateQuery,
  optionalText,
  rangeQuery,
  requiredText,
} from "./common.ts";

export const depositSchema = z.object({
  stationId: idSchema,
  businessDate: isoDate,
  bankId: idSchema,
  tellerRef: documentRef("Teller / deposit reference"),
  amount: moneyAmount("Amount"),
  depositTime: clockTime.optional(),
});

export const declarationSchema = z.object({
  stationId: idSchema,
  businessDate: isoDate,
  posAmount: moneyAmount("POS collections", { allowZero: true }),
  closingCit: moneyAmount("Cash in transit", { allowZero: true }),
  cashAtHand: moneyAmount("Cash at hand", { allowZero: true }),
  notes: optionalText(255),
});

export const positionQuery = z.object({ stationId: optionalIdQuery, date: optionalIsoDateQuery });

export const historyQuery = z.object({ stationId: optionalIdQuery, ...rangeQuery });

export const reviewSchema = z.object({ comment: requiredText("Comment", 500) });

export const closeSchema = z.object({ comment: optionalText(500) });
