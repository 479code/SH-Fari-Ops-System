/** Audit trail — filterable, paginated history with before/after values and CSV export. */
import { api } from "../api/client.js";
import { $, debounce, html, setOptions } from "../core/dom.js";
import { actionPill, auditValue, dateTime } from "../core/format.js";
import { state, today } from "../core/state.js";
import { loadTable, renderPager, toast, toastError } from "../core/ui.js";

const COLS = 6;
let page = 1;

const truncate = (text, max = 70) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function renderRow(r) {
  const oldText = auditValue(r.oldValue);
  const newText = auditValue(r.newValue);
  return html`<tr>
    <td class="strong mono-tag">${dateTime(r.createdAt)}</td>
    <td>${r.userName}</td>
    <td>${actionPill(r.action)}</td>
    <td><span class="mono-tag">${r.recordRef ?? (r.resourceId ? `#${r.resourceId}` : "—")}</span> <span class="muted small">${r.resource.replaceAll("_", " ")}</span></td>
    <td title="${oldText}">${truncate(oldText)}</td>
    <td title="${newText}">${truncate(newText)}</td></tr>`;
}

const filters = () => ({
  action: $("#auditAction").value,
  userId: $("#auditUser").value,
  search: $("#auditSearch").value.trim(),
  from: $("#auditFrom").value,
  to: $("#auditTo").value,
});

async function load() {
  const res = await loadTable($("#auditBody"), COLS, () => api.get("/audit", { ...filters(), page, limit: 25 }), renderRow, { empty: "No audit entries match these filters." });
  if (res) {
    renderPager($("#auditPager"), res.pagination, (p) => {
      page = p;
      load();
    });
  }
}

const reload = () => {
  page = 1;
  load();
};

export default {
  id: "audit",
  permission: "audit.view",

  async init() {
    setOptions($("#auditUser"), state.lookups?.users ?? [], { label: "fullName", placeholder: "All users" });
    $("#auditFrom").max = today();
    $("#auditTo").max = today();
    try {
      const { data } = await api.get("/audit/facets");
      setOptions($("#auditAction"), data.actions.map((a) => ({ id: a, name: a.replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase()) })), { placeholder: "All actions" });
    } catch (err) {
      setOptions($("#auditAction"), [], { placeholder: "All actions" });
      toastError(err);
    }
    for (const id of ["#auditAction", "#auditUser", "#auditFrom", "#auditTo"]) $(id).addEventListener("change", reload);
    $("#auditSearch").addEventListener("input", debounce(reload, 350));
  },

  async load() {
    await load();
  },

  actions: {
    "audit-export": async (button) => {
      button.disabled = true;
      try {
        await api.download("/audit/export", filters(), "audit-trail.csv");
        toast("Audit trail exported.", "success");
      } catch (err) {
        toastError(err);
      } finally {
        button.disabled = false;
      }
    },
  },
};
