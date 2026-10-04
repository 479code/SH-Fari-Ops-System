/** Master data every transaction depends on: stations, products, tanks, pumps, prices and lists. */
import { bigint, index, mysqlEnum, mysqlTable, text, uniqueIndex, varchar, type AnyMySqlColumn } from "drizzle-orm/mysql-core";
import { businessDate, createdAt, fk, id, money, unitPrice, updatedAt, volume } from "./columns.ts";
import { users } from "./auth.ts";

const activeStatus = () => mysqlEnum(["active", "inactive"]).notNull().default("active");

export const stations = mysqlTable("stations", {
  id: id(),
  /** Short code used in document references, e.g. DSR-LA-20260913. */
  code: varchar({ length: 10 }).notNull().unique(),
  name: varchar({ length: 120 }).notNull().unique(),
  address: varchar({ length: 255 }),
  managerUserId: fk().references((): AnyMySqlColumn => users.id, { onDelete: "set null" }),
  /** Cash variance (₦) above which a reconciliation is flagged. */
  cashTolerance: money().notNull().default(0),
  /** Physical-dip variance (litres, ±) above which a tank is flagged. */
  stockTolerance: volume().notNull().default(0),
  status: activeStatus(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const products = mysqlTable("products", {
  id: id(),
  code: varchar({ length: 10 }).notNull().unique(),
  name: varchar({ length: 60 }).notNull(),
  status: activeStatus(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Pump selling prices with effective dates. A price change inserts a new row;
 * existing transactions keep the price they snapshotted. station_id NULL is the
 * company-wide default, overridden by a station-specific row.
 */
export const productPrices = mysqlTable(
  "product_prices",
  {
    id: id(),
    productId: fk()
      .notNull()
      .references(() => products.id),
    stationId: fk().references(() => stations.id),
    price: unitPrice().notNull(),
    effectiveFrom: businessDate().notNull(),
    createdBy: fk().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("product_prices_lookup_idx").on(t.productId, t.stationId, t.effectiveFrom)],
);

export const tanks = mysqlTable(
  "tanks",
  {
    id: id(),
    stationId: fk()
      .notNull()
      .references(() => stations.id),
    productId: fk()
      .notNull()
      .references(() => products.id),
    name: varchar({ length: 60 }).notNull(),
    capacity: volume(),
    status: activeStatus(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("tanks_station_name_uq").on(t.stationId, t.name), index("tanks_station_product_idx").on(t.stationId, t.productId)],
);

export const pumps = mysqlTable(
  "pumps",
  {
    id: id(),
    stationId: fk()
      .notNull()
      .references(() => stations.id),
    tankId: fk()
      .notNull()
      .references(() => tanks.id),
    name: varchar({ length: 60 }).notNull(),
    meterLabel: varchar({ length: 40 }),
    /** Opening reading for the pump's first DSR; later days inherit the prior closing reading. */
    initialReading: volume().notNull().default(0),
    status: activeStatus(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("pumps_station_name_uq").on(t.stationId, t.name), index("pumps_tank_idx").on(t.tankId)],
);

export const trucks = mysqlTable("trucks", {
  id: id(),
  plateNumber: varchar({ length: 20 }).notNull().unique(),
  transporter: varchar({ length: 120 }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const banks = mysqlTable("banks", {
  id: id(),
  name: varchar({ length: 80 }).notNull().unique(),
  status: activeStatus(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const expenseNarrations = mysqlTable("expense_narrations", {
  id: id(),
  name: varchar({ length: 80 }).notNull().unique(),
  /** Expenses above this amount need approval. NULL = never needs approval. */
  approvalThreshold: money(),
  status: activeStatus(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Business-configurable control parameters, JSON-encoded values. */
export const settings = mysqlTable("settings", {
  key: varchar({ length: 80 }).primaryKey(),
  value: text().notNull(),
  updatedBy: fk().references(() => users.id, { onDelete: "set null" }),
  updatedAt: updatedAt(),
});

/** Counters for human-readable document references (GIT-1042, RTT-3391…). */
export const refSequences = mysqlTable("ref_sequences", {
  name: varchar({ length: 40 }).primaryKey(),
  value: bigint({ mode: "number", unsigned: true }).notNull().default(0),
});
