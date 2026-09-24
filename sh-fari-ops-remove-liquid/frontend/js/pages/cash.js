/** Cash, POS & bank — daily reconciliation, teller-wise deposits, declarations, review and close. */
import { api } from "../api/client.js";
import { $, html, setHtml, setOptions } from "../core/dom.js";
import { dateInput, stationOptions } from "../core/filters.js";
import { date, naira, number, shortDate, statusPill, statusText } from "../core/format.js";
import { refreshBadges } from "../core/shell.js";
import { can, defaultStationId, state, today } from "../core/state.js";
import { bindForm, closeModal, fillTable, formModal, reasonModal, tableError, tableLoading, toast } from "../core/ui.js";

let position = null;

const filters = () => ({ stationId: $("#cashStation").value, date: $("#cashDate").value });

function show(el, condition) {
  el.hidden = !condition || Boolean(el.dataset.permission && !can(el.dataset.permission));
}

function depositRow(d) {
  const canCancel = d.status === "confirmed" && can("cash.record") && position?.declaration?.status !== "closed";
  return html`<tr title="${d.cancelReason ?? ""}"><td class="strong">${d.time}</td><td>${d.bankName}</td><td class="mono-tag">${d.tellerRef}</td><td class="num">${naira(d.amount)}</td>
    <td>${d.recordedByName}</td><td>${statusPill(d.status)}</td>
    <td class="actions-cell">${canCancel ? html`<button class="btn btn-xs" data-cancel-deposit="${d.id}">Cancel</button>` : ""}</td></tr>`;
}

function renderPosition(p) {
  const f = p.figures;
  $("#cashExpected").textContent = naira(f.expectedCash);
  $("#cashExpectedLabel").textContent = `Expected cash — ${shortDate(p.date)}`;
  $("#cashDeposited").textContent = naira(f.depositsTotal);
  $("#cashCit").textContent = naira(f.closingCit);
  const variance = $("#cashVariance");
  if (f.variance === null) {
    variance.textContent = "—";
    variance.style.color = "";
    $("#cashVarianceLabel").textContent = "Variance — awaiting cash declaration";
  } else {
    variance.textContent = naira(f.variance, { signed: true });
    variance.style.color = f.variance < 0 ? "var(--red)" : f.variance > 0 ? "var(--green)" : "";
    $("#cashVarianceLabel").textContent = `Variance · ${statusText(f.toleranceStatus)}`;
  }

  const decl = p.declaration;
  setHtml(
    $("#cashStatusPill"),
    decl ? html`${f.toleranceStatus ? statusPill(f.toleranceStatus) : ""} ${decl.status !== "open" ? statusPill(decl.status) : ""}` : statusPill("not_declared"),
  );
  show($("#cashReview"), decl && decl.status === "open");
  show($("#cashCloseBtn"), decl && decl.status !== "closed");

  $("#cashDepositsTitle").textContent = `Teller-wise deposits — ${date(p.date)}`;
  const rows = p.deposits.map((d) => ({ ...d, kind: "deposit" }));
  if (f.closingCit > 0) rows.push({ kind: "cit", amount: f.closingCit });
  fillTable(
    $("#cashDepositsBody"),
    7,
    rows,
    (r) =>
      r.kind === "cit"
        ? html`<tr><td class="strong">—</td><td>—</td><td class="mono-tag">CIT carry-forward</td><td class="num">${naira(r.amount)}</td><td>System</td><td><span class="pill gray">Carried forward</span></td><td></td></tr>`
        : depositRow(r),
    "No deposits recorded for this day.",
  );

  const dsrNote = p.dsr.required && p.dsr.status !== "closed" ? " (DSR not closed — sales excluded)" : "";
  setHtml(
    $("#cashBreakdown"),
    html`<span>DSR sales value${dsrNote}</span><span>${naira(f.salesValue)}</span>
      <span>− POS collections</span><span>${naira(f.posAmount)}</span>
      <span>− Credit sales to debtors</span><span>${naira(f.creditSales)}</span>
      <span>+ Cash repayments from debtors</span><span>${naira(f.debtorCashReceipts)}</span>
      <span>− Approved cash expenses</span><span>${naira(f.cashExpenses)}</span>
      <span class="total">Expected cash</span><span class="total">${naira(f.expectedCash)}</span>
      <span>CIT / cash brought forward</span><span>${naira(f.broughtForward)}</span>
      <span>Deposited to bank</span><span>${naira(f.depositsTotal)}</span>
      <span>CIT carried forward</span><span>${naira(f.closingCit)}</span>
      <span>Cash at hand</span><span>${naira(f.cashAtHand)}</span>
      <span class="total">Variance</span><span class="total ${f.variance < 0 ? "num-neg" : ""}">${f.variance === null ? "—" : naira(f.variance, { signed: true })}</span>
      <span>Tolerance</span><span>±${naira(f.tolerance)}</span>`,
  );
  $("#cashBreakdownSub").textContent = decl
    ? `Declared by ${decl.recordedByName ?? "—"}${decl.reviewComment ? ` · ${decl.reviewedByName ?? "review"}: “${decl.reviewComment}”` : ""}${decl.closedByName ? ` · closed by ${decl.closedByName}` : ""}`
    : "No cash declaration yet — record POS, CIT and cash at hand to reconcile.";
}

