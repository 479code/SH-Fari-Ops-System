/** Stock & dip — movement summary, tank variance status, ledger drill-down, dips and adjustments. */
import { api } from "../api/client.js";
import { $, html, setHtml, setOptions } from "../core/dom.js";
import { dateInput, monthStart, productOptions, stationOptions, tanksFor } from "../core/filters.js";
import { date, litres, number, shortDate, statusPill } from "../core/format.js";
import { refreshBadges } from "../core/shell.js";
import { defaultStationId, today } from "../core/state.js";
import { bindForm, closeModal, fillTable, renderPager, tableError, tableLoading, toast } from "../core/ui.js";

let page = 1;

const MOVEMENT_LABEL = {
  opening_balance: "Opening stock",
  receipt: "Truck receipt",
  dispensed: "Pump dispensing",
  rtt: "RTT",
  adjustment: "Adjustment",
};

const filters = () => ({ stationId: $("#stStation").value, productId: $("#stProduct").value, date: $("#stDate").value });

async function loadMovement() {
  const body = $("#stMovementBody");
  tableLoading(body, 2);
  try {
    const { data: m } = await api.get("/stock/movement", filters());
    $("#stMovementTitle").textContent = `Stock movement — ${m.productCode}, ${m.stationName}, ${date(m.date)}`;
    const exceeded = m.variance !== null && Math.abs(m.variance) > m.tolerance;
    setHtml(
      body,
      html`<tr><td>Opening stock</td><td class="num">${litres(m.opening)}</td></tr>
        <tr><td>+ Truck receipts</td><td class="num">${litres(m.receipts)}</td></tr>
        <tr><td>− Pump dispensing (metered)</td><td class="num">${litres(-m.dispensed)}</td></tr>
        <tr><td>+ RTT</td><td class="num">${litres(m.rtt)}</td></tr>
        <tr><td>± Adjustments</td><td class="num">${litres(m.adjustments, 1, { signed: true })}</td></tr>
        <tr><td class="strong">System closing stock</td><td class="num strong">${litres(m.closing)}</td></tr>
        <tr><td>Physical dip</td><td class="num">${m.physicalDip === null ? html`<span class="muted">${m.tanksTotal ? `${m.tanksDipped} of ${m.tanksTotal} tank(s) dipped` : "No tank"}</span>` : litres(m.physicalDip)}</td></tr>
        <tr><td class="strong">Variance</td><td class="num ${m.variance === null ? "" : exceeded ? "num-neg" : "num-pos"}">${m.variance === null ? "—" : litres(m.variance, 1, { signed: true })}</td></tr>
        <tr><td class="muted">Net sales (dispensing − RTT)</td><td class="num muted">${litres(m.netSales)}</td></tr>`,
    );
  } catch (err) {
    tableError(body, 2, err, loadMovement);
  }
}

async function loadTanks() {
  const list = $("#stTankList");
  setHtml(list, html`<div class="chart-empty"><span class="spinner dark"></span>Loading…</div>`);
  try {
    const { data } = await api.get("/stock/tanks", { stationId: $("#stStation").value });
    setHtml(
      list,
      data.length
        ? html`${data.map((t) => {
            const d = t.latestDip;
            return html`<div class="exception-row"><div class="exc-body"><div class="exc-title">${t.name} — ${t.stationName}</div>
              <div class="exc-meta">Balance ${litres(t.balance)} L ${t.productCode} · ${d ? `Variance ${litres(d.variance, 1, { signed: true })}L on ${shortDate(d.businessDate)} · tolerance ±${number(d.tolerance)}L` : "No dip recorded yet"}</div></div>
              ${d ? statusPill(d.toleranceStatus) : html`<span class="pill gray">Not dipped</span>`}</div>`;
          })}`
        : html`<div class="chart-empty">No active tanks at this station.</div>`,
    );
  } catch (err) {
    setHtml(list, html`<div class="chart-empty">${err.message}</div>`);
  }
}

function movementRow(r) {
  return html`<tr><td class="strong">${shortDate(r.businessDate)}</td><td>${r.productCode}</td><td>${r.tankName}</td><td>${MOVEMENT_LABEL[r.movementType] ?? r.movementType}</td>
    <td class="num">${litres(r.quantity, 1, { signed: true })}</td><td class="num">${litres(r.runningBalance)}</td><td class="mono-tag">${r.sourceRef}</td></tr>`;
}

function dipRow(d) {
  const cls = d.toleranceStatus === "exceeded" ? "num-neg" : "";
  return html`<tr><td class="strong">${shortDate(d.businessDate)}</td><td>${d.productCode}</td><td>${d.tankName}</td><td>Physical dip</td>
    <td class="num">${litres(d.dipLitres)}</td><td class="num ${cls}">${litres(d.variance, 1, { signed: true })} var.</td><td class="mono-tag">${d.ref}</td></tr>`;
}

