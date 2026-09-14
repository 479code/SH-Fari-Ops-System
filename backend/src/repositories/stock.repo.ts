/**
 * stock.repo.ts — the stock ledger primitives.
 *
 * Tank balance on a date = SUM(quantity) of non-voided ledger rows dated on or
 * before it. Nothing else stores a balance, so opening stock is always the
 * previous closing stock and every litre traces back to a source document.
 */
import { and, eq, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import type { Executor, Tx } from "../db/client.ts";
import { stockLedger, tanks } from "../db/schema/index.ts";
import { AppError } from "../utils/errors.ts";
import { litres, num } from "../utils/numbers.ts";

export type LedgerInsert = typeof stockLedger.$inferInsert;
export type LedgerSourceType = LedgerInsert["sourceType"];

export async function postMovements(tx: Tx, rows: LedgerInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(stockLedger).values(rows.map((r) => ({ ...r, quantity: litres(r.quantity) })));
}

export async function voidMovements(
  tx: Tx,
  sourceType: LedgerSourceType,
  sourceIds: number[],
  userId: number,
  reason: string,
): Promise<number[]> {
  if (sourceIds.length === 0) return [];
  const affected = await tx
    .selectDistinct({ tankId: stockLedger.tankId })
    .from(stockLedger)
    .where(and(eq(stockLedger.sourceType, sourceType), inArray(stockLedger.sourceId, sourceIds), isNull(stockLedger.voidedAt)));
  await tx
    .update(stockLedger)
    .set({ voidedAt: new Date(), voidedBy: userId, voidReason: reason.slice(0, 255) })
    .where(and(eq(stockLedger.sourceType, sourceType), inArray(stockLedger.sourceId, sourceIds), isNull(stockLedger.voidedAt)));
  return affected.map((a) => a.tankId);
}

/** Balances per tank, optionally as of a business date. Tanks with no movements are 0. */
export async function tankBalances(ex: Executor, tankIds: number[], asOf?: string): Promise<Map<number, number>> {
  const out = new Map<number, number>(tankIds.map((id) => [id, 0]));
  if (tankIds.length === 0) return out;
  const conds: SQL[] = [inArray(stockLedger.tankId, tankIds), isNull(stockLedger.voidedAt)];
  if (asOf) conds.push(lte(stockLedger.businessDate, asOf));
  const rows = await ex
    .select({ tankId: stockLedger.tankId, balance: sql<number>`COALESCE(SUM(${stockLedger.quantity}), 0)` })
    .from(stockLedger)
    .where(and(...conds))
    .groupBy(stockLedger.tankId);
  for (const r of rows) out.set(r.tankId, litres(num(r.balance)));
  return out;
}

/**
 * Blocks a change that leaves any affected tank below zero — either on the
 * posting date or overall — unless negative stock is explicitly allowed.
 */
export async function assertNoNegativeStock(tx: Tx, tankIds: number[], date: string, allowNegative: boolean): Promise<void> {
  const unique = [...new Set(tankIds)];
  if (allowNegative || unique.length === 0) return;
  const [atDate, overall] = await Promise.all([tankBalances(tx, unique, date), tankBalances(tx, unique)]);
  const negative = unique.filter((id) => (atDate.get(id) ?? 0) < -0.001 || (overall.get(id) ?? 0) < -0.001);
  if (negative.length === 0) return;
  const names = await tx.select({ id: tanks.id, name: tanks.name }).from(tanks).where(inArray(tanks.id, negative));
  const detail = names
    .map((t) => `${t.name} (${Math.min(atDate.get(t.id) ?? 0, overall.get(t.id) ?? 0).toLocaleString("en-NG")} L)`)
    .join(", ");
  throw new AppError(
    "CONFLICT",
    `This would take stock below zero for ${detail}. Record the missing receipt or adjustment first, or allow negative stock in Setup.`,
  );
}
