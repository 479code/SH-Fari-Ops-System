/**
 * dsr.service.ts — the Daily Sales Record.
 *
 * Open day   → a reading row per active pump; opening = the pump's previous
 *              closed closing reading (or its initial reading on day one).
 * Readings   → closing readings entered during/at the end of the day.
 * Close day  → per pump: dispensed = closing − opening, net sales = dispensed − RTT,
 *              value = net × pump price. Figures are snapshotted, dispensing and
 *              RTT are posted to the stock ledger, and the day is locked.
 * Reopen day → authorised, reason required, audit logged; ledger postings are
 *              voided until the day is closed again. Only the latest day can be
 *              reopened, so carried-forward readings can never diverge.
 */
import { and, asc, count, desc, eq, gt, inArray, lt, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { assertCanWriteStation, assertStationAccess, stationFilter } from "../auth/scope.ts";
import { db, type Executor, type Tx } from "../db/client.ts";
import { cashPositions, dsrDays, dsrReadings, products, pumps, rttEntries, stations, tanks, users } from "../db/schema/index.ts";
import { assertNotFuture } from "../repositories/locks.repo.ts";
import { landingCostAt, pumpPriceAt } from "../repositories/pricing.repo.ts";
import { assertNoNegativeStock, postMovements, voidMovements, type LedgerInsert } from "../repositories/stock.repo.ts";
import type { Actor } from "../types.ts";
import { resolveRange, today } from "../utils/dates.ts";
import { AppError, conflict, notFound } from "../utils/errors.ts";
import { paginationMeta } from "../utils/http.ts";
import { litres, money, num } from "../utils/numbers.ts";
import { recordAudit } from "./audit.service.ts";
import { refreshCashPositions } from "./cash.service.ts";
import { getSettings } from "./settings.service.ts";
import { recomputeDipsForDay } from "./stock.service.ts";

const opener = alias(users, "opener");
const closer = alias(users, "closer");
const reopener = alias(users, "reopener");

async function previousClosingReading(ex: Executor, pumpId: number, date: string): Promise<number | null> {
  const [prev] = await ex
    .select({ closing: dsrReadings.closingReading })
    .from(dsrReadings)
    .innerJoin(dsrDays, eq(dsrDays.id, dsrReadings.dsrDayId))
    .where(and(eq(dsrReadings.pumpId, pumpId), eq(dsrDays.status, "closed"), lt(dsrDays.businessDate, date)))
    .orderBy(desc(dsrDays.businessDate))
    .limit(1);
  return prev?.closing ?? null;
}

async function stationPumps(ex: Executor, stationId: number, activeOnly = true) {
  return ex
    .select({
      pumpId: pumps.id,
      pumpName: pumps.name,
      meterLabel: pumps.meterLabel,
      initialReading: pumps.initialReading,
      status: pumps.status,
      tankId: tanks.id,
      tankName: tanks.name,
      productId: products.id,
      productCode: products.code,
    })
    .from(pumps)
    .innerJoin(tanks, eq(tanks.id, pumps.tankId))
    .innerJoin(products, eq(products.id, tanks.productId))
    .where(and(eq(pumps.stationId, stationId), activeOnly ? eq(pumps.status, "active") : undefined))
    .orderBy(asc(pumps.name));
}

async function rttByPump(ex: Executor, stationId: number, date: string) {
  const rows = await ex
    .select({ pumpId: rttEntries.pumpId, total: sql<number>`COALESCE(SUM(${rttEntries.quantity}), 0)` })
    .from(rttEntries)
    .where(and(eq(rttEntries.stationId, stationId), eq(rttEntries.businessDate, date), eq(rttEntries.status, "active")))
    .groupBy(rttEntries.pumpId);
  return new Map(rows.map((r) => [r.pumpId, litres(num(r.total))]));
}

/** Why a day cannot be opened, or null if it can. */
async function openBlocker(ex: Executor, stationId: number, date: string): Promise<string | null> {
  if (date > today()) return "A business day cannot be opened in the future.";
  const [earlierOpen] = await ex
    .select({ ref: dsrDays.ref, businessDate: dsrDays.businessDate })
    .from(dsrDays)
    .where(and(eq(dsrDays.stationId, stationId), eq(dsrDays.status, "open"), lt(dsrDays.businessDate, date)))
    .limit(1);
  if (earlierOpen) return `The DSR for ${earlierOpen.businessDate} (${earlierOpen.ref}) is still open. Close it before opening a later day.`;
  const [later] = await ex
    .select({ businessDate: dsrDays.businessDate })
    .from(dsrDays)
    .where(and(eq(dsrDays.stationId, stationId), gt(dsrDays.businessDate, date)))
    .orderBy(desc(dsrDays.businessDate))
    .limit(1);
  if (later) return `A later business day (${later.businessDate}) already exists. Days must be recorded in order.`;
  return null;
}

/* ------------------------------------------------------------------------ */
/* Read                                                                      */
/* ------------------------------------------------------------------------ */

export async function getDay(actor: Actor, stationId: number, date: string) {
  assertStationAccess(actor, stationId, "Station");
  const [station] = await db.select({ id: stations.id, name: stations.name, code: stations.code }).from(stations).where(eq(stations.id, stationId));
  if (!station) throw notFound("Station");

  const [day] = await db
    .select({
      id: dsrDays.id,
      ref: dsrDays.ref,
      status: dsrDays.status,
      businessDate: dsrDays.businessDate,
      openedAt: dsrDays.openedAt,
      openedByName: opener.fullName,
      closedAt: dsrDays.closedAt,
      closedByName: closer.fullName,
      reopenCount: dsrDays.reopenCount,
      lastReopenedAt: dsrDays.lastReopenedAt,
      lastReopenedByName: reopener.fullName,
      lastReopenReason: dsrDays.lastReopenReason,
    })
    .from(dsrDays)
    .leftJoin(opener, eq(opener.id, dsrDays.openedBy))
    .leftJoin(closer, eq(closer.id, dsrDays.closedBy))
    .leftJoin(reopener, eq(reopener.id, dsrDays.lastReopenedBy))
    .where(and(eq(dsrDays.stationId, stationId), eq(dsrDays.businessDate, date)))
    .limit(1);

  const pumpList = await stationPumps(db, stationId, false);
  const pumpById = new Map(pumpList.map((p) => [p.pumpId, p]));
  const rtt = await rttByPump(db, stationId, date);
  const priceCache = new Map<number, number | null>();
  const priceFor = async (productId: number) => {
    if (!priceCache.has(productId)) priceCache.set(productId, await pumpPriceAt(db, stationId, productId, date));
    return priceCache.get(productId) ?? null;
  };

  type Row = {
    readingId: number | null;
    pumpId: number;
    pumpName: string;
    meterLabel: string | null;
    tankName: string;
    productId: number;
    productCode: string;
    openingReading: number;
    closingReading: number | null;
    openingEditable: boolean;
    dispensed: number | null;
    rtt: number;
    netSales: number | null;
    unitPrice: number | null;
    salesValue: number | null;
    notInDay: boolean;
  };
  const readings: Row[] = [];

  const projected = async (p: (typeof pumpList)[number]): Promise<Row> => {
    const prev = await previousClosingReading(db, p.pumpId, date);
    return {
      readingId: null,
      pumpId: p.pumpId,
      pumpName: p.pumpName,
      meterLabel: p.meterLabel,
      tankName: p.tankName,
      productId: p.productId,
      productCode: p.productCode,
      openingReading: prev ?? p.initialReading,
      closingReading: null,
      openingEditable: prev === null,
      dispensed: null,
      rtt: rtt.get(p.pumpId) ?? 0,
      netSales: null,
      unitPrice: await priceFor(p.productId),
      salesValue: null,
      notInDay: true,
    };
  };

  if (day) {
    const rows = await db.select().from(dsrReadings).where(eq(dsrReadings.dsrDayId, day.id));
    for (const r of rows) {
      const p = pumpById.get(r.pumpId);
      const closed = day.status === "closed";
      const rttLitres = closed ? (r.rttLitres ?? 0) : (rtt.get(r.pumpId) ?? 0);
      const dispensed = r.closingReading === null ? null : litres(r.closingReading - r.openingReading);
      const netSales = closed ? r.netSalesLitres : dispensed === null ? null : litres(dispensed - rttLitres);
      const unitPrice = closed ? r.unitPrice : await priceFor(r.productId);
      readings.push({
        readingId: r.id,
        pumpId: r.pumpId,
        pumpName: p?.pumpName ?? `Pump #${r.pumpId}`,
        meterLabel: p?.meterLabel ?? null,
        tankName: p?.tankName ?? "",
        productId: r.productId,
        productCode: p?.productCode ?? "",
        openingReading: r.openingReading,
        closingReading: r.closingReading,
        openingEditable: !closed && (await previousClosingReading(db, r.pumpId, date)) === null,
        dispensed,
        rtt: rttLitres,
        netSales,
        unitPrice,
        salesValue: closed ? r.salesValue : netSales === null || unitPrice === null ? null : money(netSales * unitPrice),
        notInDay: false,
      });
    }
    if (day.status === "open") {
      for (const p of pumpList) {
        if (p.status === "active" && !rows.some((r) => r.pumpId === p.pumpId)) readings.push(await projected(p));
      }
    }
  } else {
    for (const p of pumpList) if (p.status === "active") readings.push(await projected(p));
  }
  readings.sort((a, b) => a.pumpName.localeCompare(b.pumpName, undefined, { numeric: true }));

  const byProduct = new Map<string, { productCode: string; netSales: number; salesValue: number; rtt: number }>();
  for (const r of readings) {
    const entry = byProduct.get(r.productCode) ?? { productCode: r.productCode, netSales: 0, salesValue: 0, rtt: 0 };
    entry.netSales = litres(entry.netSales + (r.netSales ?? 0));
    entry.salesValue = money(entry.salesValue + (r.salesValue ?? 0));
    entry.rtt = litres(entry.rtt + r.rtt);
    byProduct.set(r.productCode, entry);
  }
  const productSummary = [...byProduct.values()].map((p) => ({ ...p, avgPrice: p.netSales > 0 ? money(p.salesValue / p.netSales) : null }));

  return {
    station,
    date,
    status: day?.status ?? ("not_opened" as const),
    day: day ?? null,
    openBlocker: day ? null : await openBlocker(db, stationId, date),
    readings,
    products: productSummary,
    totals: {
      netSales: litres(productSummary.reduce((s, p) => s + p.netSales, 0)),
      salesValue: money(productSummary.reduce((s, p) => s + p.salesValue, 0)),
      rtt: litres(productSummary.reduce((s, p) => s + p.rtt, 0)),
      readingsMissing: readings.filter((r) => r.closingReading === null).length,
    },
  };
}

export async function listDays(
  actor: Actor,
  q: { stationId?: number; status?: "open" | "closed"; month?: string; from?: string; to?: string; page: number; limit: number; sortOrder: "asc" | "desc" },
) {
  const station = stationFilter(actor, q.stationId);
  const range = resolveRange(q);
  const conds: SQL[] = [sql`${dsrDays.businessDate} BETWEEN ${range.from} AND ${range.to}`];
  if (station !== null) conds.push(eq(dsrDays.stationId, station));
  if (q.status) conds.push(eq(dsrDays.status, q.status));
  const where = and(...conds);
  const dir = q.sortOrder === "asc" ? asc : desc;
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: dsrDays.id,
        ref: dsrDays.ref,
        stationId: dsrDays.stationId,
        stationName: stations.name,
        businessDate: dsrDays.businessDate,
        status: dsrDays.status,
        reopenCount: dsrDays.reopenCount,
        netSales: sql<number>`COALESCE(SUM(${dsrReadings.netSalesLitres}), 0)`,
        salesValue: sql<number>`COALESCE(SUM(${dsrReadings.salesValue}), 0)`,
      })
      .from(dsrDays)
      .innerJoin(stations, eq(stations.id, dsrDays.stationId))
      .leftJoin(dsrReadings, eq(dsrReadings.dsrDayId, dsrDays.id))
      .where(where)
      .groupBy(dsrDays.id)
      .orderBy(dir(dsrDays.businessDate), dir(dsrDays.id))
      .limit(q.limit)
      .offset((q.page - 1) * q.limit),
    db.select({ n: count() }).from(dsrDays).where(where),
  ]);
  return {
    rows: rows.map((r) => ({ ...r, netSales: litres(num(r.netSales)), salesValue: money(num(r.salesValue)) })),
    pagination: paginationMeta(q.page, q.limit, total?.n ?? 0),
  };
}

