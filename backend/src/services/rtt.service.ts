/**
 * rtt.service.ts — Return to Tank.
 *
 * RTT is test/trial dispensing poured back into the tank. It is recorded
 * separately, never counted as a sale, and posted to the stock ledger (as a
 * positive movement) when its DSR day is closed.
 */
import { and, asc, count, desc, eq, sql, type SQL } from "drizzle-orm";
import { assertCanWriteStation, assertStationAccess, stationFilter } from "../auth/scope.ts";
import { db, type Executor } from "../db/client.ts";
import { products, pumps, rttEntries, stations, tanks, users } from "../db/schema/index.ts";
import { assertDayNotClosed, assertNotFuture } from "../repositories/locks.repo.ts";
import { formatRef, nextSequence } from "../repositories/sequence.repo.ts";
import type { Actor } from "../types.ts";
import { resolveRange, today } from "../utils/dates.ts";
import { AppError, conflict, notFound } from "../utils/errors.ts";
import { paginationMeta } from "../utils/http.ts";
import { litres, num } from "../utils/numbers.ts";
import { recordAudit } from "./audit.service.ts";

const columns = {
  id: rttEntries.id,
  ref: rttEntries.ref,
  stationId: rttEntries.stationId,
  stationName: stations.name,
  pumpId: rttEntries.pumpId,
  pumpName: pumps.name,
  tankName: tanks.name,
  productId: rttEntries.productId,
  productCode: products.code,
  businessDate: rttEntries.businessDate,
  quantity: rttEntries.quantity,
  reason: rttEntries.reason,
  operatorName: users.fullName,
  status: rttEntries.status,
  cancelReason: rttEntries.cancelReason,
  createdAt: rttEntries.createdAt,
};

function baseQuery(ex: Executor) {
  return ex
    .select(columns)
    .from(rttEntries)
    .innerJoin(stations, eq(stations.id, rttEntries.stationId))
    .innerJoin(pumps, eq(pumps.id, rttEntries.pumpId))
    .innerJoin(tanks, eq(tanks.id, rttEntries.tankId))
    .innerJoin(products, eq(products.id, rttEntries.productId))
    .innerJoin(users, eq(users.id, rttEntries.operatorId));
}

export async function getRtt(actor: Actor, id: number) {
  const [row] = await baseQuery(db).where(eq(rttEntries.id, id)).limit(1);
  if (!row) throw notFound("RTT entry");
  assertStationAccess(actor, row.stationId, "RTT entry");
  return row;
}

export async function listRtt(
  actor: Actor,
  q: {
    month?: string;
    from?: string;
    to?: string;
    stationId?: number;
    pumpId?: number;
    productId?: number;
    status?: "active" | "cancelled";
    page: number;
    limit: number;
    sortOrder: "asc" | "desc";
  },
) {
  const range = resolveRange(q);
  const station = stationFilter(actor, q.stationId);
  const conds: SQL[] = [sql`${rttEntries.businessDate} BETWEEN ${range.from} AND ${range.to}`];
  if (station !== null) conds.push(eq(rttEntries.stationId, station));
  if (q.pumpId) conds.push(eq(rttEntries.pumpId, q.pumpId));
  if (q.productId) conds.push(eq(rttEntries.productId, q.productId));
  if (q.status) conds.push(eq(rttEntries.status, q.status));
  const where = and(...conds);
  const dir = q.sortOrder === "asc" ? asc : desc;

  const [rows, [total], [sum]] = await Promise.all([
    baseQuery(db).where(where).orderBy(dir(rttEntries.businessDate), dir(rttEntries.id)).limit(q.limit).offset((q.page - 1) * q.limit),
    db.select({ n: count() }).from(rttEntries).where(where),
    db
      .select({ litres: sql<number>`COALESCE(SUM(${rttEntries.quantity}), 0)` })
      .from(rttEntries)
      .where(and(where, eq(rttEntries.status, "active"))),
  ]);
  return {
    rows,
    pagination: paginationMeta(q.page, q.limit, total?.n ?? 0),
    summary: { range, totalLitres: litres(num(sum?.litres)) },
  };
}

export async function createRtt(
  actor: Actor,
  input: { stationId: number; pumpId: number; productId?: number; quantity: number; reason: string; businessDate?: string },
) {
  assertCanWriteStation(actor, input.stationId);
  const businessDate = input.businessDate ?? today();
  assertNotFuture(businessDate);

  const id = await db.transaction(async (tx) => {
    const [pump] = await tx
      .select({ id: pumps.id, name: pumps.name, status: pumps.status, stationId: pumps.stationId, tankId: pumps.tankId, productId: tanks.productId, productCode: products.code })
      .from(pumps)
      .innerJoin(tanks, eq(tanks.id, pumps.tankId))
      .innerJoin(products, eq(products.id, tanks.productId))
      .where(eq(pumps.id, input.pumpId))
      .limit(1);
    if (!pump || pump.stationId !== input.stationId || pump.status !== "active") {
      throw new AppError("VALIDATION_ERROR", "Select an active pump at this station.", { fields: { pumpId: "Select an active pump at this station." } });
    }
    if (input.productId && input.productId !== pump.productId) {
      throw new AppError("VALIDATION_ERROR", `${pump.name} dispenses ${pump.productCode}.`, { fields: { productId: `${pump.name} dispenses ${pump.productCode}.` } });
    }
    await assertDayNotClosed(tx, input.stationId, businessDate, "log RTT");

    const ref = formatRef("RTT", await nextSequence(tx, "RTT"));
    const quantity = litres(input.quantity);
    const [inserted] = await tx
      .insert(rttEntries)
      .values({
        ref,
        stationId: input.stationId,
        pumpId: pump.id,
        tankId: pump.tankId,
        productId: pump.productId,
        businessDate,
        quantity,
        reason: input.reason,
        operatorId: actor.id,
      })
      .$returningId();
    await recordAudit(tx, actor, {
      action: "created",
      resource: "rtt_entry",
      resourceId: inserted!.id,
      recordRef: ref,
      stationId: input.stationId,
      newValue: { pump: pump.name, product: pump.productCode, quantity, reason: input.reason, businessDate },
    });
    return inserted!.id;
  });
  return getRtt(actor, id);
}

export async function cancelRtt(actor: Actor, id: number, reason: string) {
  await db.transaction(async (tx) => {
    const [entry] = await tx.select().from(rttEntries).where(eq(rttEntries.id, id)).limit(1).for("update");
    if (!entry) throw notFound("RTT entry");
    assertStationAccess(actor, entry.stationId, "RTT entry");
    assertCanWriteStation(actor, entry.stationId);
    if (entry.status === "cancelled") throw conflict("This RTT entry is already cancelled.");
    await assertDayNotClosed(tx, entry.stationId, entry.businessDate, "cancel this RTT entry");

    await tx
      .update(rttEntries)
      .set({ status: "cancelled", cancelledBy: actor.id, cancelledAt: new Date(), cancelReason: reason })
      .where(eq(rttEntries.id, id));
    await recordAudit(tx, actor, {
      action: "cancelled",
      resource: "rtt_entry",
      resourceId: id,
      recordRef: entry.ref,
      stationId: entry.stationId,
      oldValue: { status: "active", quantity: entry.quantity },
      newValue: { status: "cancelled", reason },
    });
  });
  return getRtt(actor, id);
}
