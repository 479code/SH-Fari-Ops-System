/** Setup — stations/tanks/pumps, users & roles, narrations/products/prices/banks, control settings. */
import { api } from "../api/client.js";
import { $, $$, debounce, html, raw, setOptions } from "../core/dom.js";
import { date, dateTime, litres, naira, number, price, statusPill } from "../core/format.js";
import { can, canAny, loadLookups, state, today } from "../core/state.js";
import { bindForm, closeModal, fillTable, formModal, infoModal, loadTable, renderPager, tableEmpty, toast, toastError } from "../core/ui.js";

const SECTIONS = {
  stations: ["stations.view"],
  users: ["users.view", "roles.view"],
  master: ["narrations.manage", "products.manage", "banks.manage", "stations.view", "expenses.view", "cash.view"],
  settings: ["settings.manage"],
};

let section = "stations";
let userPage = 1;
let stations = [];
let users = [];
let roles = [];
let products = [];
let narrations = [];
let banks = [];

const statusOptions = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

async function refreshLookups() {
  try {
    await loadLookups();
  } catch {
    // Dropdowns refresh on the next page load.
  }
}

const userOptions = () => (state.lookups?.users ?? []).filter((u) => u.status === "active").map((u) => ({ value: u.id, label: u.fullName }));
const productChoices = () => (state.lookups?.products ?? []).map((p) => ({ value: p.id, label: `${p.code} — ${p.name}` }));

/* Stations ----------------------------------------------------------------------------------- */

function stationRow(s) {
  return html`<tr class="clickable" data-station-id="${s.id}"><td class="strong">${s.name} <span class="muted small">${s.code}</span></td><td>${s.managerName ?? "Unassigned"}</td>
    <td class="num">${number(s.pumpCount)}</td><td>${s.products ?? "—"}</td><td class="num">${naira(s.cashTolerance)}</td><td class="num">±${number(s.stockTolerance)}L</td><td>${statusPill(s.status)}</td></tr>`;
}

async function loadStations() {
  const res = await loadTable($("#stationsBody"), 7, () => api.get("/stations"), stationRow, { empty: "No stations registered yet." });
  stations = res?.data ?? [];
}

async function afterStationChange(stationId, message) {
  toast(message, "success");
  await Promise.all([loadStations(), refreshLookups()]);
  if (stationId) openStation(stationId);
}

