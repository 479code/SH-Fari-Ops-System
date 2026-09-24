/** exceptions.js — the shared review/close dialog for exceptions (dashboard and bell menu). */
import { api } from "../api/client.js";
import { html } from "./dom.js";
import { dateTime, naira, statusPill } from "./format.js";
import { navigate } from "./router.js";
import { can } from "./state.js";
import { formModal, toast } from "./ui.js";

const TYPE_LABEL = {
  cash_variance: "Cash variance",
  stock_variance: "Physical dip variance",
  git_delay: "GIT delay",
  git_shortage: "GIT shortage",
  git_exception: "GIT exception",
  debtor_aging: "Debtor aging",
};

export function exceptionPill(item) {
  if (item.status === "reviewed") return html`<span class="pill blue">Reviewed</span>`;
  if (item.status === "closed") return html`<span class="pill gray">Closed</span>`;
  switch (item.type) {
    case "git_delay":
      return html`<span class="pill amber">Delayed</span>`;
    case "debtor_aging":
      return html`<span class="pill amber">Review</span>`;
    case "git_shortage":
      return html`<span class="pill red">Shortage</span>`;
    case "git_exception":
      return html`<span class="pill red">Exception</span>`;
    default:
      return html`<span class="pill red">Exceeded</span>`;
  }
}

/** Where the underlying record lives in the UI. */
export function exceptionTarget(item) {
  switch (item.type) {
    case "cash_variance":
      return { page: "cash", params: { stationId: item.stationId, date: item.sourceRef.replace("CASH-", "") } };
    case "stock_variance":
      return { page: "stock", params: { stationId: item.stationId } };
    case "debtor_aging":
      return { page: "debtors", params: { search: item.sourceRef, stationId: item.stationId } };
    default:
      return { page: "git", params: { search: item.sourceRef } };
  }
}

export function openException(item, onChanged) {
  const canAct = can("exceptions.review") && item.status !== "closed";
  const summary = html`<div class="kv" style="padding:0">
      <span>Type</span><span>${TYPE_LABEL[item.type] ?? item.type}</span>
      <span>Station</span><span>${item.stationName ?? "Company-wide"}</span>
      <span>Reference</span><span>${item.sourceRef}</span>
      ${item.amount !== null && item.amount !== undefined ? html`<span>Figure</span><span>${item.type === "cash_variance" ? naira(item.amount, { signed: true }) : `${item.amount.toLocaleString("en-NG")}`}</span>` : ""}
      <span>Raised</span><span>${dateTime(item.raisedAt)}</span>
      <span>Status</span><span>${statusPill(item.status)}</span>
      ${item.reviewComment ? html`<span>Review</span><span>${item.reviewedByName ?? ""}: ${item.reviewComment}</span>` : ""}
      ${item.resolution ? html`<span>Resolution</span><span>${item.resolution}</span>` : ""}
    </div>
    <div style="margin-top:12px"><button class="btn btn-xs" type="button" data-go-record>Open record</button></div>`;

  const fields = [{ type: "html", name: "_summary", span: true, content: summary }];
  if (canAct) {
    fields.push(
      {
        name: "action",
        label: "Action",
        type: "select",
        span: true,
        value: item.status === "open" ? "review" : "close",
        options: [...(item.status === "open" ? [{ value: "review", label: "Mark as reviewed (keep open)" }] : []), { value: "close", label: "Close with resolution" }],
      },
      { name: "comment", label: "Comment / resolution", type: "textarea", span: true, placeholder: "What was found and what was done" },
    );
  }

  formModal({
    title: item.title,
    intro: item.detail ?? "",
    fields,
    submitLabel: "Save",
    hideSubmit: !canAct,
    cancelLabel: canAct ? "Cancel" : "Close",
    onRender: (form, close) => {
      form.querySelector("[data-go-record]")?.addEventListener("click", () => {
        close();
        const target = exceptionTarget(item);
        navigate(target.page, target.params);
      });
    },
    onSubmit: async (values, { close }) => {
      if (values.action === "review") {
        await api.post(`/exceptions/${item.id}/review`, { comment: values.comment ?? "" });
        toast("Exception marked as reviewed.", "success");
      } else {
        await api.post(`/exceptions/${item.id}/close`, { resolution: values.comment ?? "" });
        toast("Exception closed.", "success");
      }
      close();
      onChanged?.();
    },
  });
}
