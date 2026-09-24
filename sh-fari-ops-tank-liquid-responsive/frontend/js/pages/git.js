/** GIT — orders, stage tracking, trucks, multi-delivery, exceptions and history. */
import { api } from "../api/client.js";
import { $, $$, debounce, html, raw, setHtml } from "../core/dom.js";
import { dateInput, productOptions, stationOptions } from "../core/filters.js";
import { date, dateTime, number, price, statusPill } from "../core/format.js";
import { refreshBadges } from "../core/shell.js";
import { boundStation, can, state, today } from "../core/state.js";
import { bindForm, closeModal, fillTable, formModal, infoModal, loadTable, reasonModal, renderPager, toast, toastError } from "../core/ui.js";

const COLS = 7;
let page = 1;
let rows = [];
let selectedId = null;
let selected = null;

const TRANSITION_LABEL = {
  truck_assigned: "Assign truck",
  in_transit: "Mark in transit",
  arrived: "Mark arrived",
  discharging: "Start discharge",
  completed: "Complete order",
  cancelled: "Cancel order",
};

function pillFor(o) {
  if (o.delayed || (o.exceptionType === "delay" && o.status === "in_transit")) {
    return html`<span class="pill amber">Delayed — ${o.daysInTransit ?? "?"} days in transit</span>`;
  }
  if (o.exceptionType && o.status !== "cancelled") return html`<span class="pill red">Exception — ${o.exceptionNote ?? o.exceptionType}</span>`;
  return statusPill(o.status, o.statusLabel);
}

function renderRow(o) {
  return html`<tr class="clickable ${o.id === selectedId ? "selected" : ""}" data-order-id="${o.id}">
    <td class="strong mono-tag">${o.ref}</td><td class="mono-tag">${o.truckPlate ?? "—"}</td><td>${o.productCode}</td>
    <td class="num">${number(o.quantity)}</td><td class="num">${price(o.orderPrice)}</td><td>${o.destinations ?? "—"}</td><td>${pillFor(o)}</td></tr>`;
}

function stagesMarkup(stages) {
  return html`${stages.map((s, i) => {
    const cls = { done: "done", current: "current", cancelled: "cancelled" }[s.state] ?? "";
    const dot = s.state === "done" ? "✓" : s.state === "cancelled" ? "×" : i + 1;
    return html`<div class="stage ${cls}">${i < stages.length - 1 ? raw('<div class="stage-line"></div>') : ""}<div class="stage-dot">${dot}</div><div class="stage-label">${s.label}</div></div>`;
  })}`;
}

function renderFeature(o) {
  const open = o.status !== "completed" && o.status !== "cancelled";
  const destinations = o.deliveries.filter((d) => d.status !== "cancelled").map((d) => d.stationName).join(", ") || "—";
  const anyDischarged = o.deliveries.some((d) => d.status === "discharged");
  const actions = [];
  if (can("git.update") && open) {
    for (const t of o.allowedTransitions) {
      actions.push(html`<button class="btn btn-xs ${t === "cancelled" ? "" : "btn-primary"}" data-git-status="${t}">${TRANSITION_LABEL[t]}</button>`);
    }
    actions.push(html`<button class="btn btn-xs" data-git-edit>Edit truck / ETA</button>`);
    if (!anyDischarged) actions.push(html`<button class="btn btn-xs" data-git-deliveries>Deliveries</button>`);
  }
  if (can("git.update")) {
    actions.push(o.exceptionType ? html`<button class="btn btn-xs" data-git-resolve>Resolve exception</button>` : open ? html`<button class="btn btn-xs" data-git-flag>Flag exception</button>` : "");
  }
  actions.push(html`<button class="btn btn-xs" data-git-history>History</button>`);

  setHtml(
    $("#gitFeature"),
    html`<div class="panel-head bordered"><div><div class="panel-title">${o.ref} — ${o.productCode} ${number(o.quantity)}L${o.isMultiDelivery ? " · multi-delivery" : ""}</div>
      <div class="panel-sub">Truck ${o.truckPlate ?? "not assigned"} · destination ${destinations} · order price ${price(o.orderPrice)}/L · ordered ${date(o.orderDate)}${o.source ? ` · ${o.source}` : ""}${o.expectedArrivalDate ? ` · ETA ${date(o.expectedArrivalDate)}` : ""}</div></div>
      ${pillFor(o)}</div>
      <div class="stage-track">${stagesMarkup(o.stages)}</div>
      <div class="table-wrap"><table><thead><tr><th class="strong">Destination</th><th class="num">Planned (L)</th><th class="num">Discharged (L)</th><th>Status</th><th>Receipts</th></tr></thead><tbody>
      ${o.deliveries.map(
        (d) => html`<tr><td class="strong">${d.stationName}</td><td class="num">${number(d.plannedQuantity)}</td><td class="num">${number(d.dischargedQuantity)}</td><td>${statusPill(d.status)}</td>
          <td>${d.receipts.length ? d.receipts.map((r) => `${r.waybillRef} (${r.status})`).join(", ") : "—"}</td></tr>`,
      )}
      </tbody></table></div>
      <div class="feature-actions" style="padding-top:14px">${actions}</div>`,
  );
}

