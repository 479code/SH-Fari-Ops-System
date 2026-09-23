/** DSR — open a business day, capture closing readings, close & lock, reopen with a reason. */
import { api } from "../api/client.js";
import { $, html, setHtml } from "../core/dom.js";
import { dateInput, stationOptions } from "../core/filters.js";
import { dateTime, litres, naira, price } from "../core/format.js";
import { refreshBadges } from "../core/shell.js";
import { can, defaultStationId, today } from "../core/state.js";
import { fillTable, formModal, reasonModal, showFieldErrors, tableError, tableLoading, toast, toastError, withBusy } from "../core/ui.js";

const STATUS = {
  not_opened: ["gray", "Day not opened"],
  open: ["amber", "Day open — not yet locked"],
  closed: ["green", "Day closed & locked"],
};

let day = null;
let dirty = false;

const editable = () => day?.status === "open" && can("dsr.record");

function show(el, condition) {
  el.hidden = !condition || Boolean(el.dataset.permission && !can(el.dataset.permission));
}

function card(r, i) {
  const opening =
    r.openingEditable && editable()
      ? html`<input class="input" name="readings.${i}.openingReading" data-type="number" inputmode="decimal" value="${r.openingReading}" aria-label="${r.pumpName} opening reading">`
      : html`${litres(r.openingReading)}`;
  const closing = editable()
    ? html`<input class="input" name="readings.${i}.closingReading" data-type="number" inputmode="decimal" value="${r.closingReading ?? ""}" placeholder="Enter reading" aria-label="${r.pumpName} closing reading">`
    : html`${r.closingReading === null ? "—" : litres(r.closingReading)}`;
  return html`<div class="pump-card" data-index="${i}">
    <div class="pump-card-head"><span class="pump-name">${r.pumpName} — ${r.productCode}</span><span class="pill gray">${r.meterLabel ?? r.tankName}</span></div>
    <div class="pump-row"><span>Opening reading</span><span>${opening}</span></div>
    <div class="pump-row"><span>Closing reading</span><span>${closing}</span></div>
    <div class="pump-row"><span>RTT (excluded)</span><span>${litres(r.rtt)}</span></div>
    <div class="pump-row sales"><span>Net sales (L)</span><span data-net>${r.netSales === null ? "—" : litres(r.netSales)}</span></div>
  </div>`;
}

function productRow(p) {
  return html`<tr${p.total ? html` style="font-weight:700"` : ""}><td class="strong">${p.productCode}</td><td class="num">${litres(p.netSales)}</td><td class="num">${litres(p.rtt)}</td><td class="num">${p.avgPrice === null || p.avgPrice === undefined ? "—" : price(p.avgPrice)}</td><td class="num">${naira(p.salesValue)}</td></tr>`;
}

function assetLabel(cls, name, value, extra = "") {
  return html`<div class="asset-label ${cls}"><span class="label-name">${name}</span><span class="label-value">${value}</span>${extra}</div>`;
}

function renderPumpIllustration() {
  const shown = day.readings.slice(0, 3);
  const overflow = day.readings.slice(3);

  const pumpBlocks = shown.map((r, i) => {
    const value = r.netSales === null ? "—" : `${litres(r.netSales)} L`;
    return assetLabel(`pump-label p${i + 1}`, `${r.pumpName} · ${r.productCode}`, value, r.closingReading === null ? html`<small>No closing reading yet</small>` : "");
  });
  setHtml(
    $("#dsrCanvas"),
    day.readings.length
      ? html`<img class="station-scene" src="/assets/station-scene.jpg" alt="Illustrative pump layout for this station">${pumpBlocks}`
      : html`<div class="chart-empty">No active pumps at this station — register pumps in Setup.</div>`,
  );

  const overflowEl = $("#dsrOverflow");
  if (!overflow.length) {
    overflowEl.hidden = true;
  } else {
    overflowEl.hidden = false;
    setHtml(
      overflowEl,
      html`<div class="plain-note">Beyond the illustration's 3 fixed pump slots:</div><div class="plain-grid">${overflow.map(
        (r) => html`<div class="plain-card"><label>${r.pumpName} · ${r.productCode}</label><strong>${r.netSales === null ? "—" : `${litres(r.netSales)} L`}</strong><div class="hint">Net sales today</div></div>`,
      )}</div>`,
    );
  }
}

