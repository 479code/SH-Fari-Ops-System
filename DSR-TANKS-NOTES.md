# DSR gets tanks too — and the illustration logic is now shared

## What changed this round
Only 3 files actually changed (everything else in the zip is identical to
what you already pushed — safe to overwrite, `git status` will only show
these three):

- **`frontend/js/core/twin.js` (new file)** — the illustration rendering
  logic (hotspot splitting, pump/tank/receipt markup, the overflow panel)
  moved here from `dashboard.js`, so both pages call the same functions
  instead of maintaining two copies that could quietly drift apart. This is
  what "all illustrations should be maintained" means concretely — one place
  to fix or improve the illustration, both pages benefit.
- **`frontend/js/pages/dashboard.js`** — now imports from `twin.js` instead
  of defining its own copies. No behavior change here, just de-duplication.
- **`frontend/js/pages/dsr.js`** — the pump illustration now also shows tank
  hotspots (PMS/AGO, same as Dashboard), fetched via `/stock/movement` for
  that station's tanks. Same overflow treatment: a 4th+ pump or extra tank
  shows in the plain list underneath, same as Dashboard.

## Why a shared module, not a copy-paste
You asked that all illustrations stay maintained together. Two separate
copies of the same hotspot-splitting and rendering logic is exactly the kind
of thing that drifts — a bug fixed in one place stays broken in the other.
`twin.js` is now the single source of truth both pages call into.

## A small UX note on DSR
The tank hotspots load slightly after the pump ones and the reading form —
they need their own `/stock/movement` fetch, which the pump data doesn't.
The form itself is fully interactive immediately; the tank numbers on the
picture fill in a moment later. If you switch station or date while that's
still loading, the in-flight fetch is discarded rather than rendering a
mismatched station's numbers.

## Verification done
Same full pass as every round: all JS files pass `node --check`, HTML
re-validated with the strict tag-balance parser (0 errors), every element ID
both `dashboard.js` and `dsr.js` reference confirmed to exist in
`index.html` (both directions, both pages), and every CSS class either file
generates confirmed defined in `app.css`.

## How to apply
Same as always: unzip `sh-fari-ops-dsr-tanks.zip` over your local clone,
merging into `frontend/` and `context/`. Expect the same CRLF noise — same
fix: `git diff --ignore-space-at-eol --stat` to see what's real, then
`git checkout --` anything that isn't `frontend/js/core/twin.js`,
`frontend/js/pages/dashboard.js`, or `frontend/js/pages/dsr.js`.