async function openStation(id) {
  let s;
  try {
    s = (await api.get(`/stations/${id}`)).data;
  } catch (err) {
    toastError(err);
    return;
  }
  const manage = can("stations.manage");
  infoModal({
    title: `${s.name} (${s.code})`,
    content: html`<div class="kv" style="padding:0 0 12px">
        <span>Manager</span><span>${s.managerName ?? "Unassigned"}</span>
        <span>Address</span><span>${s.address ?? "—"}</span>
        <span>Cash tolerance</span><span>${naira(s.cashTolerance)}</span>
        <span>Stock tolerance</span><span>±${number(s.stockTolerance)} L</span>
        <span>Status</span><span>${statusPill(s.status)}</span>
      </div>
      ${manage ? html`<div class="feature-actions" style="padding:0 0 14px"><button class="btn btn-xs" type="button" data-st="edit">Edit station</button><button class="btn btn-xs" type="button" data-st="tank">+ Tank</button><button class="btn btn-xs btn-primary" type="button" data-st="pump">+ Pump</button></div>` : ""}
      <div class="panel-title" style="margin:4px 0 8px">Tanks</div>
      <div class="table-wrap"><table><thead><tr><th class="strong">Tank</th><th>Product</th><th class="num">Balance (L)</th><th class="num">Capacity (L)</th><th>Status</th><th></th></tr></thead><tbody>
        ${s.tanks.length ? s.tanks.map((t) => html`<tr><td class="strong">${t.name}</td><td>${t.productCode}</td><td class="num">${litres(t.balance)}</td><td class="num">${t.capacity ? number(t.capacity) : "—"}</td><td>${statusPill(t.status)}</td><td class="actions-cell">${manage ? html`<button class="btn btn-xs" type="button" data-tank="${t.id}">Edit</button>` : ""}</td></tr>`) : html`<tr class="state-row"><td colspan="6">No tanks yet.</td></tr>`}
      </tbody></table></div>
      <div class="panel-title" style="margin:16px 0 8px">Pumps</div>
      <div class="table-wrap"><table><thead><tr><th class="strong">Pump</th><th>Tank / product</th><th>Meter</th><th class="num">Initial reading</th><th>Status</th><th></th></tr></thead><tbody>
        ${s.pumps.length ? s.pumps.map((p) => html`<tr><td class="strong">${p.name}</td><td>${p.tankName} (${p.productCode})</td><td>${p.meterLabel ?? "—"}</td><td class="num">${litres(p.initialReading)}</td><td>${statusPill(p.status)}</td><td class="actions-cell">${manage ? html`<button class="btn btn-xs" type="button" data-pump="${p.id}">Edit</button>` : ""}</td></tr>`) : html`<tr class="state-row"><td colspan="6">No pumps yet.</td></tr>`}
      </tbody></table></div>`,
    onRender: (form, close) => {
      form.addEventListener("click", (e) => {
        const action = e.target.closest("[data-st]")?.dataset.st;
        const tankId = e.target.closest("[data-tank]")?.dataset.tank;
        const pumpId = e.target.closest("[data-pump]")?.dataset.pump;
        if (!action && !tankId && !pumpId) return;
        close();
        if (action === "edit") stationDialog(s);
        if (action === "tank") tankDialog(s);
        if (action === "pump") pumpDialog(s);
        if (tankId) tankDialog(s, s.tanks.find((t) => String(t.id) === tankId));
        if (pumpId) pumpDialog(s, s.pumps.find((p) => String(p.id) === pumpId));
      });
    },
  });
}

function stationDialog(s) {
  formModal({
    title: `Edit ${s.name}`,
    fields: [
      { name: "name", label: "Station name", value: s.name },
      { name: "managerUserId", label: "Manager", type: "select", value: s.managerUserId ?? "", placeholder: "Unassigned", options: userOptions() },
      { name: "cashTolerance", label: "Cash tolerance (₦)", type: "number", value: s.cashTolerance },
      { name: "stockTolerance", label: "Stock tolerance (±L)", type: "number", value: s.stockTolerance },
      { name: "address", label: "Address", value: s.address ?? "" },
      { name: "status", label: "Status", type: "select", value: s.status, options: statusOptions },
    ],
    onSubmit: async (values, { close }) => {
      await api.patch(`/stations/${s.id}`, { ...values, managerUserId: values.managerUserId ? Number(values.managerUserId) : null });
      close();
      afterStationChange(s.id, "Station updated.");
    },
  });
}

function tankDialog(s, tank) {
  formModal({
    title: tank ? `Edit ${tank.name}` : `Register tank — ${s.name}`,
    intro: tank ? undefined : "Opening stock is posted to the ledger as the tank's opening balance on the chosen date.",
    fields: tank
      ? [
          { name: "name", label: "Tank name", value: tank.name },
          { name: "capacity", label: "Capacity (L)", type: "number", value: tank.capacity ?? "" },
          { name: "status", label: "Status", type: "select", value: tank.status, options: statusOptions },
        ]
      : [
          { name: "productId", label: "Product", type: "select", placeholder: "Select product", options: productChoices() },
          { name: "name", label: "Tank name", placeholder: "PMS Tank 1" },
          { name: "capacity", label: "Capacity (L)", type: "number", placeholder: "Optional" },
          { name: "openingStock", label: "Opening stock (L)", type: "number", placeholder: "0" },
          { name: "openingDate", label: "Opening stock date", type: "date", value: today() },
        ],
    onSubmit: async (values, { close }) => {
      if (tank) await api.patch(`/tanks/${tank.id}`, values);
      else await api.post(`/stations/${s.id}/tanks`, values);
      close();
      afterStationChange(s.id, tank ? "Tank updated." : "Tank registered.");
    },
  });
}

