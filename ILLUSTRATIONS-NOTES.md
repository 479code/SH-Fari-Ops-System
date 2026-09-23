# Illustrations rework — always shown, overflow as extra detail

## What changed from last time
Per your feedback, the illustration eligibility gate is gone. It no longer
picks between "show the picture" OR "show a plain list" for a whole station.

**New behaviour, everywhere the illustration appears:**
- The picture always renders.
- It always shows real numbers on its fixed hotspots: up to 3 pumps, one PMS
  tank, one AGO tank — that's what the artwork itself has positions for.
- Anything beyond that (a 4th+ pump, a second tank of the same product, any
  other product) still shows — as a small real-numbers panel directly under
  the picture, not instead of it. Nothing is ever hidden or dropped; it's
  just laid out as a plain list once it's more than the picture's slots can
  hold.

Still nothing hardcoded — which pumps/tanks land on the picture vs. the
overflow list is decided live from the station's actual registered pumps and
tanks each time the page loads, so it stays correct as stations change.

## Dashboard — Station twin
Same illustration, same panel — just no longer an either/or. A station with
5 pumps now shows 3 on the picture and 2 in the overflow list underneath,
instead of losing the picture entirely.

## DSR — new pump illustration
Added the same station illustration to the Daily Sales Record page, above
the actual reading-entry form (which is unchanged — this is a visual summary
sitting alongside it, not a replacement for data entry). It shows today's
net sales on up to 3 pump hotspots, with any additional pumps in a compact
list below. This uses data already being loaded for the page (today's `/dsr/
day` readings) — no extra API calls.

I kept this pumps-only, matching what you asked for specifically — the tanks
and receiving bay in the picture sit undecorated on this page, since DSR is
about pump readings, not stock. Let me know if you'd like tank hotspots here
too for full parity with the Dashboard twin.

## Files touched this round
- `frontend/js/pages/dashboard.js` — illustration logic reworked (always
  show + overflow instead of eligible/ineligible branching)
- `frontend/js/pages/dsr.js` — new pump illustration above the reading form
- `frontend/css/app.css` — small additions: a compact `.dsr-canvas` variant,
  restyled `.station-plain` as a supplementary strip instead of a full
  replacement panel
- `frontend/index.html` — Dashboard's canvas is no longer conditionally
  hidden; DSR gained the canvas + overflow containers

## Verification done
- Same full pass as before: HTML re-validated with the strict tag-balance
  parser (0 errors), every touched JS file passes `node --check`, CSS
  brace-balanced, and every element ID both pages' JS references confirmed
  to exist in `index.html` (checked both directions programmatically).
- Every CSS class the updated JS generates confirmed defined in `app.css`.
- Not yet click-tested in a live browser — same caveat as last time. Worth
  specifically checking: a station with 4+ pumps (overflow list should
  appear under the Dashboard twin), and the DSR page for a station with
  exactly the pumps it has today.

## How to apply
Same as before: unzip `sh-fari-ops-illustrations.zip` over your local clone,
or `git apply illustrations.patch` (includes `--binary` again for the image
asset). Same CRLF note applies if you hit it again.