async function select(id) {
  selectedId = id;
  $$("#gitBody tr[data-order-id]").forEach((tr) => tr.classList.toggle("selected", Number(tr.dataset.orderId) === id));
  try {
    const res = await api.get(`/git-orders/${id}`);
    selected = res.data;
    renderFeature(selected);
  } catch (err) {
    setHtml($("#gitFeature"), html`<div class="chart-empty">${err.message}</div>`);
  }
}

async function load({ selectId } = {}) {
  const res = await loadTable(
    $("#gitBody"),
    COLS,
    () => api.get("/git-orders", { status: $("#gitStatus").value, stationId: $("#gitStation").value, search: $("#gitSearch").value.trim(), page, limit: 20 }),
    renderRow,
    { empty: "No GIT orders for these filters." },
  );
  if (!res) return;
  rows = res.data;
  renderPager($("#gitPager"), res.pagination, (p) => {
    page = p;
    load();
  });
  const target = selectId ?? (rows.some((r) => r.id === selectedId) ? selectedId : (rows.find((r) => r.status !== "completed" && r.status !== "cancelled") ?? rows[0])?.id);
  if (target) await select(target);
  else setHtml($("#gitFeature"), html`<div class="chart-empty">No order selected.</div>`);
}

const reload = () => {
  page = 1;
  load();
};

async function afterChange(res) {
  selected = res.data;
  toast(res.message, "success");
  await load({ selectId: selected.id });
  refreshBadges();
}

/* Dialogs -------------------------------------------------------------------------------- */

function stationChoices() {
  const bound = boundStation();
  return (state.lookups?.stations ?? []).filter((s) => bound === null || s.id === bound);
}

function destRow(stationId = "", quantity = "") {
  return html`<div class="dest-row"><select class="select" data-dest-station>${stationChoices().map((s) => html`<option value="${s.id}" ${String(s.id) === String(stationId) ? raw("selected") : ""}>${s.name}</option>`)}</select>
    <input class="input" data-dest-qty inputmode="decimal" placeholder="Litres" value="${quantity}"><button class="btn btn-xs" type="button" data-dest-remove aria-label="Remove">×</button></div>`;
}

function readDestinations(root) {
  return $$(".dest-row", root).map((row) => {
    const qty = row.querySelector("[data-dest-qty]").value.replace(/,/g, "").trim();
    return { stationId: Number(row.querySelector("[data-dest-station]").value), quantity: qty === "" ? undefined : Number(qty) };
  });
}

function bindDestRows(container, addButton) {
  addButton.addEventListener("click", () => container.insertAdjacentHTML("beforeend", destRow().toString()));
  container.addEventListener("click", (e) => {
    if (e.target.closest("[data-dest-remove]")) e.target.closest(".dest-row").remove();
  });
}