function pumpDialog(s, pump) {
  const tanks = s.tanks.filter((t) => t.status === "active").map((t) => ({ value: t.id, label: `${t.name} (${t.productCode})` }));
  if (!pump && tanks.length === 0) {
    toast("Register a tank before adding pumps.", "error");
    openStation(s.id);
    return;
  }
  formModal({
    title: pump ? `Edit ${pump.name}` : `Register pump — ${s.name}`,
    fields: [
      { name: "tankId", label: "Draws from tank", type: "select", value: pump?.tankId ?? "", options: tanks },
      { name: "name", label: "Pump name", value: pump?.name ?? "", placeholder: "Pump 5" },
      { name: "meterLabel", label: "Meter label", value: pump?.meterLabel ?? "", placeholder: "Meter A" },
      { name: "initialReading", label: "Initial meter reading", type: "number", value: pump?.initialReading ?? "", hint: "Opening reading for the pump's first DSR. Cannot change after the pump is used." },
      ...(pump ? [{ name: "status", label: "Status", type: "select", value: pump.status, options: statusOptions }] : []),
    ],
    onSubmit: async (values, { close }) => {
      if (pump) await api.patch(`/pumps/${pump.id}`, values);
      else await api.post(`/stations/${s.id}/pumps`, values);
      close();
      afterStationChange(s.id, pump ? "Pump updated." : "Pump registered.");
    },
  });
}

/* Users & roles ------------------------------------------------------------------------------ */

function userRow(u) {
  const actions = can("users.manage")
    ? html`<div class="row-actions"><button class="btn btn-xs" data-user="edit" data-id="${u.id}">Edit</button><button class="btn btn-xs" data-user="reset" data-id="${u.id}">Reset link</button>${u.locked ? html`<button class="btn btn-xs" data-user="unlock" data-id="${u.id}">Unlock</button>` : ""}</div>`
    : "";
  return html`<tr><td class="strong">${u.fullName} <span class="muted small">${u.username}</span></td><td style="white-space:normal">${u.roles ?? "—"}</td><td>${u.stationName ?? "All"}</td>
    <td>${statusPill(u.status)}${u.locked ? html` <span class="pill red">Locked</span>` : ""}${u.mustChangePassword ? html` <span class="pill amber">Temp password</span>` : ""}</td><td class="actions-cell">${actions}</td></tr>`;
}

function roleRow(r) {
  const actions = can("roles.manage")
    ? html`<div class="row-actions"><button class="btn btn-xs" data-role="edit" data-id="${r.id}">Edit</button>${!r.isSystem && r.userCount === 0 ? html`<button class="btn btn-xs" data-role="delete" data-id="${r.id}">Delete</button>` : ""}</div>`
    : "";
  return html`<tr><td class="strong">${r.name}${r.isSystem ? html` <span class="pill gray">System</span>` : ""}</td><td class="num">${number(r.userCount)}</td><td class="num">${number(r.permissions.length)}</td><td class="actions-cell">${actions}</td></tr>`;
}

async function loadUserList() {
  if (!can("users.view")) {
    tableEmpty($("#usersBody"), 5, "Your role cannot view users.");
    return;
  }
  const res = await loadTable($("#usersBody"), 5, () => api.get("/users", { search: $("#userSearch").value.trim(), page: userPage, limit: 15 }), userRow, { empty: "No users found." });
  if (!res) return;
  users = res.data;
  renderPager($("#usersPager"), res.pagination, (p) => {
    userPage = p;
    loadUserList();
  });
}

async function loadRoles() {
  if (!can("roles.view")) {
    tableEmpty($("#rolesBody"), 4, "Your role cannot view roles.");
    return;
  }
  const res = await loadTable($("#rolesBody"), 4, () => api.get("/roles"), roleRow, { empty: "No roles." });
  roles = res?.data ?? [];
}

const loadUsers = () => Promise.all([loadUserList(), loadRoles()]);

