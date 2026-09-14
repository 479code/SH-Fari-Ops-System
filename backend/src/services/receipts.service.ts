/**
 * receipts.service.ts — the Truck Receive Sheet.
 *
 * Lifecycle: received → verified | disputed → cancelled.
 * Business rule: verification posts the quantity to the tank's stock ledger and,
 * when linked, discharges the GIT delivery (completing the order when every
 * delivery is discharged). Cancelling a verified receipt voids both effects.
 */
import { and, asc, count, desc, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { assertCanWriteStation, assertStationAccess, stationFilter } from "../auth/scope.ts";
import { db, type Executor } from "../db/client.ts";
import { gitDeliveries, gitOrders, products, stations, tanks, truckReceipts, trucks, users } from "../db/schema/index.ts";
import { assertDayNotClosed, assertNotFuture } from "../repositories/locks.repo.ts";
import { assertNoNegativeStock, postMovements, voidMovements } from "../repositories/stock.repo.ts";
import { upsertTruck } from "../repositories/trucks.repo.ts";
import type { Actor } from "../types.ts";
import { resolveRange, today } from "../utils/dates.ts";
import { AppError, conflict, notFound } from "../utils/errors.ts";
import { paginationMeta } from "../utils/http.ts";
import { litres, money, num } from "../utils/numbers.ts";
import { likeContains } from "../utils/sql.ts";
import { recordAudit } from "./audit.service.ts";
import { applyReceiptToDelivery, revertReceiptFromDelivery } from "./git.service.ts";
import { getSettings } from "./settings.service.ts";

const recorder = alias(users, "recorder");
const verifier = alias(users, "verifier");

const columns = {
  id: truckReceipts.id,
  waybillRef: truckReceipts.waybillRef,
  stationId: truckReceipts.stationId,
  stationName: stations.name,
  productId: truckReceipts.productId,
  productCode: products.code,
  tankId: truckReceipts.tankId,
  tankName: tanks.name,
  truckPlate: trucks.plateNumber,
  gitDeliveryId: truckReceipts.gitDeliveryId,
  gitOrderId: gitOrders.id,
  gitOrderRef: gitOrders.ref,
  quantity: truckReceipts.quantity,
  orderPrice: truckReceipts.orderPrice,
  landingPrice: truckReceipts.landingPrice,
  businessDate: truckReceipts.businessDate,
  receivedAt: truckReceipts.receivedAt,
  status: truckReceipts.status,
  verifiedAt: truckReceipts.verifiedAt,
  verifiedByName: verifier.fullName,
  disputeReason: truckReceipts.disputeReason,
  cancelReason: truckReceipts.cancelReason,
  recordedByName: recorder.fullName,
  createdAt: truckReceipts.createdAt,
};

function baseQuery(ex: Executor) {
  return ex
    .select(columns)
    .from(truckReceipts)
    .innerJoin(stations, eq(stations.id, truckReceipts.stationId))
    .innerJoin(products, eq(products.id, truckReceipts.productId))
    .innerJoin(tanks, eq(tanks.id, truckReceipts.tankId))
    .innerJoin(trucks, eq(trucks.id, truckReceipts.truckId))
    .leftJoin(gitDeliveries, eq(gitDeliveries.id, truckReceipts.gitDeliveryId))
    .leftJoin(gitOrders, eq(gitOrders.id, gitDeliveries.gitOrderId))
    .leftJoin(recorder, eq(recorder.id, truckReceipts.recordedBy))
    .leftJoin(verifier, eq(verifier.id, truckReceipts.verifiedBy));
}

export async function getReceipt(actor: Actor, id: number, ex: Executor = db) {
  const [row] = await baseQuery(ex).where(eq(truckReceipts.id, id)).limit(1);
  if (!row) throw notFound("Truck receipt");
  assertStationAccess(actor, row.stationId, "Truck receipt");
  return { ...row, value: money(row.quantity * row.landingPrice) };
}

export interface ReceiptListQuery {
  month?: string;
  from?: string;
  to?: string;
  stationId?: number;
  productId?: number;
  status?: (typeof truckReceipts.$inferSelect)["status"];
  search?: string;
  sortBy: "businessDate" | "quantity" | "createdAt";
  sortOrder: "asc" | "desc";
  page: number;
  limit: number;
}

export async function listReceipts(actor: Actor, q: ReceiptListQuery) {
  const range = resolveRange(q);
  const station = stationFilter(actor, q.stationId);
  const conds: SQL[] = [sql`${truckReceipts.businessDate} BETWEEN ${range.from} AND ${range.to}`];
  if (station !== null) conds.push(eq(truckReceipts.stationId, station));
  if (q.productId) conds.push(eq(truckReceipts.productId, q.productId));
  if (q.status) conds.push(eq(truckReceipts.status, q.status));
  if (q.search) {
    const pattern = likeContains(q.search);
    conds.push(or(like(truckReceipts.waybillRef, pattern), like(trucks.plateNumber, pattern), like(gitOrders.ref, pattern))!);
  }
  const where = and(...conds);
  const sortColumn = { businessDate: truckReceipts.businessDate, quantity: truckReceipts.quantity, createdAt: truckReceipts.createdAt }[q.sortBy];
  const dir = q.sortOrder === "asc" ? asc : desc;

  const countQuery = db
    .select({ n: count() })
    .from(truckReceipts)
    .innerJoin(trucks, eq(trucks.id, truckReceipts.truckId))
    .leftJoin(gitDeliveries, eq(gitDeliveries.id, truckReceipts.gitDeliveryId))
    .leftJoin(gitOrders, eq(gitOrders.id, gitDeliveries.gitOrderId))
    .where(where);

  const summaryQuery = db
    .select({
      status: truckReceipts.status,
      n: count(),
      quantity: sql<number>`COALESCE(SUM(${truckReceipts.quantity}), 0)`,
      value: sql<number>`COALESCE(SUM(${truckReceipts.quantity} * ${truckReceipts.landingPrice}), 0)`,
    })
    .from(truckReceipts)
    .innerJoin(trucks, eq(trucks.id, truckReceipts.truckId))
    .leftJoin(gitDeliveries, eq(gitDeliveries.id, truckReceipts.gitDeliveryId))
    .leftJoin(gitOrders, eq(gitOrders.id, gitDeliveries.gitOrderId))
    .where(where)
    .groupBy(truckReceipts.status);

  const [rows, [total], summaryRows] = await Promise.all([
    baseQuery(db)
      .where(where)
      .orderBy(dir(sortColumn), dir(truckReceipts.id))
      .limit(q.limit)
      .offset((q.page - 1) * q.limit),
    countQuery,
    summaryQuery,
  ]);

  const verified = summaryRows.find((s) => s.status === "verified");
  return {
    rows: rows.map((r) => ({ ...r, value: money(r.quantity * r.landingPrice) })),
    pagination: paginationMeta(q.page, q.limit, total?.n ?? 0),
    summary: {
      range,
      byStatus: Object.fromEntries(summaryRows.map((s) => [s.status, s.n])),
      verifiedCount: verified?.n ?? 0,
      verifiedQuantity: litres(num(verified?.quantity)),
      verifiedValue: money(num(verified?.value)),
    },
  };
}

export interface ReceiptInput {
  stationId: number;
  productId: number;
  tankId?: number | null;
  quantity: number;
  orderPrice: number;
  landingPrice: number;
  waybillRef: string;
  truckPlate: string;
  gitDeliveryId?: number | null;
  businessDate?: string;
}

export async function createReceipt(actor: Actor, input: ReceiptInput) {
  assertCanWriteStation(actor, input.stationId);
  const businessDate = input.businessDate ?? today();
  assertNotFuture(businessDate);

  const id = await db.transaction(async (tx) => {
    const [station] = await tx.select({ status: stations.status, name: stations.name }).from(stations).where(eq(stations.id, input.stationId));
    if (!station || station.status !== "active") throw new AppError("VALIDATION_ERROR", "Select an active station.", { fields: { stationId: "Select an active station." } });
    const [product] = await tx.select({ code: products.code, status: products.status }).from(products).where(eq(products.id, input.productId));
    if (!product || product.status !== "active") throw new AppError("VALIDATION_ERROR", "Select an active product.", { fields: { productId: "Select an active product." } });

    const candidateTanks = await tx
      .select({ id: tanks.id })
      .from(tanks)
      .where(and(eq(tanks.stationId, input.stationId), eq(tanks.productId, input.productId), eq(tanks.status, "active")));
    let tankId: number;
    if (input.tankId) {
      if (!candidateTanks.some((t) => t.id === input.tankId)) {
        throw new AppError("VALIDATION_ERROR", `Select an active ${product.code} tank at ${station.name}.`, { fields: { tankId: "Tank does not hold this product at this station." } });
      }
      tankId = input.tankId;
    } else if (candidateTanks.length === 1) {
      tankId = candidateTanks[0]!.id;
    } else if (candidateTanks.length === 0) {
      throw new AppError("VALIDATION_ERROR", `${station.name} has no active ${product.code} tank. Register one in Setup first.`, { fields: { productId: `No active ${product.code} tank at this station.` } });
    } else {
      throw new AppError("VALIDATION_ERROR", "Select the tank that received the product.", { fields: { tankId: "Select the receiving tank." } });
    }

    await assertDayNotClosed(tx, input.stationId, businessDate, "record a truck receipt");

    const [duplicate] = await tx.select({ id: truckReceipts.id }).from(truckReceipts).where(eq(truckReceipts.waybillRef, input.waybillRef)).limit(1);
    if (duplicate) {
      throw new AppError("CONFLICT", `Waybill reference ${input.waybillRef} has already been recorded.`, { fields: { waybillRef: "This waybill reference already exists." } });
    }

    if (input.gitDeliveryId) {
      const [delivery] = await tx
        .select({ stationId: gitDeliveries.stationId, status: gitDeliveries.status, productId: gitOrders.productId, orderStatus: gitOrders.status, ref: gitOrders.ref })
        .from(gitDeliveries)
        .innerJoin(gitOrders, eq(gitOrders.id, gitDeliveries.gitOrderId))
        .where(eq(gitDeliveries.id, input.gitDeliveryId));
      const ok =
        delivery &&
        delivery.stationId === input.stationId &&
        delivery.productId === input.productId &&
        delivery.status === "pending" &&
        !["completed", "cancelled"].includes(delivery.orderStatus);
      if (!ok) {
        throw new AppError("VALIDATION_ERROR", "The selected GIT order is not open for this station and product.", { fields: { gitDeliveryId: "Select an open GIT order for this station and product." } });
      }
      const [linked] = await tx
        .select({ waybillRef: truckReceipts.waybillRef })
        .from(truckReceipts)
        .where(and(eq(truckReceipts.gitDeliveryId, input.gitDeliveryId), inArray(truckReceipts.status, ["received", "disputed", "verified"])))
        .limit(1);
      if (linked) {
        throw new AppError("CONFLICT", `${delivery.ref} already has receipt ${linked.waybillRef} for this station.`, { fields: { gitDeliveryId: "This GIT delivery already has a receipt." } });
      }
    }

    const truckId = await upsertTruck(tx, input.truckPlate);
    const [inserted] = await tx
      .insert(truckReceipts)
      .values({
        waybillRef: input.waybillRef,
        stationId: input.stationId,
        productId: input.productId,
        tankId,
        truckId,
        gitDeliveryId: input.gitDeliveryId ?? null,
        quantity: litres(input.quantity),
        orderPrice: input.orderPrice,
        landingPrice: input.landingPrice,
        businessDate,
        receivedAt: new Date(),
        status: "received",
        recordedBy: actor.id,
      })
      .$returningId();
    const receiptId = inserted!.id;

    await recordAudit(tx, actor, {
      action: "created",
      resource: "truck_receipt",
      resourceId: receiptId,
      recordRef: input.waybillRef,
      stationId: input.stationId,
      newValue: {
        product: product.code,
        quantity: input.quantity,
        orderPrice: input.orderPrice,
        landingPrice: input.landingPrice,
        truck: input.truckPlate,
        businessDate,
        status: "received",
      },
    });
    return receiptId;
  });
  return getReceipt(actor, id);
}

async function lockReceipt(actor: Actor, tx: Executor, id: number) {
  const [receipt] = await tx.select().from(truckReceipts).where(eq(truckReceipts.id, id)).limit(1).for("update");
  if (!receipt) throw notFound("Truck receipt");
  assertStationAccess(actor, receipt.stationId, "Truck receipt");
  assertCanWriteStation(actor, receipt.stationId);
  return receipt;
}

export async function verifyReceipt(actor: Actor, id: number) {
  await db.transaction(async (tx) => {
    const receipt = await lockReceipt(actor, tx, id);
    if (receipt.status !== "received" && receipt.status !== "disputed") {
      throw conflict(`Only received or disputed receipts can be verified (this one is ${receipt.status}).`);
    }
    await assertDayNotClosed(tx, receipt.stationId, receipt.businessDate, "verify this receipt");

    await tx
      .update(truckReceipts)
      .set({ status: "verified", verifiedBy: actor.id, verifiedAt: new Date() })
      .where(eq(truckReceipts.id, id));

    await postMovements(tx, [
      {
        stationId: receipt.stationId,
        tankId: receipt.tankId,
        productId: receipt.productId,
        businessDate: receipt.businessDate,
        movementType: "receipt",
        quantity: receipt.quantity,
        sourceType: "truck_receipt",
        sourceId: receipt.id,
        sourceRef: receipt.waybillRef,
        createdBy: actor.id,
      },
    ]);

    if (receipt.gitDeliveryId) await applyReceiptToDelivery(tx, actor, receipt);

    await recordAudit(tx, actor, {
      action: "verified",
      resource: "truck_receipt",
      resourceId: id,
      recordRef: receipt.waybillRef,
      stationId: receipt.stationId,
      oldValue: { status: receipt.status },
      newValue: { status: "verified", stockPosted: receipt.quantity },
    });
  });
  return getReceipt(actor, id);
}

export async function disputeReceipt(actor: Actor, id: number, reason: string) {
  await db.transaction(async (tx) => {
    const receipt = await lockReceipt(actor, tx, id);
    if (receipt.status !== "received") throw conflict(`Only receipts awaiting verification can be disputed (this one is ${receipt.status}).`);
    await tx
      .update(truckReceipts)
      .set({ status: "disputed", disputeReason: reason, disputedBy: actor.id, disputedAt: new Date() })
      .where(eq(truckReceipts.id, id));
    await recordAudit(tx, actor, {
      action: "disputed",
      resource: "truck_receipt",
      resourceId: id,
      recordRef: receipt.waybillRef,
      stationId: receipt.stationId,
      oldValue: { status: receipt.status },
      newValue: { status: "disputed", reason },
    });
  });
  return getReceipt(actor, id);
}

export async function cancelReceipt(actor: Actor, id: number, reason: string) {
  await db.transaction(async (tx) => {
    const receipt = await lockReceipt(actor, tx, id);
    if (receipt.status === "cancelled") throw conflict("This receipt is already cancelled.");
    await assertDayNotClosed(tx, receipt.stationId, receipt.businessDate, "cancel this receipt");

    await tx
      .update(truckReceipts)
      .set({ status: "cancelled", cancelReason: reason, cancelledBy: actor.id, cancelledAt: new Date() })
      .where(eq(truckReceipts.id, id));

    if (receipt.status === "verified") {
      const tankIds = await voidMovements(tx, "truck_receipt", [receipt.id], actor.id, `Receipt cancelled: ${reason}`);
      const settings = await getSettings(tx);
      await assertNoNegativeStock(tx, tankIds, receipt.businessDate, settings.allowNegativeStock);
      if (receipt.gitDeliveryId) await revertReceiptFromDelivery(tx, actor, receipt, reason);
    }

    await recordAudit(tx, actor, {
      action: "cancelled",
      resource: "truck_receipt",
      resourceId: id,
      recordRef: receipt.waybillRef,
      stationId: receipt.stationId,
      oldValue: { status: receipt.status },
      newValue: { status: "cancelled", reason, stockReversed: receipt.status === "verified" ? receipt.quantity : 0 },
    });
  });
  return getReceipt(actor, id);
}
