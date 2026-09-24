/** Truck receiving — record, verify, dispute and cancel receipts; link to GIT orders. */
import { api } from "../api/client.js";
import { $, debounce, html, setOptions } from "../core/dom.js";
import { dateInput, monthOptions, productOptions, stationOptions, tanksFor } from "../core/filters.js";
import { date, litres, monthLabel, naira, number, price, statusPill } from "../core/format.js";
import { refreshBadges } from "../core/shell.js";
import { can, state, today } from "../core/state.js";
import { bindForm, closeModal, formModal, loadTable, reasonModal, renderPager, toast } from "../core/ui.js";

const COLS = 10;
let page = 1;
let rows = [];

function rowActions(r) {
  const buttons = [];
  if ((r.status === "received" || r.status === "disputed") && can("receipts.verify")) {
    buttons.push(html`<button class="btn btn-xs" data-receipt-action="verify" data-id="${r.id}">Verify</button>`);
  }
  if (r.status === "received" && can("receipts.verify")) {
    buttons.push(html`<button class="btn btn-xs" data-receipt-action="dispute" data-id="${r.id}">Dispute</button>`);
  }
  if (r.status !== "cancelled" && can("receipts.cancel")) {
    buttons.push(html`<button class="btn btn-xs" data-receipt-action="cancel" data-id="${r.id}">Cancel</button>`);
  }
  return html`<div class="row-actions">${buttons}</div>`;
}

function renderRow(r) {
  const note = r.disputeReason ?? r.cancelReason ?? "";
  return html`<tr title="${note}">
    <td class="strong">${date(r.businessDate)}</td>
    <td class="mono-tag">${r.truckPlate}</td>
    <td>${r.productCode}</td>
    <td class="num">${number(r.quantity)}</td>
    <td class="num">${price(r.orderPrice)}</td>
    <td class="num">${price(r.landingPrice)}</td>
    <td class="mono-tag">${r.waybillRef}${r.gitOrderRef ? html` · ${r.gitOrderRef}` : ""}</td>
    <td>${r.stationName}</td>
    <td>${statusPill(r.status)}</td>
    <td class="actions-cell">${rowActions(r)}</td>
  </tr>`;
}

async function load() {
  const res = await loadTable(
    $("#truckBody"),
    COLS,
    () =>
      api.get("/receipts", {
        month: $("#truckMonth").value,
        stationId: $("#truckStation").value,
        productId: $("#truckProduct").value,
        status: $("#truckStatus").value,
        search: $("#truckSearch").value.trim(),
        page,
        limit: 20,
      }),
    renderRow,
    { empty: "No truck receipts for these filters." },
  );
  if (!res) return;
  rows = res.data;
  renderPager($("#truckPager"), res.pagination, (p) => {
    page = p;
    load();
  });
  const s = res.summary;
  $("#truckSummary").textContent = `${s.verifiedCount} verified · ${litres(s.verifiedQuantity, 0)} L · ${naira(s.verifiedValue, { compact: true })} landed.`;
  $("#truckStatVerified").textContent = s.verifiedCount;
  $("#truckStatVerifiedSub").textContent = `${litres(s.verifiedQuantity, 0)} L received`;
  $("#truckStatReceived").textContent = s.byStatus.received ?? 0;
  $("#truckStatDisputed").textContent = s.byStatus.disputed ?? 0;
  $("#truckStatPeriod").textContent = monthLabel($("#truckMonth").value);
  $("#truckStatPeriodSub").textContent = `${res.pagination.total} record${res.pagination.total === 1 ? "" : "s"}`;
}

function reload() {
  page = 1;
  load();
}

