/**
 * ui.js — toasts, modals, forms, table states and pagination.
 *
 * Dynamic dialogs are declared as data (`fields`) and rendered with the
 * prototype's form-grid / field / input classes so they match the original
 * modals. Server validation errors (422 `fields`) appear beside matching inputs.
 */
import { $, $$, html, raw, setHtml } from "./dom.js";

const FOCUSABLE = "input:not([readonly]):not([type=hidden]):not([disabled]), select:not([disabled]), textarea";

/**
 * Focuses the first field shortly after a dialog opens — unless the user (or an
 * automated tool) has already put focus inside it, so typing is never redirected
 * into another field mid-word.
 */
function focusFirst(root) {
  setTimeout(() => {
    if (root.contains(document.activeElement)) return;
    root.querySelector(FOCUSABLE)?.focus();
  }, 30);
}

/* Toasts ------------------------------------------------------------------ */

export function toast(message, type = "info") {
  const host = $("#toastHost");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.textContent = message;
  host.appendChild(el);
  setTimeout(
    () => {
      el.style.opacity = "0";
      el.style.transition = "opacity .3s";
      setTimeout(() => el.remove(), 300);
    },
    type === "error" ? 5200 : 2800,
  );
}

export function toastError(err) {
  const ref = err?.status >= 500 && err?.requestId ? ` (ref ${String(err.requestId).slice(0, 8)})` : "";
  toast((err?.message || "Something went wrong.") + ref, "error");
}

/* Static modals (markup lives in index.html) ------------------------------- */

export function openModal(id) {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  clearFieldErrors(overlay);
  overlay.classList.add("show");
  focusFirst(overlay);
}

export function closeModal(id) {
  document.getElementById(id)?.classList.remove("show");
}

/* Busy state ----------------------------------------------------------------- */

export async function withBusy(button, fn) {
  if (!button) return fn();
  if (button.dataset.busy === "1") return undefined;
  button.dataset.busy = "1";
  button.disabled = true;
  const label = button.innerHTML;
  button.innerHTML = `<span class="spinner${button.classList.contains("btn-primary") || button.classList.contains("btn-danger") ? "" : " dark"}"></span>${label}`;
  try {
    return await fn();
  } finally {
    button.dataset.busy = "0";
    button.disabled = false;
    button.innerHTML = label;
  }
}

/* Forms ---------------------------------------------------------------------------- */

export function clearFieldErrors(root) {
  if (!root) return;
  $$(".field-error", root).forEach((e) => e.remove());
  $$(".invalid", root).forEach((e) => e.classList.remove("invalid"));
  $$(".form-error", root).forEach((b) => (b.hidden = true));
}

/** Shows an ApiError on a form: field messages beside inputs, the summary in the banner. */
export function showFieldErrors(root, err) {
  clearFieldErrors(root);
  let matched = false;
  for (const [name, message] of Object.entries(err?.fields ?? {})) {
    const input = root.querySelector(`[name="${CSS.escape(name)}"]`) || root.querySelector(`[name="${CSS.escape(name.split(".")[0])}"]`);
    if (!input) continue;
    matched = true;
    input.classList.add("invalid");
    const note = document.createElement("div");
    note.className = "field-error";
    note.textContent = message;
    (input.closest(".field") || input.parentElement).appendChild(note);
  }
  const banner = $(".form-error", root);
  if (banner) {
    banner.textContent = err?.message || "Please review the form.";
    banner.hidden = false;
  } else if (!matched) {
    toastError(err);
  }
}

/** Reads named controls: blanks are omitted, checkboxes become booleans, data-type="number" parses numbers. */
export function readForm(root) {
  const data = {};
  for (const el of $$("input[name], select[name], textarea[name]", root)) {
    if (el.disabled) continue;
    if (el.type === "checkbox") {
      if (el.dataset.group) {
        data[el.dataset.group] ??= [];
        if (el.checked) data[el.dataset.group].push(el.value);
      } else {
        data[el.name] = el.checked;
      }
      continue;
    }
    const value = el.value.trim();
    if (value === "") continue;
    data[el.name] = el.dataset.type === "number" ? Number(value.replace(/[₦,\s]/g, "").replace(/L$/i, "")) : value;
  }
  return data;
}