/* ------------------------------------------------------------------------ */
/* Commands                                                                  */
/* ------------------------------------------------------------------------ */

async function lockDay(actor: Actor, tx: Tx, id: number) {
  const [day] = await tx.select().from(dsrDays).where(eq(dsrDays.id, id)).limit(1).for("update");
  if (!day) throw notFound("DSR day");
  assertStationAccess(actor, day.stationId, "DSR day");
  assertCanWriteStation(actor, day.stationId);
  return day;
}

/** Adds reading rows for pumps activated after the day was opened. */
async function syncMissingPumps(tx: Tx, dayId: number, stationId: number, date: string) {
  const existing = await tx.select({ pumpId: dsrReadings.pumpId }).from(dsrReadings).where(eq(dsrReadings.dsrDayId, dayId));
  const have = new Set(existing.map((e) => e.pumpId));
  for (const p of await stationPumps(tx, stationId)) {
    if (have.has(p.pumpId)) continue;
    const prev = await previousClosingReading(tx, p.pumpId, date);
    await tx.insert(dsrReadings).values({
      dsrDayId: dayId,
      pumpId: p.pumpId,
      tankId: p.tankId,
      productId: p.productId,
      openingReading: prev ?? p.initialReading,
    });
  }
}

export async function openDay(actor: Actor, input: { stationId: number; businessDate: string }) {
  assertCanWriteStation(actor, input.stationId);
  assertNotFuture(input.businessDate);

  await db.transaction(async (tx) => {
    const [station] = await tx.select().from(stations).where(eq(stations.id, input.stationId)).limit(1).for("update");
    if (!station || station.status !== "active") throw new AppError("VALIDATION_ERROR", "Select an active station.", { fields: { stationId: "Select an active station." } });

    const [existing] = await tx
      .select({ ref: dsrDays.ref })
      .from(dsrDays)
      .where(and(eq(dsrDays.stationId, input.stationId), eq(dsrDays.businessDate, input.businessDate)))
      .limit(1);
    if (existing) throw conflict(`The DSR for ${input.businessDate} is already open (${existing.ref}).`);
    const blocker = await openBlocker(tx, input.stationId, input.businessDate);
    if (blocker) throw conflict(blocker);

    const pumpList = await stationPumps(tx, input.stationId);
    if (pumpList.length === 0) throw conflict(`${station.name} has no active pumps. Register pumps in Setup before opening a day.`);

    const ref = `DSR-${station.code}-${input.businessDate.replaceAll("-", "")}`;
    const [inserted] = await tx
      .insert(dsrDays)
      .values({ ref, stationId: input.stationId, businessDate: input.businessDate, status: "open", openedBy: actor.id, openedAt: new Date() })
      .$returningId();
    const dayId = inserted!.id;
    await syncMissingPumps(tx, dayId, input.stationId, input.businessDate);

    await recordAudit(tx, actor, {
      action: "opened",
      resource: "dsr_day",
      resourceId: dayId,
      recordRef: ref,
      stationId: input.stationId,
      newValue: { status: "Open", businessDate: input.businessDate, pumps: pumpList.length },
    });
  });
  return getDay(actor, input.stationId, input.businessDate);
}

