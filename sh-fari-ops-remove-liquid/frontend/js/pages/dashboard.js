/**
 * Dashboard — network-wide overview plus a per-station "twin": a real-data
 * drill-down (stock equation, pump/tank readings, featured GIT delivery,
 * today's DSR control) for whichever station is selected in the switcher.
 *
 * The station illustration is only shown for a station whose actual pump/tank
 * configuration fits the illustration's fixed hotspot slots (max 3 pumps; at
 * most one PMS tank and one AGO tank). Any other station gets a plain, still
 * fully real, data panel instead — the picture never stands in for numbers
 * it can't actually represent.
 */
import { api } from "../api/client.js";
import { $, html, raw, setHtml } from "../core/dom.js";
import { areaChart, bars } from "../core/charts.js";
import { exceptionPill, openException } from "../core/exceptions.js";
import { pumpsFor } from "../core/filters.js";
import { monthLabel, naira, number, pct, recentMonths } from "../core/format.js";
import { navigate } from "../core/router.js";
import { refreshBadges } from "../core/shell.js";
import { can, currentMonth, defaultStationId, state, today } from "../core/state.js";
import { bindHotspotClicks, loadTankMovements, mobileAssetsMarkup, pumpDetailModal, pumpHotspot, receiptDetailModal, receiptHotspot, renderOverflowInto, signedNumber, splitStationForIllustration, stationScene, tankDetailModal, tankHotspot } from "../core/twin.js";
import { fillTable, infoModal, tableError, tableLoading, toast, toastError } from "../core/ui.js";

const ICON_PATHS = {
  station: "M3 7h18V3H3zM5 7v14M19 7v14M2 21h20M9 11h6v10H9zM10 14h4",
  truck: "M1 6h13v11H1zM14 10h4l4 4v3h-8M4 17a2 2 0 1 0 4 0M16 17a2 2 0 1 0 4 0",
  drop: "M12 2s-7 8-7 13a7 7 0 0 0 14 0c0-5-7-13-7-13z",
  alert: "M12 3 2 21h20zM12 9v5M12 17v1",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v6l4 2",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4M12 15v3",
  unlock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0M12 15v3",
  check: "M4 12l5 5L21 5",
  external: "M7 17 19 5M8 5h11v11M4 8v12h12",
  arrow: "M5 12h14M13 6l6 6-6 6",
};
const ico = (name, cls = "") => raw(`<svg class="ico ${cls}" viewBox="0 0 24 24">${`<path d="${ICON_PATHS[name]}"/>`}</svg>`);

let stationId = null;
let exceptionItems = [];
let currentDsrDay = null;
let currentReceipt = null;
let currentMovementsByProduct = new Map();
let summaryMonth = null;

/* ---------------------------------------------------------------- Network */

function delta(el, value) {
  if (value === null || value === undefined) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = value >= 0 ? "green" : "red";
  setHtml(el, html`${value >= 0 ? "▲" : "▼"} ${pct(value)} vs last month`);
}

function summaryRow(r) {
  return html`<tr${r.total ? raw(' style="font-weight:700"') : ""}><td class="strong">${r.stationName}</td><td class="num">${number(r.soldLitres)}</td><td class="num">${naira(r.salesValue, { compact: true })}</td><td class="num">${number(r.trucksReceived)}</td><td class="num">${naira(r.expenses, { compact: true })}</td><td class="num ${r.netProfit < 0 ? "num-neg" : ""}">${naira(r.netProfit, { compact: true })}</td><td class="num">${naira(r.debt, { compact: true })}</td><td class="num">${r.gitLitres ? `${number(r.gitLitres)}L` : "—"}</td></tr>`;
}

function withTotals(summary) {
  return summary.rows.length > 1 ? [...summary.rows, { ...summary.totals, stationName: "Total", total: true }] : summary.rows;
}

function exceptionRow(item, index) {
  const amber = item.type === "git_delay" || item.type === "debtor_aging";
  const icon = item.type === "stock_variance" ? "drop" : item.type === "git_delay" ? "clock" : "alert";
  return html`<div class="exception-item clickable" data-exception-index="${index}"><span class="exception-icon ${amber ? "warn" : ""}">${ico(icon)}</span><div><b>${item.title}</b><p>${item.detail ?? ""}</p>${exceptionPill(item)}</div></div>`;
}

