/**
 * masterdata.service.ts — products and pump prices, the expense narration list
 * and the bank list.
 *
 * Prices are append-only: a change inserts a new effective-dated row, so the
 * price in force on any past date can always be reconstructed.
 */
import { and, desc, eq, isNull, lte, ne, sql } from "drizzle-orm";
import { db, selectRows } from "../db/client.ts";
import { banks, expenseNarrations, productPrices, products, stations, users } from "../db/schema/index.ts";
import { pumpPriceAt } from "../repositories/pricing.repo.ts";
import type { Actor } from "../types.ts";
import { today } from "../utils/dates.ts";
import { AppError, notFound } from "../utils/errors.ts";
import { num } from "../utils/numbers.ts";
import { recordAudit } from "./audit.service.ts";

const pick = <T extends object>(input: T) => Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>;

/* Products & prices -------------------------------------------------------- */

export async function listProducts() {
  const rows = await selectRows<{ id: number; code: string; name: string; status: "active" | "inactive"; station_overrides: number }>(
    db,
    sql`SELECT p.id, p.code, p.name, p.status,
               (SELECT COUNT(DISTINCT pp.station_id) FROM product_prices pp WHERE pp.product_id = p.id AND pp.station_id IS NOT NULL) AS station_overrides
        FROM products p ORDER BY p.status, p.code`,
  );
  const date = today();
  const out = [];
  for (const r of rows) {
    const [price] = await db
      .select({ price: productPrices.price, effectiveFrom: productPrices.effectiveFrom })
      .from(productPrices)
      .where(and(eq(productPrices.productId, r.id), isNull(productPrices.stationId), lte(productPrices.effectiveFrom, date)))
      .orderBy(desc(productPrices.effectiveFrom), desc(productPrices.id))
      .limit(1);
    out.push({
      id: r.id,
      code: r.code,
      name: r.name,
      status: r.status,
      defaultPrice: price?.price ?? null,
      priceEffectiveFrom: price?.effectiveFrom ?? null,
      stationOverrides: num(r.station_overrides),
    });
  }
  return out;
}

export async function createProduct(actor: Actor, input: { code: string; name: string; price?: number; effectiveFrom?: string }) {
  return db.transaction(async (tx) => {
    const [dup] = await tx.select({ id: products.id }).from(products).where(eq(products.code, input.code));
    if (dup) throw new AppError("CONFLICT", `Product code ${input.code} already exists.`, { fields: { code: "Code already in use." } });
    const [inserted] = await tx.insert(products).values({ code: input.code, name: input.name }).$returningId();
    if (input.price) {
      await tx.insert(productPrices).values({
        productId: inserted!.id,
        stationId: null,
        price: input.price,
        effectiveFrom: input.effectiveFrom ?? today(),
        createdBy: actor.id,
      });
    }
    await recordAudit(tx, actor, { action: "created", resource: "product", resourceId: inserted!.id, recordRef: input.code, newValue: input });
    return { id: inserted!.id, ...input };
  });
}

export async function updateProduct(actor: Actor, id: number, input: { name?: string; status?: "active" | "inactive" }) {
  return db.transaction(async (tx) => {
    const [product] = await tx.select().from(products).where(eq(products.id, id)).for("update");
    if (!product) throw notFound("Product");
    const patch = pick(input);
    await tx.update(products).set(patch).where(eq(products.id, id));
    await recordAudit(tx, actor, {
      action: "updated",
      resource: "product",
      resourceId: id,
      recordRef: product.code,
      oldValue: Object.fromEntries(Object.keys(patch).map((k) => [k, product[k as keyof typeof product]])),
      newValue: patch,
    });
    return { ...product, ...patch };
  });
}

export async function listPrices(productId: number) {
  return db
    .select({
      id: productPrices.id,
      stationId: productPrices.stationId,
      stationName: stations.name,
      price: productPrices.price,
      effectiveFrom: productPrices.effectiveFrom,
      createdByName: users.fullName,
      createdAt: productPrices.createdAt,
    })
    .from(productPrices)
    .leftJoin(stations, eq(stations.id, productPrices.stationId))
    .leftJoin(users, eq(users.id, productPrices.createdBy))
    .where(eq(productPrices.productId, productId))
    .orderBy(desc(productPrices.effectiveFrom), desc(productPrices.id));
}