export async function saveReadings(
  actor: Actor,
  dayId: number,
  input: { readings: { pumpId: number; openingReading?: number; closingReading?: number | null }[] },
) {
  const day = await db.transaction(async (tx) => {
    const day = await lockDay(actor, tx, dayId);
    if (day.status !== "open") throw conflict(`${day.ref} is closed and locked. Reopen the day to change readings.`);
    await syncMissingPumps(tx, day.id, day.stationId, day.businessDate);

    const rows = await tx.select().from(dsrReadings).where(eq(dsrReadings.dsrDayId, day.id));
    const pumpNames = new Map((await stationPumps(tx, day.stationId, false)).map((p) => [p.pumpId, p.pumpName]));
    const fields: Record<string, string> = {};
    const changes: { pump: string; old: Record<string, number | null>; new: Record<string, number | null> }[] = [];

    for (const [i, input_] of input.readings.entries()) {
      const row = rows.find((r) => r.pumpId === input_.pumpId);
      if (!row) {
        fields[`readings.${i}.pumpId`] = "This pump is not part of the day.";
        continue;
      }
      let opening = row.openingReading;
      if (input_.openingReading !== undefined && litres(input_.openingReading) !== row.openingReading) {
        if ((await previousClosingReading(tx, row.pumpId, day.businessDate)) !== null) {
          fields[`readings.${i}.openingReading`] = "Opening reading is carried forward from the previous day and cannot be edited.";
          continue;
        }
        opening = litres(input_.openingReading);
      }
      const closing = input_.closingReading === undefined ? row.closingReading : input_.closingReading === null ? null : litres(input_.closingReading);
      if (closing !== null && closing < opening) {
        fields[`readings.${i}.closingReading`] = `Closing reading cannot be below the opening reading (${opening.toLocaleString("en-NG")}).`;
        continue;
      }
      if (opening !== row.openingReading || closing !== row.closingReading) {
        await tx.update(dsrReadings).set({ openingReading: opening, closingReading: closing }).where(eq(dsrReadings.id, row.id));
        changes.push({
          pump: pumpNames.get(row.pumpId) ?? String(row.pumpId),
          old: { opening: row.openingReading, closing: row.closingReading },
          new: { opening, closing },
        });
      }
    }
    if (Object.keys(fields).length > 0) throw new AppError("VALIDATION_ERROR", "Some readings are invalid.", { fields });

    if (changes.length > 0) {
      await recordAudit(tx, actor, {
        action: "updated",
        resource: "dsr_day",
        resourceId: day.id,
        recordRef: day.ref,
        stationId: day.stationId,
        oldValue: Object.fromEntries(changes.map((c) => [c.pump, c.old])),
        newValue: Object.fromEntries(changes.map((c) => [c.pump, c.new])),
      });
    }
    return day;
  });
  return getDay(actor, day.stationId, day.businessDate);
}