function renderNetworkMap() {
  const stations = state.lookups?.stations ?? [];
  setHtml(
    $("#routeSchematic"),
    html`${stations
      .slice(0, 3)
      .map((s) => html`<div class="route-node">${s.name}</div>`)}`,
  );
  $("#netStationCount").textContent = `Schematic · ${stations.length} station${stations.length === 1 ? "" : "s"}`;
}

function renderNetwork(data) {
  const k = data.kpis;
  const stations = state.lookups?.stations.length ?? 0;
  $("#netSub").textContent = `${stations} station${stations === 1 ? "" : "s"} · ${monthLabel(data.period.month)} month to date`;

  $("#netSales").textContent = naira(k.salesMtd, { compact: true });
  delta($("#netSalesDelta"), k.salesDeltaPct);
  $("#netStock").textContent = naira(k.stockValue, { compact: true });
  $("#netStockSub").textContent = `${number(k.stockLitres)} L · ${k.stockStations} station${k.stockStations === 1 ? "" : "s"}`;
  $("#netDebt").textContent = naira(k.outstandingDebt, { compact: true });
  $("#netDebtSub").textContent = k.debtAccountsOver60 > 0 ? `${k.debtAccountsOver60} acct${k.debtAccountsOver60 === 1 ? "" : "s"} over 60 days` : "None over 60 days";
  $("#netProfit").textContent = naira(k.netProfitMtd, { compact: true });
  delta($("#netProfitDelta"), k.netProfitDeltaPct);

  exceptionItems = data.exceptions.items;
  $("#dashExceptionCount").textContent = data.exceptions.open;
  setHtml(
    $("#dashExceptions"),
    exceptionItems.length ? html`${exceptionItems.map(exceptionRow)}` : html`<div class="chart-empty">No open exceptions — all variances are within tolerance.</div>`,
  );

  $("#trendSub").textContent = `Last 8 weeks · ₦ · ${stations > 1 ? "all stations" : "closed sales days"}`;
  setHtml($("#salesTrendChart"), areaChart(data.salesTrend, { partialLast: true }));
  $("#netStationBadge").textContent = `${data.salesByStation.length} station${data.salesByStation.length === 1 ? "" : "s"}`;
  setHtml($("#salesByStation"), bars(data.salesByStation.map((s) => ({ label: s.stationName, value: s.value }))));

  $("#stationSummaryMonth").textContent = `${monthLabel(data.stationSummary.month)} — last closed month`;
  summaryMonth = data.stationSummary.month;
  fillTable($("#stationSummaryBody"), 8, withTotals(data.stationSummary), summaryRow, "No stations to summarise.");
}

async function loadNetwork() {
  tableLoading($("#stationSummaryBody"), 8);
  try {
    const { data } = await api.get("/dashboard", {});
    renderNetwork(data);
  } catch (err) {
    toastError(err);
    tableError($("#stationSummaryBody"), 8, err, loadNetwork);
    setHtml($("#salesTrendChart"), html`<div class="chart-empty">${err.message}</div>`);
  }
}

/* -------------------------------------------------------------- Switcher */

function renderSwitcher() {
  const stations = state.lookups?.stations ?? [];
  setHtml(
    $("#stationSwitcher"),
    html`${stations.map(
      (s) =>
        html`<button type="button" class="station-option ${s.id === stationId ? "active" : ""}" data-station="${s.id}" aria-pressed="${s.id === stationId}">${ico("station")}<span><b>${s.name}</b><small>${s.code}</small></span></button>`,
    )}`,
  );
}

/* ------------------------------------------------------------------ Twin */

async function renderTwin(shownPumps, movementsById, dsrDay, receipt) {
  const pumpReadings = dsrDay?.readings ?? [];
  const pumpBlocks = shownPumps.map((p, i) => pumpHotspot(p, i, pumpReadings.find((r) => r.pumpName === p.name)));
  const tankBlocks = ["PMS", "AGO"].map((code) => tankHotspot(code, movementsById.get(code)));

  setHtml(
    $("#twinCanvas"),
    html`${stationScene("Illustrative station cutaway showing tanker receiving, fuel dispensers and underground tanks")}${receiptHotspot(receipt)}${pumpBlocks}${tankBlocks}`,
  );
  setHtml($("#twinMobileAssets"), mobileAssetsMarkup(shownPumps, movementsById, pumpReadings, receipt));
}

function renderOverflow(overflowPumps, overflowTanks, movementsByTankId, dsrDay) {
  renderOverflowInto($("#twinOverflow"), overflowPumps, overflowTanks, { movementsByTankId, pumpReadings: dsrDay?.readings ?? [] });
}

