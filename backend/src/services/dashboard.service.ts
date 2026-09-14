/**
 * dashboard.service.ts — management KPIs, all computed from approved records:
 * closed (locked) DSR days, verified receipts and approved expenses.
 *
 * Profit follows the configured rule used throughout reporting:
 *   gross profit = net sales value − cost of sales (net litres × landing cost snapshotted at DSR close)
 *   net profit   = gross profit − approved expenses
 */
import { and, count, eq, sql } from "drizzle-orm";
import { stationFilter } from "../auth/scope.ts";
import { db, selectRows } from "../db/client.ts";
import { dsrDays, exceptions, expenses } from "../db/schema/index.ts";
import { valuationPrices } from "../repositories/pricing.repo.ts";
import type { Actor } from "../types.ts";
import { addDays, addMonths, minDate, monthBounds, startOfWeek, today } from "../utils/dates.ts";
import { litres, money, num, round } from "../utils/numbers.ts";
import { debtorSummary } from "./debtors.service.ts";
import { countExceptions, listExceptions } from "./exceptions.service.ts";
import { outstandingByStation, outstandingByStatus } from "./git.service.ts";
import { getTankStatus } from "./stock.service.ts";

const scopeSql = (column: string, station: number | null) => (station !== null ? sql`AND ${sql.raw(column)} = ${station}` : sql``);

async function salesBetween(from: string, to: string, station: number | null) {
  const [row] = await selectRows<{ value: number; litres: number; cost: number }>(
    db,
    sql`SELECT COALESCE(SUM(r.sales_value), 0) AS value, COALESCE(SUM(r.net_sales_litres), 0) AS litres, COALESCE(SUM(r.cost_value), 0) AS cost
        FROM dsr_readings r JOIN dsr_days d ON d.id = r.dsr_day_id
        WHERE d.status = 'closed' AND d.business_date BETWEEN ${from} AND ${to} ${scopeSql("d.station_id", station)}`,
  );
  return { value: money(num(row?.value)), litres: litres(num(row?.litres)), cost: money(num(row?.cost)) };
}

async function expensesBetween(from: string, to: string, station: number | null) {
  const [row] = await selectRows<{ amount: number }>(
    db,
    sql`SELECT COALESCE(SUM(amount), 0) AS amount FROM expenses
        WHERE status = 'approved' AND business_date BETWEEN ${from} AND ${to} ${scopeSql("station_id", station)}`,
  );
  return money(num(row?.amount));
}

const pct = (current: number, previous: number) => (previous === 0 ? null : round(((current - previous) / Math.abs(previous)) * 100, 1));

