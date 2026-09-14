/** Finance: bank deposits, daily cash positions, debtors and expenses. */
import { index, mysqlEnum, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import { businessDate, createdAt, fk, id, instant, money, updatedAt } from "./columns.ts";
import { users } from "./auth.ts";
import { banks, expenseNarrations, stations } from "./master.ts";

export const bankDeposits = mysqlTable(
  "bank_deposits",
  {
    id: id(),
    /** Teller / deposit slip reference — unique so a deposit cannot be counted twice. */
    tellerRef: varchar({ length: 60 }).notNull().unique(),
    stationId: fk()
      .notNull()
      .references(() => stations.id),
    bankId: fk()
      .notNull()
      .references(() => banks.id),
    businessDate: businessDate().notNull(),
    depositedAt: instant().notNull(),
    amount: money().notNull(),
    status: mysqlEnum(["confirmed", "cancelled"]).notNull().default("confirmed"),
    recordedBy: fk()
      .notNull()
      .references(() => users.id),
    cancelledBy: fk().references(() => users.id),
    cancelledAt: instant(),
    cancelReason: varchar({ length: 255 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("bank_deposits_station_date_idx").on(t.stationId, t.businessDate)],
);

/**
 * The cashier's end-of-day declaration (POS total, CIT, cash counted) plus a
 * snapshot of the reconciliation computed from it:
 *
 *   expected         = sales value − POS − credit sales + cash debtor repayments − approved cash expenses
 *   brought forward  = previous declared day's closing CIT + cash at hand
 *   variance         = deposits + closing CIT + cash at hand − (brought forward + expected)
 *
 * The snapshot is refreshed whenever the day is recalculated and frozen once closed.
 */
export const cashPositions = mysqlTable(
  "cash_positions",
  {
    id: id(),
    stationId: fk()
      .notNull()
      .references(() => stations.id),
    businessDate: businessDate().notNull(),
    posAmount: money().notNull().default(0),
    closingCit: money().notNull().default(0),
    cashAtHand: money().notNull().default(0),
    notes: varchar({ length: 255 }),
    status: mysqlEnum(["open", "reviewed", "closed"]).notNull().default("open"),
    salesValue: money().notNull().default(0),
    creditSales: money().notNull().default(0),
    debtorCashReceipts: money().notNull().default(0),
    cashExpenses: money().notNull().default(0),
    expectedCash: money().notNull().default(0),
    broughtForward: money().notNull().default(0),
    depositsTotal: money().notNull().default(0),
    variance: money().notNull().default(0),
    tolerance: money().notNull().default(0),
    toleranceStatus: mysqlEnum(["reconciled", "within_tolerance", "exceeded"]).notNull().default("reconciled"),
    recordedBy: fk()
      .notNull()
      .references(() => users.id),
    reviewedBy: fk().references(() => users.id),
    reviewedAt: instant(),
    reviewComment: varchar({ length: 500 }),
    closedBy: fk().references(() => users.id),
    closedAt: instant(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("cash_positions_station_date_uq").on(t.stationId, t.businessDate)],
);

export const debtors = mysqlTable(
  "debtors",
  {
    id: id(),
    stationId: fk()
      .notNull()
      .references(() => stations.id),
    name: varchar({ length: 160 }).notNull(),
    phone: varchar({ length: 30 }),
    /** Optional cap on the outstanding balance; NULL = no limit. */
    creditLimit: money(),
    status: mysqlEnum(["active", "inactive"]).notNull().default("active"),
    createdBy: fk()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("debtors_station_name_uq").on(t.stationId, t.name)],
);

/** Balances are never stored — they are always the sum of these rows. */
export const debtorTransactions = mysqlTable(
  "debtor_transactions",
  {
    id: id(),
    debtorId: fk()
      .notNull()
      .references(() => debtors.id),
    stationId: fk()
      .notNull()
      .references(() => stations.id),
    type: mysqlEnum(["opening_balance", "credit_sale", "repayment"]).notNull(),
    /** Always positive; the type decides the sign. */
    amount: money().notNull(),
    businessDate: businessDate().notNull(),
    reference: varchar({ length: 60 }),
    paymentMethod: mysqlEnum(["cash", "transfer", "pos"]),
    note: varchar({ length: 255 }),
    recordedBy: fk()
      .notNull()
      .references(() => users.id),
    voidedAt: instant(),
    voidedBy: fk().references(() => users.id),
    voidReason: varchar({ length: 255 }),
    createdAt: createdAt(),
  },
  (t) => [index("debtor_tx_debtor_date_idx").on(t.debtorId, t.businessDate), index("debtor_tx_station_date_idx").on(t.stationId, t.businessDate)],
);

export const expenses = mysqlTable(
  "expenses",
  {
    id: id(),
    ref: varchar({ length: 20 }).notNull().unique(),
    stationId: fk()
      .notNull()
      .references(() => stations.id),
    narrationId: fk()
      .notNull()
      .references(() => expenseNarrations.id),
    businessDate: businessDate().notNull(),
    amount: money().notNull(),
    payee: varchar({ length: 120 }).notNull(),
    reference: varchar({ length: 60 }),
    note: varchar({ length: 255 }),
    paymentMethod: mysqlEnum(["cash", "transfer"]).notNull().default("cash"),
    status: mysqlEnum(["pending", "approved", "rejected", "cancelled"]).notNull(),
    /** Threshold in force when the expense was logged. */
    approvalThreshold: money(),
    decidedBy: fk().references(() => users.id),
    decidedAt: instant(),
    decisionNote: varchar({ length: 255 }),
    recordedBy: fk()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("expenses_station_date_idx").on(t.stationId, t.businessDate),
    index("expenses_status_idx").on(t.status),
    index("expenses_narration_idx").on(t.narrationId),
  ],
);