function renderEquation(movement) {
  const el = $("#twinEquation");
  if (!movement) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const items = [
    ["Opening", number(movement.opening)],
    ["Receipts", number(movement.receipts)],
    ["Sales", number(movement.dispensed)],
    ["RTT", number(movement.rtt)],
    ["Adj.", signedNumber(movement.adjustments)],
    ["System", `${number(movement.closing)} L`],
  ];
  setHtml(
    el,
    html`<div class="equation-title">Stock position<br><span class="muted">${movement.productCode} · ${movement.tankName ?? "primary tank"}</span></div>${items.map(
      ([label, value], i) => html`${i ? html`<span>${["", "+", "−", "+", "±", "="][i]}</span>` : ""}<div class="equation-item ${i === 5 ? "total" : ""}"><label>${label}</label><strong class="num">${value}</strong></div>`,
    )}`,
  );
}

const STAGES = [
  ["order_created", "Order"],
  ["truck_assigned", "Assigned"],
  ["in_transit", "In transit"],
  ["arrived", "Arrived"],
  ["discharging", "Discharge"],
  ["completed", "Completed"],
];

function renderJourney(order) {
  const el = $("#twinJourney");
  if (!order) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const currentIndex = STAGES.findIndex(([s]) => s === order.status);
  setHtml(
    el,
    html`<div class="journey-ref">${ico("truck")}<div><small>GIT journey</small><b>${order.ref} · ${order.productCode} · ${number(order.quantity)} L</b></div></div><div class="journey-steps">${STAGES.map(
      ([s, label], i) => html`<div class="journey-step ${i < currentIndex ? "done" : i === currentIndex ? "current" : ""}"><span class="step-dot">${i < currentIndex ? "✓" : i === currentIndex ? "•" : ""}</span>${label}</div>`,
    )}</div><button type="button" class="link" data-action="journey-open" data-id="${order.id}">${order.delayed ? `${order.daysInTransit} days · Delayed` : order.statusLabel} ${ico("arrow")}</button>`,
  );
}

function renderDayControl(dsrDay) {
  const el = $("#dayControl");
  if (!can("dsr.view")) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (!dsrDay?.day) {
    setHtml(
      el,
      html`<h3>${ico("unlock")}Daily sales control</h3><small>${dsrDay?.openBlocker ?? "This business day has not been opened yet."}</small><button type="button" class="btn" data-action="open-dsr">Open day ${ico("arrow")}</button>`,
    );
    return;
  }
  const locked = dsrDay.status === "closed";
  setHtml(
    el,
    html`<h3>${ico(locked ? "lock" : "unlock")}Daily sales control</h3><div><strong class="num">${number(dsrDay.totals.netSales)} L</strong><strong class="day-money num">${naira(dsrDay.totals.salesValue)}</strong></div><small>RTT of ${number(dsrDay.totals.rtt)} L excluded</small><button type="button" class="btn" data-action="open-dsr">${locked ? "View locked day" : "Review & close day"} ${ico("arrow")}</button>`,
  );
}

async function loadTwin() {
  const stations = state.lookups?.stations ?? [];
  const station = stations.find((s) => s.id === stationId);
  if (!station) return;

  $("#twinStationName").textContent = station.name;
  $("#twinStationSub").textContent = `Station overview · ${station.code}`;
  renderSwitcher();

  const { shownPumps, overflowPumps, shownTanks, overflowTanks } = splitStationForIllustration(stationId);
  const allTanks = [...shownTanks, ...overflowTanks];
  const date = today();

  const [dsrDay, receiptRows, { byTankId: movementsByTankId, byProduct: movementsByProduct }, gitRows] = await Promise.all([
    api
      .get("/dsr/day", { stationId, date })
      .then((r) => r.data)
      .catch(() => null),
    api
      .get("/receipts", { stationId, status: "verified", sortOrder: "desc", limit: 1 })
      .then((r) => r.data)
      .catch(() => []),
    loadTankMovements(stationId, allTanks, date),
    api
      .get("/git-orders", { stationId, status: "open", limit: 5 })
      .then((r) => r.data)
      .catch(() => []),
  ]);

  await renderTwin(shownPumps, movementsByProduct, dsrDay, receiptRows[0] ?? null);
  renderOverflow(overflowPumps, overflowTanks, movementsByTankId, dsrDay);

  currentDsrDay = dsrDay;
  currentReceipt = receiptRows[0] ?? null;
  currentMovementsByProduct = movementsByProduct;

  const equationTank = shownTanks[0] ?? overflowTanks[0] ?? null;
  renderEquation(equationTank ? movementsByTankId.get(equationTank.id) : null);

  const orders = gitRows ?? [];
  const featured = orders.find((o) => o.delayed) ?? orders.find((o) => o.status === "in_transit") ?? orders[0] ?? null;
  renderJourney(featured);

  renderDayControl(dsrDay);
}

