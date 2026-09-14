/** Control layer: exceptions requiring attention and the audit trail. */
import { index, json, mysqlEnum, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { createdAt, fk, id, instant, money, updatedAt } from "./columns.ts";
import { users } from "./auth.ts";
import { stations } from "./master.ts";

export const EXCEPTION_TYPES = [
  "cash_variance",
  "stock_variance",
  "git_delay",
  "git_shortage",
  "git_exception",
  "debtor_aging",
] as const;
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];

/**
 * One row per (type, source). Raising an exception that already exists updates
 * it in place, so re-running a check never duplicates an alert.
 */
export const exceptions = mysqlTable(
  "exceptions",
  {
    id: id(),
    type: mysqlEnum(EXCEPTION_TYPES).notNull(),
    severity: mysqlEnum(["high", "medium"]).notNull(),
    stationId: fk().references(() => stations.id),
    sourceType: varchar({ length: 40 }).notNull(),
    sourceId: fk().notNull(),
    sourceRef: varchar({ length: 60 }).notNull(),
    title: varchar({ length: 255 }).notNull(),
    detail: varchar({ length: 500 }),
    amount: money(),
    status: mysqlEnum(["open", "reviewed", "closed"]).notNull().default("open"),
    raisedAt: instant().notNull(),
    reviewedBy: fk().references(() => users.id),
    reviewedAt: instant(),
    reviewComment: varchar({ length: 500 }),
    closedBy: fk().references(() => users.id),
    closedAt: instant(),
    resolution: varchar({ length: 500 }),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("exceptions_source_uq").on(t.type, t.sourceType, t.sourceId),
    index("exceptions_status_station_idx").on(t.status, t.stationId),
  ],
);

export const auditLogs = mysqlTable(
  "audit_logs",
  {
    id: id(),
    /** NULL = performed by the system (scheduled checks, automatic flags). */
    userId: fk().references(() => users.id),
    action: varchar({ length: 40 }).notNull(),
    resource: varchar({ length: 40 }).notNull(),
    resourceId: varchar({ length: 40 }),
    recordRef: varchar({ length: 80 }),
    stationId: fk(),
    oldValue: json(),
    newValue: json(),
    ipAddress: varchar({ length: 64 }),
    userAgent: varchar({ length: 255 }),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_created_idx").on(t.createdAt),
    index("audit_user_idx").on(t.userId),
    index("audit_action_idx").on(t.action),
    index("audit_ref_idx").on(t.recordRef),
    index("audit_resource_idx").on(t.resource, t.resourceId),
  ],
);
