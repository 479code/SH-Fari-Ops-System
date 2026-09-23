/** RTT — log and cancel return-to-tank entries (never counted as sales). */
import { api } from "../api/client.js";
import { $, html, setOptions } from "../core/dom.js";
import { dateInput, monthOptions, productOptions, pumpsFor, stationOptions } from "../core/filters.js";
import { date, litres, statusPill } from "../core/format.js";
import { can, today } from "../core/state.js";
import { bindForm, closeModal, loadTable, reasonModal, renderPager, toast } from "../core/ui.js";

const COLS = 9;
let page = 1;
let rows = [];

function renderRow(r) {
  const action =
    r.status === "cancelled"
      ? statusPill("cancelled")
      : can("rtt.cancel")
        ? html`<button class="btn btn-xs" data-cancel-rtt="${r.id}">Cancel</button>`
        : "";
  return html`<tr title="${r.cancelReason ?? ""}">
    <td class="strong">${date(r.businessDate)}</td><td>${r.stationName}</td><td>${r.pumpName}</td><td>${r.productCode}</td>
    <td class="num">${litres(r.quantity)}</td><td>${r.reason}</td><td>${r.operatorName}</td><td class="mono-tag">${r.ref}</td>
    <td class="actions-cell">${action}</td></tr>`;
}

async function load() {
  const res = await loadTable(
    $("#rttBody"),
    COLS,
    () => api.get("/rtt", { month: $("#rttMonth").value, stationId: $("#rttStation").value, page, limit: 20 }),
    renderRow,
    { empty: "No RTT entries for these filters." },
  );
  if (!res) return;
  rows = res.data;
  renderPager($("#rttPager"), res.pagination, (p) => {
    page = p;
    load();
  });
  $("#rttSummary").textContent = `Total RTT (active): ${litres(res.summary.totalLitres)} L`;
}

const reload = () => {
  page = 1;
  load();
};

function refreshPumps() {
  const pumps = pumpsFor($("#rtStation").value);
  setOptions($("#rtPump"), pumps, { label: (p) => `${p.name} — ${p.productCode}`, placeholder: pumps.length ? undefined : "No active pumps" });
  refreshProduct();
}

function refreshProduct() {
  const pump = pumpsFor($("#rtStation").value).find((p) => String(p.id) === $("#rtPump").value);
  productOptions($("#rtProduct"));
  if (pump) $("#rtProduct").value = String(pump.productId);
}

export default {
  id: "rtt",
  permission: "rtt.view",

  init() {
    monthOptions($("#rttMonth"));
    stationOptions($("#rttStation"), { all: true });
    $("#rttMonth").addEventListener("change", reload);
    $("#rttStation").addEventListener("change", reload);

    $("#rttBody").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-cancel-rtt]");
      if (!btn) return;
      const r = rows.find((x) => x.id === Number(btn.dataset.cancelRtt));
      reasonModal({
        title: `Cancel ${r.ref}`,
        intro: `${litres(r.quantity)} L on ${r.pumpName}, ${date(r.businessDate)}. Only possible while the day is open.`,
        submitLabel: "Cancel RTT",
        onSubmit: async (values, { close }) => {
          const res = await api.post(`/rtt/${r.id}/cancel`, { reason: values.reason ?? "" });
          close();
          toast(res.message, "success");
          load();
        },
      });
    });

    $("#rtStation").addEventListener("change", refreshPumps);
    $("#rtPump").addEventListener("change", refreshProduct);
    bindForm($("#formRtt"), async (values) => {
      const res = await api.post("/rtt", values);
      closeModal("modalRtt");
      toast(res.message, "success");
      reload();
    });
  },

  async load(params = {}) {
    if (params.focus?.date) $("#rttMonth").value = params.focus.date.slice(0, 7);
    await load();
  },

  modals: {
    modalRtt() {
      $("#formRtt").reset();
      stationOptions($("#rtStation"), { selected: $("#rttStation").value || undefined });
      dateInput($("#rtDate"), today());
      refreshPumps();
    },
  },
};