async function userDialog(user) {
  const roleList = roles.length ? roles : state.lookups?.roles ?? [];
  const checks = html`<div class="perm-grid">${roleList.map((r) => html`<label class="check"><input type="checkbox" name="role-${r.id}" data-group="roleIds" value="${r.id}" ${user?.roleIds.includes(r.id) ? raw("checked") : ""}> ${r.name}</label>`)}</div>`;
  const stationField = { name: "stationId", label: "Station access", type: "select", value: user?.stationId ?? "", placeholder: "All stations", options: (state.lookups?.stations ?? []).map((s) => ({ value: s.id, label: s.name })) };
  formModal({
    title: user ? `Edit ${user.fullName}` : "New user",
    intro: user ? undefined : "The user signs in with this temporary password and must change it immediately.",
    wide: true,
    fields: [
      ...(user ? [] : [{ name: "username", label: "Username", placeholder: "c.nwachukwu" }]),
      { name: "fullName", label: "Full name", value: user?.fullName ?? "" },
      { name: "email", label: "Email", type: "email", value: user?.email ?? "", placeholder: "Optional" },
      { name: "phone", label: "Phone", value: user?.phone ?? "", placeholder: "Optional" },
      stationField,
      ...(user
        ? [{ name: "status", label: "Status", type: "select", value: user.status, options: [{ value: "active", label: "Active" }, { value: "suspended", label: "Suspended" }] }]
        : [{ name: "password", label: "Temporary password", type: "password", autocomplete: "new-password", hint: "At least 10 characters with letters and numbers." }]),
      { type: "html", name: "roleIds", label: "Roles", span: true, content: checks },
    ],
    onSubmit: async (values, { close }) => {
      const body = { ...values, roleIds: (values.roleIds ?? []).map(Number), stationId: values.stationId ? Number(values.stationId) : null };
      const res = user ? await api.patch(`/users/${user.id}`, body) : await api.post("/users", body);
      close();
      toast(res.message, "success");
      loadUsers();
      refreshLookups();
    },
  });
}

async function resetLink(user) {
  try {
    const res = await api.post(`/users/${user.id}/password-reset`);
    const link = `${window.location.origin}${window.location.pathname}#reset=${res.data.token}`;
    infoModal({
      title: `Password reset link — ${user.fullName}`,
      content: html`<div class="modal-intro">Share this single-use link with ${user.fullName} through a trusted channel. It expires ${dateTime(res.data.expiresAt)} and will not be shown again. Any earlier link stops working.</div>
        <div class="secret-box" data-link>${link}</div><div style="margin-top:10px"><button class="btn btn-xs" type="button" data-copy>Copy link</button></div>`,
      onRender: (form) =>
        form.querySelector("[data-copy]").addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(link);
            toast("Link copied.", "success");
          } catch {
            toast("Copy failed — select the link and copy it manually.", "error");
          }
        }),
    });
  } catch (err) {
    toastError(err);
  }
}

async function roleDialog(role) {
  let catalogue;
  try {
    catalogue = (await api.get("/roles/permissions")).data;
  } catch (err) {
    toastError(err);
    return;
  }
  const matrix = html`<div class="perm-grid">${catalogue.map(
    (group) => html`<div class="perm-group"><h4>${group.module}</h4>${group.permissions.map(
      (p) => html`<label><input type="checkbox" name="perm-${p.code}" data-group="permissions" value="${p.code}" ${role?.permissions.includes(p.code) ? raw("checked") : ""}><span>${p.description}<br><code>${p.code}</code></span></label>`,
    )}</div>`,
  )}</div>`;
  formModal({
    title: role ? `Edit role — ${role.name}` : "New role",
    wide: true,
    intro: role?.isSystem ? "System roles cannot be renamed or deleted, but their permissions can be adjusted." : undefined,
    fields: [
      { name: "name", label: "Role name", value: role?.name ?? "", readonly: role?.isSystem },
      { name: "description", label: "Description", value: role?.description ?? "" },
      { type: "html", name: "permissions", label: "Permissions", span: true, content: matrix },
    ],
    onSubmit: async (values, { close }) => {
      const body = { name: values.name, description: values.description, permissions: values.permissions ?? [] };
      const res = role ? await api.patch(`/roles/${role.id}`, body) : await api.post("/roles", body);
      close();
      toast(res.message, "success");
      loadRoles();
      refreshLookups();
    },
  });
}

