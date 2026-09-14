/**
 * cash.service.ts — cash analysis, POS, CIT, cash at hand and teller-wise deposits.
 *
 * For a station and business date:
 *   expected cash    = DSR sales value (closed day) − POS collections − credit sales
 *                      + cash repayments from debtors − approved cash expenses
 *   brought forward  = closing CIT + cash at hand of the previous declared day
 *   variance         = deposits + closing CIT + cash at hand − (brought forward + expected)
 *
 * Variance is always shown; the station's cash tolerance decides whether it is
 * reconciled (0), within tolerance, or exceeded (flagged as an exception that
 * must be reviewed and closed with a justification).
 */
import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { assertCanWriteStation, assertStationAccess, requireStation } from "../auth/scope.ts";
import { db, selectRows, type Executor, type Tx } from "../db/client.ts";
import { bankDeposits, banks, cashPositions, dsrDays, pumps, stations, users } from "../db/schema/index.ts";
import { assertCashDayOpen, assertNotFuture } from "../repositories/locks.repo.ts";
import type { Actor } from "../types.ts";
import { businessInstant, businessTime, resolveRange, today } from "../utils/dates.ts";
import { AppError, conflict, notFound } from "../utils/errors.ts";
import { money, num } from "../utils/numbers.ts";
import { recordAudit } from "./audit.service.ts";
import { markExceptionReviewed, raiseException, resolveException } from "./exceptions.service.ts";

interface DailyInputs {
  sales: number;
  credit: number;
  debtorCash: number;
  cashExpenses: number;
  deposits: number;
}

const ZERO: DailyInputs = { sales: 0, credit: 0, debtorCash: 0, cashExpenses: 0, deposits: 0 };

type ToleranceStatus = "reconciled" | "within_tolerance" | "exceeded";

/** Every cash-affecting total for a station, per business date, in one round trip. */
async function loadDailyInputs(ex: Executor, stationId: number, from: string, to: string): Promise<Map<string, DailyInputs>> {
  const rows = await selectRows<{ d: string; k: keyof DailyInputs; v: number }>(
    ex,
    sql`SELECT d.business_date AS d, 'sales' AS k, SUM(r.sales_value) AS v
          FROM dsr_readings r JOIN dsr_days d ON d.id = r.dsr_day_id
          WHERE d.station_id = ${stationId} AND d.status = 'closed' AND d.business_date BETWEEN ${from} AND ${to}
          GROUP BY d.business_date
        UNION ALL
        SELECT business_date, 'credit', SUM(amount) FROM debtor_transactions
          WHERE station_id = ${stationId} AND type = 'credit_sale' AND voided_at IS NULL AND business_date BETWEEN ${from} AND ${to}
          GROUP BY business_date
        UNION ALL
        SELECT business_date, 'debtorCash', SUM(amount) FROM debtor_transactions
          WHERE station_id = ${stationId} AND type = 'repayment' AND payment_method = 'cash' AND voided_at IS NULL AND business_date BETWEEN ${from} AND ${to}
          GROUP BY business_date
        UNION ALL
        SELECT business_date, 'cashExpenses', SUM(amount) FROM expenses
          WHERE station_id = ${stationId} AND status = 'approved' AND payment_method = 'cash' AND business_date BETWEEN ${from} AND ${to}
          GROUP BY business_date
        UNION ALL
        SELECT business_date, 'deposits', SUM(amount) FROM bank_deposits
          WHERE station_id = ${stationId} AND status = 'confirmed' AND business_date BETWEEN ${from} AND ${to}
          GROUP BY business_date`,
  );
  const out = new Map<string, DailyInputs>();
  for (const r of rows) {
    const entry = out.get(r.d) ?? { ...ZERO };
    entry[r.k] = money(num(r.v));
    out.set(r.d, entry);
  }
  return out;
}

function toleranceStatus(variance: number, tolerance: number): ToleranceStatus {
  if (Math.abs(variance) < 0.005) return "reconciled";
  return Math.abs(variance) <= tolerance ? "within_tolerance" : "exceeded";
}

