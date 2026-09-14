/**
 * stations.service.ts — station registration and the physical setup every
 * operational module depends on: tanks (stock is held per tank) and pumps
 * (DSR readings are taken per pump; each pump draws from one tank).
 */
import { and, asc, count, eq, isNull, ne, sql } from "drizzle-orm";
import { assertStationAccess } from "../auth/scope.ts";
import { db, selectRows, type Tx } from "../db/client.ts";
import { dsrDays, dsrReadings, products, pumps, stations, tanks, users } from "../db/schema/index.ts";
import { assertDayNotClosed, assertNotFuture } from "../repositories/locks.repo.ts";
import { postMovements, tankBalances } from "../repositories/stock.repo.ts";
import type { Actor } from "../types.ts";
import { today } from "../utils/dates.ts";
import { AppError, conflict, notFound } from "../utils/errors.ts";
import { litres, num } from "../utils/numbers.ts";
import { recordAudit } from "./audit.service.ts";

interface StationRow {
  id: number;
  code: string;
  name: string;
  address: string | null;
  manager_user_id: number | null;
  manager_name: string | null;
  cash_tolerance: number;
  stock_tolerance: number;
  status: "active" | "inactive";
  pump_count: number;
  tank_count: number;
  products: string | null;
}

export async function listStations(actor: Actor) {
  const rows = await selectRows<StationRow>(
    db,
    sql`SELECT s.id, s.code, s.name, s.address, s.manager_user_id, u.full_name AS manager_name,
               s.cash_tolerance, s.stock_tolerance, s.status,
               (SELECT COUNT(*) FROM pumps p WHERE p.station_id = s.id AND p.status = 'active') AS pump_count,
               (SELECT COUNT(*) FROM tanks t WHERE t.station_id = s.id AND t.status = 'active') AS tank_count,
               (SELECT GROUP_CONCAT(DISTINCT pr.code ORDER BY pr.code SEPARATOR ', ')
                  FROM tanks t JOIN products pr ON pr.id = t.product_id
                 WHERE t.station_id = s.id AND t.status = 'active') AS products
        FROM stations s LEFT JOIN users u ON u.id = s.manager_user_id
        ${actor.stationId !== null ? sql`WHERE s.id = ${actor.stationId}` : sql``}
        ORDER BY s.status, s.name`,
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    address: r.address,
    managerUserId: r.manager_user_id,
    managerName: r.manager_name,
    cashTolerance: num(r.cash_tolerance),
    stockTolerance: num(r.stock_tolerance),
    status: r.status,
    pumpCount: num(r.pump_count),
    tankCount: num(r.tank_count),
    products: r.products,
  }));
}

export async function getStation(actor: Actor, id: number) {
  assertStationAccess(actor, id, "Station");
  const [station] = (await listStations({ ...actor, stationId: id })).filter((s) => s.id === id);
  if (!station) throw notFound("Station");

  const tankRows = await db
    .select({ id: tanks.id, name: tanks.name, capacity: tanks.capacity, status: tanks.status, productId: tanks.productId, productCode: products.code })
    .from(tanks)
    .innerJoin(products, eq(products.id, tanks.productId))
    .where(eq(tanks.stationId, id))
    .orderBy(asc(tanks.name));
  const balances = await tankBalances(db, tankRows.map((t) => t.id));
  const pumpRows = await db
    .select({
      id: pumps.id,
      name: pumps.name,
      meterLabel: pumps.meterLabel,
      initialReading: pumps.initialReading,
      status: pumps.status,
      tankId: pumps.tankId,
      tankName: tanks.name,
      productCode: products.code,
    })
    .from(pumps)
    .innerJoin(tanks, eq(tanks.id, pumps.tankId))
    .innerJoin(products, eq(products.id, tanks.productId))
    .where(eq(pumps.stationId, id))
    .orderBy(asc(pumps.name));

  return {
    ...station,
    tanks: tankRows.map((t) => ({ ...t, balance: balances.get(t.id) ?? 0 })),
    pumps: pumpRows,
  };
}

async function assertManager(tx: Tx, managerUserId: number | null | undefined) {
  if (!managerUserId) return;
  const [user] = await tx
    .select({ status: users.status })
    .from(users)
    .where(and(eq(users.id, managerUserId), isNull(users.deletedAt)));
  if (!user || user.status !== "active") {
    throw new AppError("VALIDATION_ERROR", "Select an active user as manager.", { fields: { managerUserId: "Select an active user." } });
  }
}