function editDialog(o) {
  formModal({
    title: `Edit ${o.ref}`,
    intro: "The original quantity and order price cannot change. Truck, ETA and notes are tracked in the order history.",
    fields: [
      { name: "truckPlate", label: "Truck", value: o.truckPlate ?? "", placeholder: "NGR-482-XY" },
      { name: "expectedArrivalDate", label: "Expected arrival", type: "date", value: o.expectedArrivalDate ?? "" },
      { name: "source", label: "Loading depot / source", value: o.source ?? "" },
      { name: "notes", label: "Notes", value: o.notes ?? "" },
    ],
    onSubmit: async (values, { close }) => {
      const res = await api.patch(`/git-orders/${o.id}`, values);
      close();
      await afterChange(res);
    },
  });
}

function statusDialog(o, status) {
  if (status === "truck_assigned" && !o.truckPlate) return editDialog(o);
  const needsNote = status === "cancelled" || status === "completed";
  formModal({
    title: `${TRANSITION_LABEL[status]} — ${o.ref}`,
    intro:
      status === "completed"
        ? "Completing an order with undischarged deliveries short-closes it and flags a shortage."
        : status === "cancelled"
          ? "Only orders without linked receipts can be cancelled."
          : `Move the order from ${o.statusLabel} to the next stage.`,
    danger: status === "cancelled",
    submitLabel: TRANSITION_LABEL[status],
    fields: [{ name: "note", label: needsNote ? "Reason / note" : "Note (optional)", type: "textarea", span: true }],
    onSubmit: async (values, { close }) => {
      const res = await api.post(`/git-orders/${o.id}/status`, { status, note: values.note });
      close();
      await afterChange(res);
    },
  });
}

function deliveriesDialog(o) {
  const current = o.deliveries.filter((d) => d.status !== "cancelled");
  formModal({
    title: `Deliveries — ${o.ref}`,
    intro: `Allocate the full ${number(o.quantity)} L across one or more stations. Deliveries cannot change once a receipt is linked.`,
    fields: [
      {
        type: "html",
        name: "destinations",
        span: true,
        content: html`<div data-dest-rows>${current.map((d) => destRow(d.stationId, d.plannedQuantity))}</div><button class="btn btn-xs" type="button" data-dest-add>+ Add destination</button><input type="hidden" name="destinations">`,
      },
    ],
    onRender: (form) => bindDestRows(form.querySelector("[data-dest-rows]"), form.querySelector("[data-dest-add]")),
    onSubmit: async (_values, { form, close }) => {
      const res = await api.put(`/git-orders/${o.id}/deliveries`, { destinations: readDestinations(form) });
      close();
      await afterChange(res);
    },
  });
}

function flagDialog(o) {
  formModal({
    title: `Flag exception — ${o.ref}`,
    fields: [
      { name: "type", label: "Exception type", type: "select", options: [{ value: "shortage", label: "Shortage" }, { value: "delay", label: "Delay" }, { value: "price", label: "Price discrepancy" }, { value: "other", label: "Other" }] },
      { name: "note", label: "Details", type: "textarea", span: true },
    ],
    submitLabel: "Flag exception",
    danger: true,
    onSubmit: async (values, { close }) => {
      const res = await api.post(`/git-orders/${o.id}/exception`, values);
      close();
      await afterChange(res);
    },
  });
}

function historyDialog(o) {
  infoModal({
    title: `History — ${o.ref}`,
    content: html`<div class="table-wrap"><table><thead><tr><th class="strong">When</th><th>Event</th><th>Status</th><th>Note</th><th>By</th></tr></thead><tbody>
      ${o.events.map(
        (e) => html`<tr><td class="strong">${dateTime(e.createdAt)}</td><td>${e.eventType.replaceAll("_", " ")}</td><td>${e.fromStatus && e.fromStatus !== e.toStatus ? `${e.fromStatus.replaceAll("_", " ")} → ` : ""}${(e.toStatus ?? "").replaceAll("_", " ")}</td><td style="white-space:normal">${e.note ?? ""}</td><td>${e.userName ?? "System"}</td></tr>`,
      )}</tbody></table></div>`,
  });
}

