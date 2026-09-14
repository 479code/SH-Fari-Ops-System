/** Dashboard — consolidated KPIs, trend, GIT status, exceptions and station summaries. */
import { api } from "../api/client.js";
import { $, html, raw, setHtml } from "../core/dom.js";
import { areaChart, bars, donut } from "../core/charts.js";
import { exceptionPill, openException } from "../core/exceptions.js";
import { stationOptions } from "../core/filters.js";
import { monthLabel, naira, number, pct, recentMonths } from "../core/format.js";
import { refreshBadges } from "../core/shell.js";
import { boundStation, currentMonth, state } from "../core/state.js";
import { fillTable, infoModal, tableError, tableLoading, toastError } from "../core/ui.js";

const GIT_COLORS = { order_created: "#7C5CFC", truck_assigned: "#7C5CFC", in_transit: "#3E6DF6", arrived: "#F5A524", discharging: "#1CA96B" };
const ICON_WARN = raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.5 17.5a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>');
const ICON_CLOCK = raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>');

let exceptionItems = [];

function delta(el, value) {
  if (value === null || value === undefined) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = `kpi-delta ${value >= 0 ? "up" : "down"}`;
  setHtml(el, html`${value >= 0 ? "▲" : "▼"} ${pct(value)}<span class="muted">vs last month</span>`);
}

function summaryRow(r) {
  return html`<tr${r.total ? raw(' style="font-weight:700"') : ""}><td class="strong">${r.stationName}</td><td class="num">${number(r.soldLitres)}</td><td class="num">${naira(r.salesValue, { compact: true })}</td><td class="num">${number(r.trucksReceived)}</td><td class="num">${naira(r.expenses, { compact: true })}</td><td class="num ${r.netProfit < 0 ? "num-neg" : ""}">${naira(r.netProfit, { compact: true })}</td><td class="num">${naira(r.debt, { compact: true })}</td><td class="num">${r.gitLitres ? `${number(r.gitLitres)}L` : "—"}</td></tr>`;
}

function withTotals(summary) {
  return summary.rows.length > 1 ? [...summary.rows, { ...summary.totals, stationName: "Total", total: true }] : summary.rows;
}

function exceptionRow(item, index) {
  const amber = item.severity === "medium";
  return html`<div class="exception-row clickable" data-exception-index="${index}"><div class="exc-ico ${amber ? "amber" : ""}">${amber ? ICON_CLOCK : ICON_WARN}</div><div class="exc-body"><div class="exc-title">${item.title}</div><div class="exc-meta">${item.detail ?? ""}</div></div>${exceptionPill(item)}</div>`;
}

function render(data) {
  const k = data.kpis;
  $("#kpiSales").textContent = naira(k.salesMtd, { compact: true });
  delta($("#kpiSalesDelta"), k.salesDeltaPct);
  $("#kpiStock").textContent = naira(k.stockValue, { compact: true });
  setHtml($("#kpiStockSub"), html`${number(k.stockLitres)} L<span class="muted">${k.stockStations} station${k.stockStations === 1 ? "" : "s"}</span>`);
  $("#kpiDebt").textContent = naira(k.outstandingDebt, { compact: true });
  const debtSub = $("#kpiDebtSub");
  debtSub.hidden = false;
  debtSub.className = `kpi-delta ${k.debtAccountsOver60 > 0 ? "down" : "up"}`;
  setHtml(debtSub, k.debtAccountsOver60 > 0 ? html`▲ ${k.debtAccountsOver60} acct${k.debtAccountsOver60 === 1 ? "" : "s"}<span class="muted">over 60 days</span>` : html`None<span class="muted">over 60 days</span>`);
  $("#kpiProfit").textContent = naira(k.netProfitMtd, { compact: true });
  delta($("#kpiProfitDelta"), k.netProfitDeltaPct);

  const stations = data.salesByStation.length;
  $("#dashDesc").textContent = `${stations > 1 ? `Consolidated across ${stations} stations` : (data.salesByStation[0]?.stationName ?? "No stations")} — month to date, approved records only`;
  setHtml($("#salesTrendChart"), areaChart(data.salesTrend, { partialLast: true }));
  $("#trendSub").textContent = `${stations > 1 ? "All stations combined" : "Closed sales days"}, ₦ — current week to date shown dashed`;

  const segments = data.gitStatus.map((g) => ({ label: g.label, value: g.litres, color: GIT_COLORS[g.status] }));
  const chart = donut(segments);
  setHtml($("#gitDonut"), chart.svg);
  setHtml($("#gitLegend"), html`${chart.legend}`);

  exceptionItems = data.exceptions.items;
  $("#dashExceptionCount").textContent = `${data.exceptions.open} open`;
  setHtml(
    $("#dashExceptions"),
    exceptionItems.length ? html`${exceptionItems.map(exceptionRow)}` : html`<div class="chart-empty">No open exceptions — all variances are within tolerance.</div>`,
  );

  setHtml($("#salesByStation"), bars(data.salesByStation.map((s) => ({ label: s.stationName, value: s.value }))));

  $("#stationSummaryMonth").textContent = `${monthLabel(data.stationSummary.month)} — last closed month`;
  fillTable($("#stationSummaryBody"), 8, withTotals(data.stationSummary), summaryRow, "No stations to summarise.");
}

