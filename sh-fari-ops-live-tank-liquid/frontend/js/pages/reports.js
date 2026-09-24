/** Reports — catalogue by category, filter dialog, on-screen table, CSV export and print-to-PDF. */
import { api } from "../api/client.js";
import { $, $$, html, setHtml } from "../core/dom.js";
import { monthStart } from "../core/filters.js";
import { date, dateTime, litres, naira, number, price, recentMonths, statusPill } from "../core/format.js";
import { boundStation, currentMonth, state, today } from "../core/state.js";
import { fillTable, formModal, infoModal, loadTable, toast, toastError } from "../core/ui.js";

const DISPLAY_LIMIT = 500;
let catalogue = [];
let category = "daily";

function formatCell(value, type) {
  if (value === null || value === undefined || value === "") return "—";
  switch (type) {
    case "money":
      return naira(value, { dp: Number.isInteger(Number(value)) ? 0 : 2 });
    case "litres":
      return litres(value);
    case "price":
      return price(value);
    case "number":
      return number(value);
    case "date":
      return date(value);
    case "datetime":
      return dateTime(value);
    case "status":
      return statusPill(String(value));
    default:
      return String(value);
  }
}

const numeric = (type) => ["money", "litres", "price", "number"].includes(type);

function tableMarkup(report, limit) {
  const shown = limit ? report.rows.slice(0, limit) : report.rows;
  const totals = report.totals
    ? html`<tr style="font-weight:700">${report.columns.map((c, i) => html`<td class="${numeric(c.type) ? "num" : ""}">${report.totals[c.key] !== undefined ? (typeof report.totals[c.key] === "string" ? report.totals[c.key] : formatCell(report.totals[c.key], c.type)) : i === 0 ? "Total" : ""}</td>`)}</tr>`
    : "";
  return html`<table><thead><tr>${report.columns.map((c) => html`<th class="${numeric(c.type) ? "num" : ""}">${c.label}</th>`)}</tr></thead>
    <tbody>${shown.length ? shown.map((r) => html`<tr>${report.columns.map((c) => html`<td class="${numeric(c.type) ? "num" : ""}">${formatCell(r[c.key], c.type)}</td>`)}</tr>`) : html`<tr class="state-row"><td colspan="${report.columns.length}">No data for these filters.</td></tr>`}${totals}</tbody></table>`;
}

function describeFilters(report) {
  const f = report.filters ?? {};
  const parts = [];
  if (f.from || f.to) parts.push(`${date(f.from ?? report.meta?.from)} – ${date(f.to ?? report.meta?.to)}`);
  else if (report.meta?.from) parts.push(`${date(report.meta.from)} – ${date(report.meta.to)}`);
  if (f.month) parts.push(f.month);
  if (f.stationId) parts.push(state.lookups?.stations.find((s) => s.id === Number(f.stationId))?.name ?? "");
  if (f.status) parts.push(`status: ${f.status}`);
  if (f.search) parts.push(`“${f.search}”`);
  return parts.filter(Boolean).join(" · ") || "All records";
}

function printReport(report) {
  setHtml(
    $("#printArea"),
    html`<h2>${report.title}</h2><div class="meta">SH Fari Ops · ${describeFilters(report)} · generated ${dateTime(report.generatedAt)}${report.meta?.note ? ` · ${report.meta.note}` : ""}</div>${tableMarkup(report)}`,
  );
  document.body.classList.add("printing-report");
  const cleanup = () => document.body.classList.remove("printing-report");
  window.addEventListener("afterprint", cleanup, { once: true });
  window.print();
  setTimeout(cleanup, 1000);
}