async function loadPosition() {
  tableLoading($("#cashDepositsBody"), 7);
  try {
    const res = await api.get("/cash/position", filters());
    position = res.data;
    renderPosition(position);
  } catch (err) {
    position = null;
    tableError($("#cashDepositsBody"), 7, err, loadPosition);
  }
}

function historyRow(r) {
  return html`<tr class="clickable" data-cash-date="${r.businessDate}"><td class="strong">${shortDate(r.businessDate)}</td>
    <td class="num">${number(r.expectedCash)}</td><td class="num">${number(r.depositsTotal)}</td><td class="num">${number(r.closingCit)}</td><td class="num">${number(r.cashAtHand)}</td>
    <td class="num ${r.variance < 0 ? "num-neg" : ""}">${r.variance === null ? "—" : number(r.variance)}</td>
    <td>${r.variance === null ? statusPill("not_declared") : statusPill(r.toleranceStatus)}${r.status === "closed" ? html` <span class="pill gray">Closed</span>` : ""}</td></tr>`;
}

async function loadHistory() {
  const body = $("#cashHistoryBody");
  tableLoading(body, 7);
  try {
    const res = await api.get("/cash/history", { stationId: $("#cashStation").value, month: $("#cashDate").value.slice(0, 7) });
    $("#cashHistoryTitle").textContent = `Variance history — ${res.data.station.name}`;
    fillTable(body, 7, res.data.rows, historyRow, "No cash activity this month.");
  } catch (err) {
    tableError(body, 7, err, loadHistory);
  }
}

const loadAll = () => Promise.all([loadPosition(), loadHistory()]);

function stationLabel() {
  return state.lookups?.stations.find((s) => String(s.id) === $("#cashStation").value)?.name ?? "";
}

