/**
 * stock.service.ts — stock movement summaries, the drill-down ledger, physical
 * dips and controlled adjustments.
 *
 * Tank movement equation (per business day):
 *   closing = opening + verified receipts − metered dispensing + RTT ± adjustments
 * Net sales (what the DSR reports) = metered dispensing − RTT, so RTT is added
 * back to the tank and never counted as a sale.
 *
 * Physical dip variance = dip − system closing stock (negative = product missing).
 */
import { and, count, eq, sql } from "drizzle-orm";
import { assertCanWriteStation, assertStationAccess, stationFilter } from "../auth/scope.ts";
import { db, selectRows, type Executor, type Tx } from "../db/client.ts";
import { dsrDays, physicalDips, products, pumps, stations, stockAdjustments, tanks } from "../db/schema/index.ts";
import { assertDayNotClosed, assertNotFuture } from "../repositories/locks.repo.ts";
import { valuationPrices } from "../repositories/pricing.repo.ts";
import { formatRef, nextSequence } from "../repositories/sequence.repo.ts";
import { assertNoNegativeStock, postMovements, tankBalances } from "../repositories/stock.repo.ts";
import type { Actor } from "../types.ts";
import { monthBounds, today } from "../utils/dates.ts";
import { AppError, conflict, notFound } from "../utils/errors.ts";
import { paginationMeta } from "../utils/http.ts";
import { litres, money, num } from "../utils/numbers.ts";
import { recordAudit } from "./audit.service.ts";
import { raiseException, resolveException } from "./exceptions.service.ts";
import { getSettings } from "./settings.service.ts";

export async function loadTank(ex: Executor, tankId: number) {
  const [tank] = await ex
    .select({
      id: tanks.id,
      name: tanks.name,
      status: tanks.status,
      capacity: tanks.capacity,
      stationId: tanks.stationId,
      productId: tanks.productId,
      stationName: stations.name,
      stationCode: stations.code,
      stockTolerance: stations.stockTolerance,
      productCode: products.code,
    })
    .from(tanks)
    .innerJoin(stations, eq(stations.id, tanks.stationId))
    .innerJoin(products, eq(products.id, tanks.productId))
    .where(eq(tanks.id, tankId))
    .limit(1);
  return tank ?? null;
}

type LoadedTank = NonNullable<Awaited<ReturnType<typeof loadTank>>>;

/* ------------------------------------------------------------------------ */
/* Movement summary                                                          */
/* ------------------------------------------------------------------------ */