function compareRow(r) {
  return html`<tr${r.total ? raw(' style="font-weight:700"') : ""}><td class="strong">${r.stationName}</td><td class="num">${number(r.soldLitres)}</td><td class="num">${naira(r.salesValue)}</td><td class="num">${naira(r.costOfSales)}</td><td class="num">${naira(r.grossProfit)}</td><td class="num">${naira(r.expenses)}</td><td class="num ${r.netProfit < 0 ? "num-neg" : ""}">${naira(r.netProfit)}</td><td class="num">${number(r.closingStockLitres)} L</td><td class="num">${naira(r.debt)}</td><td class="num">${number(r.gitLitres)}</td></tr>`;
}

function openComparison() {
  const months = recentMonths(currentMonth(), 12);
  infoModal({
    title: "Station comparison",
    content: html`<div style="margin-bottom:12px"><select class="select" data-compare-month>${months.map((m) => html`<option value="${m.value}">${m.label}</option>`)}</select></div>
      <div class="table-wrap"><table><thead><tr><th class="strong">Station</th><th class="num">Sold (L)</th><th class="num">Sales value</th><th class="num">Cost of sales</th><th class="num">Gross profit</th><th class="num">Expenses</th><th class="num">Net profit</th><th class="num">Closing stock</th><th class="num">Debt</th><th class="num">GIT (L)</th></tr></thead><tbody data-compare-body></tbody></table></div>
      <div class="hint" style="margin-top:10px">Approved records only. Debt and stock as of month end; GIT is the current outstanding quantity.</div>`,
    onRender: (form) => {
      const select = form.querySelector("[data-compare-month]");
      const body = form.querySelector("[data-compare-body]");
      const run = async () => {
        tableLoading(body, 10);
        try {
          const { data } = await api.get("/dashboard/comparison", { month: select.value });
          fillTable(body, 10, withTotals(data), compareRow, "No stations.");
        } catch (err) {
          tableError(body, 10, err, run);
        }
      };
      select.addEventListener("change", run);
      run();
    },
  });
}

export default {
  id: "dashboard",
  permission: "dashboard.view",

  init() {
    const select = $("#dashStation");
    stationOptions(select, { all: true });
    select.hidden = boundStation() !== null || (state.lookups?.stations.length ?? 0) < 2;
    select.addEventListener("change", () => this.load());
    $("#dashExceptions").addEventListener("click", (e) => {
      const row = e.target.closest("[data-exception-index]");
      if (row) {
        openException(exceptionItems[Number(row.dataset.exceptionIndex)], () => {
          this.load();
          refreshBadges();
        });
      }
    });
  },

  async load() {
    tableLoading($("#stationSummaryBody"), 8);
    try {
      const { data } = await api.get("/dashboard", { stationId: $("#dashStation").value || undefined });
      render(data);
    } catch (err) {
      toastError(err);
      tableError($("#stationSummaryBody"), 8, err, () => this.load());
      setHtml($("#salesTrendChart"), html`<div class="chart-empty">${err.message}</div>`);
    }
  },

  actions: {
    "dash-export": () => window.print(),
    "dash-compare": openComparison,
  },
};
