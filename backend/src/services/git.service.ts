/**
 * git.service.ts — Goods in Transit.
 *
 * Stages: order created → truck assigned → in transit → arrived → discharging → completed
 * (or cancelled before discharge). One order can serve several stations
 * (multi-delivery); each destination is a git_deliveries row that a verified
 * truck receipt discharges.
 *
 * The original quantity and order price are immutable. Dynamic fields (truck,
 * ETA, status, deliveries before discharge) can change, and every change is
 * appended to git_events and the audit trail.
 */
import { and, count, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { assertCanWriteStation, stationFilter } from "../auth/scope.ts";
import { db, selectRows, type Executor, type Tx } from "../db/client.ts";
import {
  exceptions,
  gitDeliveries,
  gitEvents,
  gitOrders,
  GIT_STATUSES,
  products,
  stations,
  truckReceipts,
  trucks,
  users,
} from "../db/schema/index.ts";
import { formatRef, nextSequence } from "../repositories/sequence.repo.ts";
import { upsertTruck } from "../repositories/trucks.repo.ts";
import type { Actor } from "../types.ts";
import { resolveRange, today } from "../utils/dates.ts";
import { AppError, conflict, notFound } from "../utils/errors.ts";
import { paginationMeta } from "../utils/http.ts";
import { litres, money, num } from "../utils/numbers.ts";
import { likeContains } from "../utils/sql.ts";
import { recordAudit } from "./audit.service.ts";
import { raiseException, resolveException } from "./exceptions.service.ts";
import { getSettings } from "./settings.service.ts";

export type GitStatus = (typeof GIT_STATUSES)[number];

const TRANSITIONS: Record<GitStatus, GitStatus[]> = {
  order_created: ["truck_assigned", "cancelled"],
  truck_assigned: ["in_transit", "cancelled"],
  in_transit: ["arrived", "cancelled"],
  arrived: ["discharging", "cancelled"],
  discharging: ["completed"],
  completed: [],
  cancelled: [],
};

const STAGES: { status: GitStatus; label: string }[] = [
  { status: "order_created", label: "Order created" },
  { status: "truck_assigned", label: "Truck assigned" },
  { status: "in_transit", label: "In transit" },
  { status: "arrived", label: "Arrived" },
  { status: "discharging", label: "Discharge" },
  { status: "completed", label: "Completed" },
];

const STATUS_LABEL: Record<GitStatus, string> = {
  order_created: "Order created",
  truck_assigned: "Truck assigned",
  in_transit: "In transit",
  arrived: "Arrived",
  discharging: "Discharging",
  completed: "Completed",
  cancelled: "Cancelled",
};

const DAY_MS = 86_400_000;

function transitDays(inTransitAt: Date | string | null, arrivedAt: Date | string | null): number | null {
  if (!inTransitAt) return null;
  const start = new Date(typeof inTransitAt === "string" ? `${inTransitAt.replace(" ", "T")}Z` : inTransitAt).getTime();
  const endRaw = arrivedAt ? new Date(typeof arrivedAt === "string" ? `${arrivedAt.replace(" ", "T")}Z` : arrivedAt).getTime() : Date.now();
  return Math.max(0, Math.floor((endRaw - start) / DAY_MS));
}

async function addEvent(tx: Tx, orderId: number, actor: Actor | null, e: { eventType: string; fromStatus?: string; toStatus?: string; note?: string | null }) {
  await tx.insert(gitEvents).values({
    gitOrderId: orderId,
    eventType: e.eventType,
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus ?? null,
    note: e.note?.slice(0, 255) ?? null,
    userId: actor?.id ?? null,
  });
}

/** Station-bound users only see orders with a delivery to their station. */
async function assertOrderInScope(actor: Actor, ex: Executor, orderId: number) {
  if (actor.stationId === null) return;
  const [row] = await ex
    .select({ n: count() })
    .from(gitDeliveries)
    .where(and(eq(gitDeliveries.gitOrderId, orderId), eq(gitDeliveries.stationId, actor.stationId)));
  if (!row || row.n === 0) throw notFound("GIT order");
}

/* ------------------------------------------------------------------------ */
/* Queries                                                                   */
/* ------------------------------------------------------------------------ */

interface OrderListRow {
  id: number;
  ref: string;
  status: GitStatus;
  quantity: number;
  order_price: number;
  order_date: string;
  expected_arrival_date: string | null;
  is_multi_delivery: number;
  exception_type: string | null;
  exception_note: string | null;
  in_transit_at: string | null;
  arrived_at: string | null;
  product_id: number;
  product_code: string;
  truck_plate: string | null;
  destinations: string | null;
  discharged: number;
}

export async function listOrders(
  actor: Actor,
  q: { status?: GitStatus | "open" | "exception"; stationId?: number; productId?: number; search?: string; month?: string; from?: string; to?: string; page: number; limit: number },
) {
  const station = stationFilter(actor, q.stationId);
  const settings = await getSettings();
  const conds: SQL[] = [];
  if (q.from || q.to || q.month) {
    const range = resolveRange(q);
    conds.push(sql`o.order_date BETWEEN ${range.from} AND ${range.to}`);
  }
  if (q.status === "open") conds.push(sql`o.status NOT IN ('completed', 'cancelled')`);
  else if (q.status === "exception") conds.push(sql`o.exception_type IS NOT NULL`);
  else if (q.status) conds.push(sql`o.status = ${q.status}`);
  if (q.productId) conds.push(sql`o.product_id = ${q.productId}`);
  if (station !== null) conds.push(sql`EXISTS (SELECT 1 FROM git_deliveries d WHERE d.git_order_id = o.id AND d.station_id = ${station})`);
  if (q.search) {
    const p = likeContains(q.search);
    conds.push(sql`(o.ref LIKE ${p} OR tr.plate_number LIKE ${p})`);
  }
  const where = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;

  const [rows, [total]] = await Promise.all([
    selectRows<OrderListRow>(
      db,
      sql`SELECT o.id, o.ref, o.status, o.quantity, o.order_price, o.order_date, o.expected_arrival_date, o.is_multi_delivery,
                 o.exception_type, o.exception_note, o.in_transit_at, o.arrived_at, o.product_id, p.code AS product_code,
                 tr.plate_number AS truck_plate,
                 (SELECT GROUP_CONCAT(s.name ORDER BY s.name SEPARATOR ', ') FROM git_deliveries d JOIN stations s ON s.id = d.station_id
                   WHERE d.git_order_id = o.id AND d.status <> 'cancelled') AS destinations,
                 (SELECT COALESCE(SUM(d.discharged_quantity), 0) FROM git_deliveries d WHERE d.git_order_id = o.id) AS discharged
          FROM git_orders o
          JOIN products p ON p.id = o.product_id
          LEFT JOIN trucks tr ON tr.id = o.truck_id
          ${where}
          ORDER BY o.order_date DESC, o.id DESC
          LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
    ),
    selectRows<{ n: number }>(db, sql`SELECT COUNT(*) AS n FROM git_orders o LEFT JOIN trucks tr ON tr.id = o.truck_id ${where}`),
  ]);

  return {
    rows: rows.map((r) => {
      const days = transitDays(r.in_transit_at, r.arrived_at);
      const discharged = litres(num(r.discharged));
      const open = r.status !== "completed" && r.status !== "cancelled";
      return {
        id: r.id,
        ref: r.ref,
        status: r.status,
        statusLabel: STATUS_LABEL[r.status],
        quantity: r.quantity,
        orderPrice: r.order_price,
        value: money(r.quantity * r.order_price),
        orderDate: r.order_date,
        expectedArrivalDate: r.expected_arrival_date,
        isMultiDelivery: Boolean(r.is_multi_delivery),
        productId: r.product_id,
        productCode: r.product_code,
        truckPlate: r.truck_plate,
        destinations: r.destinations,
        discharged,
        outstanding: open ? litres(Math.max(0, r.quantity - discharged)) : 0,
        daysInTransit: days,
        delayed: r.status === "in_transit" && days !== null && days > settings.gitDelayDays,
        exceptionType: r.exception_type,
        exceptionNote: r.exception_note,
      };
    }),
    pagination: paginationMeta(q.page, q.limit, num(total?.n)),
  };
}

export async function getOrder(actor: Actor, id: number, ex: Executor = db) {
  const [order] = await ex
    .select({
      id: gitOrders.id,
      ref: gitOrders.ref,
      status: gitOrders.status,
      quantity: gitOrders.quantity,
      orderPrice: gitOrders.orderPrice,
      isMultiDelivery: gitOrders.isMultiDelivery,
      source: gitOrders.source,
      orderDate: gitOrders.orderDate,
      expectedArrivalDate: gitOrders.expectedArrivalDate,
      truckAssignedAt: gitOrders.truckAssignedAt,
      inTransitAt: gitOrders.inTransitAt,
      arrivedAt: gitOrders.arrivedAt,
      dischargeStartedAt: gitOrders.dischargeStartedAt,
      completedAt: gitOrders.completedAt,
      cancelledAt: gitOrders.cancelledAt,
      cancelReason: gitOrders.cancelReason,
      exceptionType: gitOrders.exceptionType,
      exceptionNote: gitOrders.exceptionNote,
      notes: gitOrders.notes,
      productId: gitOrders.productId,
      productCode: products.code,
      truckPlate: trucks.plateNumber,
      createdByName: users.fullName,
      createdAt: gitOrders.createdAt,
    })
    .from(gitOrders)
    .innerJoin(products, eq(products.id, gitOrders.productId))
    .leftJoin(trucks, eq(trucks.id, gitOrders.truckId))
    .leftJoin(users, eq(users.id, gitOrders.createdBy))
    .where(eq(gitOrders.id, id))
    .limit(1);
  if (!order) throw notFound("GIT order");
  await assertOrderInScope(actor, ex, id);

  const [deliveries, receipts, events, settings] = await Promise.all([
    ex
      .select({
        id: gitDeliveries.id,
        stationId: gitDeliveries.stationId,
        stationName: stations.name,
        plannedQuantity: gitDeliveries.plannedQuantity,
        dischargedQuantity: gitDeliveries.dischargedQuantity,
        status: gitDeliveries.status,
        dischargedAt: gitDeliveries.dischargedAt,
      })
      .from(gitDeliveries)
      .innerJoin(stations, eq(stations.id, gitDeliveries.stationId))
      .where(eq(gitDeliveries.gitOrderId, id))
      .orderBy(stations.name),
    ex
      .select({
        id: truckReceipts.id,
        gitDeliveryId: truckReceipts.gitDeliveryId,
        waybillRef: truckReceipts.waybillRef,
        quantity: truckReceipts.quantity,
        status: truckReceipts.status,
        businessDate: truckReceipts.businessDate,
      })
      .from(truckReceipts)
      .innerJoin(gitDeliveries, eq(gitDeliveries.id, truckReceipts.gitDeliveryId))
      .where(eq(gitDeliveries.gitOrderId, id)),
    ex
      .select({
        eventType: gitEvents.eventType,
        fromStatus: gitEvents.fromStatus,
        toStatus: gitEvents.toStatus,
        note: gitEvents.note,
        userName: users.fullName,
        createdAt: gitEvents.createdAt,
      })
      .from(gitEvents)
      .leftJoin(users, eq(users.id, gitEvents.userId))
      .where(eq(gitEvents.gitOrderId, id))
      .orderBy(sql`${gitEvents.id} DESC`),
    getSettings(ex),
  ]);

  const discharged = litres(deliveries.reduce((s, d) => s + d.dischargedQuantity, 0));
  const days = transitDays(order.inTransitAt, order.arrivedAt);
  const currentIndex = STAGES.findIndex((s) => s.status === order.status);
  return {
    ...order,
    statusLabel: STATUS_LABEL[order.status],
    value: money(order.quantity * order.orderPrice),
    discharged,
    outstanding: order.status === "completed" || order.status === "cancelled" ? 0 : litres(Math.max(0, order.quantity - discharged)),
    daysInTransit: days,
    delayed: order.status === "in_transit" && days !== null && days > settings.gitDelayDays,
    delayThresholdDays: settings.gitDelayDays,
    allowedTransitions: TRANSITIONS[order.status],
    stages: STAGES.map((s, i) => ({
      ...s,
      state: order.status === "cancelled" ? "cancelled" : i < currentIndex || order.status === "completed" ? "done" : i === currentIndex ? "current" : "pending",
    })),
    deliveries: deliveries.map((d) => ({ ...d, receipts: receipts.filter((r) => r.gitDeliveryId === d.id) })),
    events,
  };
}

/** Pending deliveries a receipt at this station can be linked to. */
export async function openDeliveries(actor: Actor, q: { stationId: number; productId?: number }) {
  const station = stationFilter(actor, q.stationId);
  return db
    .select({
      deliveryId: gitDeliveries.id,
      orderId: gitOrders.id,
      orderRef: gitOrders.ref,
      productId: gitOrders.productId,
      productCode: products.code,
      plannedQuantity: gitDeliveries.plannedQuantity,
      orderPrice: gitOrders.orderPrice,
      truckPlate: trucks.plateNumber,
      status: gitOrders.status,
    })
    .from(gitDeliveries)
    .innerJoin(gitOrders, eq(gitOrders.id, gitDeliveries.gitOrderId))
    .innerJoin(products, eq(products.id, gitOrders.productId))
    .leftJoin(trucks, eq(trucks.id, gitOrders.truckId))
    .where(
      and(
        eq(gitDeliveries.stationId, station ?? q.stationId),
        eq(gitDeliveries.status, "pending"),
        inArray(gitOrders.status, ["order_created", "truck_assigned", "in_transit", "arrived", "discharging"]),
        q.productId ? eq(gitOrders.productId, q.productId) : undefined,
        sql`NOT EXISTS (SELECT 1 FROM truck_receipts r WHERE r.git_delivery_id = ${gitDeliveries.id} AND r.status IN ('received', 'disputed', 'verified'))`,
      ),
    )
    .orderBy(gitOrders.ref);
}

/** Outstanding (undischarged) litres and value by order status, for dashboards. */
export async function outstandingByStatus(ex: Executor, stationId: number | null) {
  const rows = await selectRows<{ status: GitStatus; litres: number; value: number }>(
    ex,
    sql`SELECT o.status, SUM(d.planned_quantity - d.discharged_quantity) AS litres,
               SUM((d.planned_quantity - d.discharged_quantity) * o.order_price) AS value
        FROM git_orders o JOIN git_deliveries d ON d.git_order_id = o.id
        WHERE o.status NOT IN ('completed', 'cancelled') AND d.status = 'pending'
          ${stationId !== null ? sql`AND d.station_id = ${stationId}` : sql``}
        GROUP BY o.status`,
  );
  return rows.map((r) => ({ status: r.status, label: STATUS_LABEL[r.status], litres: litres(num(r.litres)), value: money(num(r.value)) }));
}

/** Outstanding litres/value per destination station. */
export async function outstandingByStation(ex: Executor, stationId: number | null) {
  const rows = await selectRows<{ station_id: number; litres: number; value: number }>(
    ex,
    sql`SELECT d.station_id, SUM(d.planned_quantity - d.discharged_quantity) AS litres,
               SUM((d.planned_quantity - d.discharged_quantity) * o.order_price) AS value
        FROM git_orders o JOIN git_deliveries d ON d.git_order_id = o.id
        WHERE o.status NOT IN ('completed', 'cancelled') AND d.status = 'pending'
          ${stationId !== null ? sql`AND d.station_id = ${stationId}` : sql``}
        GROUP BY d.station_id`,
  );
  return new Map(rows.map((r) => [r.station_id, { litres: litres(num(r.litres)), value: money(num(r.value)) }]));
}

/* ------------------------------------------------------------------------ */
/* Commands                                                                  */
/* ------------------------------------------------------------------------ */

export interface GitCreateInput {
  productId: number;
  quantity: number;
  orderPrice: number;
  truckPlate?: string | null;
  source?: string | null;
  orderDate?: string;
  expectedArrivalDate?: string | null;
  notes?: string | null;
  isMultiDelivery: boolean;
  destinations: { stationId: number; quantity?: number }[];
}

async function assertActiveStations(tx: Tx, ids: number[]) {
  const rows = await tx.select({ id: stations.id, status: stations.status }).from(stations).where(inArray(stations.id, ids));
  if (rows.length !== ids.length || rows.some((r) => r.status !== "active")) {
    throw new AppError("VALIDATION_ERROR", "Every destination must be an active station.", { fields: { destinations: "Select active stations only." } });
  }
}

export async function createOrder(actor: Actor, input: GitCreateInput) {
  for (const d of input.destinations) assertCanWriteStation(actor, d.stationId);
  const orderDate = input.orderDate ?? today();
  if (orderDate > today()) throw new AppError("VALIDATION_ERROR", "Order date cannot be in the future.", { fields: { orderDate: "Cannot be in the future." } });

  const id = await db.transaction(async (tx) => {
    const [product] = await tx.select({ code: products.code, status: products.status }).from(products).where(eq(products.id, input.productId));
    if (!product || product.status !== "active") throw new AppError("VALIDATION_ERROR", "Select an active product.", { fields: { productId: "Select an active product." } });
    await assertActiveStations(tx, input.destinations.map((d) => d.stationId));

    const ref = formatRef("GIT", await nextSequence(tx, "GIT", 1001));
    const truckId = input.truckPlate ? await upsertTruck(tx, input.truckPlate) : null;
    const now = new Date();
    const status: GitStatus = truckId ? "truck_assigned" : "order_created";

    const [inserted] = await tx
      .insert(gitOrders)
      .values({
        ref,
        productId: input.productId,
        quantity: litres(input.quantity),
        orderPrice: input.orderPrice,
        truckId,
        isMultiDelivery: input.isMultiDelivery,
        source: input.source ?? null,
        status,
        orderDate,
        expectedArrivalDate: input.expectedArrivalDate ?? null,
        truckAssignedAt: truckId ? now : null,
        notes: input.notes ?? null,
        createdBy: actor.id,
      })
      .$returningId();
    const orderId = inserted!.id;

    await tx.insert(gitDeliveries).values(
      input.destinations.map((d) => ({
        gitOrderId: orderId,
        stationId: d.stationId,
        plannedQuantity: litres(input.isMultiDelivery ? d.quantity! : input.quantity),
      })),
    );
    await addEvent(tx, orderId, actor, { eventType: "created", toStatus: "order_created", note: `${product.code} ${input.quantity.toLocaleString("en-NG")} L @ ₦${input.orderPrice}` });
    if (truckId) await addEvent(tx, orderId, actor, { eventType: "status_changed", fromStatus: "order_created", toStatus: "truck_assigned", note: `Truck ${input.truckPlate}` });

    await recordAudit(tx, actor, {
      action: "created",
      resource: "git_order",
      resourceId: orderId,
      recordRef: ref,
      stationId: input.destinations.length === 1 ? input.destinations[0]!.stationId : null,
      newValue: {
        product: product.code,
        quantity: input.quantity,
        orderPrice: input.orderPrice,
        truck: input.truckPlate ?? null,
        destinations: input.destinations,
        status,
      },
    });
    return orderId;
  });
  return getOrder(actor, id);
}

async function lockOrder(actor: Actor, tx: Tx, id: number) {
  const [order] = await tx.select().from(gitOrders).where(eq(gitOrders.id, id)).limit(1).for("update");
  if (!order) throw notFound("GIT order");
  await assertOrderInScope(actor, tx, id);
  return order;
}

export async function updateOrder(
  actor: Actor,
  id: number,
  input: { truckPlate?: string | null; expectedArrivalDate?: string | null; source?: string | null; notes?: string | null },
) {
  await db.transaction(async (tx) => {
    const order = await lockOrder(actor, tx, id);
    if (order.status === "completed" || order.status === "cancelled") throw conflict(`${order.ref} is ${order.status} and can no longer be edited.`);

    const patch: Partial<typeof gitOrders.$inferInsert> = {};
    const oldValue: Record<string, unknown> = {};
    const newValue: Record<string, unknown> = {};

    if (input.truckPlate !== undefined) {
      const [current] = order.truckId ? await tx.select({ plate: trucks.plateNumber }).from(trucks).where(eq(trucks.id, order.truckId)) : [];
      const currentPlate = current?.plate ?? null;
      if (input.truckPlate !== currentPlate) {
        if (!input.truckPlate && order.status !== "order_created") throw conflict("A truck cannot be removed once the order has progressed.");
        patch.truckId = input.truckPlate ? await upsertTruck(tx, input.truckPlate) : null;
        oldValue.truck = currentPlate;
        newValue.truck = input.truckPlate;
        if (input.truckPlate && order.status === "order_created") {
          patch.status = "truck_assigned";
          patch.truckAssignedAt = new Date();
          oldValue.status = order.status;
          newValue.status = "truck_assigned";
        }
      }
    }
    for (const key of ["expectedArrivalDate", "source", "notes"] as const) {
      if (input[key] !== undefined && input[key] !== order[key]) {
        patch[key] = input[key] ?? null;
        oldValue[key] = order[key];
        newValue[key] = input[key];
      }
    }
    if (Object.keys(patch).length === 0) return;

    await tx.update(gitOrders).set(patch).where(eq(gitOrders.id, id));
    await addEvent(tx, id, actor, {
      eventType: "edited",
      fromStatus: order.status,
      toStatus: patch.status ?? order.status,
      note: Object.entries(newValue).map(([k, v]) => `${k}: ${v ?? "—"}`).join(", "),
    });
    await recordAudit(tx, actor, { action: "updated", resource: "git_order", resourceId: id, recordRef: order.ref, oldValue, newValue });
  });
  return getOrder(actor, id);
}

export async function changeStatus(actor: Actor, id: number, input: { status: GitStatus; note?: string | null }) {
  await db.transaction(async (tx) => {
    const order = await lockOrder(actor, tx, id);
    if (!TRANSITIONS[order.status].includes(input.status)) {
      throw conflict(`${order.ref} cannot move from ${STATUS_LABEL[order.status]} to ${STATUS_LABEL[input.status]}.`);
    }
    const now = new Date();
    const patch: Partial<typeof gitOrders.$inferInsert> = { status: input.status };
    const deliveries = await tx.select().from(gitDeliveries).where(eq(gitDeliveries.gitOrderId, id));

    switch (input.status) {
      case "truck_assigned":
        if (!order.truckId) throw new AppError("VALIDATION_ERROR", "Assign a truck before marking the order as truck assigned.", { fields: { truckPlate: "Truck is required." } });
        patch.truckAssignedAt = now;
        break;
      case "in_transit":
        patch.inTransitAt = now;
        break;
      case "arrived":
        patch.arrivedAt = now;
        break;
      case "discharging":
        patch.dischargeStartedAt = now;
        break;
      case "completed": {
        const pending = deliveries.filter((d) => d.status === "pending");
        if (pending.length > 0 && !input.note) {
          throw new AppError("VALIDATION_ERROR", "Explain why the order is being completed with undischarged deliveries.", { fields: { note: "A note is required to short-close an order." } });
        }
        patch.completedAt = now;
        if (pending.length > 0) {
          await tx.update(gitDeliveries).set({ status: "cancelled" }).where(inArray(gitDeliveries.id, pending.map((d) => d.id)));
          const shortfall = litres(pending.reduce((s, d) => s + d.plannedQuantity - d.dischargedQuantity, 0));
          patch.exceptionType = "shortage";
          patch.exceptionNote = `Short-closed with ${shortfall.toLocaleString("en-NG")} L undelivered`;
          await raiseException(tx, {
            type: "git_shortage",
            severity: "medium",
            stationId: pending.length === 1 ? pending[0]!.stationId : null,
            sourceType: "git_order",
            sourceId: id,
            sourceRef: order.ref,
            title: `GIT short-closed — ${order.ref}, ${shortfall.toLocaleString("en-NG")} L undelivered`,
            detail: input.note ?? null,
            amount: shortfall,
          });
        }
        break;
      }
      case "cancelled": {
        if (!input.note) throw new AppError("VALIDATION_ERROR", "A reason is required to cancel an order.", { fields: { note: "Reason is required." } });
        const [linked] = await tx
          .select({ n: count() })
          .from(truckReceipts)
          .where(and(inArray(truckReceipts.gitDeliveryId, deliveries.map((d) => d.id).concat(0)), ne(truckReceipts.status, "cancelled")));
        if (linked && linked.n > 0) throw conflict("This order has linked truck receipts. Cancel those receipts before cancelling the order.");
        patch.cancelledAt = now;
        patch.cancelReason = input.note;
        await tx.update(gitDeliveries).set({ status: "cancelled" }).where(eq(gitDeliveries.gitOrderId, id));
        break;
      }
      default:
        break;
    }

    // Leaving "in transit" ends any delay.
    if (order.status === "in_transit" && input.status !== "in_transit") {
      await resolveException(tx, { type: "git_delay", sourceType: "git_order", sourceId: id }, `Order moved to ${STATUS_LABEL[input.status]}.`, actor.id);
      if (order.exceptionType === "delay") {
        patch.exceptionType = null;
        patch.exceptionNote = null;
      }
    }

    await tx.update(gitOrders).set(patch).where(eq(gitOrders.id, id));
    await addEvent(tx, id, actor, { eventType: "status_changed", fromStatus: order.status, toStatus: input.status, note: input.note });
    await recordAudit(tx, actor, {
      action: input.status === "cancelled" ? "cancelled" : "status_changed",
      resource: "git_order",
      resourceId: id,
      recordRef: order.ref,
      oldValue: { status: STATUS_LABEL[order.status] },
      newValue: { status: STATUS_LABEL[input.status], note: input.note ?? null },
    });
  });
  return getOrder(actor, id);
}

export async function setDeliveries(actor: Actor, id: number, destinations: { stationId: number; quantity?: number }[]) {
  for (const d of destinations) assertCanWriteStation(actor, d.stationId);
  await db.transaction(async (tx) => {
    const order = await lockOrder(actor, tx, id);
    if (order.status === "completed" || order.status === "cancelled") throw conflict(`${order.ref} is ${order.status}.`);
    const existing = await tx.select().from(gitDeliveries).where(eq(gitDeliveries.gitOrderId, id));
    const [linked] = await tx
      .select({ n: count() })
      .from(truckReceipts)
      .where(and(inArray(truckReceipts.gitDeliveryId, existing.map((d) => d.id).concat(0)), ne(truckReceipts.status, "cancelled")));
    if (linked && linked.n > 0) throw conflict("Deliveries cannot be changed once a truck receipt is linked to this order.");

    const ids = destinations.map((d) => d.stationId);
    if (new Set(ids).size !== ids.length) throw new AppError("VALIDATION_ERROR", "Each destination station can appear only once.", { fields: { destinations: "Duplicate station." } });
    const multi = destinations.length > 1;
    const quantities = destinations.map((d) => (multi ? d.quantity : (d.quantity ?? order.quantity)));
    if (quantities.some((qty) => qty === undefined)) throw new AppError("VALIDATION_ERROR", "Enter a quantity for every destination.", { fields: { destinations: "Quantity is required." } });
    const sum = litres(quantities.reduce<number>((s, qty) => s + (qty ?? 0), 0));
    if (sum !== litres(order.quantity)) {
      throw new AppError("VALIDATION_ERROR", `Destination quantities (${sum} L) must add up to the order quantity (${order.quantity} L).`, { fields: { destinations: "Quantities must add up to the order quantity." } });
    }
    await assertActiveStations(tx, ids);

    await tx.delete(gitDeliveries).where(eq(gitDeliveries.gitOrderId, id));
    await tx.insert(gitDeliveries).values(destinations.map((d, i) => ({ gitOrderId: id, stationId: d.stationId, plannedQuantity: litres(quantities[i]!) })));
    await tx.update(gitOrders).set({ isMultiDelivery: multi }).where(eq(gitOrders.id, id));

    const summary = destinations.map((d, i) => ({ stationId: d.stationId, quantity: quantities[i] }));
    await addEvent(tx, id, actor, { eventType: "deliveries_changed", fromStatus: order.status, toStatus: order.status, note: `${destinations.length} destination(s)` });
    await recordAudit(tx, actor, {
      action: "updated",
      resource: "git_order",
      resourceId: id,
      recordRef: order.ref,
      oldValue: { destinations: existing.map((d) => ({ stationId: d.stationId, quantity: d.plannedQuantity })) },
      newValue: { destinations: summary },
    });
  });
  return getOrder(actor, id);
}

const EXCEPTION_KIND = { shortage: "git_shortage", delay: "git_delay", price: "git_exception", other: "git_exception" } as const;

export async function flagException(actor: Actor, id: number, input: { type: "shortage" | "delay" | "price" | "other"; note: string }) {
  await db.transaction(async (tx) => {
    const order = await lockOrder(actor, tx, id);
    const deliveries = await tx.select({ stationId: gitDeliveries.stationId }).from(gitDeliveries).where(eq(gitDeliveries.gitOrderId, id));
    await tx.update(gitOrders).set({ exceptionType: input.type, exceptionNote: input.note }).where(eq(gitOrders.id, id));
    await raiseException(tx, {
      type: EXCEPTION_KIND[input.type],
      severity: input.type === "shortage" || input.type === "price" ? "high" : "medium",
      stationId: deliveries.length === 1 ? deliveries[0]!.stationId : null,
      sourceType: "git_order",
      sourceId: id,
      sourceRef: order.ref,
      title: `GIT ${input.type} exception — ${order.ref}`,
      detail: input.note,
    });
    await addEvent(tx, id, actor, { eventType: "exception_flagged", fromStatus: order.status, toStatus: order.status, note: `${input.type}: ${input.note}` });
    await recordAudit(tx, actor, {
      action: "flagged",
      resource: "git_order",
      resourceId: id,
      recordRef: order.ref,
      oldValue: { exception: order.exceptionType },
      newValue: { exception: input.type, note: input.note },
    });
  });
  return getOrder(actor, id);
}

export async function resolveOrderException(actor: Actor, id: number, note: string) {
  await db.transaction(async (tx) => {
    const order = await lockOrder(actor, tx, id);
    if (!order.exceptionType) throw conflict(`${order.ref} has no open exception.`);
    await tx.update(gitOrders).set({ exceptionType: null, exceptionNote: null }).where(eq(gitOrders.id, id));
    const deliveryIds = (await tx.select({ id: gitDeliveries.id }).from(gitDeliveries).where(eq(gitDeliveries.gitOrderId, id))).map((d) => d.id);
    await tx
      .update(exceptions)
      .set({ status: "closed", closedBy: actor.id, closedAt: new Date(), resolution: note })
      .where(
        and(
          inArray(exceptions.type, ["git_delay", "git_shortage", "git_exception"]),
          ne(exceptions.status, "closed"),
          sql`((${exceptions.sourceType} = 'git_order' AND ${exceptions.sourceId} = ${id}) OR (${exceptions.sourceType} = 'git_delivery' AND ${exceptions.sourceId} IN (${sql.join(deliveryIds.concat(0).map((d) => sql`${d}`), sql`, `)})))`,
        ),
      );
    await addEvent(tx, id, actor, { eventType: "exception_resolved", fromStatus: order.status, toStatus: order.status, note });
    await recordAudit(tx, actor, {
      action: "resolved",
      resource: "git_order",
      resourceId: id,
      recordRef: order.ref,
      oldValue: { exception: order.exceptionType, note: order.exceptionNote },
      newValue: { exception: null, resolution: note },
    });
  });
  return getOrder(actor, id);
}

/* ------------------------------------------------------------------------ */
/* Receipt linkage (called inside the receipts transaction)                  */
/* ------------------------------------------------------------------------ */

interface LinkedReceipt {
  id: number;
  gitDeliveryId: number | null;
  quantity: number;
  waybillRef: string;
  stationId: number;
}

export async function applyReceiptToDelivery(tx: Tx, actor: Actor, receipt: LinkedReceipt) {
  if (!receipt.gitDeliveryId) return;
  const [delivery] = await tx.select().from(gitDeliveries).where(eq(gitDeliveries.id, receipt.gitDeliveryId)).limit(1).for("update");
  if (!delivery) return;
  const [order] = await tx.select().from(gitOrders).where(eq(gitOrders.id, delivery.gitOrderId)).limit(1).for("update");
  if (!order) return;
  if (order.status === "completed" || order.status === "cancelled") {
    throw conflict(`GIT order ${order.ref} is ${order.status}. Cancel this receipt and record it without the GIT link.`);
  }
  if (delivery.status !== "pending") throw conflict(`The ${order.ref} delivery for this station has already been discharged.`);

  const now = new Date();
  const discharged = litres(delivery.dischargedQuantity + receipt.quantity);
  await tx.update(gitDeliveries).set({ dischargedQuantity: discharged, status: "discharged", dischargedAt: now }).where(eq(gitDeliveries.id, delivery.id));

  const [pending] = await tx
    .select({ n: count() })
    .from(gitDeliveries)
    .where(and(eq(gitDeliveries.gitOrderId, order.id), eq(gitDeliveries.status, "pending")));
  const newStatus: GitStatus = (pending?.n ?? 0) === 0 ? "completed" : "discharging";

  const [station] = await tx.select({ name: stations.name }).from(stations).where(eq(stations.id, delivery.stationId));
  const settings = await getSettings(tx);
  const shortage = litres(delivery.plannedQuantity - discharged);
  const patch: Partial<typeof gitOrders.$inferInsert> = {
    status: newStatus,
    arrivedAt: order.arrivedAt ?? now,
    dischargeStartedAt: order.dischargeStartedAt ?? now,
    completedAt: newStatus === "completed" ? now : null,
  };
  if (order.status === "in_transit") {
    await resolveException(tx, { type: "git_delay", sourceType: "git_order", sourceId: order.id }, "Order discharged.", actor.id);
    if (order.exceptionType === "delay") {
      patch.exceptionType = null;
      patch.exceptionNote = null;
    }
  }
  if (shortage > settings.gitShortageToleranceLitres) {
    patch.exceptionType = "shortage";
    patch.exceptionNote = `Shortage ${shortage.toLocaleString("en-NG")}L at ${station?.name ?? "station"}`;
    await raiseException(tx, {
      type: "git_shortage",
      severity: "high",
      stationId: delivery.stationId,
      sourceType: "git_delivery",
      sourceId: delivery.id,
      sourceRef: order.ref,
      title: `GIT shortage ${shortage.toLocaleString("en-NG")}L — ${order.ref}, ${station?.name ?? ""}`,
      detail: `Planned ${delivery.plannedQuantity.toLocaleString("en-NG")}L · received ${discharged.toLocaleString("en-NG")}L · waybill ${receipt.waybillRef}`,
      amount: shortage,
    });
  }
  await tx.update(gitOrders).set(patch).where(eq(gitOrders.id, order.id));

  await addEvent(tx, order.id, actor, {
    eventType: "receipt_verified",
    fromStatus: order.status,
    toStatus: newStatus,
    note: `Waybill ${receipt.waybillRef} · ${receipt.quantity.toLocaleString("en-NG")} L discharged at ${station?.name ?? "station"}`,
  });
  if (newStatus !== order.status) {
    await recordAudit(tx, actor, {
      action: "status_changed",
      resource: "git_order",
      resourceId: order.id,
      recordRef: order.ref,
      stationId: delivery.stationId,
      oldValue: { status: STATUS_LABEL[order.status] },
      newValue: { status: STATUS_LABEL[newStatus], via: receipt.waybillRef },
    });
  }
}

export async function revertReceiptFromDelivery(tx: Tx, actor: Actor, receipt: LinkedReceipt, reason: string) {
  if (!receipt.gitDeliveryId) return;
  const [delivery] = await tx.select().from(gitDeliveries).where(eq(gitDeliveries.id, receipt.gitDeliveryId)).limit(1).for("update");
  if (!delivery) return;
  const [order] = await tx.select().from(gitOrders).where(eq(gitOrders.id, delivery.gitOrderId)).limit(1).for("update");
  if (!order) return;

  const discharged = litres(Math.max(0, delivery.dischargedQuantity - receipt.quantity));
  await tx.update(gitDeliveries).set({ dischargedQuantity: discharged, status: "pending", dischargedAt: null }).where(eq(gitDeliveries.id, delivery.id));

  const [stillDischarged] = await tx
    .select({ n: count() })
    .from(gitDeliveries)
    .where(and(eq(gitDeliveries.gitOrderId, order.id), eq(gitDeliveries.status, "discharged")));
  const newStatus: GitStatus =
    order.status === "cancelled" ? "cancelled" : (stillDischarged?.n ?? 0) > 0 ? "discharging" : "arrived";

  await resolveException(tx, { type: "git_shortage", sourceType: "git_delivery", sourceId: delivery.id }, `Receipt ${receipt.waybillRef} cancelled.`, actor.id);
  const [otherShortages] = await tx
    .select({ n: count() })
    .from(exceptions)
    .where(and(eq(exceptions.type, "git_shortage"), ne(exceptions.status, "closed"), eq(exceptions.sourceRef, order.ref)));

  await tx
    .update(gitOrders)
    .set({
      status: newStatus,
      completedAt: null,
      ...(order.exceptionType === "shortage" && (otherShortages?.n ?? 0) === 0 ? { exceptionType: null, exceptionNote: null } : {}),
    })
    .where(eq(gitOrders.id, order.id));

  await addEvent(tx, order.id, actor, {
    eventType: "receipt_cancelled",
    fromStatus: order.status,
    toStatus: newStatus,
    note: `Waybill ${receipt.waybillRef} cancelled: ${reason}`,
  });
  if (newStatus !== order.status) {
    await recordAudit(tx, actor, {
      action: "status_changed",
      resource: "git_order",
      resourceId: order.id,
      recordRef: order.ref,
      stationId: delivery.stationId,
      oldValue: { status: STATUS_LABEL[order.status] },
      newValue: { status: STATUS_LABEL[newStatus], via: `${receipt.waybillRef} cancelled` },
    });
  }
}

/* ------------------------------------------------------------------------ */
/* Scheduled check                                                           */
/* ------------------------------------------------------------------------ */

export async function scanDelays(): Promise<{ flagged: number; resolved: number }> {
  const settings = await getSettings();
  const cutoff = new Date(Date.now() - settings.gitDelayDays * DAY_MS);
  const late = await selectRows<{
    id: number;
    ref: string;
    quantity: number;
    in_transit_at: string;
    product_code: string;
    truck_plate: string | null;
    exception_type: string | null;
    destinations: string | null;
    station_ids: string | null;
  }>(
    db,
    sql`SELECT o.id, o.ref, o.quantity, o.in_transit_at, p.code AS product_code, tr.plate_number AS truck_plate, o.exception_type,
               (SELECT GROUP_CONCAT(s.name SEPARATOR ', ') FROM git_deliveries d JOIN stations s ON s.id = d.station_id WHERE d.git_order_id = o.id) AS destinations,
               (SELECT GROUP_CONCAT(d.station_id) FROM git_deliveries d WHERE d.git_order_id = o.id) AS station_ids
        FROM git_orders o JOIN products p ON p.id = o.product_id LEFT JOIN trucks tr ON tr.id = o.truck_id
        WHERE o.status = 'in_transit' AND o.in_transit_at <= ${cutoff}`,
  );

  let flagged = 0;
  for (const o of late) {
    const days = transitDays(o.in_transit_at, null) ?? 0;
    const stationIds = (o.station_ids ?? "").split(",").filter(Boolean).map(Number);
    await db.transaction(async (tx) => {
      const raised = await raiseException(tx, {
        type: "git_delay",
        severity: "medium",
        stationId: stationIds.length === 1 ? stationIds[0]! : null,
        sourceType: "git_order",
        sourceId: o.id,
        sourceRef: o.ref,
        title: `GIT overdue — Truck ${o.truck_plate ?? "unassigned"}, ${days} days in transit`,
        detail: `Order ${o.ref} · ${o.destinations ?? ""} · ${o.product_code} ${num(o.quantity).toLocaleString("en-NG")}L`,
        reopenOnChange: false,
      });
      if (!o.exception_type) {
        await tx.update(gitOrders).set({ exceptionType: "delay", exceptionNote: `Delayed — over ${settings.gitDelayDays} days in transit` }).where(eq(gitOrders.id, o.id));
      }
      if (raised) {
        flagged++;
        await recordAudit(tx, null, {
          action: "flagged",
          resource: "git_order",
          resourceId: o.id,
          recordRef: o.ref,
          newValue: { note: `Delayed — ${days} days in transit` },
        });
      }
    });
  }

  // Close delay exceptions for orders that are no longer in transit.
  const stale = await selectRows<{ source_id: number }>(
    db,
    sql`SELECT e.source_id FROM exceptions e JOIN git_orders o ON o.id = e.source_id
        WHERE e.type = 'git_delay' AND e.source_type = 'git_order' AND e.status <> 'closed' AND o.status <> 'in_transit'`,
  );
  for (const s of stale) {
    await resolveException(db, { type: "git_delay", sourceType: "git_order", sourceId: s.source_id }, "Order is no longer in transit.", null);
  }
  return { flagged, resolved: stale.length };
}
