/**
 * columns.ts — shared column shapes so every table uses the same types.
 *
 * - ids are INT UNSIGNED; foreign keys must match exactly.
 * - money DECIMAL(16,2), volumes/readings DECIMAL(14,2), unit prices DECIMAL(12,2),
 *   all mapped to JS numbers (see utils/numbers.ts for the rounding contract).
 * - business dates are DATE handled as 'YYYY-MM-DD' strings; instants are DATETIME in UTC.
 */
import { sql } from "drizzle-orm";
import { date, datetime, decimal, int } from "drizzle-orm/mysql-core";

export const id = () => int({ unsigned: true }).autoincrement().primaryKey();
export const fk = () => int({ unsigned: true });

export const money = () => decimal({ precision: 16, scale: 2, mode: "number" });
export const volume = () => decimal({ precision: 14, scale: 2, mode: "number" });
export const unitPrice = () => decimal({ precision: 12, scale: 2, mode: "number" });

export const businessDate = () => date({ mode: "string" });
export const instant = () => datetime({ mode: "date" });

export const createdAt = () => datetime({ mode: "date" }).notNull().default(sql`CURRENT_TIMESTAMP`);
export const updatedAt = () =>
  datetime({ mode: "date" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`)
    .$onUpdate(() => new Date());