/** Wires a static <form> so submit → handler, with busy state and error display. */
export function bindForm(form, handler) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const overlay = form.closest(".overlay");
    const button = overlay?.querySelector(`[data-submit="${form.id}"]`) ?? form.querySelector("[type=submit]");
    clearFieldErrors(form);
    await withBusy(button, async () => {
      try {
        await handler(readForm(form), form);
      } catch (err) {
        if (err?.name === "ApiError") showFieldErrors(form, err);
        else {
          console.error(err);
          toast("Something went wrong in the page. Please reload and try again.", "error");
        }
      }
    });
  });
}

/* Dynamic form modal ------------------------------------------------------------ */

let dynamicHandler = null;

function fieldMarkup(f) {
  const span = f.span ? raw(' style="grid-column:span 2;"') : "";
  const hint = f.hint ? html`<div class="hint">${f.hint}</div>` : "";
  const common = html`name="${f.name}" ${f.readonly ? raw("readonly") : ""} ${f.disabled ? raw("disabled") : ""}`;

  switch (f.type) {
    case "html":
      return html`<div class="field"${span}>${f.label ? html`<label>${f.label}</label>` : ""}${f.content}</div>`;
    case "checkbox":
      return html`<div class="field"${span}><label class="check"><input type="checkbox" ${common} ${f.value ? raw("checked") : ""}> ${f.label}</label>${hint}</div>`;
    case "select": {
      const options = (f.options ?? []).map(
        (o) => html`<option value="${o.value}" ${String(o.value) === String(f.value ?? "") ? raw("selected") : ""}>${o.label}</option>`,
      );
      return html`<div class="field"${span}><label>${f.label}</label><select class="select" ${common}>${f.placeholder !== undefined ? html`<option value="">${f.placeholder}</option>` : ""}${options}</select>${hint}</div>`;
    }
    case "textarea":
      return html`<div class="field"${span}><label>${f.label}</label><textarea class="input" rows="3" ${common} placeholder="${f.placeholder ?? ""}">${f.value ?? ""}</textarea>${hint}</div>`;
    default: {
      const isNumber = f.type === "number";
      return html`<div class="field"${span}><label>${f.label}</label><input class="input" type="${isNumber ? "text" : (f.type ?? "text")}" ${common} ${isNumber ? raw('data-type="number" inputmode="decimal"') : ""} value="${f.value ?? ""}" placeholder="${f.placeholder ?? ""}" autocomplete="${f.autocomplete ?? "off"}">${hint}</div>`;
    }
  }
}

/**
 * Opens the shared dynamic modal. `onSubmit(values, { form, close })` may throw
 * an ApiError; its field errors are shown in the form.
 */
export function formModal({ title, intro, fields = [], submitLabel = "Save", onSubmit, wide = false, danger = false, onRender, cancelLabel = "Cancel", hideSubmit = false }) {
  const overlay = $("#dynamicModal");
  const modal = $(".modal", overlay);
  modal.classList.toggle("wide", wide);
  setHtml(
    modal,
    html`<div class="modal-head"><div class="modal-title">${title}</div><div class="modal-close" data-close-dynamic aria-label="Close">&times;</div></div>
      <form class="modal-body" novalidate>
        ${intro ? html`<div class="modal-intro">${intro}</div>` : ""}
        <div class="form-error" hidden></div>
        <div class="form-grid">${fields.map(fieldMarkup)}</div>
        <button type="submit" hidden></button>
      </form>
      <div class="modal-foot">
        <button class="btn" type="button" data-close-dynamic>${cancelLabel}</button>
        ${hideSubmit ? "" : html`<button class="btn ${danger ? "btn-danger" : "btn-primary"}" type="button" data-submit-dynamic>${submitLabel}</button>`}
      </div>`,
  );
  const form = $("form", modal);
  const close = () => {
    overlay.classList.remove("show");
    dynamicHandler = null;
  };
  dynamicHandler = async (button) => {
    if (!onSubmit) return close();
    clearFieldErrors(form);
    await withBusy(button, async () => {
      try {
        await onSubmit(readForm(form), { form, close });
      } catch (err) {
        if (err?.name === "ApiError") showFieldErrors(form, err);
        else {
          console.error(err);
          toast("Something went wrong in the page. Please reload and try again.", "error");
        }
      }
    });
  };
  overlay.classList.add("show");
  onRender?.(form, close);
  focusFirst(form);
  return { form, close };
}