/* Master data ---------------------------------------------------------------------------------- */

async function loadNarrations() {
  if (!canAny("narrations.manage", "expenses.view")) return tableEmpty($("#narrationsBody"), 4, "Not available for your role.");
  const res = await loadTable(
    $("#narrationsBody"),
    4,
    () => api.get("/narrations"),
    (n) => html`<tr><td class="strong">${n.name}</td><td>${n.approvalThreshold === null ? "No approval" : naira(n.approvalThreshold)}</td><td>${statusPill(n.status)}</td>
      <td class="actions-cell">${can("narrations.manage") ? html`<button class="btn btn-xs" data-narration="${n.id}">Edit</button>` : ""}</td></tr>`,
    { empty: "The narration list is empty." },
  );
  narrations = res?.data ?? [];
}

async function loadProducts() {
  if (!canAny("products.manage", "stations.view")) return tableEmpty($("#productsBody"), 5, "Not available for your role.");
  const res = await loadTable(
    $("#productsBody"),
    5,
    () => api.get("/products"),
    (p) => html`<tr><td class="strong">${p.code} <span class="muted small">${p.name}</span></td><td class="num">${p.defaultPrice === null ? "Not set" : price(p.defaultPrice)}</td>
      <td>${p.priceEffectiveFrom ? date(p.priceEffectiveFrom) : "—"}${p.stationOverrides ? ` · ${p.stationOverrides} station override(s)` : ""}</td><td>${statusPill(p.status)}</td>
      <td class="actions-cell"><div class="row-actions">${can("products.manage") ? html`<button class="btn btn-xs btn-primary" data-product="price" data-id="${p.id}">Set price</button>` : ""}<button class="btn btn-xs" data-product="history" data-id="${p.id}">History</button>${can("products.manage") ? html`<button class="btn btn-xs" data-product="edit" data-id="${p.id}">Edit</button>` : ""}</div></td></tr>`,
    { empty: "No products." },
  );
  products = res?.data ?? [];
}

async function loadBanks() {
  if (!canAny("banks.manage", "cash.view")) return tableEmpty($("#banksBody"), 3, "Not available for your role.");
  const res = await loadTable(
    $("#banksBody"),
    3,
    () => api.get("/banks"),
    (b) => html`<tr><td class="strong">${b.name}</td><td>${statusPill(b.status)}</td><td class="actions-cell">${can("banks.manage") ? html`<button class="btn btn-xs" data-bank="${b.id}">Edit</button>` : ""}</td></tr>`,
    { empty: "No banks registered." },
  );
  banks = res?.data ?? [];
}

const loadMaster = () => Promise.all([loadNarrations(), loadProducts(), loadBanks()]);

function narrationDialog(n) {
  formModal({
    title: n ? `Edit narration — ${n.name}` : "Add narration",
    fields: [
      { name: "name", label: "Narration", value: n?.name ?? "", placeholder: "Generator diesel" },
      { name: "approvalThreshold", label: "Approval threshold (₦)", type: "number", value: n?.approvalThreshold ?? "", hint: "Expenses above this amount need approval." },
      { name: "noApproval", label: "No approval required", type: "checkbox", value: n ? n.approvalThreshold === null : false },
      ...(n ? [{ name: "status", label: "Status", type: "select", value: n.status, options: statusOptions }] : []),
    ],
    onSubmit: async (values, { close }) => {
      const { noApproval, ...body } = values;
      if (noApproval) body.approvalThreshold = null;
      const res = n ? await api.patch(`/narrations/${n.id}`, body) : await api.post("/narrations", body);
      close();
      toast(res.message, "success");
      loadNarrations();
      refreshLookups();
    },
  });
}

