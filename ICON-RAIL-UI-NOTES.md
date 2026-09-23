# Icon-rail UI re-skin — what changed and why

## The situation
`sh-fari-ops.html` (the file you uploaded) is a **visual-only mockup**. It has
zero `fetch()` calls — everything renders from a hardcoded `SOURCE` object and
the file literally comments itself as "sample data... no financial postings
or live telemetry." It's a static twin of the design, not a build of the app.

The real repo (`SH-Fari-Ops-System`) already has all 12 modules **fully wired**
to the live Bun/Hono API — forms, validation, business rules, everything. That
part didn't need "wiring." So instead of rebuilding data flow from scratch
(which would throw away all the working logic), I re-skinned the real app's
shell with your new icon-rail design and left every page's data logic
untouched.

## Files changed
- `frontend/index.html` — old horizontal topnav + click-through subnav
  replaced with your icon-rail (60px) + labeled sidebar (190px) + topbar
  layout. Every element ID the JS depends on (`#profileButton`,
  `#bellButton`, `#globalSearch`, badges, etc.) was kept exactly as-is.
  Setup's 4 sub-tabs (stations/users/master/settings) moved from a global
  subnav into an in-page tab strip at the top of the Setup page, since
  `setup.js` depends on those tab elements existing.
- `frontend/js/core/router.js` — rewritten for flat single-level navigation
  (your sidebar has no group-then-subnav step). Adds mobile nav-toggle
  support. Verified nothing else in the codebase depended on the old
  two-level nav structure before removing it.
- `frontend/js/core/shell.js` — two added lines to populate the sidebar
  footer's user name/role.
- `frontend/css/app.css` — new navy (`#112E42`) / amber (`#EDB243`) tokens
  matching your palette, Inter font, and the icon-rail/sidebar/topbar CSS.
  Every shared component style (KPI cards, tables, panels, modals, badges,
  forms, toasts) was left untouched — pages already use those classes
  correctly, so they inherit the refreshed look automatically.

**Zero changes** to: `app.js`, `state.js`, `dom.js`, `ui.js`, `format.js`,
`filters.js`, `charts.js`, `exceptions.js`, the API client, or any of the 12
`pages/*.js` files. All the real business logic, validation, and API calls
are exactly as they were.

## Verification done
- HTML re-parsed with a strict tag-balance checker — 0 errors (also found and
  fixed a **pre-existing** stray `</div>` at the end of the Setup page that
  was in the original repo already, silently masked by an offsetting bug in
  the old topnav markup; browsers tolerated it, but it's now properly closed).
- All touched JS files pass `node --check` (syntax-valid ES modules).
- CSS brace-balanced (279 open / 279 close).
- Grepped the full `frontend/js` tree for leftover references to removed
  classes/ids (`.nav-btn`, `.main-nav`, `.topnav`, `#subnav-operations`,
  `#subnav-finance`, `.sub-badge`) — none found.
- No duplicate element IDs across the document (211 IDs, all unique).

## What I have not done
- Not run against a live backend (no DB in this sandbox) — I could not
  visually click through the app end-to-end. Structural/static checks all
  pass, but please smoke-test navigation, the Setup tabs, and mobile
  collapse (below ~1100px width) once deployed.
- Left the deeper per-page visual components (KPI cards, network overview,
  tank diagrams, etc. from your mockup) as the app's existing card/table
  style rather than porting the mockup's bespoke widgets 1:1 — those would
  require touching each page's JS, which risks the exact kind of mistake you
  asked me to avoid. Happy to do that page-by-page next if you want the
  deeper visual fidelity too.

## How to apply
Unzip `sh-fari-ops-frontend-icon-rail-ui.zip` over the repo's `frontend/`
folder (or apply `icon-rail-ui.patch` with `git apply icon-rail-ui.patch`
from the repo root), then deploy as usual.
