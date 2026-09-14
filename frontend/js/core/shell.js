/** shell.js — top-bar behaviour: profile menu, global search, exceptions bell and nav badges. */
import { api } from "../api/client.js";
import { $, debounce, html, setHtml } from "./dom.js";
import { date as fmtDate, initials } from "./format.js";
import { exceptionPill, openException } from "./exceptions.js";
import { navigate } from "./router.js";
import { can, state } from "./state.js";

const menus = ["#profileMenu", "#bellMenu", "#searchResults"];

function closeMenus(except) {
  for (const sel of menus) if (sel !== except) $(sel).hidden = true;
}

function toggle(sel) {
  const menu = $(sel);
  const open = menu.hidden;
  closeMenus(sel);
  menu.hidden = !open;
  return open;
}

export function setProfile(user) {
  $("#profileInitials").textContent = initials(user.fullName);
  // "Uthman M." → "Uthman"; "C. Nwachukwu" → "Nwachukwu" (skip bare initials).
  const parts = user.fullName.replace(/\./g, " ").split(/\s+/).filter(Boolean);
  $("#profileName").textContent = parts.find((p) => p.length > 2) ?? parts[0] ?? user.username;
  $("#menuName").textContent = user.fullName;
  $("#menuRole").textContent = `${user.roles.join(", ")} · ${user.stationName ?? "All stations"}`;
  $("#bellButton").hidden = !can("exceptions.view");
}

export async function refreshBadges() {
  try {
    const { data } = await api.get("/dashboard/badges");
    state.badges = data;
    const bell = $("#bellCount");
    bell.hidden = !can("exceptions.view") || data.openExceptions === 0;
    bell.textContent = data.openExceptions > 99 ? "99+" : String(data.openExceptions);

    const dsr = $("#badgeDsr");
    dsr.hidden = data.openDsrDays === 0;
    dsr.title = `${data.openDsrDays} business day(s) open`;
    const stock = $("#badgeStock");
    stock.hidden = data.stockExceptions === 0;
    stock.textContent = String(data.stockExceptions);
    const expenses = $("#badgeExpenses");
    expenses.hidden = data.pendingExpenses === 0 || !can("expenses.approve");
    expenses.textContent = String(data.pendingExpenses);
  } catch {
    // Badges are advisory; a failed refresh must not interrupt the user.
  }
}

async function openBell() {
  const menu = $("#bellMenu");
  if (!toggle("#bellMenu")) return;
  setHtml(menu, html`<div class="menu-head"><b>Exceptions requiring attention</b><span>Loading…</span></div>`);
  try {
    const res = await api.get("/exceptions", { status: "open", limit: 8 });
    setHtml(
      menu,
      html`<div class="menu-head"><b>Exceptions requiring attention</b><span>${res.pagination.total} open</span></div>
        ${res.data.length === 0 ? html`<div class="empty">Nothing needs attention right now.</div>` : ""}
        ${res.data.map(
          (item, i) => html`<div class="exception-row clickable" data-bell-index="${i}" style="padding:10px 11px">
            <div class="exc-body"><div class="exc-title">${item.title}</div><div class="exc-meta">${item.detail ?? ""}</div></div>${exceptionPill(item)}</div>`,
        )}
        ${can("dashboard.view") ? html`<div class="menu-item" data-bell-dashboard>Open dashboard</div>` : ""}`,
    );
    menu.onclick = (e) => {
      const row = e.target.closest("[data-bell-index]");
      if (row) {
        closeMenus();
        openException(res.data[Number(row.dataset.bellIndex)], refreshBadges);
      }
      if (e.target.closest("[data-bell-dashboard]")) {
        closeMenus();
        navigate("dashboard");
      }
    };
  } catch (err) {
    setHtml(menu, html`<div class="empty">${err.message}</div>`);
  }
}

function initSearch() {
  const input = $("#globalSearch");
  const results = $("#searchResults");
  let hits = [];

  const go = (hit) => {
    closeMenus();
    input.value = "";
    navigate(hit.page, { focus: hit });
  };

  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) {
      results.hidden = true;
      return;
    }
    try {
      const res = await api.get("/search", { q });
      hits = res.data;
      setHtml(
        results,
        hits.length === 0
          ? html`<div class="empty">No records match “${q}”.</div>`
          : html`${hits.map(
              (h, i) => html`<div class="search-hit${i === 0 ? " active" : ""}" data-hit="${i}"><b>${h.ref}</b> <span class="pill gray">${h.type}</span>
                <div>${h.label}${h.stationName ? ` · ${h.stationName}` : ""}${h.date ? ` · ${fmtDate(h.date)}` : ""}</div></div>`,
            )}`,
      );
      closeMenus("#searchResults");
      results.hidden = false;
    } catch (err) {
      setHtml(results, html`<div class="empty">${err.message}</div>`);
      results.hidden = false;
    }
  }, 300);

  input.addEventListener("input", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && hits[0] && !results.hidden) go(hits[0]);
    if (e.key === "Escape") closeMenus();
  });
  results.addEventListener("click", (e) => {
    const hit = e.target.closest("[data-hit]");
    if (hit) go(hits[Number(hit.dataset.hit)]);
  });
}

export function initShell({ onLogout, onChangePassword }) {
  $("#profileButton").addEventListener("click", () => toggle("#profileMenu"));
  $("#bellButton").addEventListener("click", openBell);
  $("#profileMenu").addEventListener("click", (e) => {
    const item = e.target.closest("[data-action]");
    if (!item) return;
    closeMenus();
    if (item.dataset.action === "logout") onLogout();
    if (item.dataset.action === "change-password") onChangePassword();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".menu-wrap")) closeMenus();
  });
  initSearch();
}
