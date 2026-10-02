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
 *
 * Tank visualisation: a self-contained SVG (not a photo overlay), so it's
 * never at risk of drifting out of alignment at any screen size. Level is
 * drawn against an auto "indicative scale" (the smallest round multiple of
 * 50,000 L above the current stock/dip figures) rather than tank capacity —
 * capacity isn't reliably known for every tank, and a scale that always
 * leaves headroom reads better than a bar that can peg at 100%.
 */
import { api } from "../api/client.js";
import { html, raw, setHtml } from "./dom.js";
import { pumpsFor, tanksFor } from "./filters.js";
import { date, naira, number } from "./format.js";
import { infoModal } from "./ui.js";

const ICON_PATHS = {
  check: "M4 12l5 5L21 5",
  alert: "M12 3 2 21h20zM12 9v5M12 17v1",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v6l4 2",
};
const twinIcon = (name) => raw(`<svg class="ico" viewBox="0 0 24 24"><path d="${ICON_PATHS[name]}"/></svg>`);
export const signedNumber = (v) => `${v >= 0 ? "+" : ""}${number(v)}`;

export function stationScene(alt) {
  return html`<img class="station-scene" src="/assets/station-scene.jpg" alt="${alt}">`;
}

export function assetLabel(cls, name, value, extra = "", attrs = "") {
  return html`<button type="button" class="asset-label ${cls}" ${raw(attrs)}><span class="label-name">${name}</span><span class="label-value">${value}</span>${extra}</button>`;
}

/* ------------------------------------------------------------- Tank state */

/** Derives the same shape of figures the tank graphic/label/modal all need,
 * from one `/stock/tanks` row (balance + latestDip). */
export function tankMetrics(tank) {
  const system = tank.balance;
  const d = tank.latestDip;
  const dip = d ? d.dipLitres : null;
  const variance = d ? d.variance : null;
  const tolerance = d ? d.tolerance : tank.stockTolerance;
  const stale = d ? d.systemStock !== system : false;
  const bad = d ? d.toleranceStatus === "exceeded" : false;
  const scale = Math.max(50000, Math.ceil(Math.max(system || 0, dip || 0) / 50000) * 50000);
  return { system, dip, dipRef: d?.ref ?? null, dipDate: d?.businessDate ?? null, variance, tolerance, stale, bad, scale };
}

function tankStatusLabel(m) {
  if (m.dip === null) return "Dip reading needed";
  if (m.stale) return "Dip needs refresh";
  if (m.bad) return "Above tolerance";
  return "Within tolerance";
}

function tankSeverity(m) {
  if (m.dip === null || m.stale) return "warn";
  if (m.bad) return "bad";
  return "ok";
}

let svgSeq = 0;

/** The tank cutaway graphic: a solid fill line for calculated stock, a
 * dashed line for the latest physical dip, both plotted against the same
 * auto indicative scale — so the two are always directly comparable. */
export function tankInteriorSvg(productCode, tank, suffix = "") {
  const m = tankMetrics(tank);
  const id = `fluid-${productCode}-${suffix || svgSeq++}`;
  const liquidY = 150 * (1 - Math.min(m.system / m.scale, 1));
  const dipY = m.dip !== null ? 150 * (1 - Math.min(m.dip / m.scale, 1)) : null;
  const color = productCode === "AGO" ? "#bc9035" : "#208e82";
  const dipColor = m.stale ? "#9b7335" : m.bad ? "#b83e46" : "#122e43";
  return raw(
    `<svg class="recorded-liquid" viewBox="0 0 400 160" preserveAspectRatio="none" role="img" aria-label="${tank.name}. Calculated ${number(m.system)} litres. Latest dip ${m.dip !== null ? number(m.dip) + " litres" : "not recorded"}. Indicative scale ${number(m.scale)} litres, not capacity.">` +
      `<defs><clipPath id="${id}-clip"><path d="M45 5H354C413 5 413 155 354 155H45C-13 155-13 5 45 5Z"/></clipPath>` +
      `<linearGradient id="${id}-liquid"><stop stop-color="${color}" stop-opacity=".72"/><stop offset=".5" stop-color="${color}"/><stop offset="1" stop-color="${color}" stop-opacity=".8"/></linearGradient>` +
      `<linearGradient id="${id}-glass"><stop stop-color="#eef3f3"/><stop offset=".5" stop-color="#d8e5e5"/><stop offset="1" stop-color="#edf1ee"/></linearGradient></defs>` +
      `<g clip-path="url(#${id}-clip)"><rect width="400" height="160" fill="url(#${id}-glass)"/>` +
      `<rect class="fluid-fill" x="0" y="${liquidY + 5}" width="400" height="${155 - liquidY}" fill="url(#${id}-liquid)"/>` +
      `<path d="M0 ${liquidY + 5}H400" stroke="#315d6b" stroke-width="3"/>` +
      (dipY !== null ? `<path d="M0 ${dipY + 5}H400" stroke="${dipColor}" stroke-width="3" stroke-dasharray="8 5"/>` : "") +
      `<path d="M48 10C28 40 28 120 48 150M350 10C374 40 374 120 350 150" stroke="#fff" stroke-opacity=".5" stroke-width="7"/>` +
      `<path d="M115 0L65 160H92L145 0Z" fill="#fff" opacity=".12"/></g>` +
      `<path d="M45 5H354C413 5 413 155 354 155H45C-13 155-13 5 45 5Z" fill="none" stroke="#a5b8be" stroke-width="3"/></svg>`,
  );
}

