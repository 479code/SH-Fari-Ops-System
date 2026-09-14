/**
 * locks.repo.ts — period locks every module respects.
 *
 * A closed DSR day freezes the station's stock movements for that date; a closed
 * cash reconciliation freezes the cash inputs for that date. Changes then need
 * an authorised reopening (DSR) rather than a silent edit.
 *
 * The lookups take a row lock when run inside a transaction, so a close and a
 * write against the same day serialise instead of interleaving.
 */
import { and, eq } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { cashPositions, dsrDays } from "../db/schema/index.ts";
import { today } from "../utils/dates.ts";
import { AppError } from "../utils/errors.ts";

export async function assertDayNotClosed(ex: Executor, stationId: number, date: string, action: string): Promise<void> {
  const [day] = await ex
    .select({ status: dsrDays.status, ref: dsrDays.ref })
    .from(dsrDays)
    .where(and(eq(dsrDays.stationId, stationId), eq(dsrDays.businessDate, date)))
    .limit(1)
    .for("update");
  if (day?.status === "closed") {
    throw new AppError("CONFLICT", `The business day ${date} is closed and locked (${day.ref}). Reopen the day to ${action}.`);
  }
}

export async function assertCashDayOpen(ex: Executor, stationId: number, date: string, action: string): Promise<void> {
  const [pos] = await ex
    .select({ status: cashPositions.status })
    .from(cashPositions)
    .where(and(eq(cashPositions.stationId, stationId), eq(cashPositions.businessDate, date)))
    .limit(1)
    .for("update");
  if (pos?.status === "closed") {
    throw new AppError("CONFLICT", `The cash reconciliation for ${date} is closed, so you cannot ${action}.`);
  }
}

export function assertNotFuture(date: string, field = "businessDate"): void {
  if (date > today()) {
    throw new AppError("VALIDATION_ERROR", "Date cannot be in the future.", { fields: { [field]: "Date cannot be in the future." } });
  }
}
