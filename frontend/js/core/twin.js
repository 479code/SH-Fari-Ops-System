/**
 * twin.js — shared "station illustration" rendering, used by both the
 * Dashboard twin panel and the DSR pump illustration so the two stay
 * consistent instead of drifting into two separately-maintained copies.
 *
 * The artwork has fixed hotspot positions: 3 pumps, one PMS tank, one AGO
 * tank. A station's real pumps/tanks are split into what fits those slots
 * (`shown*`) and whatever doesn't (`overflow*` — a 4th+ pump, a second tank
 * of the same product, any other product). The picture always renders with
 * real numbers on its slots; overflow is always shown too, just as a plain
 * list rather than forced onto a hotspot that doesn't exist for it.
 */
import { api } from "../api/client.js";
import { html, raw, setHtml } from "./dom.js";
import { pumpsFor, tanksFor } from "./filters.js";
import { number } from "./format.js";

const ICON_PATHS = {
  check: "M4 12l5 5L21 5",
  alert: "M12 3 2 21h20zM12 9v5M12 17v1",
};
const twinIcon = (name) => raw(`<svg class="ico" viewBox="0 0 24 24"><path d="${ICON_PATHS[name]}"/></svg>`);
export const signedNumber = (v) => `${v >= 0 ? "+" : ""}${number(v)}`;

export function stationScene(alt) {
  return html`<img class="station-scene" src="/assets/station-scene.jpg" alt="${alt}">`;
}

export function assetLabel(cls, name, value, extra = "") {
  return html`<div class="asset-label ${cls}"><span class="label-name">${name}</span><span class="label-value">${value}</span>${extra}</div>`;
}

export function tankVarianceBlock(movement) {
  if (!movement || movement.physicalDip === null || movement.physicalDip === undefined) {
    return html`<small>Awaiting today's dip</small>`;
  }
  const within = Math.abs(movement.variance) <= movement.tolerance;
  return html`<span class="reading-line"><span>System</span><b>${number(movement.closing)} L</b></span><span class="reading-line"><span>Dip</span><b>${number(movement.physicalDip)} L</b></span><span class="variance-label">${twinIcon(within ? "check" : "alert")}${within ? `Within ±${number(movement.tolerance)} L tolerance` : `${signedNumber(movement.variance)} L · Above tolerance`}</span>`;
}

/** Splits a station's real pumps and tanks into what the illustration's
 * fixed slots can show vs. what has to be listed separately. */
export function splitStationForIllustration(stationId) {
  const pumps = pumpsFor(stationId);
  const tanks = tanksFor(stationId)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const pms = tanks.find((t) => t.productCode === "PMS");
  const ago = tanks.find((t) => t.productCode === "AGO");
  const shownTanks = [pms, ago].filter(Boolean);
  const shownIds = new Set(shownTanks.map((t) => t.id));
  return {
    shownPumps: pumps.slice(0, 3),
    overflowPumps: pumps.slice(3),
    shownTanks,
    overflowTanks: tanks.filter((t) => !shownIds.has(t.id)),
  };
}

export function pumpHotspot(pump, index, reading) {
  const value = reading?.netSales != null ? `${number(reading.netSales)} L` : "—";
  return assetLabel(`pump-label p${index + 1}`, `${pump.name} · ${pump.productCode}`, value, reading ? "" : html`<small>No reading today</small>`);
}

export function tankHotspot(productCode, movement) {
  if (!movement) return "";
  const cls = productCode === "PMS" ? "tank-label pms" : "tank-label ago";
  return html`<div class="${cls}"><span class="label-name">${productCode} · ${movement.tankName ?? "Tank"}</span><span class="label-value">${number(movement.closing)} L</span>${tankVarianceBlock(movement)}</div>`;
}

export function receiptHotspot(receipt) {
  if (!receipt) return "";
  return assetLabel("receipt-label", receipt.waybillRef, `${number(receipt.quantity)} L ${receipt.productCode}`, html`<small class="green">✓ Verified receipt</small>`);
}

/** Builds the "beyond the fixed hotspots" panel markup, or null when there's
 * nothing to show — callers decide how to (un)hide their own container. */
export function overflowMarkup(overflowPumps, overflowTanks, { movementsByTankId = new Map(), pumpReadings = [] } = {}) {
  if (!overflowPumps.length && !overflowTanks.length) return null;
  const cards = [
    ...overflowTanks.map((t) => {
      const m = movementsByTankId.get(t.id);
      const noDip = !m || m.physicalDip === null || m.physicalDip === undefined;
      const within = !noDip && Math.abs(m.variance) <= m.tolerance;
      return html`<div class="plain-card"><label>${t.productCode} · ${t.name}</label><strong>${m ? `${number(m.closing)} L` : "—"}</strong><div class="hint">${noDip ? "Awaiting today's dip" : within ? "Within tolerance" : `${signedNumber(m.variance)} L variance`}</div></div>`;
    }),
    ...overflowPumps.map((p) => {
      const r = pumpReadings.find((x) => x.pumpName === p.name);
      return html`<div class="plain-card"><label>${p.name} · ${p.productCode}</label><strong>${r?.netSales != null ? `${number(r.netSales)} L` : "—"}</strong><div class="hint">Net sales today</div></div>`;
    }),
  ];
  return html`<div class="plain-note">Beyond the illustration's fixed hotspots:</div><div class="plain-grid">${cards}</div>`;
}

/** Convenience wrapper: sets the overflow panel's content and hidden state
 * on the given element in one call. */
export function renderOverflowInto(el, overflowPumps, overflowTanks, opts) {
  const markup = overflowMarkup(overflowPumps, overflowTanks, opts);
  el.hidden = !markup;
  if (markup) setHtml(el, markup);
}

/** Fetches `/stock/movement` for a set of tanks in parallel and indexes the
 * results by tank id and by product code (first match wins per product). */
export async function loadTankMovements(stationId, tanks, date) {
  const movements = await Promise.all(
    tanks.map((t) =>
      api
        .get("/stock/movement", { stationId, productId: t.productId, date })
        .then((r) => r.data)
        .catch(() => null),
    ),
  );
  const byTankId = new Map();
  const byProduct = new Map();
  tanks.forEach((t, i) => {
    if (!movements[i]) return;
    byTankId.set(t.id, movements[i]);
    if (!byProduct.has(t.productCode)) byProduct.set(t.productCode, movements[i]);
  });
  return { byTankId, byProduct };
}
