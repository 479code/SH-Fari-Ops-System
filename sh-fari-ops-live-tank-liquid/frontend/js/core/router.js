/**
 * router.js — page navigation for the single-page shell.
 *
 * Flat navigation: the icon-rail (shortcuts) and sidebar (.nav-item) both link
 * straight to a page id — there is no group->subnav click-through step. The one
 * exception is Setup, whose four sections (stations/users/master/settings) are
 * an in-page tab strip (#subnav-setup) rather than separate top-level pages.
 *
 * Adds hash URLs (#truck, #setup/users) so refresh and back/forward work, hides
 * pages/nav entries the user has no permission for, and initialises each page
 * module once on first visit.
 */
import { $$ } from "./dom.js";
import { canAny } from "./state.js";
import { toastError } from "./ui.js";

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

export function firstAllowed() {
  return [...pages.keys()].find(allowed) ?? null;
}

export function applyNavPermissions() {
  $$(".nav-item[data-page], .rail-button[data-page]").forEach((btn) => (btn.hidden = !allowed(btn.dataset.page)));
}

function closeMobileNav() {
  document.body.classList.remove("nav-open");
}

export async function navigate(id, params = {}, { updateHash = true } = {}) {
  if (!allowed(id)) id = firstAllowed();
  if (!id) return;

  $$(".nav-item[data-page]:not([data-section])").forEach((n) => n.classList.toggle("active", n.dataset.page === id));
  $$(".rail-button[data-page]").forEach((n) => n.classList.toggle("active", n.dataset.page === id));
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${id}`));
  closeMobileNav();

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
  $$(".sidebar-nav, .icon-rail").forEach((nav) =>
    nav.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-page]:not([data-section])");
      if (btn) navigate(btn.dataset.page);
    }),
  );
  // Setup's in-page section tabs (#subnav-setup) carry both data-page and
  // data-section; they stay a click-through pair handled here, same as before.
  $$(".subnav").forEach((nav) =>
    nav.addEventListener("click", (e) => {
      const btn = e.target.closest(".sub-btn");
      if (btn) navigate(btn.dataset.page, btn.dataset.section ? { section: btn.dataset.section } : {});
    }),
  );
  $$("#menuToggle").forEach((btn) =>
    btn.addEventListener("click", () => document.body.classList.toggle("nav-open")),
  );
  $$(".mobile-shade").forEach((shade) => shade.addEventListener("click", closeMobileNav));
  window.addEventListener("popstate", fromHash);
  fromHash();
}
