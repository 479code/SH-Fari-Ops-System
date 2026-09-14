/**
 * expenses.service.ts — station expenses against the controlled narration list.
 *
 * An expense above its narration's approval threshold starts as pending and
 * needs a user with expenses.approve — who must not be the person who logged it
 * (segregation of duties). Expenses within the threshold are approved on entry.
 * Only approved expenses count towards cash and profit.
 */
import { and, asc, count, desc, eq, like, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { assertCanWriteStation, assertStationAccess, stationFilter } from "../auth/scope.ts";
import { db, type Executor } from "../db/client.ts";
import { expenseNarrations, expenses, stations, users } from "../db/schema/index.ts";
import { assertCashDayOpen, assertNotFuture } from "../repositories/locks.repo.ts";
import { formatRef, nextSequence } from "../repositories/sequence.repo.ts";
import type { Actor } from "../types.ts";
import { resolveRange, today } from "../utils/dates.ts";
import { AppError, conflict, notFound } from "../utils/errors.ts";
import { paginationMeta } from "../utils/http.ts";
import { money, num } from "../utils/numbers.ts";
import { likeContains } from "../utils/sql.ts";
import { recordAudit } from "./audit.service.ts";
import { refreshCashPositions } from "./cash.service.ts";

type ExpenseStatus = (typeof expenses.$inferSelect)["status"];

const recorder = alias(users, "recorder");
const decider = alias(users, "decider");

const columns = {
  id: expenses.id,
  ref: expenses.ref,
  stationId: expenses.stationId,
  stationName: stations.name,
  narrationId: expenses.narrationId,
  narration: expenseNarrations.name,
  businessDate: expenses.businessDate,
  amount: expenses.amount,
  payee: expenses.payee,
  reference: expenses.reference,
  note: expenses.note,
  paymentMethod: expenses.paymentMethod,
  status: expenses.status,
  approvalThreshold: expenses.approvalThreshold,
  recordedBy: expenses.recordedBy,
  recordedByName: recorder.fullName,
  decidedByName: decider.fullName,
  decidedAt: expenses.decidedAt,
  decisionNote: expenses.decisionNote,
  createdAt: expenses.createdAt,
};

function baseQuery(ex: Executor) {
  return ex
    .select(columns)
    .from(expenses)
    .innerJoin(stations, eq(stations.id, expenses.stationId))
    .innerJoin(expenseNarrations, eq(expenseNarrations.id, expenses.narrationId))
    .leftJoin(recorder, eq(recorder.id, expenses.recordedBy))
    .leftJoin(decider, eq(decider.id, expenses.decidedBy));
}

export async function getExpense(actor: Actor, id: number) {
  const [row] = await baseQuery(db).where(eq(expenses.id, id)).limit(1);
  if (!row) throw notFound("Expense");
  assertStationAccess(actor, row.stationId, "Expense");
  return row;
}

export async function listExpenses(
  actor: Actor,
  q: {
    month?: string;
    from?: string;
    to?: string;
    stationId?: number;
    narrationId?: number;
    status?: ExpenseStatus;
    search?: string;
    page: number;
    limit: number;
    sortOrder: "asc" | "desc";
  },
) {
  const range = resolveRange(q);
  const station = stationFilter(actor, q.stationId);
  const conds: SQL[] = [sql`${expenses.businessDate} BETWEEN ${range.from} AND ${range.to}`];
  if (station !== null) conds.push(eq(expenses.stationId, station));
  if (q.narrationId) conds.push(eq(expenses.narrationId, q.narrationId));
  if (q.status) conds.push(eq(expenses.status, q.status));
  if (q.search) {
    const p = likeContains(q.search);
    conds.push(or(like(expenses.payee, p), like(expenses.ref, p), like(expenses.reference, p))!);
  }
  const where = and(...conds);
  const dir = q.sortOrder === "asc" ? asc : desc;

  const [rows, [total], summary] = await Promise.all([
    baseQuery(db).where(where).orderBy(dir(expenses.businessDate), dir(expenses.id)).limit(q.limit).offset((q.page - 1) * q.limit),
    db.select({ n: count() }).from(expenses).where(where),
    db
      .select({ status: expenses.status, n: count(), amount: sql<number>`COALESCE(SUM(${expenses.amount}), 0)` })
      .from(expenses)
      .where(where)
      .groupBy(expenses.status),
  ]);
  const by = (s: ExpenseStatus) => summary.find((r) => r.status === s);
  return {
    rows: rows.map((r) => ({ ...r, canDecide: r.status === "pending" && r.recordedBy !== actor.id })),
    pagination: paginationMeta(q.page, q.limit, total?.n ?? 0),
    summary: {
      range,
      approvedAmount: money(num(by("approved")?.amount)),
      approvedCount: by("approved")?.n ?? 0,
      pendingAmount: money(num(by("pending")?.amount)),
      pendingCount: by("pending")?.n ?? 0,
    },
  };
}

export async function createExpense(
  actor: Actor,
  input: {
    stationId: number;
    narrationId: number;
    amount: number;
    payee: string;
    businessDate?: string;
    reference?: string | null;
    note?: string | null;
    paymentMethod: "cash" | "transfer";
  },
) {
  assertCanWriteStation(actor, input.stationId);
  const businessDate = input.businessDate ?? today();
  assertNotFuture(businessDate);

  const id = await db.transaction(async (tx) => {
    const [station] = await tx.select({ status: stations.status }).from(stations).where(eq(stations.id, input.stationId));
    if (!station || station.status !== "active") throw new AppError("VALIDATION_ERROR", "Select an active station.", { fields: { stationId: "Select an active station." } });
    const [narration] = await tx.select().from(expenseNarrations).where(eq(expenseNarrations.id, input.narrationId));
    if (!narration || narration.status !== "active") {
      throw new AppError("VALIDATION_ERROR", "Select a narration from the approved list.", { fields: { narrationId: "Select a narration from the approved list." } });
    }

    const amount = money(input.amount);
    const needsApproval = narration.approvalThreshold !== null && amount > narration.approvalThreshold;
    const status: ExpenseStatus = needsApproval ? "pending" : "approved";
    if (status === "approved" && input.paymentMethod === "cash") {
      await assertCashDayOpen(tx, input.stationId, businessDate, "log a cash expense");
    }

    const ref = formatRef("EXP", await nextSequence(tx, "EXP"));
    const [inserted] = await tx
      .insert(expenses)
      .values({
        ref,
        stationId: input.stationId,
        narrationId: input.narrationId,
        businessDate,
        amount,
        payee: input.payee,
        reference: input.reference ?? null,
        note: input.note ?? null,
        paymentMethod: input.paymentMethod,
        status,
        approvalThreshold: narration.approvalThreshold,
        recordedBy: actor.id,
      })
      .$returningId();
    if (status === "approved" && input.paymentMethod === "cash") await refreshCashPositions(tx, input.stationId, businessDate);

    await recordAudit(tx, actor, {
      action: "created",
      resource: "expense",
      resourceId: inserted!.id,
      recordRef: ref,
      stationId: input.stationId,
      newValue: {
        narration: narration.name,
        amount,
        payee: input.payee,
        status: needsApproval ? "Pending — above threshold" : "Approved (within threshold)",
      },
    });
    return inserted!.id;
  });
  return getExpense(actor, id);
}

async function lockExpense(actor: Actor, tx: Executor, id: number) {
  const [row] = await tx.select().from(expenses).where(eq(expenses.id, id)).limit(1).for("update");
  if (!row) throw notFound("Expense");
  assertStationAccess(actor, row.stationId, "Expense");
  return row;
}

export async function approveExpense(actor: Actor, id: number, note?: string | null) {
  await db.transaction(async (tx) => {
    const row = await lockExpense(actor, tx, id);
    if (row.status !== "pending") throw conflict(`Only pending expenses can be approved (this one is ${row.status}).`);
    if (row.recordedBy === actor.id) throw new AppError("FORBIDDEN", "You cannot approve an expense you logged.");
    if (row.paymentMethod === "cash") await assertCashDayOpen(tx, row.stationId, row.businessDate, "approve this cash expense");

    await tx.update(expenses).set({ status: "approved", decidedBy: actor.id, decidedAt: new Date(), decisionNote: note ?? null }).where(eq(expenses.id, id));
    if (row.paymentMethod === "cash") await refreshCashPositions(tx, row.stationId, row.businessDate);
    await recordAudit(tx, actor, {
      action: "approved",
      resource: "expense",
      resourceId: id,
      recordRef: row.ref,
      stationId: row.stationId,
      oldValue: { status: "Pending" },
      newValue: { status: "Approved", amount: row.amount, note: note ?? null },
    });
  });
  return getExpense(actor, id);
}

export async function rejectExpense(actor: Actor, id: number, reason: string) {
  await db.transaction(async (tx) => {
    const row = await lockExpense(actor, tx, id);
    if (row.status !== "pending") throw conflict(`Only pending expenses can be rejected (this one is ${row.status}).`);
    if (row.recordedBy === actor.id) throw new AppError("FORBIDDEN", "You cannot reject an expense you logged. Cancel it instead.");
    await tx.update(expenses).set({ status: "rejected", decidedBy: actor.id, decidedAt: new Date(), decisionNote: reason }).where(eq(expenses.id, id));
    await recordAudit(tx, actor, {
      action: "rejected",
      resource: "expense",
      resourceId: id,
      recordRef: row.ref,
      stationId: row.stationId,
      oldValue: { status: "Pending" },
      newValue: { status: "Rejected", reason },
    });
  });
  return getExpense(actor, id);
}

/**
 * The person who logged a pending expense may withdraw it; cancelling an
 * approved expense reverses it from cash and profit and needs expenses.approve.
 */
export async function cancelExpense(actor: Actor, id: number, reason: string) {
  await db.transaction(async (tx) => {
    const row = await lockExpense(actor, tx, id);
    if (row.status === "cancelled" || row.status === "rejected") throw conflict(`This expense is already ${row.status}.`);
    const canApprove = actor.permissions.has("expenses.approve");
    if (row.status === "pending" && row.recordedBy !== actor.id && !canApprove) {
      throw new AppError("FORBIDDEN", "Only the person who logged this expense or an approver can cancel it.");
    }
    if (row.status === "approved") {
      if (!canApprove) throw new AppError("FORBIDDEN", "Only an approver can cancel an approved expense.");
      if (row.paymentMethod === "cash") await assertCashDayOpen(tx, row.stationId, row.businessDate, "cancel this cash expense");
    }
    await tx.update(expenses).set({ status: "cancelled", decidedBy: actor.id, decidedAt: new Date(), decisionNote: reason }).where(eq(expenses.id, id));
    if (row.status === "approved" && row.paymentMethod === "cash") await refreshCashPositions(tx, row.stationId, row.businessDate);
    await recordAudit(tx, actor, {
      action: "cancelled",
      resource: "expense",
      resourceId: id,
      recordRef: row.ref,
      stationId: row.stationId,
      oldValue: { status: row.status },
      newValue: { status: "cancelled", reason },
    });
  });
  return getExpense(actor, id);
}