/* Create order ---------------------------------------------------------------------------- */

function toggleMulti() {
  const multi = $("#gtMulti").value === "true";
  $("#gtMultiDest").hidden = !multi;
  $("#gtSingleDest").hidden = multi;
  if (multi && $$("#gtDestRows .dest-row").length === 0) {
    $("#gtDestRows").insertAdjacentHTML("beforeend", destRow().toString() + destRow().toString());
  }
}

export default {
  id: "git",
  permission: "git.view",

  init() {
    stationOptions($("#gitStation"), { all: true });
    $("#gitStatus").addEventListener("change", reload);
    $("#gitStation").addEventListener("change", reload);
    $("#gitSearch").addEventListener("input", debounce(reload, 350));
    $("#gitBody").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-order-id]");
      if (tr) select(Number(tr.dataset.orderId));
    });

    $("#gitFeature").addEventListener("click", (e) => {
      if (!selected) return;
      const status = e.target.closest("[data-git-status]");
      if (status) return statusDialog(selected, status.dataset.gitStatus);
      if (e.target.closest("[data-git-edit]")) return editDialog(selected);
      if (e.target.closest("[data-git-deliveries]")) return deliveriesDialog(selected);
      if (e.target.closest("[data-git-flag]")) return flagDialog(selected);
      if (e.target.closest("[data-git-history]")) return historyDialog(selected);
      if (e.target.closest("[data-git-resolve]")) {
        return reasonModal({
          title: `Resolve exception — ${selected.ref}`,
          label: "Resolution",
          field: "note",
          danger: false,
          submitLabel: "Resolve",
          onSubmit: async (values, { close }) => {
            const res = await api.post(`/git-orders/${selected.id}/exception/resolve`, { note: values.note ?? "" });
            close();
            await afterChange(res);
          },
        });
      }
      return undefined;
    });

    $("#gtMulti").addEventListener("change", toggleMulti);
    bindDestRows($("#gtDestRows"), $("#gtAddDest"));

    bindForm($("#formGit"), async (values) => {
      const multi = values.isMultiDelivery === "true";
      const body = {
        productId: values.productId,
        quantity: values.quantity,
        orderPrice: values.orderPrice,
        truckPlate: values.truckPlate,
        source: values.source,
        orderDate: values.orderDate,
        isMultiDelivery: multi,
        destinations: multi ? readDestinations($("#gtDestRows")) : values.destinationStationId ? [{ stationId: Number(values.destinationStationId) }] : [],
      };
      try {
        const res = await api.post("/git-orders", body);
        closeModal("modalGit");
        toast(res.message, "success");
        page = 1;
        await load({ selectId: res.data.id });
      } catch (err) {
        if (!multi && err.fields) {
          for (const key of Object.keys(err.fields)) {
            if (key.startsWith("destinations")) err.fields.destinationStationId = err.fields[key];
          }
        }
        throw err;
      }
    });
  },

  async load(params = {}) {
    const search = params.search ?? (params.focus?.type === "GIT order" ? params.focus.ref : undefined);
    if (search) {
      $("#gitSearch").value = search;
      $("#gitStatus").value = "";
      page = 1;
    }
    try {
      await load({ selectId: params.focus?.type === "GIT order" ? params.focus.id : undefined });
    } catch (err) {
      toastError(err);
    }
  },

  modals: {
    modalGit() {
      $("#formGit").reset();
      productOptions($("#gtProduct"));
      stationOptions($("#gtStation"));
      setHtml($("#gtDestRows"), html``);
      $("#gtMulti").value = "false";
      toggleMulti();
      dateInput($("#gtDate"), today());
    },
  },
};
