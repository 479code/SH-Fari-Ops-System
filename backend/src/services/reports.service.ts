/**
 * reports.service.ts — the report catalogue.
 *
 * Every report returns the same shape (columns + rows + totals) so the frontend
 * renders any of them with one component and CSV export is generic. Reports
 * reuse the module services where one exists so a report can never disagree
 * with the screen it summarises.
 */
import { sql, type SQL } from "drizzle-orm";
import type { Permission } from "../auth/permissions.ts";
import { stationFilter } from "../auth/scope.ts";
import { db, selectRows } from "../db/client.ts";
import type { Actor } from "../types.ts";
import { currentMonth, resolveRange } from "../utils/dates.ts";
import { AppError } from "../utils/errors.ts";
import { litres, money, num } from "../utils/numbers.ts";
import { likeContains } from "../utils/sql.ts";
import { exportAudit } from "./auditlog.service.ts";
import { getHistory } from "./cash.service.ts";
import { stationComparison } from "./dashboard.service.ts";
import { listDebtors } from "./debtors.service.ts";
import { listOrders, type GitStatus } from "./git.service.ts";

export const MAX_ROWS = 5000;

export type ColumnType = "text" | "number" | "money" | "litres" | "price" | "date" | "datetime" | "status";
export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
}

export interface ReportFilters {
  month?: string;
  from?: string;
  to?: string;
  date?: string;
  stationId?: number;
  productId?: number;
  pumpId?: number;
  bankId?: number;
  narrationId?: number;
  userId?: number;
  status?: string;
  action?: string;
  search?: string;
}

type FilterKey = "range" | "month" | "station" | "product" | "pump" | "bank" | "narration" | "status" | "user" | "action" | "search";

interface ReportOutput {
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  totals?: Record<string, unknown>;
  truncated?: boolean;
  meta?: Record<string, unknown>;
}

interface ReportDefinition {
  key: string;
  title: string;
  category: "daily" | "monthly" | "management";
  description: string;
  filters: FilterKey[];
  statuses?: string[];
  permission: Permission;
  exportPermission: Permission;
  run(actor: Actor, f: ReportFilters): Promise<ReportOutput>;
}

const col = (key: string, label: string, type: ColumnType = "text"): ReportColumn => ({ key, label, type });

function where(conds: (SQL | undefined)[]): SQL {
  const list = conds.filter((c): c is SQL => c !== undefined);
  return list.length ? sql`WHERE ${sql.join(list, sql` AND `)}` : sql``;
}

function statusFilter(f: ReportFilters, allowed: string[], column: string): SQL | undefined {
  if (!f.status) return undefined;
  if (!allowed.includes(f.status)) {
    throw new AppError("VALIDATION_ERROR", "Unknown status filter.", { fields: { status: `Use one of: ${allowed.join(", ")}.` } });
  }
  return sql`${sql.raw(column)} = ${f.status}`;
}

function capped<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
}

const sumOf = (rows: Record<string, unknown>[], key: string) => rows.reduce((s, r) => s + num(r[key]), 0);

/** Stations a report should iterate over for per-station computations. */
async function stationsInScope(actor: Actor, requested?: number) {
  const station = stationFilter(actor, requested);
  return selectRows<{ id: number; name: string }>(
    db,
    sql`SELECT id, name FROM stations ${station !== null ? sql`WHERE id = ${station}` : sql`WHERE status = 'active'`} ORDER BY name`,
  );
}

