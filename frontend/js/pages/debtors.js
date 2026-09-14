/** Debtors — balances, aging, customer history, credit sales, repayments and voids. */
import { api } from "../api/client.js";
import { $, debounce, html } from "../core/dom.js";
import { dateInput, monthOptions, stationOptions } from "../core/filters.js";
import { date, naira, number, statusPill } from "../core/format.js";
import { can, today } from "../core/state.js";
import { bindForm, closeModal, formModal, infoModal, loadTable, reasonModal, renderPager, toast, toastError } from "../core/ui.js";

const COLS = 7;
let page = 1;

const TYPE_LABEL = { opening_balance: "Opening balance", credit_sale: "Credit sale", repayment: "Repayment" };

function renderRow(d) {
  return html`<tr class="clickable" data-debtor-id="${d.id}"><td class="strong">${d.name}</td><td>${d.stationName}</td>
    <td class="num">${number(d.opening)}</td><td class="num">${number(d.additions)}</td><td class="num">${number(d.payments)}</td><td class="num">${number(d.closing)}</td>
    <td>${statusPill(d.aging)}${d.status === "inactive" ? html` <span class="pill gray">Inactive</span>` : ""}</td></tr>`;
}

async function loadSummary() {
  try {
    const { data } = await api.get("/debtors/summary", { stationId: $("#debtStation").value });
    $("#debtTotal").textContent = naira(data.totalOutstanding, { compact: true });
    $("#debtAccounts").textContent = number(data.accounts);
    $("#debtOver60").textContent = naira(data.over60, { compact: true });
    $("#debtOver90").textContent = naira(data.over90, { compact: true });
  } catch (err) {
    toastError(err);
  }
}

async function loadList() {
  const res = await loadTable(
    $("#debtBody"),
    COLS,
    () => api.get("/debtors", { search: $("#debtSearch").value.trim(), stationId: $("#debtStation").value, month: $("#debtMonth").value, page, limit: 20, sortBy: "balance" }),
    renderRow,
    { empty: "No debtors match these filters." },
  );
  if (res) {
    renderPager($("#debtPager"), res.pagination, (p) => {
      page = p;
      loadList();
    });
  }
}

const loadAll = () => Promise.all([loadSummary(), loadList()]);
const reload = () => {
  page = 1;
  loadAll();
};

async function openDetail(id) {
  let d;
  try {
    d = (await api.get(`/debtors/${id}`)).data;
  } catch (err) {
    toastError(err);
    return;
  }
  const actions = [];
  if (can("debtors.transact")) {
    if (d.status === "active") actions.push(html`<button class="btn btn-xs btn-primary" type="button" data-detail="credit_sale">+ Credit sale</button>`);
    if (d.balance > 0) actions.push(html`<button class="btn btn-xs" type="button" data-detail="repayment">Record repayment</button>`);
  }
  if (can("debtors.create")) actions.push(html`<button class="btn btn-xs" type="button" data-detail="edit">Edit</button>`);

  infoModal({
    title: d.name,
    content: html`<div class="kv" style="padding:0 0 14px">
        <span>Station</span><span>${d.stationName}</span>
        <span>Phone</span><span>${d.phone ?? "—"}</span>
        <span>Credit limit</span><span>${d.creditLimit === null ? "No limit" : naira(d.creditLimit)}</span>
        <span>Outstanding balance</span><span>${naira(d.balance)}</span>
        <span>Aging</span><span>${statusPill(d.aging.status)}${d.aging.oldestAgeDays !== null ? ` oldest unpaid ${d.aging.oldestAgeDays} days` : ""}</span>
        <span>Buckets (0–30 / 31–60 / 61–90 / 90+)</span><span>${naira(d.aging.buckets.current, { compact: true })} / ${naira(d.aging.buckets["31_60"], { compact: true })} / ${naira(d.aging.buckets["61_90"], { compact: true })} / ${naira(d.aging.buckets["90_plus"], { compact: true })}</span>
      </div>
      <div class="feature-actions" style="padding:0 0 14px">${actions}</div>
      <div class="table-wrap"><table><thead><tr><th class="strong">Date</th><th>Type</th><th>Reference</th><th>Method</th><th class="num">Amount</th><th class="num">Balance</th><th>Recorded by</th><th></th></tr></thead><tbody>
      ${d.transactions.map(
        (t) => html`<tr${t.voidedAt ? html` style="opacity:.55" title="Voided: ${t.voidReason ?? ""}"` : ""}>
          <td class="strong">${date(t.businessDate)}</td><td>${TYPE_LABEL[t.type]}${t.voidedAt ? " (voided)" : ""}</td><td class="mono-tag">${t.reference ?? "—"}</td><td>${t.paymentMethod ?? "—"}</td>
          <td class="num">${naira(t.type === "repayment" ? -t.amount : t.amount, { signed: true })}</td><td class="num">${naira(t.runningBalance)}</td><td>${t.recordedByName ?? ""}</td>
          <td class="actions-cell">${!t.voidedAt && can("debtors.void") ? html`<button class="btn btn-xs" type="button" data-void="${t.id}">Void</button>` : ""}</td></tr>`,
      )}
      </tbody></table></div>`,
    onRender: (form, close) => {
      form.addEventListener("click", (e) => {
        const detail = e.target.closest("[data-detail]");
        if (detail) {
          close();
          if (detail.dataset.detail === "edit") editDialog(d);
          else transactionDialog({ type: detail.dataset.detail, debtor: d });
        }
        const voidBtn = e.target.closest("[data-void]");
        if (voidBtn) {
          close();
          reasonModal({
            title: "Void transaction",
            intro: "The transaction stays in the history but no longer counts towards the balance.",
            submitLabel: "Void transaction",
            onSubmit: async (values, { close: done }) => {
              await api.post(`/debtors/transactions/${voidBtn.dataset.void}/void`, { reason: values.reason ?? "" });
              done();
              toast("Transaction voided.", "success");
              loadAll();
              openDetail(d.id);
            },
          });
        }
      });
    },
  });
}