export async function getDashboard(actor: Actor, q: { stationId?: number }) {
  const station = stationFilter(actor, q.stationId);
  const now = today();
  const month = now.slice(0, 7);
  const { from } = monthBounds(month);
  const prevMonth = addMonths(month, -1);
  const prev = monthBounds(prevMonth);
  const prevTo = minDate(prev.to, addDays(prev.from, Number(now.slice(8, 10)) - 1));

  const [salesMtd, salesPrev, expMtd, expPrev, tanks, debt, gitByStatus, exceptionList, exceptionCounts, trendRows, byStation, comparison] = await Promise.all([
    salesBetween(from, now, station),
    salesBetween(prev.from, prevTo, station),
    expensesBetween(from, now, station),
    expensesBetween(prev.from, prevTo, station),
    getTankStatus(actor, { stationId: station ?? undefined }),
    debtorSummary(actor, station ?? undefined),
    outstandingByStatus(db, station),
    listExceptions(actor, { status: "open", stationId: station ?? undefined, page: 1, limit: 5 }),
    countExceptions(actor, station ?? undefined),
    selectRows<{ business_date: string; value: number }>(
      db,
      sql`SELECT d.business_date, SUM(r.sales_value) AS value
          FROM dsr_readings r JOIN dsr_days d ON d.id = r.dsr_day_id
          WHERE d.status = 'closed' AND d.business_date BETWEEN ${addDays(startOfWeek(now), -49)} AND ${now} ${scopeSql("d.station_id", station)}
          GROUP BY d.business_date`,
    ),
    selectRows<{ id: number; name: string; value: number; litres: number }>(
      db,
      sql`SELECT s.id, s.name, COALESCE(SUM(r.sales_value), 0) AS value, COALESCE(SUM(r.net_sales_litres), 0) AS litres
          FROM stations s
          LEFT JOIN dsr_days d ON d.station_id = s.id AND d.status = 'closed' AND d.business_date BETWEEN ${from} AND ${now}
          LEFT JOIN dsr_readings r ON r.dsr_day_id = d.id
          WHERE s.status = 'active' ${scopeSql("s.id", station)}
          GROUP BY s.id ORDER BY value DESC, s.name`,
    ),
    stationComparison(actor, prevMonth, station),
  ]);

  const weekStart = startOfWeek(now);
  const weeks = Array.from({ length: 8 }, (_, i) => ({ weekStart: addDays(weekStart, (i - 7) * 7), value: 0 }));
  for (const r of trendRows) {
    const w = weeks.find((x) => x.weekStart === startOfWeek(r.business_date));
    if (w) w.value = money(w.value + num(r.value));
  }

  const netMtd = money(salesMtd.value - salesMtd.cost - expMtd);
  const netPrev = money(salesPrev.value - salesPrev.cost - expPrev);
  const stockLitres = litres(tanks.reduce((s, t) => s + t.balance, 0));
  const stockValue = money(tanks.reduce((s, t) => s + t.stockValue, 0));

  return {
    asOf: now,
    period: { month, from, to: now, comparedTo: { from: prev.from, to: prevTo } },
    kpis: {
      salesMtd: salesMtd.value,
      salesLitresMtd: salesMtd.litres,
      salesDeltaPct: pct(salesMtd.value, salesPrev.value),
      stockValue,
      stockLitres,
      stockStations: new Set(tanks.map((t) => t.stationId)).size,
      outstandingDebt: debt.totalOutstanding,
      debtAccountsOver60: debt.accountsOver60,
      netProfitMtd: netMtd,
      grossProfitMtd: money(salesMtd.value - salesMtd.cost),
      expensesMtd: expMtd,
      netProfitDeltaPct: pct(netMtd, netPrev),
    },
    salesTrend: weeks,
    gitStatus: gitByStatus,
    exceptions: { open: exceptionCounts.open, byType: exceptionCounts.byType, items: exceptionList.rows },
    salesByStation: byStation.map((s) => ({ stationId: s.id, stationName: s.name, value: money(num(s.value)), litres: litres(num(s.litres)) })),
    stationSummary: comparison,
    topDebtors: debt.topDebtors,
  };
}

/**
 * Station-level month results. Debt and closing stock are as of month end;
 * GIT has no history, so it is the current outstanding quantity.
 */