function compute(i: DailyInputs, declared: { posAmount: number; closingCit: number; cashAtHand: number } | null, broughtForward: number, tolerance: number) {
  const pos = declared?.posAmount ?? 0;
  const expectedCash = money(i.sales - pos - i.credit + i.debtorCash - i.cashExpenses);
  const variance = declared ? money(i.deposits + declared.closingCit + declared.cashAtHand - (broughtForward + expectedCash)) : null;
  return {
    salesValue: i.sales,
    posAmount: pos,
    creditSales: i.credit,
    debtorCashReceipts: i.debtorCash,
    cashExpenses: i.cashExpenses,
    expectedCash,
    broughtForward: money(broughtForward),
    depositsTotal: i.deposits,
    closingCit: declared?.closingCit ?? 0,
    cashAtHand: declared?.cashAtHand ?? 0,
    variance,
    tolerance,
    toleranceStatus: variance === null ? null : toleranceStatus(variance, tolerance),
  };
}

async function broughtForwardBefore(ex: Executor, stationId: number, date: string): Promise<number> {
  const [prev] = await ex
    .select({ closingCit: cashPositions.closingCit, cashAtHand: cashPositions.cashAtHand })
    .from(cashPositions)
    .where(and(eq(cashPositions.stationId, stationId), lt(cashPositions.businessDate, date)))
    .orderBy(desc(cashPositions.businessDate))
    .limit(1);
  return prev ? money(prev.closingCit + prev.cashAtHand) : 0;
}

async function syncCashException(tx: Tx, position: { id: number; businessDate: string }, stationId: number, stationName: string, variance: number, tolerance: number, status: ToleranceStatus) {
  const key = { type: "cash_variance" as const, sourceType: "cash_position", sourceId: position.id };
  if (status === "exceeded") {
    const raised = await raiseException(tx, {
      ...key,
      severity: "high",
      stationId,
      sourceRef: `CASH-${position.businessDate}`,
      title: `Cash variance ₦${Math.abs(variance).toLocaleString("en-NG")} ${variance < 0 ? "short" : "over"} — ${stationName}, ${position.businessDate}`,
      detail: `Tolerance ₦${tolerance.toLocaleString("en-NG")} · flagged by system`,
      amount: variance,
    });
    if (raised) {
      await recordAudit(tx, null, {
        action: "flagged",
        resource: "cash_position",
        resourceId: position.id,
        recordRef: `CASH-${position.businessDate}`,
        stationId,
        newValue: { note: "Cash variance exceeded tolerance", variance, tolerance },
      });
    }
  } else {
    await resolveException(tx, key, "Variance within tolerance after recalculation.", null);
  }
}

/**
 * Recomputes the snapshot of every non-closed declaration for the station from
 * `fromDate` onwards. Called whenever a cash input changes; the chain matters
 * because each day's closing CIT and cash at hand are the next day's brought forward.
 */
export async function refreshCashPositions(tx: Tx, stationId: number, fromDate: string): Promise<void> {
  const positions = await tx
    .select()
    .from(cashPositions)
    .where(and(eq(cashPositions.stationId, stationId), gte(cashPositions.businessDate, fromDate)))
    .orderBy(asc(cashPositions.businessDate))
    .for("update");
  if (positions.length === 0) return;

  const [station] = await tx.select({ name: stations.name, cashTolerance: stations.cashTolerance }).from(stations).where(eq(stations.id, stationId));
  const inputs = await loadDailyInputs(tx, stationId, fromDate, positions[positions.length - 1]!.businessDate);
  let bf = await broughtForwardBefore(tx, stationId, fromDate);

  for (const p of positions) {
    if (p.status !== "closed") {
      const c = compute(inputs.get(p.businessDate) ?? ZERO, p, bf, station?.cashTolerance ?? 0);
      const variance = c.variance!;
      const status = c.toleranceStatus!;
      const reviewInvalidated = p.status === "reviewed" && money(p.variance) !== variance;
      await tx
        .update(cashPositions)
        .set({
          salesValue: c.salesValue,
          creditSales: c.creditSales,
          debtorCashReceipts: c.debtorCashReceipts,
          cashExpenses: c.cashExpenses,
          expectedCash: c.expectedCash,
          broughtForward: c.broughtForward,
          depositsTotal: c.depositsTotal,
          variance,
          tolerance: c.tolerance,
          toleranceStatus: status,
          ...(reviewInvalidated ? { status: "open" as const, reviewedBy: null, reviewedAt: null, reviewComment: null } : {}),
        })
        .where(eq(cashPositions.id, p.id));
      await syncCashException(tx, p, stationId, station?.name ?? "", variance, c.tolerance, status);
    }
    bf = money(p.closingCit + p.cashAtHand);
  }
}