function selectStation(id) {
  if (id === stationId) return;
  stationId = id;
  renderSwitcher();
  loadTwin();
}

function compareRow(r) {
  return html`<tr${r.total ? raw(' style="font-weight:700"') : ""}><td class="strong">${r.stationName}</td><td class="num">${number(r.soldLitres)}</td><td class="num">${naira(r.salesValue)}</td><td class="num">${naira(r.costOfSales)}</td><td class="num">${naira(r.grossProfit)}</td><td class="num">${naira(r.expenses)}</td><td class="num ${r.netProfit < 0 ? "num-neg" : ""}">${naira(r.netProfit)}</td><td class="num">${number(r.closingStockLitres)} L</td><td class="num">${naira(r.debt)}</td><td class="num">${number(r.gitLitres)}</td></tr>`;
}

function openComparison() {
  const months = recentMonths(currentMonth(), 12);
  infoModal({
    title: "Station comparison",
    content: html`<div style="margin-bottom:12px"><select class="select" data-compare-month>${months.map((m) => html`<option value="${m.value}">${m.label}</option>`)}</select></div>
      <div class="table-wrap"><table><thead><tr><th class="strong">Station</th><th class="num">Sold (L)</th><th class="num">Sales value</th><th class="num">Cost of sales</th><th class="num">Gross profit</th><th class="num">Expenses</th><th class="num">Net profit</th><th class="num">Closing stock</th><th class="num">Debt</th><th class="num">GIT (L)</th></tr></thead><tbody data-compare-body></tbody></table></div>`,
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
    stationId = defaultStationId();

    $("#stationSwitcher").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-station]");
      if (btn) selectStation(Number(btn.dataset.station));
    });

    $("#dashExceptions").addEventListener("click", (e) => {
      const row = e.target.closest("[data-exception-index]");
      if (row) {
        openException(exceptionItems[Number(row.dataset.exceptionIndex)], () => {
          loadNetwork();
          refreshBadges();
        });
      }
    });

    $("#twinLedgerLink").addEventListener("click", () => navigate("stock", { stationId }));

    const hotspotHandlers = {
      onTankClick: (code) => tankDetailModal(code, currentMovementsByProduct.get(code), { onOpenLedger: () => navigate("stock", { stationId }) }),
      onPumpClick: (id) => {
        const pump = pumpsFor(stationId).find((p) => p.id === id);
        if (!pump) return;
        const reading = (currentDsrDay?.readings ?? []).find((r) => r.pumpName === pump.name);
        pumpDetailModal(pump, reading, { onOpenDay: () => navigate("dsr", { stationId, date: today() }) });
      },
      onReceiptClick: () => receiptDetailModal(currentReceipt, { onOpenRecord: () => navigate("truck") }),
    };
    // Bound on both: the canvas hotspots (desktop) and the mobile-assets list
    // (narrow screens) render the same real data with the same data-* hooks.
    bindHotspotClicks($("#twinCanvas"), hotspotHandlers);
    bindHotspotClicks($("#twinMobileAssets"), hotspotHandlers);
  },

  async load() {
    renderSwitcher();
    renderNetworkMap();
    await Promise.all([loadNetwork(), loadTwin()]);
  },

  actions: {
    "dash-export": async (btn) => {
      btn.disabled = true;
      try {
        await api.download("/reports/monthly-management", { month: summaryMonth ?? currentMonth(), format: "csv" }, `station-summary-${summaryMonth ?? currentMonth()}.csv`);
        toast("Export downloaded.", "success");
      } catch (err) {
        toastError(err);
      } finally {
        btn.disabled = false;
      }
    },
    "dash-compare": openComparison,
    "twin-receipt": () => navigate("truck"),
    "journey-open": () => navigate("git", { search: "" }),
    "open-dsr": () => navigate("dsr", { stationId, date: today() }),
  },
};