export async function stationComparison(actor: Actor, month: string, stationOverride?: number | null) {
  const station = stationOverride === undefined ? stationFilter(actor) : stationOverride;
  const { from, to } = monthBounds(month);
  const end = minDate(to, today());

  const [stationRows, sales, receipts, exp, debt, stock, git] = await Promise.all([
    selectRows<{ id: number; name: string }>(db, sql`SELECT id, name FROM stations s WHERE s.status = 'active' ${scopeSql("s.id", station)} ORDER BY name`),
    selectRows<{ station_id: number; value: number; litres: number; cost: number }>(
      db,
      sql`SELECT d.station_id, SUM(r.sales_value) AS value, SUM(r.net_sales_litres) AS litres, SUM(r.cost_value) AS cost
          FROM dsr_readings r JOIN dsr_days d ON d.id = r.dsr_day_id
          WHERE d.status = 'closed' AND d.business_date BETWEEN ${from} AND ${to} ${scopeSql("d.station_id", station)}
          GROUP BY d.station_id`,
    ),
    selectRows<{ station_id: number; n: number; litres: number }>(
      db,
      sql`SELECT station_id, COUNT(*) AS n, SUM(quantity) AS litres FROM truck_receipts
          WHERE status = 'verified' AND business_date BETWEEN ${from} AND ${to} ${scopeSql("station_id", station)}
          GROUP BY station_id`,
    ),
    selectRows<{ station_id: number; amount: number }>(
      db,
      sql`SELECT station_id, SUM(amount) AS amount FROM expenses
          WHERE status = 'approved' AND business_date BETWEEN ${from} AND ${to} ${scopeSql("station_id", station)}
          GROUP BY station_id`,
    ),
    selectRows<{ station_id: number; balance: number }>(
      db,
      sql`SELECT station_id, SUM(CASE WHEN type = 'repayment' THEN -amount ELSE amount END) AS balance
          FROM debtor_transactions WHERE voided_at IS NULL AND business_date <= ${end} ${scopeSql("station_id", station)}
          GROUP BY station_id`,
    ),
    selectRows<{ station_id: number; product_id: number; litres: number }>(
      db,
      sql`SELECT station_id, product_id, SUM(quantity) AS litres FROM stock_ledger
          WHERE voided_at IS NULL AND business_date <= ${end} ${scopeSql("station_id", station)}
          GROUP BY station_id, product_id`,
    ),
    outstandingByStation(db, station),
  ]);

  const prices = await valuationPrices(db, stock.map((s) => ({ stationId: s.station_id, productId: s.product_id })), end);
  const rows = stationRows.map((s) => {
    const sale = sales.find((x) => x.station_id === s.id);
    const rec = receipts.find((x) => x.station_id === s.id);
    const expenseTotal = money(num(exp.find((x) => x.station_id === s.id)?.amount));
    const stockRows = stock.filter((x) => x.station_id === s.id);
    const salesValue = money(num(sale?.value));
    const costOfSales = money(num(sale?.cost));
    const gitRow = git.get(s.id);
    return {
      stationId: s.id,
      stationName: s.name,
      soldLitres: litres(num(sale?.litres)),
      salesValue,
      costOfSales,
      grossProfit: money(salesValue - costOfSales),
      trucksReceived: num(rec?.n),
      receivedLitres: litres(num(rec?.litres)),
      expenses: expenseTotal,
      netProfit: money(salesValue - costOfSales - expenseTotal),
      debt: money(num(debt.find((x) => x.station_id === s.id)?.balance)),
      closingStockLitres: litres(stockRows.reduce((sum, x) => sum + num(x.litres), 0)),
      closingStockValue: money(stockRows.reduce((sum, x) => sum + num(x.litres) * (prices.get(`${x.station_id}:${x.product_id}`) ?? 0), 0)),
      gitLitres: gitRow?.litres ?? 0,
      gitValue: gitRow?.value ?? 0,
    };
  });

  const sum = (k: keyof (typeof rows)[number]) => rows.reduce((s, r) => s + (r[k] as number), 0);
  return {
    month,
    range: { from, to },
    rows,
    totals: {
      soldLitres: litres(sum("soldLitres")),
      salesValue: money(sum("salesValue")),
      costOfSales: money(sum("costOfSales")),
      grossProfit: money(sum("grossProfit")),
      trucksReceived: sum("trucksReceived"),
      receivedLitres: litres(sum("receivedLitres")),
      expenses: money(sum("expenses")),
      netProfit: money(sum("netProfit")),
      debt: money(sum("debt")),
      closingStockLitres: litres(sum("closingStockLitres")),
      closingStockValue: money(sum("closingStockValue")),
      gitLitres: litres(sum("gitLitres")),
      gitValue: money(sum("gitValue")),
    },
  };
}

/** Counts behind the navigation badges. */
export async function getBadges(actor: Actor) {
  const station = stationFilter(actor);
  const [openDays, stockExceptions, openExceptions, pendingExpenses] = await Promise.all([
    db.select({ n: count() }).from(dsrDays).where(and(eq(dsrDays.status, "open"), station !== null ? eq(dsrDays.stationId, station) : undefined)),
    db
      .select({ n: count() })
      .from(exceptions)
      .where(and(eq(exceptions.type, "stock_variance"), eq(exceptions.status, "open"), station !== null ? eq(exceptions.stationId, station) : undefined)),
    db.select({ n: count() }).from(exceptions).where(and(eq(exceptions.status, "open"), station !== null ? eq(exceptions.stationId, station) : undefined)),
    db.select({ n: count() }).from(expenses).where(and(eq(expenses.status, "pending"), station !== null ? eq(expenses.stationId, station) : undefined)),
  ]);
  return {
    openDsrDays: openDays[0]?.n ?? 0,
    stockExceptions: stockExceptions[0]?.n ?? 0,
    openExceptions: openExceptions[0]?.n ?? 0,
    pendingExpenses: pendingExpenses[0]?.n ?? 0,
  };
}