/* ------------------------------------------------------------------------ */
/* Read                                                                      */
/* ------------------------------------------------------------------------ */

const recorder = alias(users, "recorder");
const reviewer = alias(users, "reviewer");
const closer = alias(users, "closer");

async function stationHasPumps(ex: Executor, stationId: number) {
  const [row] = await ex.select({ id: pumps.id }).from(pumps).where(and(eq(pumps.stationId, stationId), eq(pumps.status, "active"))).limit(1);
  return Boolean(row);
}

export async function getPosition(actor: Actor, requestedStation: number | undefined, date: string = today()) {
  const stationId = requireStation(actor, requestedStation);
  assertStationAccess(actor, stationId, "Station");
  const [station] = await db.select({ id: stations.id, name: stations.name, cashTolerance: stations.cashTolerance }).from(stations).where(eq(stations.id, stationId));
  if (!station) throw notFound("Station");

  const [position] = await db
    .select({
      id: cashPositions.id,
      status: cashPositions.status,
      posAmount: cashPositions.posAmount,
      closingCit: cashPositions.closingCit,
      cashAtHand: cashPositions.cashAtHand,
      notes: cashPositions.notes,
      snapshot: {
        salesValue: cashPositions.salesValue,
        creditSales: cashPositions.creditSales,
        debtorCashReceipts: cashPositions.debtorCashReceipts,
        cashExpenses: cashPositions.cashExpenses,
        expectedCash: cashPositions.expectedCash,
        broughtForward: cashPositions.broughtForward,
        depositsTotal: cashPositions.depositsTotal,
        variance: cashPositions.variance,
        tolerance: cashPositions.tolerance,
        toleranceStatus: cashPositions.toleranceStatus,
      },
      recordedByName: recorder.fullName,
      reviewedByName: reviewer.fullName,
      reviewedAt: cashPositions.reviewedAt,
      reviewComment: cashPositions.reviewComment,
      closedByName: closer.fullName,
      closedAt: cashPositions.closedAt,
      updatedAt: cashPositions.updatedAt,
    })
    .from(cashPositions)
    .leftJoin(recorder, eq(recorder.id, cashPositions.recordedBy))
    .leftJoin(reviewer, eq(reviewer.id, cashPositions.reviewedBy))
    .leftJoin(closer, eq(closer.id, cashPositions.closedBy))
    .where(and(eq(cashPositions.stationId, stationId), eq(cashPositions.businessDate, date)))
    .limit(1);

  let figures;
  if (position?.status === "closed") {
    const s = position.snapshot;
    figures = { ...s, posAmount: position.posAmount, closingCit: position.closingCit, cashAtHand: position.cashAtHand };
  } else {
    const inputs = (await loadDailyInputs(db, stationId, date, date)).get(date) ?? ZERO;
    figures = compute(inputs, position ?? null, await broughtForwardBefore(db, stationId, date), station.cashTolerance);
  }

  const deposits = await db
    .select({
      id: bankDeposits.id,
      tellerRef: bankDeposits.tellerRef,
      bankName: banks.name,
      amount: bankDeposits.amount,
      depositedAt: bankDeposits.depositedAt,
      status: bankDeposits.status,
      cancelReason: bankDeposits.cancelReason,
      recordedByName: users.fullName,
    })
    .from(bankDeposits)
    .innerJoin(banks, eq(banks.id, bankDeposits.bankId))
    .innerJoin(users, eq(users.id, bankDeposits.recordedBy))
    .where(and(eq(bankDeposits.stationId, stationId), eq(bankDeposits.businessDate, date)))
    .orderBy(asc(bankDeposits.depositedAt));

  const [dsr] = await db
    .select({ status: dsrDays.status, ref: dsrDays.ref })
    .from(dsrDays)
    .where(and(eq(dsrDays.stationId, stationId), eq(dsrDays.businessDate, date)))
    .limit(1);

  return {
    station,
    date,
    declaration: position ? { ...position, snapshot: undefined } : null,
    figures,
    deposits: deposits.map((d) => ({ ...d, time: businessTime(d.depositedAt) })),
    dsr: { status: dsr?.status ?? "not_opened", ref: dsr?.ref ?? null, required: await stationHasPumps(db, stationId) },
  };
}