export function initDynamicModal() {
  const overlay = $("#dynamicModal");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.closest("[data-close-dynamic]")) {
      overlay.classList.remove("show");
      dynamicHandler = null;
      return;
    }
    const submit = e.target.closest("[data-submit-dynamic]");
    if (submit && dynamicHandler) dynamicHandler(submit);
  });
  overlay.addEventListener("submit", (e) => {
    e.preventDefault();
    const submit = $("[data-submit-dynamic]", overlay);
    if (submit && dynamicHandler) dynamicHandler(submit);
  });
}

/** Reason-required confirmation (cancel, dispute, reopen, reject…). */
export function reasonModal({ title, intro, label = "Reason", submitLabel = "Confirm", danger = true, onSubmit, field = "reason" }) {
  return formModal({ title, intro, danger, submitLabel, fields: [{ name: field, label, type: "textarea", span: true }], onSubmit });
}

/** Read-only dialog with arbitrary (already escaped) markup. */
export function infoModal({ title, content, wide = true, onRender }) {
  return formModal({ title, wide, fields: [{ type: "html", name: "_", span: true, content }], hideSubmit: true, cancelLabel: "Close", onRender });
}

/* Table states ------------------------------------------------------------------- */

export function tableLoading(tbody, colspan) {
  setHtml(tbody, html`<tr class="state-row"><td colspan="${colspan}"><span class="spinner dark"></span>Loading…</td></tr>`);
}

export function tableEmpty(tbody, colspan, message = "No records found for these filters.") {
  setHtml(tbody, html`<tr class="state-row"><td colspan="${colspan}">${message}</td></tr>`);
}

export function tableError(tbody, colspan, err, retry) {
  setHtml(tbody, html`<tr class="state-row error"><td colspan="${colspan}">${err?.message || "Could not load data."} ${retry ? html`<button class="btn btn-xs" type="button" data-retry>Retry</button>` : ""}</td></tr>`);
  if (retry) tbody.querySelector("[data-retry]")?.addEventListener("click", retry, { once: true });
}

/** Renders rows (or the empty state) into a tbody. */
export function fillTable(tbody, colspan, rows, renderRow, empty) {
  if (!rows || rows.length === 0) tableEmpty(tbody, colspan, empty);
  else setHtml(tbody, html`${rows.map(renderRow)}`);
}

/** Fetches, then renders rows with loading/empty/error states. Returns the API payload or null. */
export async function loadTable(tbody, colspan, loader, renderRow, { empty } = {}) {
  tableLoading(tbody, colspan);
  try {
    const result = await loader();
    fillTable(tbody, colspan, Array.isArray(result) ? result : result.data, renderRow, empty);
    return result;
  } catch (err) {
    tableError(tbody, colspan, err, () => loadTable(tbody, colspan, loader, renderRow, { empty }));
    return null;
  }
}

/* Pagination ------------------------------------------------------------------------ */

export function renderPager(container, pagination, onPage) {
  if (!container) return;
  if (!pagination || pagination.total <= pagination.limit) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  container.hidden = false;
  const { page, totalPages, total, limit } = pagination;
  const from = (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  setHtml(
    container,
    html`<span class="pager-info">${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}</span>
      <button class="btn btn-xs" type="button" data-page-to="${page - 1}" ${page <= 1 ? raw("disabled") : ""}>‹ Prev</button>
      <span class="pager-info">Page ${page} of ${totalPages}</span>
      <button class="btn btn-xs" type="button" data-page-to="${page + 1}" ${page >= totalPages ? raw("disabled") : ""}>Next ›</button>`,
  );
  container.onclick = (e) => {
    const btn = e.target.closest("[data-page-to]");
    if (btn && !btn.disabled) onPage(Number(btn.dataset.pageTo));
  };
}
