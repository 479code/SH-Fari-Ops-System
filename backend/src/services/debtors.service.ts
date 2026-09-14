/**
 * debtors.service.ts — customer credit accounts.
 *
 * Balances are never stored: a debtor's balance is the sum of its non-voided
 * transactions (opening balance + credit sales − repayments), so every naira is
 * traceable to a source entry.
 *
 * Aging is FIFO: repayments settle the oldest charges first, and the age of
 * whatever remains unpaid places the balance in a bucket.
 */
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { assertCanWriteStation, assertStationAccess, stationFilter } from "../auth/scope.ts";
import { db, selectRows, type Executor, type Tx } from "../db/client.ts";
import { debtors, debtorTransactions, stations, users } from "../db/schema/index.ts";
import { assertCashDayOpen, assertNotFuture } from "../repositories/locks.repo.ts";
import type { Actor } from "../types.ts";
import { daysBetween, minDate, resolveRange, today } from "../utils/dates.ts";
import { AppError, conflict, notFound } from "../utils/errors.ts";
import { paginationMeta } from "../utils/http.ts";
import { money, num } from "../utils/numbers.ts";
import { likeContains } from "../utils/sql.ts";
import { recordAudit } from "./audit.service.ts";
import { refreshCashPositions } from "./cash.service.ts";
import { raiseException, resolveException } from "./exceptions.service.ts";
import { getSettings } from "./settings.service.ts";

export type TxType = "opening_balance" | "credit_sale" | "repayment";
export type AgingBucket = "current" | "31_60" | "61_90" | "90_plus";

export interface AgingResult {
  balance: number;
  oldestUnpaidDate: string | null;
  oldestAgeDays: number | null;
  buckets: Record<AgingBucket, number>;
  status: AgingBucket | "settled" | "credit" | "none";
}

function bucketFor(age: number): AgingBucket {
  if (age <= 30) return "current";
  if (age <= 60) return "31_60";
  if (age <= 90) return "61_90";
  return "90_plus";
}

/** FIFO aging of a debtor's transactions as of a date. */
export function computeAging(txs: { type: TxType; amount: number; businessDate: string }[], asOf: string): AgingResult {
  const charges = txs
    .filter((t) => t.type !== "repayment" && t.businessDate <= asOf)
    .sort((a, b) => a.businessDate.localeCompare(b.businessDate))
    .map((t) => ({ date: t.businessDate, remaining: t.amount }));
  const paid = money(txs.filter((t) => t.type === "repayment" && t.businessDate <= asOf).reduce((s, t) => s + t.amount, 0));
  const charged = money(charges.reduce((s, c) => s + c.remaining, 0));

  let credit = paid;
  for (const c of charges) {
    const applied = Math.min(c.remaining, credit);
    c.remaining = money(c.remaining - applied);
    credit = money(credit - applied);
  }

  const buckets: Record<AgingBucket, number> = { current: 0, "31_60": 0, "61_90": 0, "90_plus": 0 };
  let oldest: string | null = null;
  for (const c of charges) {
    if (c.remaining <= 0) continue;
    oldest ??= c.date;
    const b = bucketFor(daysBetween(c.date, asOf));
    buckets[b] = money(buckets[b] + c.remaining);
  }

  const balance = money(charged - paid);
  const oldestAgeDays = oldest ? daysBetween(oldest, asOf) : null;
  const status: AgingResult["status"] =
    charges.length === 0 && paid === 0 ? "none" : balance < 0 ? "credit" : balance === 0 ? "settled" : bucketFor(oldestAgeDays ?? 0);
  return { balance, oldestUnpaidDate: oldest, oldestAgeDays, buckets, status };
}

const SIGNED = sql`CASE WHEN t.type = 'repayment' THEN -t.amount ELSE t.amount END`;

async function balanceOf(ex: Executor, debtorId: number): Promise<number> {
  const [row] = await selectRows<{ balance: number }>(
    ex,
    sql`SELECT COALESCE(SUM(${SIGNED}), 0) AS balance FROM debtor_transactions t WHERE t.debtor_id = ${debtorId} AND t.voided_at IS NULL`,
  );
  return money(num(row?.balance));
}