/** The two fixed tank positions over the underground section of the photo —
 * a real SVG per tank, not a photo overlay, so it's always pixel-accurate
 * at any screen size (see module docblock). */
export function tankInteriorOverlay(pmsTank, agoTank) {
  const slot = (cls, code, tank) =>
    tank
      ? html`<button type="button" class="tank-interior ${cls}" data-tank-code="${code}" aria-label="Inspect ${tank.name}">${tankInteriorSvg(code, tank)}</button>`
      : html`<div class="tank-interior ${cls} unknown-tank">No tank registered</div>`;
  return html`${slot("tank-interior-0", "PMS", pmsTank)}${slot("tank-interior-1", "AGO", agoTank)}`;
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
  return assetLabel(`pump-label p${index + 1}`, `${pump.name} · ${pump.productCode}`, value, reading ? "" : html`<small>No reading today</small>`, `data-pump-id="${pump.id}"`);
}

/** The floating info card next to (not on top of) the tank graphic —
 * calculated stock, latest dip, and status, matching tankInteriorSvg's own
 * numbers exactly. */
export function tankHotspot(productCode, tank) {
  if (!tank) return "";
  const cls = productCode === "PMS" ? "tank-label pms" : "tank-label ago";
  const m = tankMetrics(tank);
  const severity = tankSeverity(m);
  const icon = severity === "warn" ? "clock" : severity === "bad" ? "alert" : "check";
  return html`<button type="button" class="asset-label ${cls}" data-tank-code="${productCode}"><span class="label-name">${productCode} · ${tank.name}</span><span class="label-value">${number(m.system)} L</span><span class="reading-line"><span>Calculated</span><b>${number(m.system)} L</b></span><span class="reading-line"><span>Latest dip</span><b>${m.dip !== null ? `${number(m.dip)} L` : "—"}</b></span><span class="variance-label ${severity}">${twinIcon(icon)}${tankStatusLabel(m)}</span></button>`;
}

export function receiptHotspot(receipt) {
  if (!receipt) return "";
  return assetLabel("receipt-label", receipt.waybillRef, `${number(receipt.quantity)} L ${receipt.productCode}`, html`<small class="green">✓ Verified receipt</small>`, 'data-receipt-hotspot="1"');
}

/** Compact clickable list of the SAME shown pumps/tanks/receipt as the
 * illustration's hotspots — shown instead of the canvas on narrow screens,
 * where the SVG tank graphics get too small to read. Reuses the same
 * data-tank-code/data-pump-id/data-receipt-hotspot attributes as the canvas
 * hotspots, so one bindHotspotClicks() on a shared ancestor covers both. */