export async function getMovementSummary(actor: Actor, q: { stationId: number; productId: number; tankId?: number; date?: string }) {
  assertStationAccess(actor, q.stationId, "Station");
  const date = q.date ?? today();
  const tankCond = q.tankId ? sql` AND tank_id = ${q.tankId}` : sql``;

  const [row] = await selectRows<Record<string, number>>(
    db,
    sql`SELECT
          COALESCE(SUM(CASE WHEN business_date < ${date} OR movement_type = 'opening_balance' AND business_date = ${date} THEN quantity END), 0) AS opening,
          COALESCE(SUM(CASE WHEN business_date = ${date} AND movement_type = 'receipt' THEN quantity END), 0) AS receipts,
          COALESCE(SUM(CASE WHEN business_date = ${date} AND movement_type = 'dispensed' THEN quantity END), 0) AS dispensed,
          COALESCE(SUM(CASE WHEN business_date = ${date} AND movement_type = 'rtt' THEN quantity END), 0) AS rtt,
          COALESCE(SUM(CASE WHEN business_date = ${date} AND movement_type = 'adjustment' THEN quantity END), 0) AS adjustments
        FROM stock_ledger
        WHERE voided_at IS NULL AND station_id = ${q.stationId} AND product_id = ${q.productId}
          AND business_date <= ${date} ${tankCond}`,
  );

  const opening = litres(num(row?.opening));
  const receipts = litres(num(row?.receipts));
  const dispensed = litres(-num(row?.dispensed));
  const rtt = litres(num(row?.rtt));
  const adjustments = litres(num(row?.adjustments));
  const closing = litres(opening + receipts - dispensed + rtt + adjustments);

  const scopeTanks = await db
    .select({ id: tanks.id, name: tanks.name })
    .from(tanks)
    .where(
      and(
        eq(tanks.stationId, q.stationId),
        eq(tanks.productId, q.productId),
        eq(tanks.status, "active"),
        q.tankId ? eq(tanks.id, q.tankId) : undefined,
      ),
    );
  const dips = await db
    .select({
      tankId: physicalDips.tankId,
      ref: physicalDips.ref,
      dipLitres: physicalDips.dipLitres,
      systemStock: physicalDips.systemStock,
      variance: physicalDips.variance,
      toleranceStatus: physicalDips.toleranceStatus,
    })
    .from(physicalDips)
    .where(
      and(
        eq(physicalDips.stationId, q.stationId),
        eq(physicalDips.productId, q.productId),
        eq(physicalDips.businessDate, date),
        q.tankId ? eq(physicalDips.tankId, q.tankId) : undefined,
      ),
    );

  // A product-level variance only makes sense once every tank has been dipped.
  const complete = scopeTanks.length > 0 && scopeTanks.every((t) => dips.some((d) => d.tankId === t.id));
  const dipTotal = complete ? litres(dips.reduce((s, d) => s + d.dipLitres, 0)) : null;

  const [station] = await db.select({ name: stations.name, stockTolerance: stations.stockTolerance }).from(stations).where(eq(stations.id, q.stationId));
  const [product] = await db.select({ code: products.code }).from(products).where(eq(products.id, q.productId));

  return {
    stationId: q.stationId,
    stationName: station?.name ?? null,
    productId: q.productId,
    productCode: product?.code ?? null,
    tankId: q.tankId ?? null,
    date,
    opening,
    receipts,
    dispensed,
    rtt,
    adjustments,
    closing,
    netSales: litres(dispensed - rtt),
    physicalDip: dipTotal,
    variance: dipTotal === null ? null : litres(dipTotal - closing),
    dips,
    tanksDipped: dips.length,
    tanksTotal: scopeTanks.length,
    tolerance: station?.stockTolerance ?? 0,
  };
}

/* ------------------------------------------------------------------------ */
/* Ledger drill-down                                                         */
/* ------------------------------------------------------------------------ */

interface LedgerRow {
  id: number;
  business_date: string;
  movement_type: string;
  quantity: number;
  source_type: string;
  source_id: number;
  source_ref: string;
  tank_id: number;
  tank_name: string;
  product_id: number;
  product_code: string;
  station_id: number;
  station_name: string;
  running_balance: number;
  created_at: string;
}