export async function getHistory(actor: Actor, requestedStation: number | undefined, range: { month?: string; from?: string; to?: string }) {
  const stationId = requireStation(actor, requestedStation);
  const { from, to } = resolveRange(range);
  const [station] = await db.select({ name: stations.name, cashTolerance: stations.cashTolerance }).from(stations).where(eq(stations.id, stationId));
  if (!station) throw notFound("Station");

  const [positions, inputs, bfStart] = await Promise.all([
    db
      .select()
      .from(cashPositions)
      .where(and(eq(cashPositions.stationId, stationId), sql`${cashPositions.businessDate} BETWEEN ${from} AND ${to}`))
      .orderBy(asc(cashPositions.businessDate)),
    loadDailyInputs(db, stationId, from, to),
    broughtForwardBefore(db, stationId, from),
  ]);

  const byDate = new Map(positions.map((p) => [p.businessDate, p]));
  const dates = [...new Set([...byDate.keys(), ...inputs.keys()])].sort();
  let bf = bfStart;
  const rows = dates.map((date) => {
    const p = byDate.get(date);
    const row =
      p?.status === "closed"
        ? {
            salesValue: p.salesValue,
            posAmount: p.posAmount,
            creditSales: p.creditSales,
            debtorCashReceipts: p.debtorCashReceipts,
            cashExpenses: p.cashExpenses,
            expectedCash: p.expectedCash,
            broughtForward: p.broughtForward,
            depositsTotal: p.depositsTotal,
            closingCit: p.closingCit,
            cashAtHand: p.cashAtHand,
            variance: p.variance,
            tolerance: p.tolerance,
            toleranceStatus: p.toleranceStatus as ToleranceStatus | null,
          }
        : compute(inputs.get(date) ?? ZERO, p ?? null, bf, station.cashTolerance);
    if (p) bf = money(p.closingCit + p.cashAtHand);
    return { businessDate: date, positionId: p?.id ?? null, status: p?.status ?? "not_declared", ...row };
  });
  return { station: { id: stationId, ...station }, range: { from, to }, rows: rows.reverse() };
}

/* ------------------------------------------------------------------------ */
/* Commands                                                                  */
/* ------------------------------------------------------------------------ */

export async function recordDeposit(
  actor: Actor,
  input: { stationId: number; businessDate: string; bankId: number; tellerRef: string; amount: number; depositTime?: string },
) {
  assertCanWriteStation(actor, input.stationId);
  assertNotFuture(input.businessDate);
  await db.transaction(async (tx) => {
    const [station] = await tx.select({ status: stations.status }).from(stations).where(eq(stations.id, input.stationId));
    if (!station || station.status !== "active") throw new AppError("VALIDATION_ERROR", "Select an active station.", { fields: { stationId: "Select an active station." } });
    const [bank] = await tx.select({ name: banks.name, status: banks.status }).from(banks).where(eq(banks.id, input.bankId));
    if (!bank || bank.status !== "active") throw new AppError("VALIDATION_ERROR", "Select an active bank.", { fields: { bankId: "Select an active bank." } });
    await assertCashDayOpen(tx, input.stationId, input.businessDate, "record a deposit");

    const [duplicate] = await tx.select({ id: bankDeposits.id }).from(bankDeposits).where(eq(bankDeposits.tellerRef, input.tellerRef)).limit(1);
    if (duplicate) {
      throw new AppError("CONFLICT", `Teller reference ${input.tellerRef} has already been recorded.`, { fields: { tellerRef: "This teller / deposit reference already exists." } });
    }

    const depositedAt = input.depositTime
      ? businessInstant(input.businessDate, input.depositTime)
      : input.businessDate === today()
        ? new Date()
        : businessInstant(input.businessDate, "12:00");
    const amount = money(input.amount);
    const [inserted] = await tx
      .insert(bankDeposits)
      .values({ tellerRef: input.tellerRef, stationId: input.stationId, bankId: input.bankId, businessDate: input.businessDate, depositedAt, amount, recordedBy: actor.id })
      .$returningId();

    await refreshCashPositions(tx, input.stationId, input.businessDate);
    await recordAudit(tx, actor, {
      action: "created",
      resource: "bank_deposit",
      resourceId: inserted!.id,
      recordRef: input.tellerRef,
      stationId: input.stationId,
      newValue: { bank: bank.name, amount, businessDate: input.businessDate },
    });
  });
  return getPosition(actor, input.stationId, input.businessDate);
}