async function transactionsFor(ex: Executor, debtorIds: number[]) {
  if (debtorIds.length === 0) return new Map<number, { type: TxType; amount: number; businessDate: string }[]>();
  const rows = await ex
    .select({ debtorId: debtorTransactions.debtorId, type: debtorTransactions.type, amount: debtorTransactions.amount, businessDate: debtorTransactions.businessDate })
    .from(debtorTransactions)
    .where(and(inArray(debtorTransactions.debtorId, debtorIds), isNull(debtorTransactions.voidedAt)));
  const out = new Map<number, { type: TxType; amount: number; businessDate: string }[]>();
  for (const r of rows) {
    const list = out.get(r.debtorId) ?? [];
    list.push(r);
    out.set(r.debtorId, list);
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Queries                                                                   */
/* ------------------------------------------------------------------------ */

interface DebtorListRow {
  id: number;
  name: string;
  phone: string | null;
  credit_limit: number | null;
  status: "active" | "inactive";
  station_id: number;
  station_name: string;
  opening: number;
  additions: number;
  payments: number;
  closing: number;
  balance: number;
}

export async function listDebtors(
  actor: Actor,
  q: {
    search?: string;
    stationId?: number;
    status?: "active" | "inactive";
    hasBalance: boolean;
    sortBy: "name" | "balance" | "closing";
    sortOrder: "asc" | "desc";
    month?: string;
    from?: string;
    to?: string;
    page: number;
    limit: number;
  },
) {
  const { from, to } = resolveRange(q);
  const station = stationFilter(actor, q.stationId);
  const conds: SQL[] = [sql`1 = 1`];
  if (station !== null) conds.push(sql`d.station_id = ${station}`);
  if (q.status) conds.push(sql`d.status = ${q.status}`);
  if (q.search) conds.push(sql`d.name LIKE ${likeContains(q.search)}`);
  const having = q.hasBalance ? sql`HAVING balance <> 0` : sql``;
  const order = { name: sql`d.name`, balance: sql`balance`, closing: sql`closing` }[q.sortBy];
  const dir = q.sortOrder === "asc" ? sql`ASC` : sql`DESC`;

  const inner = sql`SELECT d.id, d.name, d.phone, d.credit_limit, d.status, d.station_id, s.name AS station_name,
        COALESCE(SUM(CASE WHEN t.business_date < ${from} OR (t.type = 'opening_balance' AND t.business_date <= ${to}) THEN ${SIGNED} END), 0) AS opening,
        COALESCE(SUM(CASE WHEN t.type = 'credit_sale' AND t.business_date BETWEEN ${from} AND ${to} THEN t.amount END), 0) AS additions,
        COALESCE(SUM(CASE WHEN t.type = 'repayment' AND t.business_date BETWEEN ${from} AND ${to} THEN t.amount END), 0) AS payments,
        COALESCE(SUM(CASE WHEN t.business_date <= ${to} THEN ${SIGNED} END), 0) AS closing,
        COALESCE(SUM(${SIGNED}), 0) AS balance
      FROM debtors d
      JOIN stations s ON s.id = d.station_id
      LEFT JOIN debtor_transactions t ON t.debtor_id = d.id AND t.voided_at IS NULL
      WHERE ${sql.join(conds, sql` AND `)}
      GROUP BY d.id ${having}`;

  const [rows, [total]] = await Promise.all([
    selectRows<DebtorListRow>(db, sql`${inner} ORDER BY ${order} ${dir}, d.id LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`),
    selectRows<{ n: number }>(db, sql`SELECT COUNT(*) AS n FROM (${inner}) x`),
  ]);

  const asOf = minDate(today(), to);
  const txs = await transactionsFor(db, rows.map((r) => r.id));
  return {
    rows: rows.map((r) => {
      const aging = computeAging(txs.get(r.id) ?? [], asOf);
      return {
        id: r.id,
        name: r.name,
        phone: r.phone,
        creditLimit: r.credit_limit,
        status: r.status,
        stationId: r.station_id,
        stationName: r.station_name,
        opening: money(num(r.opening)),
        additions: money(num(r.additions)),
        payments: money(num(r.payments)),
        closing: money(num(r.closing)),
        balance: money(num(r.balance)),
        aging: aging.status,
        oldestAgeDays: aging.oldestAgeDays,
      };
    }),
    range: { from, to },
    pagination: paginationMeta(q.page, q.limit, num(total?.n)),
  };
}

/** Portfolio-level figures: totals, aging buckets and the largest balances. */
export async function debtorSummary(actor: Actor, stationId?: number, ex: Executor = db) {
  const station = stationFilter(actor, stationId);
  const scope = station !== null ? sql`AND d.station_id = ${station}` : sql``;
  const balances = await selectRows<{ id: number; name: string; station_id: number; station_name: string; balance: number }>(
    ex,
    sql`SELECT d.id, d.name, d.station_id, s.name AS station_name, COALESCE(SUM(${SIGNED}), 0) AS balance
        FROM debtors d JOIN stations s ON s.id = d.station_id
        LEFT JOIN debtor_transactions t ON t.debtor_id = d.id AND t.voided_at IS NULL
        WHERE 1 = 1 ${scope}
        GROUP BY d.id`,
  );
  const owing = balances.filter((b) => num(b.balance) > 0);
  const txs = await transactionsFor(ex, owing.map((b) => b.id));
  const asOf = today();

  const buckets: Record<AgingBucket, number> = { current: 0, "31_60": 0, "61_90": 0, "90_plus": 0 };
  let accountsOver60 = 0;
  let accountsOver90 = 0;
  const byStation = new Map<number, number>();
  const ranked = owing.map((b) => {
    const aging = computeAging(txs.get(b.id) ?? [], asOf);
    for (const k of Object.keys(buckets) as AgingBucket[]) buckets[k] = money(buckets[k] + aging.buckets[k]);
    if ((aging.oldestAgeDays ?? 0) > 60) accountsOver60++;
    if ((aging.oldestAgeDays ?? 0) > 90) accountsOver90++;
    byStation.set(b.station_id, money((byStation.get(b.station_id) ?? 0) + aging.balance));
    return { id: b.id, name: b.name, stationName: b.station_name, balance: aging.balance, aging: aging.status, oldestAgeDays: aging.oldestAgeDays };
  });
  ranked.sort((a, b) => b.balance - a.balance);

  return {
    totalOutstanding: money(owing.reduce((s, b) => s + num(b.balance), 0)),
    accounts: balances.length,
    accountsWithBalance: owing.length,
    over60: money(buckets["61_90"] + buckets["90_plus"]),
    over90: buckets["90_plus"],
    accountsOver60,
    accountsOver90,
    buckets,
    byStation: Object.fromEntries(byStation),
    topDebtors: ranked.slice(0, 5),
  };
}

const recorder = alias(users, "recorder");
const voider = alias(users, "voider");

export async function getDebtor(actor: Actor, id: number) {
  const [debtor] = await db
    .select({
      id: debtors.id,
      name: debtors.name,
      phone: debtors.phone,
      creditLimit: debtors.creditLimit,
      status: debtors.status,
      stationId: debtors.stationId,
      stationName: stations.name,
      createdAt: debtors.createdAt,
    })
    .from(debtors)
    .innerJoin(stations, eq(stations.id, debtors.stationId))
    .where(eq(debtors.id, id))
    .limit(1);
  if (!debtor) throw notFound("Debtor");
  assertStationAccess(actor, debtor.stationId, "Debtor");

  const transactions = await db
    .select({
      id: debtorTransactions.id,
      type: debtorTransactions.type,
      amount: debtorTransactions.amount,
      businessDate: debtorTransactions.businessDate,
      reference: debtorTransactions.reference,
      paymentMethod: debtorTransactions.paymentMethod,
      note: debtorTransactions.note,
      recordedByName: recorder.fullName,
      voidedAt: debtorTransactions.voidedAt,
      voidedByName: voider.fullName,
      voidReason: debtorTransactions.voidReason,
      createdAt: debtorTransactions.createdAt,
    })
    .from(debtorTransactions)
    .leftJoin(recorder, eq(recorder.id, debtorTransactions.recordedBy))
    .leftJoin(voider, eq(voider.id, debtorTransactions.voidedBy))
    .where(eq(debtorTransactions.debtorId, id))
    .orderBy(desc(debtorTransactions.businessDate), desc(debtorTransactions.id));

  // Running balance in chronological order, shown newest first.
  let running = 0;
  const withBalance = [...transactions].reverse().map((t) => {
    if (!t.voidedAt) running = money(running + (t.type === "repayment" ? -t.amount : t.amount));
    return { ...t, runningBalance: running };
  });
  const aging = computeAging(transactions.filter((t) => !t.voidedAt), today());
  return { ...debtor, balance: aging.balance, aging, transactions: withBalance.reverse() };
}

/* ------------------------------------------------------------------------ */
/* Commands                                                                  */
/* ------------------------------------------------------------------------ */

export async function createDebtor(
  actor: Actor,
  input: { stationId: number; name: string; phone?: string | null; creditLimit?: number | null; openingBalance: number; openingDate?: string },
) {
  assertCanWriteStation(actor, input.stationId);
  const openingDate = input.openingDate ?? today();
  assertNotFuture(openingDate, "openingDate");

  const id = await db.transaction(async (tx) => {
    const [station] = await tx.select({ status: stations.status }).from(stations).where(eq(stations.id, input.stationId));
    if (!station || station.status !== "active") throw new AppError("VALIDATION_ERROR", "Select an active station.", { fields: { stationId: "Select an active station." } });
    const [duplicate] = await tx
      .select({ id: debtors.id })
      .from(debtors)
      .where(and(eq(debtors.stationId, input.stationId), eq(debtors.name, input.name)))
      .limit(1);
    if (duplicate) throw new AppError("CONFLICT", `${input.name} is already registered at this station.`, { fields: { name: "A debtor with this name already exists at this station." } });

    const [inserted] = await tx
      .insert(debtors)
      .values({ stationId: input.stationId, name: input.name, phone: input.phone ?? null, creditLimit: input.creditLimit ?? null, createdBy: actor.id })
      .$returningId();
    const debtorId = inserted!.id;

    if (input.openingBalance > 0) {
      await tx.insert(debtorTransactions).values({
        debtorId,
        stationId: input.stationId,
        type: "opening_balance",
        amount: money(input.openingBalance),
        businessDate: openingDate,
        note: "Opening balance at registration",
        recordedBy: actor.id,
      });
    }
    await recordAudit(tx, actor, {
      action: "created",
      resource: "debtor",
      resourceId: debtorId,
      recordRef: input.name,
      stationId: input.stationId,
      newValue: { name: input.name, openingBalance: input.openingBalance, creditLimit: input.creditLimit ?? null },
    });
    return debtorId;
  });
  return getDebtor(actor, id);
}

export async function updateDebtor(
  actor: Actor,
  id: number,
  input: { name?: string; phone?: string | null; creditLimit?: number | null; status?: "active" | "inactive" },
) {
  await db.transaction(async (tx) => {
    const [debtor] = await tx.select().from(debtors).where(eq(debtors.id, id)).limit(1).for("update");
    if (!debtor) throw notFound("Debtor");
    assertStationAccess(actor, debtor.stationId, "Debtor");
    assertCanWriteStation(actor, debtor.stationId);

    if (input.name && input.name !== debtor.name) {
      const [duplicate] = await tx
        .select({ id: debtors.id })
        .from(debtors)
        .where(and(eq(debtors.stationId, debtor.stationId), eq(debtors.name, input.name)))
        .limit(1);
      if (duplicate && duplicate.id !== id) throw new AppError("CONFLICT", `${input.name} is already registered at this station.`, { fields: { name: "Name already in use." } });
    }
    const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as typeof input;
    if (Object.keys(patch).length === 0) return;
    await tx.update(debtors).set(patch).where(eq(debtors.id, id));
    await recordAudit(tx, actor, {
      action: "updated",
      resource: "debtor",
      resourceId: id,
      recordRef: debtor.name,
      stationId: debtor.stationId,
      oldValue: Object.fromEntries(Object.keys(patch).map((k) => [k, debtor[k as keyof typeof debtor]])),
      newValue: patch,
    });
  });
  return getDebtor(actor, id);
}

const affectsCash = (type: TxType, method: string | null | undefined) => type === "credit_sale" || (type === "repayment" && method === "cash");

export async function recordTransaction(
  actor: Actor,
  debtorId: number,
  input: { type: "credit_sale" | "repayment"; amount: number; businessDate?: string; reference?: string | null; paymentMethod?: "cash" | "transfer" | "pos"; note?: string | null },
) {
  const businessDate = input.businessDate ?? today();
  assertNotFuture(businessDate);
  await db.transaction(async (tx) => {
    const [debtor] = await tx.select().from(debtors).where(eq(debtors.id, debtorId)).limit(1).for("update");
    if (!debtor) throw notFound("Debtor");
    assertStationAccess(actor, debtor.stationId, "Debtor");
    assertCanWriteStation(actor, debtor.stationId);
    if (input.type === "credit_sale" && debtor.status !== "active") throw conflict(`${debtor.name} is inactive and cannot take new credit.`);

    const paymentMethod = input.type === "repayment" ? input.paymentMethod! : null;
    if (affectsCash(input.type, paymentMethod)) await assertCashDayOpen(tx, debtor.stationId, businessDate, "record this transaction");

    const amount = money(input.amount);
    const balance = await balanceOf(tx, debtorId);
    if (input.type === "repayment" && amount > balance) {
      throw new AppError("VALIDATION_ERROR", `Repayment exceeds the outstanding balance of ₦${balance.toLocaleString("en-NG")}.`, {
        fields: { amount: `Cannot exceed the outstanding balance (₦${balance.toLocaleString("en-NG")}).` },
      });
    }
    if (input.type === "credit_sale" && debtor.creditLimit !== null && money(balance + amount) > debtor.creditLimit) {
      throw new AppError(
        "CONFLICT",
        `This credit sale would take ${debtor.name}'s balance to ₦${money(balance + amount).toLocaleString("en-NG")}, above the credit limit of ₦${debtor.creditLimit.toLocaleString("en-NG")}.`,
        { fields: { amount: "Exceeds the customer's credit limit." } },
      );
    }

    const [inserted] = await tx
      .insert(debtorTransactions)
      .values({
        debtorId,
        stationId: debtor.stationId,
        type: input.type,
        amount,
        businessDate,
        reference: input.reference ?? null,
        paymentMethod,
        note: input.note ?? null,
        recordedBy: actor.id,
      })
      .$returningId();
    if (affectsCash(input.type, paymentMethod)) await refreshCashPositions(tx, debtor.stationId, businessDate);

    await recordAudit(tx, actor, {
      action: "created",
      resource: "debtor_transaction",
      resourceId: inserted!.id,
      recordRef: debtor.name,
      stationId: debtor.stationId,
      oldValue: { balance },
      newValue: { type: input.type, amount, businessDate, paymentMethod, balance: money(balance + (input.type === "repayment" ? -amount : amount)) },
    });
  });
  return getDebtor(actor, debtorId);
}

export async function voidTransaction(actor: Actor, transactionId: number, reason: string) {
  const debtorId = await db.transaction(async (tx: Tx) => {
    const [row] = await tx.select().from(debtorTransactions).where(eq(debtorTransactions.id, transactionId)).limit(1).for("update");
    if (!row) throw notFound("Debtor transaction");
    assertStationAccess(actor, row.stationId, "Debtor transaction");
    assertCanWriteStation(actor, row.stationId);
    if (row.voidedAt) throw conflict("This transaction is already voided.");
    if (affectsCash(row.type, row.paymentMethod)) await assertCashDayOpen(tx, row.stationId, row.businessDate, "void this transaction");

    const [debtor] = await tx.select({ name: debtors.name }).from(debtors).where(eq(debtors.id, row.debtorId)).for("update");
    const balance = await balanceOf(tx, row.debtorId);
    const after = money(balance + (row.type === "repayment" ? row.amount : -row.amount));
    if (after < 0) throw conflict("Voiding this charge would leave repayments exceeding charges. Void the related repayment first.");

    await tx.update(debtorTransactions).set({ voidedAt: new Date(), voidedBy: actor.id, voidReason: reason }).where(eq(debtorTransactions.id, transactionId));
    if (affectsCash(row.type, row.paymentMethod)) await refreshCashPositions(tx, row.stationId, row.businessDate);

    await recordAudit(tx, actor, {
      action: "voided",
      resource: "debtor_transaction",
      resourceId: transactionId,
      recordRef: debtor?.name ?? null,
      stationId: row.stationId,
      oldValue: { type: row.type, amount: row.amount, balance },
      newValue: { voided: true, reason, balance: after },
    });
    return row.debtorId;
  });
  return getDebtor(actor, debtorId);
}

/* ------------------------------------------------------------------------ */
/* Scheduled check                                                           */
/* ------------------------------------------------------------------------ */

export async function scanAging(): Promise<{ flagged: number }> {
  const settings = await getSettings();
  const balances = await selectRows<{ id: number; name: string; station_id: number; station_name: string; balance: number }>(
    db,
    sql`SELECT d.id, d.name, d.station_id, s.name AS station_name, COALESCE(SUM(${SIGNED}), 0) AS balance
        FROM debtors d JOIN stations s ON s.id = d.station_id
        LEFT JOIN debtor_transactions t ON t.debtor_id = d.id AND t.voided_at IS NULL
        GROUP BY d.id`,
  );
  const txs = await transactionsFor(db, balances.map((b) => b.id));
  const asOf = today();
  let flagged = 0;
  for (const b of balances) {
    const aging = computeAging(txs.get(b.id) ?? [], asOf);
    const key = { type: "debtor_aging" as const, sourceType: "debtor", sourceId: b.id };
    if (aging.balance > 0 && (aging.oldestAgeDays ?? 0) >= settings.debtorAgingAlertDays) {
      const raised = await raiseException(db, {
        ...key,
        severity: "medium",
        stationId: b.station_id,
        sourceRef: b.name.slice(0, 60),
        title: `Debtor account past ${settings.debtorAgingAlertDays}-day aging — ${b.name}`,
        detail: `Balance ₦${aging.balance.toLocaleString("en-NG")} · ${b.station_name} · oldest unpaid ${aging.oldestAgeDays} days`,
        amount: aging.balance,
        reopenOnChange: false,
      });
      if (raised) flagged++;
    } else {
      await resolveException(db, key, aging.balance > 0 ? "Account no longer past the aging threshold." : "Account settled.", null);
    }
  }
  return { flagged };
}