async function loadLedger() {
  const body = $("#stLedgerBody");
  tableLoading(body, 7);
  try {
    const f = filters();
    const res = await api.get("/stock/ledger", { stationId: f.stationId, productId: f.productId, from: monthStart(f.date), to: f.date, page, limit: 25 });
    // Dips are observations, shown at the top of their date's movements.
    const pendingDips = new Map();
    for (const d of res.dips) pendingDips.set(d.businessDate, [...(pendingDips.get(d.businessDate) ?? []), d]);
    const merged = [];
    for (const r of res.data) {
      if (pendingDips.has(r.businessDate)) {
        merged.push(...pendingDips.get(r.businessDate).map((d) => ({ ...d, isDip: true })));
        pendingDips.delete(r.businessDate);
      }
      merged.push(r);
    }
    fillTable(body, 7, merged, (r) => (r.isDip ? dipRow(r) : movementRow(r)), "No stock movements in this period.");
    $("#stLedgerSub").textContent = `Every entry traces to its source receipt, sale, RTT or adjustment · ${date(res.range.from)} – ${date(res.range.to)}`;
    renderPager($("#stLedgerPager"), res.pagination, (p) => {
      page = p;
      loadLedger();
    });
  } catch (err) {
    tableError(body, 7, err, loadLedger);
  }
}

function loadAll() {
  page = 1;
  return Promise.all([loadMovement(), loadTanks(), loadLedger()]);
}

/* Dip & adjustment modals ------------------------------------------------------------- */

function fillTankSelect(stationSelect, tankSelect) {
  setOptions(tankSelect, tanksFor(stationSelect.value), { label: (t) => `${t.name} (${t.productCode})` });
}

async function refreshSystemClosing() {
  const tankId = $("#dpTank").value;
  $("#dpSystem").value = "";
  $("#dpHint").textContent = "";
  if (!tankId || !$("#dpDate").value) return;
  try {
    const { data } = await api.get("/stock/system-closing", { tankId, date: $("#dpDate").value });
    $("#dpSystem").value = litres(data.systemStock);
    $("#dpHint").textContent =
      data.existingDip
        ? `A dip is already recorded for this tank and date (${data.existingDip.ref}).`
        : data.dsrStatus !== "closed"
          ? `The DSR for ${date(data.date)} is ${data.dsrStatus === "open" ? "still open" : "not opened"} — close it first so system stock includes the day's sales.`
          : `Variance = dip − system closing stock. Tolerance ±${number(data.tolerance)} L; beyond it the variance is flagged for review.`;
  } catch (err) {
    $("#dpHint").textContent = err.message;
  }
}

export default {
  id: "stock",
  permission: "stock.view",

  init() {
    stationOptions($("#stStation"));
    productOptions($("#stProduct"));
    dateInput($("#stDate"), today());
    for (const id of ["#stStation", "#stProduct", "#stDate"]) $(id).addEventListener("change", loadAll);

    $("#dpStation").addEventListener("change", () => {
      fillTankSelect($("#dpStation"), $("#dpTank"));
      refreshSystemClosing();
    });
    $("#dpTank").addEventListener("change", refreshSystemClosing);
    $("#dpDate").addEventListener("change", refreshSystemClosing);
    $("#adStation").addEventListener("change", () => fillTankSelect($("#adStation"), $("#adTank")));

    bindForm($("#formDip"), async (values) => {
      const res = await api.post("/stock/dips", values);
      closeModal("modalDip");
      const dip = res.data;
      toast(
        dip.toleranceStatus === "exceeded"
          ? `Dip recorded — variance ${litres(dip.variance, 1, { signed: true })} L exceeds tolerance and was flagged.`
          : `Dip recorded — variance ${litres(dip.variance, 1, { signed: true })} L is within tolerance.`,
        dip.toleranceStatus === "exceeded" ? "error" : "success",
      );
      loadAll();
      refreshBadges();
    });

    bindForm($("#formAdjust"), async (values) => {
      const res = await api.post("/stock/adjustments", values);
      closeModal("modalAdjust");
      toast(res.message, "success");
      loadAll();
    });
  },

  async load(params = {}) {
    const stationId = params.stationId ?? params.focus?.stationId;
    if (stationId) $("#stStation").value = String(stationId);
    if (params.focus?.date) $("#stDate").value = params.focus.date;
    if (!$("#stStation").value && defaultStationId()) $("#stStation").value = String(defaultStationId());
    await loadAll();
  },

  modals: {
    modalDip() {
      $("#formDip").reset();
      stationOptions($("#dpStation"), { selected: $("#stStation").value });
      fillTankSelect($("#dpStation"), $("#dpTank"));
      const match = tanksFor($("#dpStation").value, $("#stProduct").value)[0];
      if (match) $("#dpTank").value = String(match.id);
      dateInput($("#dpDate"), $("#stDate").value || today());
      refreshSystemClosing();
    },
    modalAdjust() {
      $("#formAdjust").reset();
      stationOptions($("#adStation"), { selected: $("#stStation").value });
      fillTankSelect($("#adStation"), $("#adTank"));
      dateInput($("#adDate"), $("#stDate").value || today());
    },
  },
};