function productDialog(p) {
  formModal({
    title: p ? `Edit ${p.code}` : "Add product",
    fields: p
      ? [
          { name: "name", label: "Product name", value: p.name },
          { name: "status", label: "Status", type: "select", value: p.status, options: statusOptions },
        ]
      : [
          { name: "code", label: "Code", placeholder: "DPK" },
          { name: "name", label: "Product name", placeholder: "Dual Purpose Kerosene" },
          { name: "price", label: "Default pump price (₦)", type: "number", placeholder: "Optional" },
          { name: "effectiveFrom", label: "Price effective from", type: "date", value: today() },
        ],
    onSubmit: async (values, { close }) => {
      const res = p ? await api.patch(`/products/${p.id}`, values) : await api.post("/products", values);
      close();
      toast(res.message, "success");
      loadProducts();
      refreshLookups();
    },
  });
}

function priceDialog(p) {
  formModal({
    title: `Set pump price — ${p.code}`,
    intro: "Prices are effective-dated. Closed DSR days keep the price they were locked with; the new price applies to days from its effective date.",
    fields: [
      { name: "stationId", label: "Applies to", type: "select", placeholder: "All stations (default)", options: (state.lookups?.stations ?? []).map((s) => ({ value: s.id, label: s.name })) },
      { name: "price", label: "Pump price (₦/L)", type: "number", placeholder: "678.00" },
      { name: "effectiveFrom", label: "Effective from", type: "date", value: today() },
    ],
    onSubmit: async (values, { close }) => {
      const res = await api.post(`/products/${p.id}/prices`, { ...values, stationId: values.stationId ? Number(values.stationId) : null });
      close();
      toast(res.message, "success");
      loadProducts();
    },
  });
}

async function priceHistory(p) {
  try {
    const { data } = await api.get(`/products/${p.id}/prices`);
    infoModal({
      title: `Price history — ${p.code}`,
      content: html`<div class="table-wrap"><table><thead><tr><th class="strong">Effective from</th><th>Applies to</th><th class="num">Price</th><th>Set by</th><th>Recorded</th></tr></thead><tbody>
        ${data.length ? data.map((r) => html`<tr><td class="strong">${date(r.effectiveFrom)}</td><td>${r.stationName ?? "All stations"}</td><td class="num">${price(r.price)}</td><td>${r.createdByName ?? "—"}</td><td>${dateTime(r.createdAt)}</td></tr>`) : html`<tr class="state-row"><td colspan="5">No prices set.</td></tr>`}
        </tbody></table></div>`,
    });
  } catch (err) {
    toastError(err);
  }
}

function bankDialog(b) {
  formModal({
    title: b ? `Edit ${b.name}` : "Add bank",
    fields: [{ name: "name", label: "Bank name", value: b?.name ?? "" }, ...(b ? [{ name: "status", label: "Status", type: "select", value: b.status, options: statusOptions }] : [])],
    onSubmit: async (values, { close }) => {
      const res = b ? await api.patch(`/banks/${b.id}`, values) : await api.post("/banks", values);
      close();
      toast(res.message, "success");
      loadBanks();
      refreshLookups();
    },
  });
}

/* Settings ---------------------------------------------------------------------------------------- */

async function loadSettings() {
  const form = $("#settingsForm");
  try {
    const { data } = await api.get("/settings");
    form.allowNegativeStock.checked = data.allowNegativeStock;
    form.gitDelayDays.value = data.gitDelayDays;
    form.gitShortageToleranceLitres.value = data.gitShortageToleranceLitres;
    form.debtorAgingAlertDays.value = data.debtorAgingAlertDays;
    $$("input", form).forEach((i) => (i.disabled = !can("settings.manage")));
  } catch (err) {
    toastError(err);
  }
}

/* Page ------------------------------------------------------------------------------------------------- */

const LOADERS = { stations: loadStations, users: loadUsers, master: loadMaster, settings: loadSettings };
const sectionAllowed = (name) => canAny(...SECTIONS[name]);