export async function createStation(
  actor: Actor,
  input: { code: string; name: string; address?: string | null; managerUserId?: number | null; cashTolerance: number; stockTolerance: number },
) {
  const id = await db.transaction(async (tx) => {
    const [byCode] = await tx.select({ id: stations.id }).from(stations).where(eq(stations.code, input.code));
    if (byCode) throw new AppError("CONFLICT", `Station code ${input.code} is already in use.`, { fields: { code: "Code already in use." } });
    const [byName] = await tx.select({ id: stations.id }).from(stations).where(eq(stations.name, input.name));
    if (byName) throw new AppError("CONFLICT", `A station named ${input.name} already exists.`, { fields: { name: "Name already in use." } });
    await assertManager(tx, input.managerUserId);

    const [inserted] = await tx
      .insert(stations)
      .values({
        code: input.code,
        name: input.name,
        address: input.address ?? null,
        managerUserId: input.managerUserId ?? null,
        cashTolerance: input.cashTolerance,
        stockTolerance: input.stockTolerance,
      })
      .$returningId();
    await recordAudit(tx, actor, { action: "created", resource: "station", resourceId: inserted!.id, recordRef: input.code, stationId: inserted!.id, newValue: input });
    return inserted!.id;
  });
  return getStation(actor, id);
}

export async function updateStation(
  actor: Actor,
  id: number,
  input: { name?: string; address?: string | null; managerUserId?: number | null; cashTolerance?: number; stockTolerance?: number; status?: "active" | "inactive" },
) {
  await db.transaction(async (tx) => {
    const [station] = await tx.select().from(stations).where(eq(stations.id, id)).for("update");
    if (!station) throw notFound("Station");
    if (input.name && input.name !== station.name) {
      const [byName] = await tx.select({ id: stations.id }).from(stations).where(and(eq(stations.name, input.name), ne(stations.id, id)));
      if (byName) throw new AppError("CONFLICT", `A station named ${input.name} already exists.`, { fields: { name: "Name already in use." } });
    }
    await assertManager(tx, input.managerUserId);
    if (input.status === "inactive" && station.status === "active") {
      const [open] = await tx.select({ n: count() }).from(dsrDays).where(and(eq(dsrDays.stationId, id), eq(dsrDays.status, "open")));
      if (open && open.n > 0) throw conflict("Close all open DSR days before deactivating this station.");
    }
    const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as typeof input;
    await tx.update(stations).set(patch).where(eq(stations.id, id));
    await recordAudit(tx, actor, {
      action: "updated",
      resource: "station",
      resourceId: id,
      recordRef: station.code,
      stationId: id,
      oldValue: Object.fromEntries(Object.keys(patch).map((k) => [k, station[k as keyof typeof station]])),
      newValue: patch,
    });
  });
  return getStation(actor, id);
}

export async function createTank(
  actor: Actor,
  stationId: number,
  input: { productId: number; name: string; capacity?: number | null; openingStock: number; openingDate?: string },
) {
  await db.transaction(async (tx) => {
    const [station] = await tx.select({ code: stations.code, status: stations.status }).from(stations).where(eq(stations.id, stationId));
    if (!station) throw notFound("Station");
    const [product] = await tx.select({ code: products.code, status: products.status }).from(products).where(eq(products.id, input.productId));
    if (!product || product.status !== "active") throw new AppError("VALIDATION_ERROR", "Select an active product.", { fields: { productId: "Select an active product." } });
    const [dup] = await tx.select({ id: tanks.id }).from(tanks).where(and(eq(tanks.stationId, stationId), eq(tanks.name, input.name)));
    if (dup) throw new AppError("CONFLICT", `${input.name} already exists at this station.`, { fields: { name: "Tank name already in use at this station." } });

    const [inserted] = await tx
      .insert(tanks)
      .values({ stationId, productId: input.productId, name: input.name, capacity: input.capacity ?? null })
      .$returningId();
    const tankId = inserted!.id;

    if (input.openingStock > 0) {
      const date = input.openingDate ?? today();
      assertNotFuture(date, "openingDate");
      await assertDayNotClosed(tx, stationId, date, "post opening stock");
      await postMovements(tx, [
        {
          stationId,
          tankId,
          productId: input.productId,
          businessDate: date,
          movementType: "opening_balance",
          quantity: litres(input.openingStock),
          sourceType: "tank",
          sourceId: tankId,
          sourceRef: `OPEN-${station.code}-${tankId}`,
          createdBy: actor.id,
        },
      ]);
    }
    await recordAudit(tx, actor, {
      action: "created",
      resource: "tank",
      resourceId: tankId,
      recordRef: `${station.code} ${input.name}`,
      stationId,
      newValue: { product: product.code, name: input.name, capacity: input.capacity ?? null, openingStock: input.openingStock },
    });
  });
  return getStation(actor, stationId);
}