export async function closeDay(actor: Actor, dayId: number) {
  const day = await db.transaction(async (tx) => {
    const day = await lockDay(actor, tx, dayId);
    if (day.status !== "open") throw conflict(`${day.ref} is already closed.`);
    await syncMissingPumps(tx, day.id, day.stationId, day.businessDate);

    const rows = await tx
      .select({ reading: dsrReadings, pumpName: pumps.name, productCode: products.code })
      .from(dsrReadings)
      .innerJoin(pumps, eq(pumps.id, dsrReadings.pumpId))
      .innerJoin(products, eq(products.id, dsrReadings.productId))
      .where(eq(dsrReadings.dsrDayId, day.id));

    const missing = rows.filter((r) => r.reading.closingReading === null).map((r) => r.pumpName);
    if (missing.length > 0) throw new AppError("VALIDATION_ERROR", `Enter closing readings for: ${missing.join(", ")}.`);

    const rttRows = await tx
      .select()
      .from(rttEntries)
      .where(and(eq(rttEntries.stationId, day.stationId), eq(rttEntries.businessDate, day.businessDate), eq(rttEntries.status, "active")));

    const problems: string[] = [];
    const ledger: LedgerInsert[] = [];
    let totalNet = 0;
    let totalValue = 0;

    for (const { reading, pumpName, productCode } of rows) {
      const dispensed = litres(reading.closingReading! - reading.openingReading);
      const pumpRtt = rttRows.filter((r) => r.pumpId === reading.pumpId);
      const rtt = litres(pumpRtt.reduce((s, r) => s + r.quantity, 0));
      if (rtt > dispensed) {
        problems.push(`RTT for ${pumpName} (${rtt} L) exceeds its metered dispensing (${dispensed} L).`);
        continue;
      }
      const unitPrice = await pumpPriceAt(tx, day.stationId, reading.productId, day.businessDate);
      if (unitPrice === null) {
        problems.push(`No pump price is set for ${productCode} effective ${day.businessDate}. Set one in Setup.`);
        continue;
      }
      const unitCost = (await landingCostAt(tx, day.stationId, reading.productId, day.businessDate)) ?? 0;
      const net = litres(dispensed - rtt);
      const salesValue = money(net * unitPrice);
      totalNet += net;
      totalValue += salesValue;

      await tx
        .update(dsrReadings)
        .set({ dispensedLitres: dispensed, rttLitres: rtt, netSalesLitres: net, unitPrice, unitCost, salesValue, costValue: money(net * unitCost) })
        .where(eq(dsrReadings.id, reading.id));

      const base = { stationId: day.stationId, tankId: reading.tankId, productId: reading.productId, businessDate: day.businessDate, createdBy: actor.id };
      if (dispensed > 0) {
        ledger.push({ ...base, movementType: "dispensed", quantity: -dispensed, sourceType: "dsr_reading", sourceId: reading.id, sourceRef: day.ref });
      }
      for (const r of pumpRtt) {
        ledger.push({ ...base, tankId: r.tankId, movementType: "rtt", quantity: r.quantity, sourceType: "rtt_entry", sourceId: r.id, sourceRef: r.ref });
      }
    }
    if (problems.length > 0) throw new AppError("VALIDATION_ERROR", problems.join(" "));

    await postMovements(tx, ledger);
    const settings = await getSettings(tx);
    await assertNoNegativeStock(tx, ledger.map((l) => l.tankId), day.businessDate, settings.allowNegativeStock);

    await tx.update(dsrDays).set({ status: "closed", closedBy: actor.id, closedAt: new Date() }).where(eq(dsrDays.id, day.id));
    await recomputeDipsForDay(tx, day.stationId, day.businessDate);
    await refreshCashPositions(tx, day.stationId, day.businessDate);

    await recordAudit(tx, actor, {
      action: "closed",
      resource: "dsr_day",
      resourceId: day.id,
      recordRef: day.ref,
      stationId: day.stationId,
      oldValue: { status: "Open" },
      newValue: { status: "Locked", netSalesLitres: litres(totalNet), salesValue: money(totalValue) },
    });
    return day;
  });
  return getDay(actor, day.stationId, day.businessDate);
}