function render() {
  const [color, label] = STATUS[day.status];
  const pill = $("#dsrStatus");
  pill.className = `pill ${color}`;
  pill.textContent = label;

  show($("#dsrOpen"), day.status === "not_opened");
  $("#dsrOpen").disabled = Boolean(day.openBlocker);
  $("#dsrOpen").title = day.openBlocker ?? "";
  show($("#dsrSave"), day.status === "open");
  show($("#dsrClose"), day.status === "open");
  show($("#dsrReopen"), day.status === "closed");
  show($("#dsrDiscard"), day.status === "open" && day.day?.reopenCount === 0);

  const d = day.day;
  let meta;
  if (!d) {
    meta = day.openBlocker ?? "This business day has not been opened. Opening readings carry forward from the previous closed day.";
  } else {
    meta = `${d.ref} · opened by ${d.openedByName ?? "—"} ${dateTime(d.openedAt)}`;
    if (d.closedAt) meta += ` · locked by ${d.closedByName ?? "—"} ${dateTime(d.closedAt)}`;
    if (d.reopenCount > 0) meta += ` · reopened ${d.reopenCount}× (last by ${d.lastReopenedByName ?? "—"}: “${d.lastReopenReason ?? ""}”)`;
    if (day.status === "open" && day.totals.readingsMissing > 0) meta += ` · ${day.totals.readingsMissing} closing reading(s) outstanding`;
  }
  $("#dsrMeta").textContent = meta;

  renderPumpIllustration();

  setHtml(
    $("#dsrPumps"),
    day.readings.length
      ? html`${day.readings.map(card)}`
      : html`<div class="chart-empty" style="grid-column:1/-1">No active pumps at this station — register pumps in Setup.</div>`,
  );
  const rows = [...day.products];
  if (rows.length > 1) rows.push({ productCode: "Total", netSales: day.totals.netSales, rtt: day.totals.rtt, avgPrice: null, salesValue: day.totals.salesValue, total: true });
  fillTable($("#dsrProducts"), 5, rows, productRow, "No sales for this day yet.");
  dirty = false;
}

async function load() {
  tableLoading($("#dsrProducts"), 5);
  try {
    const res = await api.get("/dsr/day", { stationId: $("#dsrStation").value, date: $("#dsrDate").value });
    day = res.data;
    render();
  } catch (err) {
    day = null;
    setHtml($("#dsrPumps"), html``);
    setHtml($("#dsrCanvas"), html``);
    $("#dsrOverflow").hidden = true;
    tableError($("#dsrProducts"), 5, err, load);
  }
}

function collectReadings() {
  const form = $("#dsrPumps");
  return day.readings.map((r, i) => {
    const entry = { pumpId: r.pumpId };
    const closing = form.querySelector(`[name="readings.${i}.closingReading"]`);
    const opening = form.querySelector(`[name="readings.${i}.openingReading"]`);
    if (closing) entry.closingReading = closing.value.trim() === "" ? null : Number(closing.value.replace(/,/g, ""));
    if (opening && opening.value.trim() !== "") entry.openingReading = Number(opening.value.replace(/,/g, ""));
    return entry;
  });
}

async function saveReadings() {
  try {
    const res = await api.put(`/dsr/${day.day.id}/readings`, { readings: collectReadings() });
    day = res.data;
    render();
    return true;
  } catch (err) {
    showFieldErrors($("#dsrPumps"), err);
    toastError(err);
    return false;
  }
}