export async function updateTank(actor: Actor, tankId: number, input: { name?: string; capacity?: number | null; status?: "active" | "inactive" }) {
  const stationId = await db.transaction(async (tx) => {
    const [tank] = await tx.select().from(tanks).where(eq(tanks.id, tankId)).for("update");
    if (!tank) throw notFound("Tank");
    if (input.name && input.name !== tank.name) {
      const [dup] = await tx.select({ id: tanks.id }).from(tanks).where(and(eq(tanks.stationId, tank.stationId), eq(tanks.name, input.name), ne(tanks.id, tankId)));
      if (dup) throw new AppError("CONFLICT", `${input.name} already exists at this station.`, { fields: { name: "Tank name already in use at this station." } });
    }
    if (input.status === "inactive" && tank.status === "active") {
      const [active] = await tx.select({ n: count() }).from(pumps).where(and(eq(pumps.tankId, tankId), eq(pumps.status, "active")));
      if (active && active.n > 0) throw conflict("Move or deactivate the pumps drawing from this tank first.");
    }
    const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as typeof input;
    await tx.update(tanks).set(patch).where(eq(tanks.id, tankId));
    await recordAudit(tx, actor, {
      action: "updated",
      resource: "tank",
      resourceId: tankId,
      recordRef: tank.name,
      stationId: tank.stationId,
      oldValue: Object.fromEntries(Object.keys(patch).map((k) => [k, tank[k as keyof typeof tank]])),
      newValue: patch,
    });
    return tank.stationId;
  });
  return getStation(actor, stationId);
}

async function assertTankAtStation(tx: Tx, tankId: number, stationId: number) {
  const [tank] = await tx.select({ stationId: tanks.stationId, status: tanks.status }).from(tanks).where(eq(tanks.id, tankId));
  if (!tank || tank.stationId !== stationId || tank.status !== "active") {
    throw new AppError("VALIDATION_ERROR", "Select an active tank at this station.", { fields: { tankId: "Select an active tank at this station." } });
  }
}

export async function createPump(actor: Actor, stationId: number, input: { tankId: number; name: string; meterLabel?: string | null; initialReading: number }) {
  await db.transaction(async (tx) => {
    const [station] = await tx.select({ code: stations.code }).from(stations).where(eq(stations.id, stationId));
    if (!station) throw notFound("Station");
    await assertTankAtStation(tx, input.tankId, stationId);
    const [dup] = await tx.select({ id: pumps.id }).from(pumps).where(and(eq(pumps.stationId, stationId), eq(pumps.name, input.name)));
    if (dup) throw new AppError("CONFLICT", `${input.name} already exists at this station.`, { fields: { name: "Pump name already in use at this station." } });

    const [inserted] = await tx
      .insert(pumps)
      .values({ stationId, tankId: input.tankId, name: input.name, meterLabel: input.meterLabel ?? null, initialReading: litres(input.initialReading) })
      .$returningId();
    await recordAudit(tx, actor, {
      action: "created",
      resource: "pump",
      resourceId: inserted!.id,
      recordRef: `${station.code} ${input.name}`,
      stationId,
      newValue: input,
    });
  });
  return getStation(actor, stationId);
}

export async function updatePump(
  actor: Actor,
  pumpId: number,
  input: { tankId?: number; name?: string; meterLabel?: string | null; initialReading?: number; status?: "active" | "inactive" },
) {
  const stationId = await db.transaction(async (tx) => {
    const [pump] = await tx.select().from(pumps).where(eq(pumps.id, pumpId)).for("update");
    if (!pump) throw notFound("Pump");

    const [openReading] = await tx
      .select({ n: count() })
      .from(dsrReadings)
      .innerJoin(dsrDays, eq(dsrDays.id, dsrReadings.dsrDayId))
      .where(and(eq(dsrReadings.pumpId, pumpId), eq(dsrDays.status, "open")));
    const inOpenDay = (openReading?.n ?? 0) > 0;

    if (input.tankId !== undefined && input.tankId !== pump.tankId) {
      if (inOpenDay) throw conflict("Close the open DSR day before moving this pump to another tank.");
      await assertTankAtStation(tx, input.tankId, pump.stationId);
    }
    if (input.status === "inactive" && inOpenDay) throw conflict("Close the open DSR day before deactivating this pump.");
    if (input.initialReading !== undefined && litres(input.initialReading) !== pump.initialReading) {
      const [used] = await tx.select({ n: count() }).from(dsrReadings).where(eq(dsrReadings.pumpId, pumpId));
      if ((used?.n ?? 0) > 0) throw conflict("The initial reading cannot change after the pump has been used in a DSR.");
    }
    if (input.name && input.name !== pump.name) {
      const [dup] = await tx.select({ id: pumps.id }).from(pumps).where(and(eq(pumps.stationId, pump.stationId), eq(pumps.name, input.name), ne(pumps.id, pumpId)));
      if (dup) throw new AppError("CONFLICT", `${input.name} already exists at this station.`, { fields: { name: "Pump name already in use at this station." } });
    }

    const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as typeof input;
    await tx.update(pumps).set(patch).where(eq(pumps.id, pumpId));
    await recordAudit(tx, actor, {
      action: "updated",
      resource: "pump",
      resourceId: pumpId,
      recordRef: pump.name,
      stationId: pump.stationId,
      oldValue: Object.fromEntries(Object.keys(patch).map((k) => [k, pump[k as keyof typeof pump]])),
      newValue: patch,
    });
    return pump.stationId;
  });
  return getStation(actor, stationId);
}