export async function addPrice(actor: Actor, productId: number, input: { stationId?: number | null; price: number; effectiveFrom: string }) {
  await db.transaction(async (tx) => {
    const [product] = await tx.select({ code: products.code }).from(products).where(eq(products.id, productId));
    if (!product) throw notFound("Product");
    let stationName = "All stations";
    if (input.stationId) {
      const [station] = await tx.select({ name: stations.name }).from(stations).where(eq(stations.id, input.stationId));
      if (!station) throw new AppError("VALIDATION_ERROR", "Select a valid station.", { fields: { stationId: "Select a valid station." } });
      stationName = station.name;
    }
    const previous = input.stationId ? await pumpPriceAt(tx, input.stationId, productId, input.effectiveFrom) : null;
    const [inserted] = await tx
      .insert(productPrices)
      .values({ productId, stationId: input.stationId ?? null, price: input.price, effectiveFrom: input.effectiveFrom, createdBy: actor.id })
      .$returningId();
    await recordAudit(tx, actor, {
      action: "created",
      resource: "product_price",
      resourceId: inserted!.id,
      recordRef: `${product.code} ${stationName}`,
      stationId: input.stationId ?? null,
      oldValue: previous === null ? null : { price: previous },
      newValue: { price: input.price, effectiveFrom: input.effectiveFrom, station: stationName },
    });
  });
  return listPrices(productId);
}

/* Narrations ----------------------------------------------------------------- */

export async function listNarrations() {
  return db.select().from(expenseNarrations).orderBy(expenseNarrations.status, expenseNarrations.name);
}

export async function createNarration(actor: Actor, input: { name: string; approvalThreshold?: number | null }) {
  return db.transaction(async (tx) => {
    const [dup] = await tx.select({ id: expenseNarrations.id }).from(expenseNarrations).where(eq(expenseNarrations.name, input.name));
    if (dup) throw new AppError("CONFLICT", `"${input.name}" is already on the narration list.`, { fields: { name: "Already on the list." } });
    const [inserted] = await tx.insert(expenseNarrations).values({ name: input.name, approvalThreshold: input.approvalThreshold ?? null }).$returningId();
    await recordAudit(tx, actor, { action: "created", resource: "expense_narration", resourceId: inserted!.id, recordRef: input.name, newValue: input });
    return { id: inserted!.id };
  });
}

export async function updateNarration(actor: Actor, id: number, input: { name?: string; approvalThreshold?: number | null; status?: "active" | "inactive" }) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(expenseNarrations).where(eq(expenseNarrations.id, id)).for("update");
    if (!row) throw notFound("Narration");
    if (input.name && input.name !== row.name) {
      const [dup] = await tx.select({ id: expenseNarrations.id }).from(expenseNarrations).where(and(eq(expenseNarrations.name, input.name), ne(expenseNarrations.id, id)));
      if (dup) throw new AppError("CONFLICT", `"${input.name}" is already on the narration list.`, { fields: { name: "Already on the list." } });
    }
    const patch = pick(input);
    await tx.update(expenseNarrations).set(patch).where(eq(expenseNarrations.id, id));
    await recordAudit(tx, actor, {
      action: "updated",
      resource: "expense_narration",
      resourceId: id,
      recordRef: row.name,
      oldValue: Object.fromEntries(Object.keys(patch).map((k) => [k, row[k as keyof typeof row]])),
      newValue: patch,
    });
    return { id };
  });
}

/* Banks ------------------------------------------------------------------------ */

export async function listBanks() {
  return db.select().from(banks).orderBy(banks.status, banks.name);
}

export async function createBank(actor: Actor, input: { name: string }) {
  return db.transaction(async (tx) => {
    const [dup] = await tx.select({ id: banks.id }).from(banks).where(eq(banks.name, input.name));
    if (dup) throw new AppError("CONFLICT", `${input.name} is already on the bank list.`, { fields: { name: "Already on the list." } });
    const [inserted] = await tx.insert(banks).values({ name: input.name }).$returningId();
    await recordAudit(tx, actor, { action: "created", resource: "bank", resourceId: inserted!.id, recordRef: input.name, newValue: input });
    return { id: inserted!.id };
  });
}

export async function updateBank(actor: Actor, id: number, input: { name?: string; status?: "active" | "inactive" }) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(banks).where(eq(banks.id, id)).for("update");
    if (!row) throw notFound("Bank");
    if (input.name && input.name !== row.name) {
      const [dup] = await tx.select({ id: banks.id }).from(banks).where(and(eq(banks.name, input.name), ne(banks.id, id)));
      if (dup) throw new AppError("CONFLICT", `${input.name} is already on the bank list.`, { fields: { name: "Already on the list." } });
    }
    const patch = pick(input);
    await tx.update(banks).set(patch).where(eq(banks.id, id));
    await recordAudit(tx, actor, {
      action: "updated",
      resource: "bank",
      resourceId: id,
      recordRef: row.name,
      oldValue: Object.fromEntries(Object.keys(patch).map((k) => [k, row[k as keyof typeof row]])),
      newValue: patch,
    });
    return { id };
  });
}