export default {
  id: "setup",
  permission: [...new Set(Object.values(SECTIONS).flat().filter((p) => !["expenses.view", "cash.view"].includes(p)))],

  init() {
    $$("#subnav-setup .sub-btn").forEach((b) => (b.hidden = !sectionAllowed(b.dataset.section)));

    $("#stationsBody").addEventListener("click", (e) => {
      const tr = e.target.closest("[data-station-id]");
      if (tr) openStation(Number(tr.dataset.stationId));
    });
    bindForm($("#formStation"), async (values) => {
      const res = await api.post("/stations", { ...values, managerUserId: values.managerUserId ? Number(values.managerUserId) : null });
      closeModal("modalStation");
      afterStationChange(res.data.id, res.message);
    });

    $("#userSearch").addEventListener(
      "input",
      debounce(() => {
        userPage = 1;
        loadUserList();
      }, 350),
    );
    $("#usersBody").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-user]");
      if (!btn) return;
      const user = users.find((u) => u.id === Number(btn.dataset.id));
      if (btn.dataset.user === "edit") userDialog(user);
      if (btn.dataset.user === "reset") resetLink(user);
      if (btn.dataset.user === "unlock") {
        try {
          const res = await api.post(`/users/${user.id}/unlock`);
          toast(res.message, "success");
          loadUserList();
        } catch (err) {
          toastError(err);
        }
      }
    });
    $("#rolesBody").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-role]");
      if (!btn) return;
      const role = roles.find((r) => r.id === Number(btn.dataset.id));
      if (btn.dataset.role === "edit") roleDialog(role);
      if (btn.dataset.role === "delete") {
        formModal({
          title: `Delete role ${role.name}?`,
          intro: "The role has no users. This cannot be undone.",
          danger: true,
          submitLabel: "Delete role",
          onSubmit: async (_v, { close }) => {
            const res = await api.delete(`/roles/${role.id}`);
            close();
            toast(res.message, "success");
            loadRoles();
          },
        });
      }
    });

    $("#narrationsBody").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-narration]");
      if (btn) narrationDialog(narrations.find((n) => n.id === Number(btn.dataset.narration)));
    });
    $("#productsBody").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-product]");
      if (!btn) return;
      const product = products.find((p) => p.id === Number(btn.dataset.id));
      ({ price: priceDialog, history: priceHistory, edit: productDialog })[btn.dataset.product](product);
    });
    $("#banksBody").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-bank]");
      if (btn) bankDialog(banks.find((b) => b.id === Number(btn.dataset.bank)));
    });

    bindForm($("#settingsForm"), async (values) => {
      const res = await api.put("/settings", {
        allowNegativeStock: Boolean(values.allowNegativeStock),
        gitDelayDays: values.gitDelayDays,
        gitShortageToleranceLitres: values.gitShortageToleranceLitres,
        debtorAgingAlertDays: values.debtorAgingAlertDays,
      });
      toast(res.message, "success");
      refreshLookups();
    });
  },

  async load(params = {}) {
    section = params.section ?? section;
    if (!sectionAllowed(section)) section = Object.keys(SECTIONS).find(sectionAllowed) ?? "stations";
    $$("#subnav-setup .sub-btn").forEach((b) => b.classList.toggle("active", b.dataset.section === section));
    $$("[data-setup-section]").forEach((el) => (el.hidden = el.dataset.setupSection !== section));
    $$("#setupActions [data-section-action]").forEach((b) => {
      b.hidden = b.dataset.sectionAction !== section || Boolean(b.dataset.permission && !can(b.dataset.permission));
    });
    await LOADERS[section]();
  },

  actions: {
    "new-user": () => (roles.length ? userDialog() : loadRoles().then(() => userDialog())),
    "new-role": () => roleDialog(),
    "new-narration": () => narrationDialog(),
    "new-product": () => productDialog(),
    "new-bank": () => bankDialog(),
  },

  modals: {
    modalStation() {
      $("#formStation").reset();
      setOptions($("#stManager"), userOptions(), { value: "value", label: "label", placeholder: "Assign later" });
    },
  },
};