export function mobileAssetsMarkup(shownPumps, tanksByProduct, pumpReadings, receipt) {
  const rows = [];
  if (receipt) {
    rows.push(
      html`<button type="button" class="mobile-asset" data-receipt-hotspot="1"><small>${receipt.waybillRef}</small><b>${number(receipt.quantity)} L ${receipt.productCode}</b><small class="green">✓ Verified receipt</small></button>`,
    );
  }
  for (const code of ["PMS", "AGO"]) {
    const tank = tanksByProduct.get(code);
    if (!tank) continue;
    const m = tankMetrics(tank);
    const severity = tankSeverity(m);
    rows.push(
      html`<button type="button" class="mobile-asset" data-tank-code="${code}"><small>${code} · ${tank.name} · Calculated</small><b>${number(m.system)} L</b><small>Dip: ${m.dip !== null ? `${number(m.dip)} L` : "Not recorded"}</small><small class="${severity === "ok" ? "green" : severity === "bad" ? "red" : ""}">${tankStatusLabel(m)}</small></button>`,
    );
  }
  for (const p of shownPumps) {
    const r = pumpReadings.find((x) => x.pumpName === p.name);
    rows.push(
      html`<button type="button" class="mobile-asset" data-pump-id="${p.id}"><small>${p.name} · ${p.productCode}</small><b>${r?.netSales != null ? `${number(r.netSales)} L` : "—"}</b><small>Net sales today</small></button>`,
    );
  }
  return html`${rows}`;
}

/** Builds the "beyond the fixed hotspots" panel markup, or null when there's
 * nothing to show — callers decide how to (un)hide their own container. */
