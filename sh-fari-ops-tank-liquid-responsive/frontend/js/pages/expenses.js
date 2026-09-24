/** Expenses — controlled narrations, approval thresholds, approve / reject / cancel. */
import { api } from "../api/client.js";
import { $, html, setOptions } from "../core/dom.js";
import { dateInput, monthOptions, stationOptions } from "../core/filters.js";
import { naira, number, shortDate, statusPill } from "../core/format.js";
import { refreshBadges } from "../core/shell.js";
import { can, state, today } from "../core/state.js";
import { bindForm, closeModal, formModal, loadTable, reasonModal, renderPager, toast } from "../core/ui.js";

const COLS = 7;
let page = 1;
let rows = [];

function renderRow(e) {
  const buttons = [];
  if (e.status === "pending" && e.canDecide && can("expenses.approve")) {
    buttons.push(html`<button class="btn btn-xs btn-primary" data-expense-action="approve" data-id="${e.id}">Approve</button>`);
    buttons.push(html`<button class="btn btn-xs" data-expense-action="reject" data-id="${e.id}">Reject</button>`);
  }
  if ((e.status === "pending" && (e.recordedBy === state.user.id || can("expenses.approve"))) || (e.status === "approved" && can("expenses.approve"))) {
    buttons.push(html`<button class="btn btn-xs" data-expense-action="cancel" data-id="${e.id}">Cancel</button>`);
  }
  const pill = e.status === "pending" ? html`<span class="pill amber">Pending — above threshold</span>` : statusPill(e.status);
  return html`<tr title="${[e.ref, e.decisionNote].filter(Boolean).join(" · ")}">
    <td class="strong">${shortDate(e.businessDate)}</td><td>${e.stationName}</td><td>${e.narration}</td><td>${e.payee}</td>
    <td class="num">${number(e.amount)}</td><td>${pill}</td><td class="actions-cell"><div class="row-actions">${buttons}</div></td></tr>`;
}

async function load() {
  const res = await loadTable(
    $("#expBody"),
    COLS,
    () =>
      api.get("/expenses", {
        month: $("#expMonth").value,
        stationId: $("#expStation").value,
        narrationId: $("#expNarration").value,
        status: $("#expStatus").value,
        page,
        limit: 20,
      }),
    renderRow,
    { empty: "No expenses for these filters." },
  );
  if (!res) return;
  rows = res.data;
  renderPager($("#expPager"), res.pagination, (p) => {
    page = p;
    load();
  });
  const s = res.summary;
  $("#expSummary").textContent = `Approved ${naira(s.approvedAmount)} (${s.approvedCount}) · Pending ${naira(s.pendingAmount)} (${s.pendingCount})`;
}

const reload = () => {
  page = 1;
  load();
};

function act(action, id) {
  const e = rows.find((x) => x.id === id);
  if (!e) return;
  const done = async (res, close) => {
    close();
    toast(res.message, "success");
    load();
    refreshBadges();
  };
  if (action === "approve") {
    formModal({
      title: `Approve ${e.ref}`,
      intro: `${e.narration} · ${e.payee} · ${naira(e.amount)} — logged by ${e.recordedByName} (threshold ${naira(e.approvalThreshold)}).`,
      fields: [{ name: "note", label: "Approval note (optional)", type: "textarea", span: true }],
      submitLabel: "Approve expense",
      onSubmit: async (values, { close }) => done(await api.post(`/expenses/${id}/approve`, { note: values.note }), close),
    });
  } else {
    reasonModal({
      title: `${action === "reject" ? "Reject" : "Cancel"} ${e.ref}`,
      intro: `${e.narration} · ${e.payee} · ${naira(e.amount)}${e.status === "approved" ? ". Cancelling an approved expense removes it from cash and profit." : "."}`,
      submitLabel: action === "reject" ? "Reject expense" : "Cancel expense",
      onSubmit: async (values, { close }) => done(await api.post(`/expenses/${id}/${action}`, { reason: values.reason ?? "" }), close),
    });
  }
}

function updateHint() {
  const narration = state.lookups?.narrations.find((n) => String(n.id) === $("#exNarration").value);
  const amount = Number(($("#formExpense").amount.value || "0").replace(/[₦,\s]/g, ""));
  const hint = $("#exHint");
  if (!narration) hint.textContent = "Narration must be selected from the approved list.";
  else if (narration.approvalThreshold === null) hint.textContent = "No approval is needed for this narration.";
  else if (amount > narration.approvalThreshold) hint.textContent = `Above the ${naira(narration.approvalThreshold)} threshold — this expense will need approval by someone else.`;
  else hint.textContent = `Within the ${naira(narration.approvalThreshold)} approval threshold.`;
}

export default {
  id: "expenses",
  permission: "expenses.view",

  init() {
    monthOptions($("#expMonth"));
    stationOptions($("#expStation"), { all: true });
    setOptions($("#expNarration"), state.lookups?.narrations ?? [], { placeholder: "All narrations" });
    for (const id of ["#expMonth", "#expStation", "#expNarration", "#expStatus"]) $(id).addEventListener("change", reload);
    $("#expBody").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-expense-action]");
      if (btn) act(btn.dataset.expenseAction, Number(btn.dataset.id));
    });

    $("#exNarration").addEventListener("change", updateHint);
    $("#formExpense").amount.addEventListener("input", updateHint);
    bindForm($("#formExpense"), async (values) => {
      const res = await api.post("/expenses", values);
      closeModal("modalExpense");
      toast(res.message, "success");
      reload();
      refreshBadges();
    });
  },

  async load(params = {}) {
    if (params.focus?.date) $("#expMonth").value = params.focus.date.slice(0, 7);
    await load();
  },

  modals: {
    modalExpense() {
      $("#formExpense").reset();
      stationOptions($("#exStation"), { selected: $("#expStation").value || undefined });
      setOptions($("#exNarration"), state.lookups?.narrations ?? [], { placeholder: "Select narration", keep: false });
      dateInput($("#exDate"), today());
      updateHint();
    },
  },
};