export async function reopenDay(actor: Actor, dayId: number, reason: string) {
  const day = await db.transaction(async (tx) => {
    const day = await lockDay(actor, tx, dayId);
    if (day.status !== "closed") throw conflict(`${day.ref} is not closed.`);

    const [later] = await tx
      .select({ businessDate: dsrDays.businessDate })
      .from(dsrDays)
      .where(and(eq(dsrDays.stationId, day.stationId), gt(dsrDays.businessDate, day.businessDate)))
      .limit(1);
    if (later) throw conflict(`Only the most recent business day can be reopened; ${later.businessDate} already exists for this station.`);

    const [cash] = await tx
      .select({ status: cashPositions.status })
      .from(cashPositions)
      .where(and(eq(cashPositions.stationId, day.stationId), eq(cashPositions.businessDate, day.businessDate)));
    if (cash?.status === "closed") throw conflict(`The cash reconciliation for ${day.businessDate} is closed, so this day can no longer be reopened.`);

    const readingIds = (await tx.select({ id: dsrReadings.id }).from(dsrReadings).where(eq(dsrReadings.dsrDayId, day.id))).map((r) => r.id);
    const rttIds = (
      await tx
        .select({ id: rttEntries.id })
        .from(rttEntries)
        .where(and(eq(rttEntries.stationId, day.stationId), eq(rttEntries.businessDate, day.businessDate)))
    ).map((r) => r.id);
    const voidReason = `${day.ref} reopened: ${reason}`;
    await voidMovements(tx, "dsr_reading", readingIds, actor.id, voidReason);
    await voidMovements(tx, "rtt_entry", rttIds, actor.id, voidReason);

    await tx
      .update(dsrDays)
      .set({
        status: "open",
        reopenCount: sql`${dsrDays.reopenCount} + 1`,
        lastReopenedBy: actor.id,
        lastReopenedAt: new Date(),
        lastReopenReason: reason,
        closedBy: null,
        closedAt: null,
      })
      .where(eq(dsrDays.id, day.id));
    if (readingIds.length > 0) {
      await tx
        .update(dsrReadings)
        .set({ dispensedLitres: null, rttLitres: null, netSalesLitres: null, unitPrice: null, unitCost: null, salesValue: null, costValue: null })
        .where(inArray(dsrReadings.id, readingIds));
    }
    await refreshCashPositions(tx, day.stationId, day.businessDate);

    await recordAudit(tx, actor, {
      action: "reopened",
      resource: "dsr_day",
      resourceId: day.id,
      recordRef: day.ref,
      stationId: day.stationId,
      oldValue: { status: "Locked" },
      newValue: { status: "Open for correction", reason },
    });
    return day;
  });
  return getDay(actor, day.stationId, day.businessDate);
}