export async function getLedger(
  actor: Actor,
  q: { stationId?: number; productId?: number; tankId?: number; from?: string; to?: string; page: number; limit: number; sortOrder: "asc" | "desc" },
) {
  const stationId = stationFilter(actor, q.stationId);
  const to = q.to ?? today();
  const from = q.from ?? monthBounds(to.slice(0, 7)).from;
  if (from > to) throw new AppError("VALIDATION_ERROR", "'From' date must be on or before 'to' date.", { fields: { from: "Must be on or before 'to'." } });

  if (q.tankId) {
    const tank = await loadTank(db, q.tankId);
    if (!tank) throw notFound("Tank");
    assertStationAccess(actor, tank.stationId, "Tank");
  }

  const filters = sql.join(
    [
      sql`l.voided_at IS NULL`,
      stationId !== null ? sql`l.station_id = ${stationId}` : undefined,
      q.productId ? sql`l.product_id = ${q.productId}` : undefined,
      q.tankId ? sql`l.tank_id = ${q.tankId}` : undefined,
    ].filter((s): s is ReturnType<typeof sql> => s !== undefined),
    sql` AND `,
  );
  const partition = q.tankId ? sql`l.tank_id` : sql`l.station_id, l.product_id`;
  const direction = q.sortOrder === "asc" ? sql`ASC` : sql`DESC`;

  const [rows, [countRow]] = await Promise.all([
    selectRows<LedgerRow>(
      db,
      sql`SELECT * FROM (
            SELECT l.id, l.business_date, l.movement_type, l.quantity, l.source_type, l.source_id, l.source_ref,
                   l.tank_id, t.name AS tank_name, l.product_id, p.code AS product_code,
                   l.station_id, s.name AS station_name, l.created_at,
                   SUM(l.quantity) OVER (PARTITION BY ${partition} ORDER BY l.business_date, l.id) AS running_balance
            FROM stock_ledger l
            JOIN tanks t ON t.id = l.tank_id
            JOIN products p ON p.id = l.product_id
            JOIN stations s ON s.id = l.station_id
            WHERE ${filters} AND l.business_date <= ${to}
          ) x
          WHERE x.business_date >= ${from}
          ORDER BY x.business_date ${direction}, x.id ${direction}
          LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
    ),
    selectRows<{ n: number }>(
      db,
      sql`SELECT COUNT(*) AS n FROM stock_ledger l WHERE ${filters} AND l.business_date BETWEEN ${from} AND ${to}`,
    ),
  ]);

  const movements = rows.map((r) => ({
    kind: "movement" as const,
    id: r.id,
    businessDate: r.business_date,
    movementType: r.movement_type,
    quantity: litres(num(r.quantity)),
    runningBalance: litres(num(r.running_balance)),
    sourceType: r.source_type,
    sourceId: r.source_id,
    sourceRef: r.source_ref,
    tankId: r.tank_id,
    tankName: r.tank_name,
    productCode: r.product_code,
    stationName: r.station_name,
  }));

  // Physical dips are observations, not movements: shown alongside the ledger
  // for the dates on this page but never part of the running balance.
  let dips: Array<Record<string, unknown>> = [];
  if (movements.length > 0) {
    const dates = movements.map((m) => m.businessDate).sort();
    const dipRows = await db
      .select({
        id: physicalDips.id,
        businessDate: physicalDips.businessDate,
        ref: physicalDips.ref,
        dipLitres: physicalDips.dipLitres,
        systemStock: physicalDips.systemStock,
        variance: physicalDips.variance,
        toleranceStatus: physicalDips.toleranceStatus,
        tankId: physicalDips.tankId,
        tankName: tanks.name,
        productCode: products.code,
        stationName: stations.name,
      })
      .from(physicalDips)
      .innerJoin(tanks, eq(tanks.id, physicalDips.tankId))
      .innerJoin(products, eq(products.id, physicalDips.productId))
      .innerJoin(stations, eq(stations.id, physicalDips.stationId))
      .where(
        and(
          sql`${physicalDips.businessDate} BETWEEN ${dates[0]} AND ${dates[dates.length - 1]}`,
          stationId !== null ? eq(physicalDips.stationId, stationId) : undefined,
          q.productId ? eq(physicalDips.productId, q.productId) : undefined,
          q.tankId ? eq(physicalDips.tankId, q.tankId) : undefined,
        ),
      );
    dips = dipRows.map((d) => ({ kind: "dip" as const, ...d }));
  }

  return {
    rows: movements,
    dips,
    range: { from, to },
    pagination: paginationMeta(q.page, q.limit, num(countRow?.n)),
  };
}

/* ------------------------------------------------------------------------ */
/* Tank status                                                               */
/* ------------------------------------------------------------------------ */

interface TankStatusRow {
  id: number;
  name: string;
  capacity: number | null;
  station_id: number;
  station_name: string;
  stock_tolerance: number;
  product_id: number;
  product_code: string;
  balance: number;
  dip_ref: string | null;
  dip_date: string | null;
  dip_litres: number | null;
  system_stock: number | null;
  variance: number | null;
  tolerance: number | null;
  tolerance_status: "within_tolerance" | "exceeded" | null;
}

export async function getTankStatus(actor: Actor, q: { stationId?: number }) {
  const stationId = stationFilter(actor, q.stationId);
  const rows = await selectRows<TankStatusRow>(
    db,
    sql`SELECT t.id, t.name, t.capacity, t.station_id, s.name AS station_name, s.stock_tolerance,
               t.product_id, p.code AS product_code,
               (SELECT COALESCE(SUM(l.quantity), 0) FROM stock_ledger l WHERE l.tank_id = t.id AND l.voided_at IS NULL) AS balance,
               d.ref AS dip_ref, d.business_date AS dip_date, d.dip_litres, d.system_stock, d.variance, d.tolerance, d.tolerance_status
        FROM tanks t
        JOIN stations s ON s.id = t.station_id
        JOIN products p ON p.id = t.product_id
        LEFT JOIN physical_dips d ON d.id = (
          SELECT d2.id FROM physical_dips d2 WHERE d2.tank_id = t.id ORDER BY d2.business_date DESC, d2.id DESC LIMIT 1
        )
        WHERE t.status = 'active' ${stationId !== null ? sql`AND t.station_id = ${stationId}` : sql``}
        ORDER BY FIELD(d.tolerance_status, 'exceeded') DESC, s.name, p.code, t.name`,
  );

  const prices = await valuationPrices(db, rows.map((r) => ({ stationId: r.station_id, productId: r.product_id })), today());
  return rows.map((r) => {
    const balance = litres(num(r.balance));
    const price = prices.get(`${r.station_id}:${r.product_id}`) ?? 0;
    return {
      id: r.id,
      name: r.name,
      capacity: r.capacity,
      stationId: r.station_id,
      stationName: r.station_name,
      productId: r.product_id,
      productCode: r.product_code,
      balance,
      valuationPrice: price,
      stockValue: money(balance * price),
      stockTolerance: num(r.stock_tolerance),
      latestDip: r.dip_ref
        ? {
            ref: r.dip_ref,
            businessDate: r.dip_date,
            dipLitres: num(r.dip_litres),
            systemStock: num(r.system_stock),
            variance: num(r.variance),
            tolerance: num(r.tolerance),
            toleranceStatus: r.tolerance_status,
          }
        : null,
    };
  });
}

export async function getSystemClosing(actor: Actor, tankId: number, date?: string) {
  const tank = await loadTank(db, tankId);
  if (!tank) throw notFound("Tank");
  assertStationAccess(actor, tank.stationId, "Tank");
  const day = date ?? today();
  const balance = (await tankBalances(db, [tankId], day)).get(tankId) ?? 0;
  const [dsr] = await db
    .select({ status: dsrDays.status, ref: dsrDays.ref })
    .from(dsrDays)
    .where(and(eq(dsrDays.stationId, tank.stationId), eq(dsrDays.businessDate, day)))
    .limit(1);
  const [existingDip] = await db
    .select({ ref: physicalDips.ref, dipLitres: physicalDips.dipLitres })
    .from(physicalDips)
    .where(and(eq(physicalDips.tankId, tankId), eq(physicalDips.businessDate, day)))
    .limit(1);
  return {
    tankId,
    tankName: tank.name,
    stationName: tank.stationName,
    productCode: tank.productCode,
    date: day,
    systemStock: balance,
    tolerance: tank.stockTolerance,
    dsrStatus: dsr?.status ?? "not_opened",
    dsrRef: dsr?.ref ?? null,
    existingDip: existingDip ?? null,
  };
}

/* ------------------------------------------------------------------------ */
/* Physical dips                                                             */
/* ------------------------------------------------------------------------ */

async function requireClosedDayForDip(tx: Tx, stationId: number, date: string) {
  const [pumpCount] = await tx
    .select({ n: count() })
    .from(pumps)
    .where(and(eq(pumps.stationId, stationId), eq(pumps.status, "active")));
  if (!pumpCount || pumpCount.n === 0) return; // storage-only station: no sales to wait for
  const [day] = await tx
    .select({ status: dsrDays.status })
    .from(dsrDays)
    .where(and(eq(dsrDays.stationId, stationId), eq(dsrDays.businessDate, date)))
    .limit(1);
  if (day?.status !== "closed") {
    throw conflict(`Close the DSR for ${date} before recording a physical dip, so system stock includes the day's sales.`);
  }
}

async function syncDipException(
  tx: Tx,
  dip: { id: number; ref: string; businessDate: string; systemStock: number; dipLitres: number; variance: number; tolerance: number; toleranceStatus: string },
  tank: LoadedTank,
) {
  const key = { type: "stock_variance" as const, sourceType: "physical_dip", sourceId: dip.id };
  if (dip.toleranceStatus === "exceeded") {
    const sign = dip.variance > 0 ? "+" : "−";
    const raised = await raiseException(tx, {
      ...key,
      severity: "high",
      stationId: tank.stationId,
      sourceRef: dip.ref,
      title: `Physical dip variance ${sign}${Math.abs(dip.variance).toLocaleString("en-NG")}L ${tank.name} — ${tank.stationName}, ${dip.businessDate}`,
      detail: `System closing ${dip.systemStock.toLocaleString("en-NG")}L vs dip ${dip.dipLitres.toLocaleString("en-NG")}L · tolerance ±${dip.tolerance.toLocaleString("en-NG")}L`,
      amount: dip.variance,
    });
    if (raised) {
      await recordAudit(tx, null, {
        action: "flagged",
        resource: "physical_dip",
        resourceId: dip.id,
        recordRef: dip.ref,
        stationId: tank.stationId,
        newValue: { note: "Variance exceeded tolerance", variance: dip.variance, tolerance: dip.tolerance },
      });
    }
  } else {
    await resolveException(tx, key, "Variance within tolerance after recalculation.", null);
  }
}

export async function recordDip(actor: Actor, input: { tankId: number; businessDate: string; dipLitres: number; note?: string | null }) {
  return db.transaction(async (tx) => {
    const tank = await loadTank(tx, input.tankId);
    if (!tank) throw notFound("Tank");
    assertStationAccess(actor, tank.stationId, "Tank");
    assertCanWriteStation(actor, tank.stationId);
    if (tank.status !== "active") throw conflict("This tank is inactive.");
    assertNotFuture(input.businessDate);
    await requireClosedDayForDip(tx, tank.stationId, input.businessDate);

    const [existing] = await tx
      .select({ ref: physicalDips.ref })
      .from(physicalDips)
      .where(and(eq(physicalDips.tankId, tank.id), eq(physicalDips.businessDate, input.businessDate)))
      .limit(1);
    if (existing) throw conflict(`A physical dip for ${tank.name} on ${input.businessDate} is already recorded (${existing.ref}).`);

    const systemStock = (await tankBalances(tx, [tank.id], input.businessDate)).get(tank.id) ?? 0;
    const dipLitres = litres(input.dipLitres);
    const variance = litres(dipLitres - systemStock);
    const tolerance = tank.stockTolerance;
    const toleranceStatus = Math.abs(variance) > tolerance ? ("exceeded" as const) : ("within_tolerance" as const);
    const ref = formatRef("DIP", await nextSequence(tx, "DIP"), 5);

    const [inserted] = await tx
      .insert(physicalDips)
      .values({
        ref,
        stationId: tank.stationId,
        tankId: tank.id,
        productId: tank.productId,
        businessDate: input.businessDate,
        systemStock,
        dipLitres,
        variance,
        tolerance,
        toleranceStatus,
        note: input.note ?? null,
        recordedBy: actor.id,
      })
      .$returningId();
    const id = inserted!.id;

    await recordAudit(tx, actor, {
      action: "created",
      resource: "physical_dip",
      resourceId: id,
      recordRef: ref,
      stationId: tank.stationId,
      newValue: { tank: tank.name, businessDate: input.businessDate, systemStock, dipLitres, variance, toleranceStatus },
    });
    const dip = { id, ref, businessDate: input.businessDate, systemStock, dipLitres, variance, tolerance, toleranceStatus };
    await syncDipException(tx, dip, tank);
    return { ...dip, tankId: tank.id, tankName: tank.name, stationId: tank.stationId, stationName: tank.stationName, productCode: tank.productCode };
  });
}

/** Re-evaluates dips after a reopened day is closed again with different figures. */
export async function recomputeDipsForDay(tx: Tx, stationId: number, date: string): Promise<void> {
  const dips = await tx
    .select()
    .from(physicalDips)
    .where(and(eq(physicalDips.stationId, stationId), eq(physicalDips.businessDate, date)));
  for (const dip of dips) {
    const tank = await loadTank(tx, dip.tankId);
    if (!tank) continue;
    const systemStock = (await tankBalances(tx, [dip.tankId], date)).get(dip.tankId) ?? 0;
    const variance = litres(dip.dipLitres - systemStock);
    const toleranceStatus = Math.abs(variance) > dip.tolerance ? ("exceeded" as const) : ("within_tolerance" as const);
    if (systemStock !== dip.systemStock) {
      await tx.update(physicalDips).set({ systemStock, variance, toleranceStatus }).where(eq(physicalDips.id, dip.id));
      await recordAudit(tx, null, {
        action: "updated",
        resource: "physical_dip",
        resourceId: dip.id,
        recordRef: dip.ref,
        stationId,
        oldValue: { systemStock: dip.systemStock, variance: dip.variance, toleranceStatus: dip.toleranceStatus },
        newValue: { systemStock, variance, toleranceStatus, note: "Recalculated after day was re-closed" },
      });
    }
    await syncDipException(tx, { ...dip, systemStock, variance, toleranceStatus }, tank);
  }
}

/* ------------------------------------------------------------------------ */
/* Adjustments                                                               */
/* ------------------------------------------------------------------------ */

export async function recordAdjustment(actor: Actor, input: { tankId: number; businessDate: string; quantity: number; reason: string }) {
  return db.transaction(async (tx) => {
    const tank = await loadTank(tx, input.tankId);
    if (!tank) throw notFound("Tank");
    assertStationAccess(actor, tank.stationId, "Tank");
    assertCanWriteStation(actor, tank.stationId);
    if (tank.status !== "active") throw conflict("This tank is inactive.");
    assertNotFuture(input.businessDate);
    await assertDayNotClosed(tx, tank.stationId, input.businessDate, "post a stock adjustment");

    const quantity = litres(input.quantity);
    const ref = formatRef("ADJ", await nextSequence(tx, "ADJ"), 5);
    const [inserted] = await tx
      .insert(stockAdjustments)
      .values({
        ref,
        stationId: tank.stationId,
        tankId: tank.id,
        productId: tank.productId,
        businessDate: input.businessDate,
        quantity,
        reason: input.reason,
        createdBy: actor.id,
      })
      .$returningId();
    const id = inserted!.id;

    await postMovements(tx, [
      {
        stationId: tank.stationId,
        tankId: tank.id,
        productId: tank.productId,
        businessDate: input.businessDate,
        movementType: "adjustment",
        quantity,
        sourceType: "stock_adjustment",
        sourceId: id,
        sourceRef: ref,
        createdBy: actor.id,
      },
    ]);
    const settings = await getSettings(tx);
    await assertNoNegativeStock(tx, [tank.id], input.businessDate, settings.allowNegativeStock);

    await recordAudit(tx, actor, {
      action: "created",
      resource: "stock_adjustment",
      resourceId: id,
      recordRef: ref,
      stationId: tank.stationId,
      newValue: { tank: tank.name, businessDate: input.businessDate, quantity, reason: input.reason },
    });
    return { id, ref, tankId: tank.id, tankName: tank.name, businessDate: input.businessDate, quantity, reason: input.reason };
  });
}