const REPORTS: ReportDefinition[] = [
  {
    key: "truck-receipts",
    title: "Truck receive report",
    category: "daily",
    description: "Date/month, station, product, truck",
    filters: ["range", "station", "product", "status", "search"],
    statuses: ["received", "verified", "disputed", "cancelled"],
    permission: "receipts.view",
    exportPermission: "reports.export",
    async run(actor, f) {
      const { from, to } = resolveRange(f);
      const station = stationFilter(actor, f.stationId);
      const rows = await selectRows<Record<string, unknown>>(
        db,
        sql`SELECT r.business_date AS date, r.waybill_ref AS waybill, tr.plate_number AS truck, p.code AS product, s.name AS station,
                   t.name AS tank, r.quantity, r.order_price AS orderPrice, r.landing_price AS landingPrice,
                   ROUND(r.quantity * r.landing_price, 2) AS value, o.ref AS gitRef, r.status
            FROM truck_receipts r
            JOIN trucks tr ON tr.id = r.truck_id JOIN products p ON p.id = r.product_id
            JOIN stations s ON s.id = r.station_id JOIN tanks t ON t.id = r.tank_id
            LEFT JOIN git_deliveries gd ON gd.id = r.git_delivery_id LEFT JOIN git_orders o ON o.id = gd.git_order_id
            ${where([
              sql`r.business_date BETWEEN ${from} AND ${to}`,
              station !== null ? sql`r.station_id = ${station}` : undefined,
              f.productId ? sql`r.product_id = ${f.productId}` : undefined,
              statusFilter(f, this.statuses!, "r.status"),
              f.search ? sql`(tr.plate_number LIKE ${likeContains(f.search)} OR r.waybill_ref LIKE ${likeContains(f.search)})` : undefined,
            ])}
            ORDER BY r.business_date, r.id LIMIT ${MAX_ROWS + 1}`,
      );
      const out = capped(rows);
      const verified = out.rows.filter((r) => r.status === "verified");
      return {
        columns: [
          col("date", "Date", "date"), col("waybill", "Waybill ref"), col("truck", "Truck"), col("product", "Product"),
          col("station", "Station"), col("tank", "Tank"), col("quantity", "Qty (L)", "litres"), col("orderPrice", "Order price", "price"),
          col("landingPrice", "Landing price", "price"), col("value", "Value", "money"), col("gitRef", "GIT ref"), col("status", "Status", "status"),
        ],
        ...out,
        totals: { waybill: `${verified.length} verified`, quantity: litres(sumOf(verified, "quantity")), value: money(sumOf(verified, "value")) },
        meta: { from, to },
      };
    },
  },
  {
    key: "daily-sales",
    title: "Daily sales report",
    category: "daily",
    description: "Date, station, pump/product — opening, closing, sales, RTT",
    filters: ["range", "station", "product", "pump"],
    permission: "dsr.view",
    exportPermission: "reports.export",
    async run(actor, f) {
      const { from, to } = resolveRange(f);
      const station = stationFilter(actor, f.stationId);
      const rows = await selectRows<Record<string, unknown>>(
        db,
        sql`SELECT d.business_date AS date, d.ref, s.name AS station, pu.name AS pump, p.code AS product,
                   r.opening_reading AS opening, r.closing_reading AS closing, r.dispensed_litres AS dispensed,
                   r.rtt_litres AS rtt, r.net_sales_litres AS netSales, r.unit_price AS price, r.sales_value AS value
            FROM dsr_readings r JOIN dsr_days d ON d.id = r.dsr_day_id JOIN stations s ON s.id = d.station_id
            JOIN pumps pu ON pu.id = r.pump_id JOIN products p ON p.id = r.product_id
            ${where([
              sql`d.status = 'closed'`,
              sql`d.business_date BETWEEN ${from} AND ${to}`,
              station !== null ? sql`d.station_id = ${station}` : undefined,
              f.productId ? sql`r.product_id = ${f.productId}` : undefined,
              f.pumpId ? sql`r.pump_id = ${f.pumpId}` : undefined,
            ])}
            ORDER BY d.business_date, s.name, pu.name LIMIT ${MAX_ROWS + 1}`,
      );
      const out = capped(rows);
      return {
        columns: [
          col("date", "Date", "date"), col("station", "Station"), col("pump", "Pump"), col("product", "Product"),
          col("opening", "Opening", "litres"), col("closing", "Closing", "litres"), col("dispensed", "Dispensed (L)", "litres"),
          col("rtt", "RTT (L)", "litres"), col("netSales", "Net sales (L)", "litres"), col("price", "Pump price", "price"), col("value", "Sales value", "money"),
        ],
        ...out,
        totals: {
          dispensed: litres(sumOf(out.rows, "dispensed")),
          rtt: litres(sumOf(out.rows, "rtt")),
          netSales: litres(sumOf(out.rows, "netSales")),
          value: money(sumOf(out.rows, "value")),
        },
        meta: { from, to, note: "Closed (locked) days only. RTT is excluded from net sales." },
      };
    },
  },
  {
    key: "rtt",
    title: "RTT report",
    category: "daily",
    description: "Date/month, station, pump, product",
    filters: ["range", "station", "product", "pump", "status"],
    statuses: ["active", "cancelled"],
    permission: "rtt.view",
    exportPermission: "reports.export",
    async run(actor, f) {
      const { from, to } = resolveRange(f);
      const station = stationFilter(actor, f.stationId);
      const rows = await selectRows<Record<string, unknown>>(
        db,
        sql`SELECT e.business_date AS date, e.ref, s.name AS station, pu.name AS pump, p.code AS product, e.quantity,
                   e.reason, u.full_name AS operator, e.status
            FROM rtt_entries e JOIN stations s ON s.id = e.station_id JOIN pumps pu ON pu.id = e.pump_id
            JOIN products p ON p.id = e.product_id JOIN users u ON u.id = e.operator_id
            ${where([
              sql`e.business_date BETWEEN ${from} AND ${to}`,
              station !== null ? sql`e.station_id = ${station}` : undefined,
              f.productId ? sql`e.product_id = ${f.productId}` : undefined,
              f.pumpId ? sql`e.pump_id = ${f.pumpId}` : undefined,
              statusFilter(f, this.statuses!, "e.status"),
            ])}
            ORDER BY e.business_date, e.id LIMIT ${MAX_ROWS + 1}`,
      );
      const out = capped(rows);
      return {
        columns: [
          col("date", "Date", "date"), col("ref", "Ref"), col("station", "Station"), col("pump", "Pump"), col("product", "Product"),
          col("quantity", "Qty (L)", "litres"), col("reason", "Reason"), col("operator", "Operator"), col("status", "Status", "status"),
        ],
        ...out,
        totals: { quantity: litres(sumOf(out.rows.filter((r) => r.status === "active"), "quantity")) },
        meta: { from, to },
      };
    },
  },
  {
    key: "stock-ledger",
    title: "Stock ledger",
    category: "monthly",
    description: "Date range, station, product — opening, receipts, sales, RTT, adjustments, closing",
    filters: ["range", "station", "product"],
    permission: "stock.view",
    exportPermission: "reports.export",
    async run(actor, f) {
      const { from, to } = resolveRange(f);
      const station = stationFilter(actor, f.stationId);
      const scope = [
        sql`l.voided_at IS NULL`,
        station !== null ? sql`l.station_id = ${station}` : undefined,
        f.productId ? sql`l.product_id = ${f.productId}` : undefined,
      ];
      const [openings, days] = await Promise.all([
        selectRows<{ station_id: number; product_id: number; qty: number }>(
          db,
          sql`SELECT l.station_id, l.product_id, SUM(l.quantity) AS qty FROM stock_ledger l
              ${where([...scope, sql`l.business_date < ${from}`])} GROUP BY l.station_id, l.product_id`,
        ),
        selectRows<{ station_id: number; station: string; product_id: number; product: string; date: string; receipts: number; dispensed: number; rtt: number; adjustments: number }>(
          db,
          sql`SELECT l.station_id, s.name AS station, l.product_id, p.code AS product, l.business_date AS date,
                     SUM(CASE WHEN l.movement_type = 'receipt' THEN l.quantity ELSE 0 END) AS receipts,
                     SUM(CASE WHEN l.movement_type = 'dispensed' THEN -l.quantity ELSE 0 END) AS dispensed,
                     SUM(CASE WHEN l.movement_type = 'rtt' THEN l.quantity ELSE 0 END) AS rtt,
                     SUM(CASE WHEN l.movement_type IN ('adjustment', 'opening_balance') THEN l.quantity ELSE 0 END) AS adjustments
              FROM stock_ledger l JOIN stations s ON s.id = l.station_id JOIN products p ON p.id = l.product_id
              ${where([...scope, sql`l.business_date BETWEEN ${from} AND ${to}`])}
              GROUP BY l.station_id, l.product_id, l.business_date
              ORDER BY s.name, p.code, l.business_date LIMIT ${MAX_ROWS + 1}`,
        ),
      ]);
      const running = new Map(openings.map((o) => [`${o.station_id}:${o.product_id}`, litres(num(o.qty))]));
      const rows = days.map((d) => {
        const key = `${d.station_id}:${d.product_id}`;
        const opening = running.get(key) ?? 0;
        const receipts = litres(num(d.receipts));
        const dispensed = litres(num(d.dispensed));
        const rtt = litres(num(d.rtt));
        const adjustments = litres(num(d.adjustments));
        const closing = litres(opening + receipts - dispensed + rtt + adjustments);
        running.set(key, closing);
        return { date: d.date, station: d.station, product: d.product, opening, receipts, dispensed, rtt, netSales: litres(dispensed - rtt), adjustments, closing };
      });
      const out = capped(rows);
      return {
        columns: [
          col("date", "Date", "date"), col("station", "Station"), col("product", "Product"), col("opening", "Opening", "litres"),
          col("receipts", "+ Receipts", "litres"), col("dispensed", "− Dispensed", "litres"), col("rtt", "+ RTT", "litres"),
          col("adjustments", "± Adjustments", "litres"), col("closing", "Closing", "litres"), col("netSales", "Net sales", "litres"),
        ],
        ...out,
        totals: {
          receipts: litres(sumOf(out.rows, "receipts")),
          dispensed: litres(sumOf(out.rows, "dispensed")),
          rtt: litres(sumOf(out.rows, "rtt")),
          adjustments: litres(sumOf(out.rows, "adjustments")),
          netSales: litres(sumOf(out.rows, "netSales")),
        },
        meta: { from, to, note: "Days with movements only. Closing = opening + receipts − dispensed + RTT ± adjustments." },
      };
    },
  },
  {
    key: "dip-variance",
    title: "Physical dip variance",
    category: "daily",
    description: "Date, station, tank/product — system stock, dip, variance, tolerance",
    filters: ["range", "station", "product", "status"],
    statuses: ["within_tolerance", "exceeded"],
    permission: "stock.view",
    exportPermission: "reports.export",
    async run(actor, f) {
      const { from, to } = resolveRange(f);
      const station = stationFilter(actor, f.stationId);
      const rows = await selectRows<Record<string, unknown>>(
        db,
        sql`SELECT d.business_date AS date, d.ref, s.name AS station, t.name AS tank, p.code AS product,
                   d.system_stock AS systemStock, d.dip_litres AS dip, d.variance, d.tolerance, d.tolerance_status AS status
            FROM physical_dips d JOIN stations s ON s.id = d.station_id JOIN tanks t ON t.id = d.tank_id JOIN products p ON p.id = d.product_id
            ${where([
              sql`d.business_date BETWEEN ${from} AND ${to}`,
              station !== null ? sql`d.station_id = ${station}` : undefined,
              f.productId ? sql`d.product_id = ${f.productId}` : undefined,
              statusFilter(f, this.statuses!, "d.tolerance_status"),
            ])}
            ORDER BY d.business_date, s.name, t.name LIMIT ${MAX_ROWS + 1}`,
      );
      const out = capped(rows);
      return {
        columns: [
          col("date", "Date", "date"), col("ref", "Ref"), col("station", "Station"), col("tank", "Tank"), col("product", "Product"),
          col("systemStock", "System stock", "litres"), col("dip", "Physical dip", "litres"), col("variance", "Variance", "litres"),
          col("tolerance", "Tolerance ±", "litres"), col("status", "Status", "status"),
        ],
        ...out,
        totals: { variance: litres(sumOf(out.rows, "variance")), ref: `${out.rows.filter((r) => r.status === "exceeded").length} exceeded` },
        meta: { from, to },
      };
    },
  },
  {
    key: "cash-reconciliation",
    title: "Cash reconciliation",
    category: "daily",
    description: "Date, station — expected cash, POS, CIT, bank deposit, cash at hand, variance",
    filters: ["range", "station"],
    permission: "cash.view",
    exportPermission: "reports.export",
    async run(actor, f) {
      const rows: Record<string, unknown>[] = [];
      for (const s of await stationsInScope(actor, f.stationId)) {
        const history = await getHistory(actor, s.id, f);
        for (const r of [...history.rows].reverse()) rows.push({ ...r, station: s.name });
      }
      const out = capped(rows);
      return {
        columns: [
          col("businessDate", "Date", "date"), col("station", "Station"), col("salesValue", "Sales value", "money"), col("posAmount", "POS", "money"),
          col("creditSales", "Credit sales", "money"), col("debtorCashReceipts", "Debtor cash", "money"), col("cashExpenses", "Cash expenses", "money"),
          col("expectedCash", "Expected cash", "money"), col("broughtForward", "CIT b/f", "money"), col("depositsTotal", "Deposited", "money"),
          col("closingCit", "CIT", "money"), col("cashAtHand", "Cash at hand", "money"), col("variance", "Variance", "money"),
          col("toleranceStatus", "Tolerance", "status"), col("status", "Status", "status"),
        ],
        ...out,
        totals: {
          salesValue: money(sumOf(out.rows, "salesValue")),
          expectedCash: money(sumOf(out.rows, "expectedCash")),
          depositsTotal: money(sumOf(out.rows, "depositsTotal")),
          variance: money(sumOf(out.rows, "variance")),
        },
        meta: resolveRange(f),
      };
    },
  },
  {
    key: "bank-deposits",
    title: "Bank / teller report",
    category: "daily",
    description: "Date, bank, teller/reference, amount, station",
    filters: ["range", "station", "bank", "status"],
    statuses: ["confirmed", "cancelled"],
    permission: "cash.view",
    exportPermission: "reports.export",
    async run(actor, f) {
      const { from, to } = resolveRange(f);
      const station = stationFilter(actor, f.stationId);
      const rows = await selectRows<Record<string, unknown>>(
        db,
        sql`SELECT b.business_date AS date, b.deposited_at AS depositedAt, s.name AS station, bk.name AS bank, b.teller_ref AS tellerRef,
                   b.amount, u.full_name AS recordedBy, b.status
            FROM bank_deposits b JOIN stations s ON s.id = b.station_id JOIN banks bk ON bk.id = b.bank_id JOIN users u ON u.id = b.recorded_by
            ${where([
              sql`b.business_date BETWEEN ${from} AND ${to}`,
              station !== null ? sql`b.station_id = ${station}` : undefined,
              f.bankId ? sql`b.bank_id = ${f.bankId}` : undefined,
              statusFilter(f, this.statuses!, "b.status"),
            ])}
            ORDER BY b.business_date, b.deposited_at LIMIT ${MAX_ROWS + 1}`,
      );
      const out = capped(rows);
      return {
        columns: [
          col("date", "Date", "date"), col("depositedAt", "Time", "datetime"), col("station", "Station"), col("bank", "Bank"),
          col("tellerRef", "Teller / ref"), col("amount", "Amount", "money"), col("recordedBy", "Recorded by"), col("status", "Status", "status"),
        ],
        ...out,
        totals: { amount: money(sumOf(out.rows.filter((r) => r.status === "confirmed"), "amount")) },
        meta: { from, to },
      };
    },
  },
  {
    key: "expenses",
    title: "Expense report",
    category: "monthly",
    description: "Date/month, station, narration, amount, approval status",
    filters: ["range", "station", "narration", "status"],
    statuses: ["pending", "approved", "rejected", "cancelled"],
    permission: "expenses.view",
    exportPermission: "reports.export",
    async run(actor, f) {
      const { from, to } = resolveRange(f);
      const station = stationFilter(actor, f.stationId);
      const rows = await selectRows<Record<string, unknown>>(
        db,
        sql`SELECT e.business_date AS date, e.ref, s.name AS station, n.name AS narration, e.payee, e.payment_method AS method,
                   e.amount, e.status, u.full_name AS decidedBy
            FROM expenses e JOIN stations s ON s.id = e.station_id JOIN expense_narrations n ON n.id = e.narration_id
            LEFT JOIN users u ON u.id = e.decided_by
            ${where([
              sql`e.business_date BETWEEN ${from} AND ${to}`,
              station !== null ? sql`e.station_id = ${station}` : undefined,
              f.narrationId ? sql`e.narration_id = ${f.narrationId}` : undefined,
              statusFilter(f, this.statuses!, "e.status"),
            ])}
            ORDER BY e.business_date, e.id LIMIT ${MAX_ROWS + 1}`,
      );
      const out = capped(rows);
      return {
        columns: [
          col("date", "Date", "date"), col("ref", "Ref"), col("station", "Station"), col("narration", "Narration"), col("payee", "Payee"),
          col("method", "Paid by"), col("amount", "Amount", "money"), col("status", "Approval", "status"), col("decidedBy", "Decided by"),
        ],
        ...out,
        totals: { amount: money(sumOf(out.rows.filter((r) => r.status === "approved"), "amount")), payee: "Approved total" },
        meta: { from, to },
      };
    },
  },
  {
    key: "debtors",
    title: "Debtor report",
    category: "monthly",
    description: "Customer, station — opening debt, additions, payments, closing balance",
    filters: ["range", "station", "search"],
    permission: "debtors.view",
    exportPermission: "reports.export",
    async run(actor, f) {
      const result = await listDebtors(actor, {
        month: f.month,
        from: f.from,
        to: f.to,
        stationId: f.stationId,
        search: f.search,
        hasBalance: false,
        sortBy: "name",
        sortOrder: "asc",
        page: 1,
        limit: MAX_ROWS,
      });
      const rows = result.rows.map((r) => ({ ...r, aging: r.aging.replace("_", "–").replace("plus", "+") }));
      return {
        columns: [
          col("name", "Customer"), col("stationName", "Station"), col("opening", "Opening bal.", "money"), col("additions", "Additions", "money"),
          col("payments", "Payments", "money"), col("closing", "Closing bal.", "money"), col("aging", "Aging", "status"),
        ],
        rows,
        truncated: result.pagination.total > MAX_ROWS,
        totals: {
          opening: money(sumOf(rows, "opening")),
          additions: money(sumOf(rows, "additions")),
          payments: money(sumOf(rows, "payments")),
          closing: money(sumOf(rows, "closing")),
        },
        meta: result.range,
      };
    },
  },
  {
    key: "git",
    title: "GIT report",
    category: "monthly",
    description: "Order, truck, product, destination, delivery/discharge status",
    filters: ["range", "station", "product", "status", "search"],
    statuses: ["order_created", "truck_assigned", "in_transit", "arrived", "discharging", "completed", "cancelled", "open", "exception"],
    permission: "git.view",
    exportPermission: "reports.export",
    async run(actor, f) {
      if (f.status && !this.statuses!.includes(f.status)) {
        throw new AppError("VALIDATION_ERROR", "Unknown status filter.", { fields: { status: "Unknown status." } });
      }
      const result = await listOrders(actor, {
        ...f,
        month: f.month ?? (f.from || f.to ? undefined : currentMonth()),
        status: f.status as GitStatus | "open" | "exception" | undefined,
        page: 1,
        limit: MAX_ROWS,
      });
      return {
        columns: [
          col("ref", "Order"), col("orderDate", "Order date", "date"), col("truckPlate", "Truck"), col("productCode", "Product"),
          col("quantity", "Qty (L)", "litres"), col("orderPrice", "Order price", "price"), col("value", "Value", "money"),
          col("destinations", "Destination(s)"), col("discharged", "Discharged (L)", "litres"), col("outstanding", "Outstanding (L)", "litres"),
          col("statusLabel", "Status", "status"), col("exceptionNote", "Exception"),
        ],
        rows: result.rows,
        truncated: result.pagination.total > MAX_ROWS,
        totals: {
          quantity: litres(sumOf(result.rows, "quantity")),
          value: money(sumOf(result.rows, "value")),
          outstanding: litres(sumOf(result.rows, "outstanding")),
        },
      };
    },
  },
  {
    key: "monthly-management",
    title: "Monthly management report",
    category: "management",
    description: "Sales, receipts, stock, expense, profit, debt and GIT by station",
    filters: ["month", "station"],
    permission: "reports.view",
    exportPermission: "reports.export",
    async run(actor, f) {
      const month = f.month ?? currentMonth();
      const station = stationFilter(actor, f.stationId);
      const result = await stationComparison(actor, month, station);
      return {
        columns: [
          col("stationName", "Station"), col("soldLitres", "Sold (L)", "litres"), col("salesValue", "Sales value", "money"),
          col("costOfSales", "Cost of sales", "money"), col("grossProfit", "Gross profit", "money"), col("expenses", "Expenses", "money"),
          col("netProfit", "Net profit", "money"), col("trucksReceived", "Trucks recv.", "number"), col("receivedLitres", "Received (L)", "litres"),
          col("closingStockLitres", "Closing stock (L)", "litres"), col("closingStockValue", "Stock value", "money"),
          col("debt", "Debt", "money"), col("gitLitres", "GIT (L)", "litres"), col("gitValue", "GIT value", "money"),
        ],
        rows: result.rows,
        totals: { stationName: "Total", ...result.totals },
        meta: { month, ...result.range, note: "Approved records only. Debt and stock as of month end; GIT is current outstanding." },
      };
    },
  },
  {
    key: "audit",
    title: "Audit report",
    category: "management",
    description: "User, action, record, old value, new value, timestamp",
    filters: ["range", "user", "action", "search"],
    permission: "audit.view",
    exportPermission: "audit.export",
    async run(actor, f) {
      const range = f.from || f.to || f.month ? resolveRange(f) : { from: undefined, to: undefined };
      const result = await exportAudit(actor, { ...range, userId: f.userId, action: f.action, search: f.search }, MAX_ROWS);
      return {
        columns: [
          col("createdAt", "Timestamp", "datetime"), col("userName", "User"), col("action", "Action", "status"), col("resource", "Resource"),
          col("recordRef", "Record"), col("oldValue", "Old value"), col("newValue", "New value"), col("ipAddress", "IP address"),
        ],
        rows: result.rows.map((r) => ({
          ...r,
          oldValue: r.oldValue === null ? "" : JSON.stringify(r.oldValue),
          newValue: r.newValue === null ? "" : JSON.stringify(r.newValue),
        })),
        truncated: result.truncated,
      };
    },
  },
];

export function listReports(actor: Actor) {
  return REPORTS.filter((r) => actor.permissions.has(r.permission) && actor.permissions.has("reports.view")).map((r) => ({
    key: r.key,
    title: r.title,
    category: r.category,
    description: r.description,
    filters: r.filters,
    statuses: r.statuses ?? [],
    canExport: actor.permissions.has(r.exportPermission),
  }));
}

export function findReport(key: string) {
  return REPORTS.find((r) => r.key === key) ?? null;
}

export async function runReport(actor: Actor, key: string, filters: ReportFilters) {
  const def = findReport(key);
  if (!def) throw new AppError("NOT_FOUND", "Report not found.");
  if (!actor.permissions.has("reports.view") || !actor.permissions.has(def.permission)) {
    throw new AppError("FORBIDDEN", "You do not have permission to run this report.");
  }
  const output = await def.run(actor, filters);
  return {
    key: def.key,
    title: def.title,
    category: def.category,
    generatedAt: new Date().toISOString(),
    filters,
    exportPermission: def.exportPermission,
    truncated: output.truncated ?? false,
    ...output,
  };
}
