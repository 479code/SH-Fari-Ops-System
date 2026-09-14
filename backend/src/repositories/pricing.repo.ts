/**
 * pricing.repo.ts — price lookups shared by DSR, stock valuation and reporting.
 *
 * - Pump (selling) price: the latest product_prices row effective on the date,
 *   preferring a station-specific price over the company-wide default.
 * - Cost / valuation price: the landing price of the latest verified truck
 *   receipt on or before the date at that station, falling back to the latest
 *   verified receipt at any station.
 */
import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { productPrices, truckReceipts } from "../db/schema/index.ts";

export async function pumpPriceAt(ex: Executor, stationId: number, productId: number, date: string): Promise<number | null> {
  const [row] = await ex
    .select({ price: productPrices.price })
    .from(productPrices)
    .where(
      and(
        eq(productPrices.productId, productId),
        lte(productPrices.effectiveFrom, date),
        or(eq(productPrices.stationId, stationId), isNull(productPrices.stationId)),
      ),
    )
    .orderBy(sql`${productPrices.stationId} IS NULL`, desc(productPrices.effectiveFrom), desc(productPrices.id))
    .limit(1);
  return row ? row.price : null;
}

export async function landingCostAt(ex: Executor, stationId: number, productId: number, date: string): Promise<number | null> {
  const base = [eq(truckReceipts.productId, productId), eq(truckReceipts.status, "verified"), lte(truckReceipts.businessDate, date)];
  const [own] = await ex
    .select({ price: truckReceipts.landingPrice })
    .from(truckReceipts)
    .where(and(...base, eq(truckReceipts.stationId, stationId)))
    .orderBy(desc(truckReceipts.businessDate), desc(truckReceipts.id))
    .limit(1);
  if (own) return own.price;
  const [any] = await ex
    .select({ price: truckReceipts.landingPrice })
    .from(truckReceipts)
    .where(and(...base))
    .orderBy(desc(truckReceipts.businessDate), desc(truckReceipts.id))
    .limit(1);
  return any ? any.price : null;
}

/** Valuation prices for several (station, product) pairs, keyed "stationId:productId". */
export async function valuationPrices(
  ex: Executor,
  pairs: { stationId: number; productId: number }[],
  date: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const p of pairs) {
    const key = `${p.stationId}:${p.productId}`;
    if (out.has(key)) continue;
    out.set(key, (await landingCostAt(ex, p.stationId, p.productId, date)) ?? 0);
  }
  return out;
}