export async function cancelDeposit(actor: Actor, id: number, reason: string) {
  const deposit = await db.transaction(async (tx) => {
    const [deposit] = await tx.select().from(bankDeposits).where(eq(bankDeposits.id, id)).limit(1).for("update");
    if (!deposit) throw notFound("Bank deposit");
    assertStationAccess(actor, deposit.stationId, "Bank deposit");
    assertCanWriteStation(actor, deposit.stationId);
    if (deposit.status === "cancelled") throw conflict("This deposit is already cancelled.");
    await assertCashDayOpen(tx, deposit.stationId, deposit.businessDate, "cancel a deposit");

    await tx.update(bankDeposits).set({ status: "cancelled", cancelledBy: actor.id, cancelledAt: new Date(), cancelReason: reason }).where(eq(bankDeposits.id, id));
    await refreshCashPositions(tx, deposit.stationId, deposit.businessDate);
    await recordAudit(tx, actor, {
      action: "cancelled",
      resource: "bank_deposit",
      resourceId: id,
      recordRef: deposit.tellerRef,
      stationId: deposit.stationId,
      oldValue: { status: "confirmed", amount: deposit.amount },
      newValue: { status: "cancelled", reason },
    });
    return deposit;
  });
  return getPosition(actor, deposit.stationId, deposit.businessDate);
}

export async function saveDeclaration(
  actor: Actor,
  input: { stationId: number; businessDate: string; posAmount: number; closingCit: number; cashAtHand: number; notes?: string | null },
) {
  assertCanWriteStation(actor, input.stationId);
  assertNotFuture(input.businessDate);
  await db.transaction(async (tx) => {
    const [station] = await tx.select({ status: stations.status }).from(stations).where(eq(stations.id, input.stationId));
    if (!station) throw new AppError("VALIDATION_ERROR", "Select a station.", { fields: { stationId: "Select a station." } });

    const [existing] = await tx
      .select()
      .from(cashPositions)
      .where(and(eq(cashPositions.stationId, input.stationId), eq(cashPositions.businessDate, input.businessDate)))
      .limit(1)
      .for("update");
    if (existing?.status === "closed") throw conflict(`The cash reconciliation for ${input.businessDate} is closed.`);

    const values = {
      posAmount: money(input.posAmount),
      closingCit: money(input.closingCit),
      cashAtHand: money(input.cashAtHand),
      notes: input.notes ?? null,
    };
    let id: number;
    if (existing) {
      await tx
        .update(cashPositions)
        .set({ ...values, status: "open", reviewedBy: null, reviewedAt: null, reviewComment: null })
        .where(eq(cashPositions.id, existing.id));
      id = existing.id;
    } else {
      const [inserted] = await tx
        .insert(cashPositions)
        .values({ ...values, stationId: input.stationId, businessDate: input.businessDate, recordedBy: actor.id })
        .$returningId();
      id = inserted!.id;
    }
    // Later days' brought-forward depend on this declaration.
    await refreshCashPositions(tx, input.stationId, input.businessDate);

    await recordAudit(tx, actor, {
      action: existing ? "updated" : "created",
      resource: "cash_position",
      resourceId: id,
      recordRef: `CASH-${input.businessDate}`,
      stationId: input.stationId,
      oldValue: existing ? { posAmount: existing.posAmount, closingCit: existing.closingCit, cashAtHand: existing.cashAtHand, status: existing.status } : null,
      newValue: values,
    });
  });
  return getPosition(actor, input.stationId, input.businessDate);
}