function editDialog(d) {
  formModal({
    title: `Edit ${d.name}`,
    fields: [
      { name: "name", label: "Customer name", value: d.name },
      { name: "phone", label: "Phone", value: d.phone ?? "" },
      { name: "creditLimit", label: "Credit limit", type: "number", value: d.creditLimit ?? "", hint: "Leave as-is to keep the current limit." },
      { name: "status", label: "Status", type: "select", value: d.status, options: [{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }] },
    ],
    onSubmit: async (values, { close }) => {
      await api.patch(`/debtors/${d.id}`, values);
      close();
      toast("Debtor updated.", "success");
      loadAll();
      openDetail(d.id);
    },
  });
}

async function transactionDialog({ type, debtor }) {
  const repayment = type === "repayment";
  let choices = [];
  if (!debtor) {
    try {
      const res = await api.get("/debtors", { stationId: $("#debtStation").value, status: "active", hasBalance: repayment ? "true" : undefined, sortBy: "name", sortOrder: "asc", limit: 100 });
      choices = res.data;
    } catch (err) {
      toastError(err);
      return;
    }
    if (choices.length === 0) {
      toast(repayment ? "No debtors with an outstanding balance." : "Register a debtor first.", "error");
      return;
    }
  }
  const fields = [];
  if (!debtor) {
    fields.push({
      name: "debtorId",
      label: "Customer",
      type: "select",
      span: true,
      placeholder: "Select customer",
      options: choices.map((c) => ({ value: c.id, label: `${c.name} — ${c.stationName} (balance ${naira(c.balance)})` })),
    });
  }
  fields.push({ name: "amount", label: "Amount", type: "number", placeholder: "₦0" }, { name: "businessDate", label: "Date", type: "date", value: today() });
  if (repayment) {
    fields.push({ name: "paymentMethod", label: "Paid by", type: "select", value: "cash", options: [{ value: "cash", label: "Cash" }, { value: "transfer", label: "Bank transfer" }, { value: "pos", label: "POS" }] });
  }
  fields.push({ name: "reference", label: "Reference", placeholder: repayment ? "Receipt no." : "Invoice no." }, { name: "note", label: "Note", placeholder: "Optional", span: !repayment });

  formModal({
    title: repayment ? `Record repayment${debtor ? ` — ${debtor.name}` : ""}` : `Credit sale${debtor ? ` — ${debtor.name}` : ""}`,
    intro: debtor ? `Outstanding balance ${naira(debtor.balance)}${debtor.creditLimit !== null ? ` · credit limit ${naira(debtor.creditLimit)}` : ""}.` : undefined,
    fields,
    submitLabel: repayment ? "Record repayment" : "Record credit sale",
    onSubmit: async (values, { close }) => {
      const id = debtor?.id ?? values.debtorId;
      if (!id) {
        const err = new Error("Select a customer.");
        err.name = "ApiError";
        err.fields = { debtorId: "Select a customer." };
        throw err;
      }
      const res = await api.post(`/debtors/${id}/transactions`, {
        type,
        amount: values.amount,
        businessDate: values.businessDate,
        paymentMethod: values.paymentMethod,
        reference: values.reference,
        note: values.note,
      });
      close();
      toast(res.message, "success");
      loadAll();
      if (debtor) openDetail(debtor.id);
    },
  });
}

export default {
  id: "debtors",
  permission: "debtors.view",

  init() {
    stationOptions($("#debtStation"), { all: true });
    monthOptions($("#debtMonth"));
    $("#debtStation").addEventListener("change", reload);
    $("#debtMonth").addEventListener("change", reload);
    $("#debtSearch").addEventListener("input", debounce(reload, 350));
    $("#debtBody").addEventListener("click", (e) => {
      const tr = e.target.closest("[data-debtor-id]");
      if (tr) openDetail(Number(tr.dataset.debtorId));
    });

    bindForm($("#formDebtor"), async (values) => {
      const res = await api.post("/debtors", values);
      closeModal("modalDebtor");
      toast(res.message, "success");
      reload();
    });
  },

  async load(params = {}) {
    const search = params.search ?? (params.focus?.type === "Debtor" ? params.focus.ref : undefined);
    if (search !== undefined) {
      $("#debtSearch").value = search;
      page = 1;
    }
    await loadAll();
    if (params.focus?.type === "Debtor") openDetail(params.focus.id);
  },

  actions: {
    "debtor-repayment": () => transactionDialog({ type: "repayment" }),
    "debtor-credit": () => transactionDialog({ type: "credit_sale" }),
  },

  modals: {
    modalDebtor() {
      $("#formDebtor").reset();
      stationOptions($("#dbStation"), { selected: $("#debtStation").value || undefined });
      dateInput($("#dbDate"), today());
    },
  },
};