function onReadingInput(e) {
  const cardEl = e.target.closest(".pump-card");
  if (!cardEl || !day) return;
  dirty = true;
  const r = day.readings[Number(cardEl.dataset.index)];
  const opening = Number(cardEl.querySelector('[name$="openingReading"]')?.value.replace(/,/g, "") ?? r.openingReading);
  const closingRaw = cardEl.querySelector('[name$="closingReading"]')?.value.replace(/,/g, "").trim();
  const net = closingRaw === "" || closingRaw === undefined ? null : Number(closingRaw) - opening - r.rtt;
  cardEl.querySelector("[data-net]").textContent = net === null || Number.isNaN(net) ? "—" : litres(net);
}

export default {
  id: "dsr",
  permission: "dsr.view",

  init() {
    stationOptions($("#dsrStation"));
    dateInput($("#dsrDate"), today());
    $("#dsrStation").addEventListener("change", load);
    $("#dsrDate").addEventListener("change", load);
    $("#dsrPumps").addEventListener("input", onReadingInput);
    $("#dsrPumps").addEventListener("submit", (e) => {
      e.preventDefault();
      $("#dsrSave").click();
    });

    $("#dsrOpen").addEventListener("click", (e) =>
      withBusy(e.currentTarget, async () => {
        try {
          const res = await api.post("/dsr/open", { stationId: Number($("#dsrStation").value), businessDate: $("#dsrDate").value });
          day = res.data;
          render();
          toast(res.message, "success");
          refreshBadges();
        } catch (err) {
          toastError(err);
        }
      }),
    );

    $("#dsrSave").addEventListener("click", (e) =>
      withBusy(e.currentTarget, async () => {
        if (await saveReadings()) toast("Readings saved.", "success");
      }),
    );

    $("#dsrClose").addEventListener("click", async (e) => {
      if (dirty) {
        const saved = await withBusy(e.currentTarget, saveReadings);
        if (!saved) return;
      }
      formModal({
        title: `Close & lock ${day.day.ref}`,
        intro: `Net sales of ${litres(day.totals.netSales)} L worth ${naira(day.totals.salesValue)} will be posted to the stock ledger (RTT of ${litres(day.totals.rtt)} L is added back to the tanks) and the day will be locked. Changes afterwards require an authorised reopening.`,
        submitLabel: "Close & lock day",
        onSubmit: async (_v, { close }) => {
          const res = await api.post(`/dsr/${day.day.id}/close`);
          close();
          day = res.data;
          render();
          toast(res.message, "success");
          refreshBadges();
        },
      });
    });

    $("#dsrReopen").addEventListener("click", () =>
      reasonModal({
        title: `Reopen ${day.day.ref}`,
        intro: "Reopening voids this day's stock postings until it is closed again. The reason is recorded in the audit trail.",
        submitLabel: "Reopen day",
        onSubmit: async (values, { close }) => {
          const res = await api.post(`/dsr/${day.day.id}/reopen`, { reason: values.reason ?? "" });
          close();
          day = res.data;
          render();
          toast(res.message, "success");
          refreshBadges();
        },
      }),
    );

    $("#dsrDiscard").addEventListener("click", () =>
      reasonModal({
        title: `Discard ${day.day.ref}`,
        intro:
          "Use this only for a day opened by mistake. Its readings were never posted, so the day is removed; the reason and the readings are kept in the audit trail. RTT entries for the date are kept.",
        submitLabel: "Discard day",
        onSubmit: async (values, { close }) => {
          const res = await api.post(`/dsr/${day.day.id}/discard`, { reason: values.reason ?? "" });
          close();
          day = res.data;
          render();
          toast(res.message, "success");
          refreshBadges();
        },
      }),
    );
  },

  async load(params = {}) {
    const stationId = params.stationId ?? params.focus?.stationId;
    const date = params.date ?? params.focus?.date;
    if (stationId) $("#dsrStation").value = String(stationId);
    if (date) $("#dsrDate").value = date;
    if (!$("#dsrStation").value && defaultStationId()) $("#dsrStation").value = String(defaultStationId());
    await load();
  },
};
