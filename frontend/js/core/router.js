/**
 * router.js — page navigation for the single-page shell.
 *
 * Keeps the prototype's two-level navigation (group → sub page), adds hash URLs
 * (#truck, #setup/users) so refresh and back/forward work, hides pages the user
 * has no permission for, and initialises each page module once on first visit.
 */
import { $$ } from "./dom.js";
import { canAny } from "./state.js";
import { toastError } from "./ui.js";

const GROUPS = {
  dashboard: ["dashboard"],
  operations: ["truck", "dsr", "rtt", "stock", "git"],
  finance: ["cash", "debtors", "expenses"],
  reports: ["reports"],
  audit: ["audit"],
  setup: ["setup"],
};

const pages = new Map();
const initialising = new Map();
let current = null;

export function registerPage(module) {
  pages.set(module.id, module);
}

export function currentPage() {
  return current;
}

export function allowed(id) {
  const page = pages.get(id);
  if (!page) return false;
  const perms = [].concat(page.permission ?? []);
  return perms.length === 0 || canAny(...perms);
}

const groupOf = (id) => Object.keys(GROUPS).find((g) => GROUPS[g].includes(id));

export function firstAllowed(group) {
  return (group ? GROUPS[group] : Object.values(GROUPS).flat()).find(allowed) ?? null;
}

export function applyNavPermissions() {
  $$(".nav-btn").forEach((btn) => (btn.hidden = !firstAllowed(btn.dataset.group)));
  $$(".sub-btn").forEach((btn) => (btn.hidden = !allowed(btn.dataset.page)));
}

export async function navigate(id, params = {}, { updateHash = true } = {}) {
  if (!allowed(id)) id = firstAllowed();
  if (!id) return;
  const group = groupOf(id);

  $$(".nav-btn").forEach((n) => n.classList.toggle("active", n.dataset.group === group));
  $$(".subnav").forEach((s) => s.classList.toggle("show", s.id === `subnav-${group}`));
  $$(`#subnav-${group} .sub-btn:not([data-section])`).forEach((b) => b.classList.toggle("active", b.dataset.page === id));
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${id}`));

  if (updateHash) {
    const hash = `#${id}${params.section ? `/${params.section}` : ""}`;
    if (window.location.hash !== hash) history.pushState(null, "", hash);
  }

  const module = pages.get(id);
  current = module;
  window.scrollTo(0, 0);
  try {
    if (!initialising.has(id)) initialising.set(id, Promise.resolve(module.init?.()));
    await initialising.get(id);
    await module.load?.(params);
  } catch (err) {
    initialising.delete(id);
    console.error(err);
    toastError(err);
  }
}

function fromHash() {
  const [id, section] = decodeURIComponent(window.location.hash.slice(1)).split("/");
  const known = pages.has(id ?? "");
  navigate(known ? id : firstAllowed(), section ? { section } : {}, { updateHash: !known });
}

export function startRouter() {
  applyNavPermissions();
  document.querySelector(".main-nav").addEventListener("click", (e) => {
    const btn = e.target.closest(".nav-btn");
    if (btn) navigate(firstAllowed(btn.dataset.group));
  });
  $$(".subnav").forEach((nav) =>
    nav.addEventListener("click", (e) => {
      const btn = e.target.closest(".sub-btn");
      if (btn) navigate(btn.dataset.page, btn.dataset.section ? { section: btn.dataset.section } : {});
    }),
  );
  window.addEventListener("popstate", fromHash);
  fromHash();
}
