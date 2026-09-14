/** Station operations: GIT, truck receipts, DSR, RTT, stock ledger, adjustments and dips. */
import { boolean, index, int, mysqlEnum, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { businessDate, createdAt, fk, id, instant, money, unitPrice, updatedAt, volume } from "./columns.ts";
import { users } from "./auth.ts";
import { products, pumps, stations, tanks, trucks } from "./master.ts";

export const GIT_STATUSES = [
  "order_created",
  "truck_assigned",
  "in_transit",
  "arrived",
  "discharging",
  "completed",
  "cancelled",
] as const;

export const gitOrders = mysqlTable(
  "git_orders",
  {
    id: id(),
    ref: varchar({ length: 20 }).notNull().unique(),
    productId: fk()
      .notNull()
      .references(() => products.id),
    /** Original order quantity and price are immutable once created. */
    quantity: volume().notNull(),
    orderPrice: unitPrice().notNull(),
    truckId: fk().references(() => trucks.id),
    isMultiDelivery: boolean().notNull().default(false),
    source: varchar({ length: 120 }),
    status: mysqlEnum(GIT_STATUSES).notNull().default("order_created"),
    orderDate: businessDate().notNull(),
    expectedArrivalDate: businessDate(),
    truckAssignedAt: instant(),
    inTransitAt: instant(),
    arrivedAt: instant(),
    dischargeStartedAt: instant(),
    completedAt: instant(),
    cancelledAt: instant(),
    cancelReason: varchar({ length: 255 }),
    exceptionType: mysqlEnum(["shortage", "delay", "price", "other"]),
    exceptionNote: varchar({ length: 255 }),
    notes: varchar({ length: 255 }),
    createdBy: fk()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("git_orders_status_idx").on(t.status), index("git_orders_date_idx").on(t.orderDate)],
);

/** One row per destination; a multi-delivery order has several. */
export const gitDeliveries = mysqlTable(
  "git_deliveries",
  {
    id: id(),
    gitOrderId: fk()
      .notNull()
      .references(() => gitOrders.id, { onDelete: "cascade" }),
    stationId: fk()
      .notNull()
      .references(() => stations.id),
    plannedQuantity: volume().notNull(),
    dischargedQuantity: volume().notNull().default(0),
    status: mysqlEnum(["pending", "discharged", "cancelled"]).notNull().default("pending"),
    dischargedAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("git_deliveries_order_station_uq").on(t.gitOrderId, t.stationId), index("git_deliveries_station_idx").on(t.stationId)],
);

/** Append-only history of dynamic GIT changes, so edits never destroy the record. */
export const gitEvents = mysqlTable(
  "git_events",
  {
    id: id(),
    gitOrderId: fk()
      .notNull()
      .references(() => gitOrders.id, { onDelete: "cascade" }),
    eventType: varchar({ length: 40 }).notNull(),
    fromStatus: varchar({ length: 30 }),
    toStatus: varchar({ length: 30 }),
    note: varchar({ length: 255 }),
    userId: fk().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("git_events_order_idx").on(t.gitOrderId)],
);

export const truckReceipts = mysqlTable(
  "truck_receipts",
  {
    id: id(),
    /** Controlled receiving reference — a receipt cannot be duplicated. */
    waybillRef: varchar({ length: 60 }).notNull().unique(),
    stationId: fk()
      .notNull()
      .references(() => stations.id),
    productId: fk()
      .notNull()
      .references(() => products.id),
    tankId: fk()
      .notNull()
      .references(() => tanks.id),
    truckId: fk()
      .notNull()
      .references(() => trucks.id),
    gitDeliveryId: fk().references(() => gitDeliveries.id),
    quantity: volume().notNull(),
    orderPrice: unitPrice().notNull(),
    landingPrice: unitPrice().notNull(),
    businessDate: businessDate().notNull(),
    receivedAt: instant().notNull(),
    status: mysqlEnum(["received", "verified", "disputed", "cancelled"]).notNull().default("received"),
    verifiedBy: fk().references(() => users.id),
    verifiedAt: instant(),
    disputeReason: varchar({ length: 255 }),
    disputedBy: fk().references(() => users.id),
    disputedAt: instant(),
    cancelReason: varchar({ length: 255 }),
    cancelledBy: fk().references(() => users.id),
    cancelledAt: instant(),
    recordedBy: fk()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("truck_receipts_station_date_idx").on(t.stationId, t.businessDate),
    index("truck_receipts_status_idx").on(t.status),
    index("truck_receipts_delivery_idx").on(t.gitDeliveryId),
  ],
);

export const dsrDays = mysqlTable(
  "dsr_days",
  {
    id: id(),
    ref: varchar({ length: 40 }).notNull().unique(),
    stationId: fk()
      .notNull()
      .references(() => stations.id),
    businessDate: businessDate().notNull(),
    status: mysqlEnum(["open", "closed"]).notNull().default("open"),
    openedBy: fk()
      .notNull()
      .references(() => users.id),
    openedAt: instant().notNull(),
    closedBy: fk().references(() => users.id),
    closedAt: instant(),
    reopenCount: int({ unsigned: true }).notNull().default(0),
    lastReopenedBy: fk().references(() => users.id),
    lastReopenedAt: instant(),
    lastReopenReason: varchar({ length: 255 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("dsr_days_station_date_uq").on(t.stationId, t.businessDate), index("dsr_days_status_idx").on(t.status)],
);

/**
 * One row per pump per day. Calculated columns are snapshotted when the day is
 * closed so later price changes cannot rewrite a locked day's sales.
 */
export const dsrReadings = mysqlTable(
  "dsr_readings",
  {
    id: id(),
    dsrDayId: fk()
      .notNull()
      .references(() => dsrDays.id, { onDelete: "cascade" }),
    pumpId: fk()
      .notNull()
      .references(() => pumps.id),
    tankId: fk()
      .notNull()
      .references(() => tanks.id),
    productId: fk()
      .notNull()
      .references(() => products.id),
    openingReading: volume().notNull(),
    closingReading: volume(),
    dispensedLitres: volume(),
    rttLitres: volume(),
    netSalesLitres: volume(),
    unitPrice: unitPrice(),
    unitCost: unitPrice(),
    salesValue: money(),
    costValue: money(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("dsr_readings_day_pump_uq").on(t.dsrDayId, t.pumpId), index("dsr_readings_pump_idx").on(t.pumpId)],
);

export const rttEntries = mysqlTable(
  "rtt_entries",
  {
    id: id(),
    ref: varchar({ length: 20 }).notNull().unique(),
    stationId: fk()
      .notNull()
      .references(() => stations.id),
    pumpId: fk()
      .notNull()
      .references(() => pumps.id),
    tankId: fk()
      .notNull()
      .references(() => tanks.id),
    productId: fk()
      .notNull()
      .references(() => products.id),
    businessDate: businessDate().notNull(),
    quantity: volume().notNull(),
    reason: varchar({ length: 255 }).notNull(),
    operatorId: fk()
      .notNull()
      .references(() => users.id),
    status: mysqlEnum(["active", "cancelled"]).notNull().default("active"),
    cancelledBy: fk().references(() => users.id),
    cancelledAt: instant(),
    cancelReason: varchar({ length: 255 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("rtt_station_date_idx").on(t.stationId, t.businessDate), index("rtt_pump_date_idx").on(t.pumpId, t.businessDate)],
);

export const stockAdjustments = mysqlTable(
  "stock_adjustments",
  {
    id: id(),
    ref: varchar({ length: 20 }).notNull().unique(),
    stationId: fk()
      .notNull()
      .references(() => stations.id),
    tankId: fk()
      .notNull()
      .references(() => tanks.id),
    productId: fk()
      .notNull()
      .references(() => products.id),
    businessDate: businessDate().notNull(),
    /** Signed: positive adds stock, negative removes it. */
    quantity: volume().notNull(),
    reason: varchar({ length: 255 }).notNull(),
    createdBy: fk()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("stock_adjustments_tank_date_idx").on(t.tankId, t.businessDate)],
);

/**
 * The continuous stock ledger. Balance = SUM(quantity) of non-voided rows, so
 * closing stock carries forward as the next day's opening by construction.
 * Rows are voided (never deleted) when their source is reversed.
 */
export const stockLedger = mysqlTable(
  "stock_ledger",
  {
    id: id(),
    stationId: fk()
      .notNull()
      .references(() => stations.id),
    tankId: fk()
      .notNull()
      .references(() => tanks.id),
    productId: fk()
      .notNull()
      .references(() => products.id),
    businessDate: businessDate().notNull(),
    movementType: mysqlEnum(["opening_balance", "receipt", "dispensed", "rtt", "adjustment"]).notNull(),
    quantity: volume().notNull(),
    sourceType: mysqlEnum(["tank", "truck_receipt", "dsr_reading", "rtt_entry", "stock_adjustment"]).notNull(),
    sourceId: fk().notNull(),
    sourceRef: varchar({ length: 60 }).notNull(),
    voidedAt: instant(),
    voidedBy: fk().references(() => users.id),
    voidReason: varchar({ length: 255 }),
    createdBy: fk().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("stock_ledger_tank_date_idx").on(t.tankId, t.businessDate),
    index("stock_ledger_station_product_date_idx").on(t.stationId, t.productId, t.businessDate),
    index("stock_ledger_source_idx").on(t.sourceType, t.sourceId),
  ],
);

/** A physical observation; it never overwrites system stock. */
export const physicalDips = mysqlTable(
  "physical_dips",
  {
    id: id(),
    ref: varchar({ length: 30 }).notNull().unique(),
    stationId: fk()
      .notNull()
      .references(() => stations.id),
    tankId: fk()
      .notNull()
      .references(() => tanks.id),
    productId: fk()
      .notNull()
      .references(() => products.id),
    businessDate: businessDate().notNull(),
    systemStock: volume().notNull(),
    dipLitres: volume().notNull(),
    /** dip − system: negative means product is missing. */
    variance: volume().notNull(),
    tolerance: volume().notNull(),
    toleranceStatus: mysqlEnum(["within_tolerance", "exceeded"]).notNull(),
    note: varchar({ length: 255 }),
    recordedBy: fk()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("physical_dips_tank_date_uq").on(t.tankId, t.businessDate), index("physical_dips_station_date_idx").on(t.stationId, t.businessDate)],
);