async function lockPosition(actor: Actor, tx: Tx, id: number) {
  const [position] = await tx.select().from(cashPositions).where(eq(cashPositions.id, id)).limit(1).for("update");
  if (!position) throw notFound("Cash reconciliation");
  assertStationAccess(actor, position.stationId, "Cash reconciliation");
  return position;
}

export async function reviewPosition(actor: Actor, id: number, comment: string) {
  const position = await db.transaction(async (tx) => {
    const position = await lockPosition(actor, tx, id);
    if (position.status !== "open") throw conflict(`This reconciliation is already ${position.status}.`);
    await tx.update(cashPositions).set({ status: "reviewed", reviewedBy: actor.id, reviewedAt: new Date(), reviewComment: comment }).where(eq(cashPositions.id, id));
    await markExceptionReviewed(tx, { type: "cash_variance", sourceType: "cash_position", sourceId: id }, actor.id, comment);
    await recordAudit(tx, actor, {
      action: "reviewed",
      resource: "cash_position",
      resourceId: id,
      recordRef: `CASH-${position.businessDate}`,
      stationId: position.stationId,
      oldValue: { status: position.status },
      newValue: { status: "reviewed", comment, variance: position.variance },
    });
    return position;
  });
  return getPosition(actor, position.stationId, position.businessDate);
}

export async function closePosition(actor: Actor, id: number, comment?: string | null) {
  const position = await db.transaction(async (tx) => {
    const position = await lockPosition(actor, tx, id);
    if (position.status === "closed") throw conflict("This reconciliation is already closed.");

    if (await stationHasPumps(tx, position.stationId)) {
      const [dsr] = await tx
        .select({ status: dsrDays.status })
        .from(dsrDays)
        .where(and(eq(dsrDays.stationId, position.stationId), eq(dsrDays.businessDate, position.businessDate)));
      if (dsr?.status !== "closed") throw conflict(`Close the DSR for ${position.businessDate} before closing its cash reconciliation.`);
    }
    // A later open day's opening balance depends on this one; close in date order.
    const [earlierOpen] = await tx
      .select({ businessDate: cashPositions.businessDate })
      .from(cashPositions)
      .where(and(eq(cashPositions.stationId, position.stationId), lt(cashPositions.businessDate, position.businessDate), sql`${cashPositions.status} <> 'closed'`))
      .limit(1);
    if (earlierOpen) throw conflict(`Close the cash reconciliation for ${earlierOpen.businessDate} first.`);

    await refreshCashPositions(tx, position.stationId, position.businessDate);
    const [fresh] = await tx.select().from(cashPositions).where(eq(cashPositions.id, id));
    const justification = comment ?? fresh!.reviewComment;
    if (fresh!.toleranceStatus === "exceeded" && !justification) {
      throw new AppError("VALIDATION_ERROR", "A justification is required to close a variance that exceeds tolerance.", { fields: { comment: "Justification is required." } });
    }

    await tx
      .update(cashPositions)
      .set({ status: "closed", closedBy: actor.id, closedAt: new Date(), reviewComment: justification ?? null })
      .where(eq(cashPositions.id, id));
    await resolveException(
      tx,
      { type: "cash_variance", sourceType: "cash_position", sourceId: id },
      justification ? `Reconciliation closed: ${justification}` : "Reconciliation closed.",
      actor.id,
    );
    await recordAudit(tx, actor, {
      action: "closed",
      resource: "cash_position",
      resourceId: id,
      recordRef: `CASH-${position.businessDate}`,
      stationId: position.stationId,
      oldValue: { status: position.status },
      newValue: { status: "closed", variance: fresh!.variance, toleranceStatus: fresh!.toleranceStatus, comment: justification ?? null },
    });
    return position;
  });
  return getPosition(actor, position.stationId, position.businessDate);
}