export function overflowMarkup(overflowPumps, overflowTanks, { tanksById = new Map(), pumpReadings = [] } = {}) {
  if (!overflowPumps.length && !overflowTanks.length) return null;
  const cards = [
    ...overflowTanks.map((t) => {
      const tank = tanksById.get(t.id);
      if (!tank) return html`<div class="plain-card"><label>${t.productCode} · ${t.name}</label><strong>—</strong><div class="hint">Not available</div></div>`;
      const m = tankMetrics(tank);
      return html`<div class="plain-card"><label>${t.productCode} · ${t.name}</label><strong>${number(m.system)} L</strong><div class="hint">${tankStatusLabel(m)}</div></div>`;
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

/** Fetches `/stock/tanks` for a station once and indexes it by tank id and
 * by product code (first match wins per product, among the given tanks). */
export async function loadTankStatus(stationId, tanks) {
  const rows = await api
    .get("/stock/tanks", { stationId })
    .then((r) => r.data)
    .catch(() => []);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byProduct = new Map();
  for (const t of tanks) {
    const row = byId.get(t.id);
    if (row && !byProduct.has(t.productCode)) byProduct.set(t.productCode, row);
  }
  return { byId, byProduct };
}

/** Fetches `/stock/movement` for one tank on a given date — used only for
 * the stock-equation strip's opening/receipts/sales/RTT/adjustments detail,
 * which the tank graphic itself doesn't need. */
export async function loadTankMovement(stationId, tank, date) {
  if (!tank) return null;
  return api
    .get("/stock/movement", { stationId, productId: tank.productId, tankId: tank.id, date })
    .then((r) => r.data)
    .catch(() => null);
}

/* --------------------------------------------------------- Click-to-detail */

export function tankDetailModal(productCode, tank, { onOpenLedger } = {}) {
  if (!tank) return;
  const m = tankMetrics(tank);
  const severity = tankSeverity(m);
  infoModal({
    title: `${productCode} · ${tank.name}`,
    content: html`
      <div class="muted">${tank.stationName ?? ""} / Recorded stock</div>
      <div class="drawer-value num">${number(m.system)} L</div>
      <p class="hint" style="margin:-6px 0 10px">Calculated stock</p>
      <div class="tank-level-preview">${tankInteriorSvg(productCode, tank, "drawer")}</div>
      <div class="tank-scale-note">Indicative display scale: ${number(m.scale)} L · This is not tank capacity.</div>
      <span class="pill ${severity === "warn" ? "gray" : severity === "bad" ? "red" : "green"}">${tankStatusLabel(m)}</span>
      <div class="kv">
        <span>Calculated stock</span><span>${number(m.system)} L</span>
        <span>Latest physical dip</span><span>${m.dip !== null ? `${number(m.dip)} L` : "Not recorded"}</span>
        <span>${m.stale ? "Difference · dip predates movement" : "Variance"}</span><span>${m.variance !== null ? `${signedNumber(m.variance)} L` : "Not available"}</span>
        <span>Tolerance</span><span>±${number(m.tolerance)} L</span>
        ${m.dipRef ? html`<span>Latest dip reference</span><span>${m.dipRef}</span>` : ""}
      </div>
      <div class="hint">${m.stale ? "Stock has moved since the latest dip. Record a fresh dip before treating this difference as a reconciliation variance." : "Transactions update calculated stock. A dip updates the measured marker only — it never overwrites the ledger."}</div>
      ${onOpenLedger ? html`<div style="margin-top:14px"><button type="button" class="btn btn-primary" data-open-ledger>Open stock ledger</button></div>` : ""}
    `,
    onRender: (form, close) => {
      form.querySelector("[data-open-ledger]")?.addEventListener("click", () => {
        close();
        onOpenLedger();
      });
    },
  });
}

export function pumpDetailModal(pump, reading, { onOpenDay } = {}) {
  infoModal({
    title: `${pump.name} · ${pump.productCode}`,
    content: html`
      <div class="muted">${pump.meterLabel ?? pump.tankName ?? ""}</div>
      <div class="drawer-value num">${reading?.netSales != null ? `${number(reading.netSales)} L` : "—"}</div>
      ${reading ? "" : html`<span class="pill gray">No reading recorded today</span>`}
      <div class="kv">
        <span>Opening reading</span><span>${reading ? number(reading.openingReading) : "—"}</span>
        <span>Closing reading</span><span>${reading?.closingReading != null ? number(reading.closingReading) : "Not entered"}</span>
        <span>RTT (excluded)</span><span>${reading ? number(reading.rtt) : "—"}</span>
        <span>Net sales</span><span>${reading?.netSales != null ? `${number(reading.netSales)} L` : "—"}</span>
        <span>Sales value</span><span>${reading?.salesValue != null ? naira(reading.salesValue) : "—"}</span>
      </div>
      ${onOpenDay ? html`<div style="margin-top:14px"><button type="button" class="btn btn-primary" data-open-day>Open DSR day</button></div>` : ""}
    `,
    onRender: (form, close) => {
      form.querySelector("[data-open-day]")?.addEventListener("click", () => {
        close();
        onOpenDay();
      });
    },
  });
}

export function receiptDetailModal(receipt, { onOpenRecord } = {}) {
  if (!receipt) return;
  infoModal({
    title: receipt.waybillRef,
    content: html`
      <div class="muted">${receipt.stationName ?? ""}${receipt.businessDate ? ` · ${date(receipt.businessDate)}` : ""}</div>
      <div class="drawer-value num">${number(receipt.quantity)} L ${receipt.productCode}</div>
      <span class="pill green">✓ Verified receipt</span>
      <div class="kv">
        <span>Waybill</span><span>${receipt.waybillRef}</span>
        <span>Quantity</span><span>${number(receipt.quantity)} L</span>
        <span>Landing price</span><span>${receipt.landingPrice != null ? naira(receipt.landingPrice) : "—"}</span>
        <span>Tank</span><span>${receipt.tankName ?? "—"}</span>
      </div>
      ${onOpenRecord ? html`<div style="margin-top:14px"><button type="button" class="btn btn-primary" data-open-record>Open Truck Receiving</button></div>` : ""}
    `,
    onRender: (form, close) => {
      form.querySelector("[data-open-record]")?.addEventListener("click", () => {
        close();
        onOpenRecord();
      });
    },
  });
}

/** Wires click-to-detail on a rendered illustration container in one call.
 * Callers decide what a click does — Dashboard opens a detail modal;
 * DSR's own pump illustration instead highlights the matching reading card
 * already on the page, since opening a modal with the same numbers shown
 * right below it would be redundant there. */
export function bindHotspotClicks(container, { onTankClick, onPumpClick, onReceiptClick } = {}) {
  container.addEventListener("click", (e) => {
    const tankBtn = e.target.closest("[data-tank-code]");
    if (tankBtn) {
      onTankClick?.(tankBtn.dataset.tankCode);
      return;
    }
    const pumpBtn = e.target.closest("[data-pump-id]");
    if (pumpBtn) {
      onPumpClick?.(Number(pumpBtn.dataset.pumpId));
      return;
    }
    if (e.target.closest("[data-receipt-hotspot]")) onReceiptClick?.();
  });
}