export default {
  id: "cash",
  permission: "cash.view",

  init() {
    dateInput($("#cashDate"), today());
    stationOptions($("#cashStation"));
    $("#cashDate").addEventListener("change", loadAll);
    $("#cashStation").addEventListener("change", loadAll);

    $("#cashHistoryBody").addEventListener("click", (e) => {
      const tr = e.target.closest("[data-cash-date]");
      if (!tr) return;
      $("#cashDate").value = tr.dataset.cashDate;
      loadPosition();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    $("#cashDepositsBody").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-cancel-deposit]");
      if (!btn) return;
      const d = position.deposits.find((x) => x.id === Number(btn.dataset.cancelDeposit));
      reasonModal({
        title: `Cancel deposit ${d.tellerRef}`,
        intro: `${d.bankName} · ${naira(d.amount)}. The reconciliation is recalculated immediately.`,
        submitLabel: "Cancel deposit",
        onSubmit: async (values, { close }) => {
          const res = await api.post(`/cash/deposits/${d.id}/cancel`, { reason: values.reason ?? "" });
          close();
          toast(res.message, "success");
          loadAll();
          refreshBadges();
        },
      });
    });

    $("#cashReview").addEventListener("click", () =>
      reasonModal({
        title: `Review cash reconciliation — ${date(position.date)}`,
        intro: `Variance ${naira(position.figures.variance, { signed: true })} (${statusText(position.figures.toleranceStatus)}).`,
        label: "Review comment",
        field: "comment",
        danger: false,
        submitLabel: "Mark reviewed",
        onSubmit: async (values, { close }) => {
          const res = await api.post(`/cash/positions/${position.declaration.id}/review`, { comment: values.comment ?? "" });
          close();
          toast(res.message, "success");
          loadAll();
          refreshBadges();
        },
      }),
    );

    $("#cashCloseBtn").addEventListener("click", () => {
      const exceeded = position.figures.toleranceStatus === "exceeded";
      formModal({
        title: `Close cash reconciliation — ${date(position.date)}`,
        intro: `Closing freezes this day's cash figures. Variance ${naira(position.figures.variance ?? 0, { signed: true })}.${exceeded ? " It exceeds tolerance, so a justification is required." : ""}`,
        fields: [{ name: "comment", label: exceeded ? "Justification" : "Comment (optional)", type: "textarea", span: true, value: position.declaration.reviewComment ?? "" }],
        submitLabel: "Close reconciliation",
        onSubmit: async (values, { close }) => {
          const res = await api.post(`/cash/positions/${position.declaration.id}/close`, { comment: values.comment });
          close();
          toast(res.message, "success");
          loadAll();
          refreshBadges();
        },
      });
    });

    bindForm($("#formDeposit"), async (values) => {
      const res = await api.post("/cash/deposits", { ...values, ...{ stationId: Number(filters().stationId), businessDate: filters().date } });
      closeModal("modalDeposit");
      toast(res.message, "success");
      position = res.data;
      renderPosition(position);
      loadHistory();
      refreshBadges();
    });

    bindForm($("#formDeclaration"), async (values) => {
      const res = await api.put("/cash/declarations", {
        stationId: Number(filters().stationId),
        businessDate: filters().date,
        posAmount: values.posAmount ?? 0,
        closingCit: values.closingCit ?? 0,
        cashAtHand: values.cashAtHand ?? 0,
        notes: values.notes,
      });
      closeModal("modalDeclaration");
      toast(res.message, "success");
      position = res.data;
      renderPosition(position);
      loadHistory();
      refreshBadges();
    });
  },

  async load(params = {}) {
    const stationId = params.stationId ?? params.focus?.stationId;
    const day = params.date ?? params.focus?.date;
    if (stationId) $("#cashStation").value = String(stationId);
    if (day) $("#cashDate").value = day;
    if (!$("#cashStation").value && defaultStationId()) $("#cashStation").value = String(defaultStationId());
    await loadAll();
  },

  modals: {
    modalDeposit() {
      $("#formDeposit").reset();
      setOptions($("#depBank"), state.lookups?.banks ?? [], { placeholder: "Select bank" });
      $("#depositIntro").textContent = `${stationLabel()} · ${date(filters().date)}`;
    },
    modalDeclaration() {
      const form = $("#formDeclaration");
      form.reset();
      const d = position?.declaration;
      if (d) {
        form.posAmount.value = d.posAmount;
        form.closingCit.value = d.closingCit;
        form.cashAtHand.value = d.cashAtHand;
        form.notes.value = d.notes ?? "";
      }
      $("#declarationIntro").textContent = `${stationLabel()} · ${date(filters().date)}. Declare POS collections, cash collected but not yet banked (CIT) and the cash physically counted. Variance is recalculated immediately${d?.status === "reviewed" ? " and the review is cleared" : ""}.`;
    },
  },
};