async function act(action, id) {
  const r = rows.find((x) => x.id === id);
  if (!r) return;
  if (action === "verify") {
    formModal({
      title: `Verify receipt ${r.waybillRef}`,
      intro: `This posts ${number(r.quantity)} L of ${r.productCode} into ${r.tankName} at ${r.stationName}${r.gitOrderRef ? ` and discharges ${r.gitOrderRef}` : ""}. Verification is audit logged.`,
      submitLabel: "Verify receipt",
      onSubmit: async (_v, { close }) => {
        const res = await api.post(`/receipts/${id}/verify`);
        close();
        toast(res.message, "success");
        load();
        refreshBadges();
      },
    });
  } else {
    reasonModal({
      title: action === "dispute" ? `Dispute receipt ${r.waybillRef}` : `Cancel receipt ${r.waybillRef}`,
      intro:
        action === "dispute"
          ? "A disputed receipt does not move stock until it is verified."
          : r.status === "verified"
            ? `The ${number(r.quantity)} L already posted to stock will be reversed.`
            : "The receipt will be kept for audit but no longer counted.",
      submitLabel: action === "dispute" ? "Mark disputed" : "Cancel receipt",
      onSubmit: async (values, { close }) => {
        const res = await api.post(`/receipts/${id}/${action}`, { reason: values.reason ?? "" });
        close();
        toast(res.message, "success");
        load();
        refreshBadges();
      },
    });
  }
}

/* Record receipt modal ------------------------------------------------------------- */

let openDeliveries = [];

function refreshTanks() {
  const tanks = tanksFor($("#rcStation").value, $("#rcProduct").value);
  setOptions($("#rcTank"), tanks, { placeholder: tanks.length === 1 ? undefined : tanks.length === 0 ? "No tank for this product" : "Select tank" });
}

async function refreshDeliveries() {
  const select = $("#rcGit");
  setOptions(select, [], { placeholder: "None" });
  if (!$("#rcStation").value || !$("#rcProduct").value || !(can("git.view") || can("receipts.create"))) return;
  try {
    const res = await api.get("/git-orders/open-deliveries", { stationId: $("#rcStation").value, productId: $("#rcProduct").value });
    openDeliveries = res.data;
    setOptions(select, openDeliveries, {
      value: "deliveryId",
      label: (d) => `${d.orderRef} · ${d.truckPlate ?? "no truck"} · ${number(d.plannedQuantity)} L`,
      placeholder: "None",
    });
  } catch {
    openDeliveries = [];
  }
}

async function prepareModal() {
  const form = $("#formTruck");
  form.reset();
  stationOptions($("#rcStation"));
  productOptions($("#rcProduct"));
  dateInput($("#rcDate"), today());
  refreshTanks();
  await refreshDeliveries();
}

export default {
  id: "truck",
  permission: "receipts.view",

  init() {
    monthOptions($("#truckMonth"));
    stationOptions($("#truckStation"), { all: true });
    productOptions($("#truckProduct"), { all: true });
    for (const id of ["#truckMonth", "#truckStation", "#truckProduct", "#truckStatus"]) $(id).addEventListener("change", reload);
    $("#truckSearch").addEventListener("input", debounce(reload, 350));

    $("#truckBody").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-receipt-action]");
      if (btn) act(btn.dataset.receiptAction, Number(btn.dataset.id));
    });

    $("#rcStation").addEventListener("change", () => {
      refreshTanks();
      refreshDeliveries();
    });
    $("#rcProduct").addEventListener("change", () => {
      refreshTanks();
      refreshDeliveries();
    });
    $("#rcGit").addEventListener("change", (e) => {
      const d = openDeliveries.find((x) => String(x.deliveryId) === e.target.value);
      if (!d) return;
      const form = $("#formTruck");
      if (d.truckPlate && !form.truckPlate.value) form.truckPlate.value = d.truckPlate;
      if (!form.orderPrice.value) form.orderPrice.value = d.orderPrice;
      if (!form.quantity.value) form.quantity.value = d.plannedQuantity;
    });

    bindForm($("#formTruck"), async (values) => {
      const res = await api.post("/receipts", values);
      closeModal("modalTruck");
      toast(res.message, "success");
      reload();
    });
  },

  async load(params = {}) {
    if (params.focus) {
      $("#truckSearch").value = params.focus.ref;
      if (params.focus.date) $("#truckMonth").value = params.focus.date.slice(0, 7);
      $("#truckStatus").value = "";
      page = 1;
    }
    await load();
  },

  modals: { modalTruck: prepareModal },
};