function filterFields(def, previous) {
  const stations = state.lookups?.stations ?? [];
  const bound = boundStation();
  const fields = [];
  for (const f of def.filters) {
    switch (f) {
      case "range":
        fields.push({ name: "from", label: "From", type: "date", value: previous.from ?? monthStart(today()) }, { name: "to", label: "To", type: "date", value: previous.to ?? today() });
        break;
      case "month":
        fields.push({ name: "month", label: "Month", type: "select", value: previous.month ?? currentMonth(), options: recentMonths(currentMonth(), 18).map((m) => ({ value: m.value, label: m.label })) });
        break;
      case "station":
        fields.push({
          name: "stationId",
          label: "Station",
          type: "select",
          value: previous.stationId ?? bound ?? "",
          placeholder: bound === null ? "All stations" : undefined,
          options: stations.filter((s) => bound === null || s.id === bound).map((s) => ({ value: s.id, label: s.name })),
        });
        break;
      case "product":
        fields.push({ name: "productId", label: "Product", type: "select", value: previous.productId ?? "", placeholder: "All products", options: (state.lookups?.products ?? []).map((p) => ({ value: p.id, label: p.code })) });
        break;
      case "pump":
        fields.push({
          name: "pumpId",
          label: "Pump",
          type: "select",
          value: previous.pumpId ?? "",
          placeholder: "All pumps",
          options: (state.lookups?.pumps ?? []).map((p) => ({ value: p.id, label: `${stations.find((s) => s.id === p.stationId)?.code ?? ""} ${p.name} (${p.productCode})` })),
        });
        break;
      case "bank":
        fields.push({ name: "bankId", label: "Bank", type: "select", value: previous.bankId ?? "", placeholder: "All banks", options: (state.lookups?.banks ?? []).map((b) => ({ value: b.id, label: b.name })) });
        break;
      case "narration":
        fields.push({ name: "narrationId", label: "Narration", type: "select", value: previous.narrationId ?? "", placeholder: "All narrations", options: (state.lookups?.narrations ?? []).map((n) => ({ value: n.id, label: n.name })) });
        break;
      case "status":
        fields.push({ name: "status", label: "Status", type: "select", value: previous.status ?? "", placeholder: "All statuses", options: def.statuses.map((s) => ({ value: s, label: s.replaceAll("_", " ") })) });
        break;
      case "user":
        fields.push({ name: "userId", label: "User", type: "select", value: previous.userId ?? "", placeholder: "All users", options: (state.lookups?.users ?? []).map((u) => ({ value: u.id, label: u.fullName })) });
        break;
      case "action":
        fields.push({ name: "action", label: "Action", value: previous.action ?? "", placeholder: "e.g. reopened" });
        break;
      case "search":
        fields.push({ name: "search", label: "Search", value: previous.search ?? "", placeholder: "Reference, truck or name" });
        break;
      default:
        break;
    }
  }
  return fields;
}

function openReport(def, previous = {}) {
  formModal({
    title: def.title,
    intro: def.description,
    fields: filterFields(def, previous),
    submitLabel: "Generate",
    onSubmit: async (values, { close }) => {
      const res = await api.get(`/reports/${def.key}`, values);
      close();
      showResult(def, values, res.data);
    },
  });
}

function showResult(def, filters, report) {
  const note = [
    `${report.rows.length.toLocaleString()} row(s)`,
    report.rows.length > DISPLAY_LIMIT ? `showing the first ${DISPLAY_LIMIT} — export CSV for all` : "",
    report.truncated ? "result capped at 5,000 rows — narrow the filters" : "",
    report.meta?.note ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
  infoModal({
    title: report.title,
    content: html`<div class="modal-intro">${describeFilters(report)} · generated ${dateTime(report.generatedAt)}<br>${note}</div>
      <div class="feature-actions" style="padding:0 0 12px">
        <button class="btn btn-xs" type="button" data-report-filters>Change filters</button>
        ${def.canExport ? html`<button class="btn btn-xs" type="button" data-report-csv>Export Excel (CSV)</button>` : ""}
        <button class="btn btn-xs btn-primary" type="button" data-report-print>Print / Save PDF</button>
      </div>
      <div class="table-wrap">${tableMarkup(report, DISPLAY_LIMIT)}</div>`,
    onRender: (form, close) => {
      form.querySelector("[data-report-filters]").addEventListener("click", () => {
        close();
        openReport(def, filters);
      });
      form.querySelector("[data-report-csv]")?.addEventListener("click", async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api.download(`/reports/${def.key}`, { ...filters, format: "csv" }, `${def.key}.csv`);
          toast("Export downloaded.", "success");
        } catch (err) {
          toastError(err);
        } finally {
          e.currentTarget.disabled = false;
        }
      });
      form.querySelector("[data-report-print]").addEventListener("click", () => printReport(report));
    },
  });
}

function renderCatalogue() {
  const rows = catalogue.filter((r) => r.category === category);
  fillTable(
    $("#reportsBody"),
    3,
    rows,
    (r) => html`<tr><td class="strong">${r.title}</td><td>${r.description}</td><td class="actions-cell"><button class="btn ${r.category === "management" ? "btn-primary" : ""}" data-report="${r.key}">Generate</button></td></tr>`,
    "No reports in this category for your role.",
  );
}

export default {
  id: "reports",
  permission: "reports.view",

  init() {
    $("#reportTabs").addEventListener("click", (e) => {
      const tab = e.target.closest(".pill-tab");
      if (!tab) return;
      category = tab.dataset.category;
      $$("#reportTabs .pill-tab").forEach((t) => t.classList.toggle("active", t === tab));
      renderCatalogue();
    });
    $("#reportsBody").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-report]");
      const def = btn && catalogue.find((r) => r.key === btn.dataset.report);
      if (def) openReport(def);
    });
  },

  async load() {
    const res = await loadTable($("#reportsBody"), 3, () => api.get("/reports"), () => "", {});
    if (!res) return;
    catalogue = res.data;
    renderCatalogue();
  },
};
