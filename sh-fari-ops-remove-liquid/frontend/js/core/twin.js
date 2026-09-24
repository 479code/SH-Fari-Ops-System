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
import { date, naira, number } from "./format.js";
import { infoModal } from "./ui.js";

const ICON_PATHS = {
  check: "M4 12l5 5L21 5",
  alert: "M12 3 2 21h20zM12 9v5M12 17v1",
};
const twinIcon = (name) => raw(`<svg class="ico" viewBox="0 0 24 24"><path d="${ICON_PATHS[name]}"/></svg>`);
export const signedNumber = (v) => `${v >= 0 ? "+" : ""}${number(v)}`;

export function tankFillPct(movement) {
  if (!movement?.capacity) return null;
  return Math.min(100, Math.max(4, Math.round((movement.closing / movement.capacity) * 100)));
}

export function stationScene(alt) {
  return html`<img class="station-scene" src="/assets/station-scene.jpg" alt="${alt}">`;
}

export function assetLabel(cls, name, value, extra = "", attrs = "") {
  return html`<button type="button" class="asset-label ${cls}" ${raw(attrs)}><span class="label-name">${name}</span><span class="label-value">${value}</span>${extra}</button>`;
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

export function tankHotspot(productCode, movement) {
  if (!movement) return "";
  const cls = productCode === "PMS" ? "tank-label pms" : "tank-label ago";
  const pct = tankFillPct(movement);
  const gauge = pct === null ? "" : html`<div class="tank-gauge"><div class="tank-gauge-fill ${productCode === "AGO" ? "amber" : ""}" style="width:${pct}%"></div></div>`;
  return html`<button type="button" class="asset-label ${cls}" data-tank-code="${productCode}">${gauge}<span class="label-name">${productCode} · ${movement.tankName ?? "Tank"}</span><span class="label-value">${number(movement.closing)} L</span>${tankVarianceBlock(movement)}</button>`;
}

export function receiptHotspot(receipt) {
  if (!receipt) return "";
  return assetLabel("receipt-label", receipt.waybillRef, `${number(receipt.quantity)} L ${receipt.productCode}`, html`<small class="green">✓ Verified receipt</small>`, 'data-receipt-hotspot="1"');
}

/** Compact clickable list of the SAME shown pumps/tanks/receipt as the
 * illustration's hotspots — shown instead of the canvas on narrow screens,
 * where overlaying text on a photo stops being legible. Reuses the same
 * data-tank-code/data-pump-id/data-receipt-hotspot attributes as the canvas
 * hotspots, so one bindHotspotClicks() on a shared ancestor covers both. */
export function mobileAssetsMarkup(shownPumps, movementsByProduct, pumpReadings, receipt) {
  const rows = [];
  if (receipt) {
    rows.push(
      html`<button type="button" class="mobile-asset" data-receipt-hotspot="1"><small>${receipt.waybillRef}</small><b>${number(receipt.quantity)} L ${receipt.productCode}</b><small class="green">✓ Verified receipt</small></button>`,
    );
  }
  for (const code of ["PMS", "AGO"]) {
    const m = movementsByProduct.get(code);
    if (!m) continue;
    const hasDip = m.physicalDip !== null && m.physicalDip !== undefined;
    const within = hasDip && Math.abs(m.variance) <= m.tolerance;
    const pct = tankFillPct(m);
    rows.push(
      html`<button type="button" class="mobile-asset" data-tank-code="${code}"><small>${code} · ${m.tankName ?? "Tank"}</small><b>${number(m.closing)} L</b>${pct === null ? "" : html`<div class="tank-gauge"><div class="tank-gauge-fill ${code === "AGO" ? "amber" : ""}" style="width:${pct}%"></div></div>`}<small class="${!hasDip ? "" : within ? "green" : "red"}">${!hasDip ? "Awaiting today's dip" : within ? "Within tolerance" : `${signedNumber(m.variance)} L variance`}</small></button>`,
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
export function overflowMarkup(overflowPumps, overflowTanks, { movementsByTankId = new Map(), pumpReadings = [] } = {}) {
  if (!overflowPumps.length && !overflowTanks.length) return null;
  const cards = [
    ...overflowTanks.map((t) => {
      const m = movementsByTankId.get(t.id);
      const noDip = !m || m.physicalDip === null || m.physicalDip === undefined;
      const within = !noDip && Math.abs(m.variance) <= m.tolerance;
      const pct = tankFillPct(m);
      const gauge = pct === null ? "" : html`<div class="tank-gauge"><div class="tank-gauge-fill ${t.productCode === "AGO" ? "amber" : ""}" style="width:${pct}%"></div></div>`;
      return html`<div class="plain-card">${gauge}<label>${t.productCode} · ${t.name}</label><strong>${m ? `${number(m.closing)} L` : "—"}</strong><div class="hint">${noDip ? "Awaiting today's dip" : within ? "Within tolerance" : `${signedNumber(m.variance)} L variance`}</div></div>`;
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

/** Fetches `/stock/movement` for a set of tanks in parallel, plus `/stock/tanks`
 * once for capacity (movement doesn't carry it), and indexes the merged
 * results by tank id and by product code (first match wins per product). */
export async function loadTankMovements(stationId, tanks, date) {
  const [movements, tankRows] = await Promise.all([
    Promise.all(
      tanks.map((t) =>
        api
          .get("/stock/movement", { stationId, productId: t.productId, date })
          .then((r) => r.data)
          .catch(() => null),
      ),
    ),
    api
      .get("/stock/tanks", { stationId })
      .then((r) => r.data)
      .catch(() => []),
  ]);
  const capacityByTankId = new Map(tankRows.map((t) => [t.id, t.capacity]));
  const byTankId = new Map();
  const byProduct = new Map();
  tanks.forEach((t, i) => {
    if (!movements[i]) return;
    const m = { ...movements[i], capacity: capacityByTankId.get(t.id) ?? null };
    byTankId.set(t.id, m);
    if (!byProduct.has(t.productCode)) byProduct.set(t.productCode, m);
  });
  return { byTankId, byProduct };
}

/* --------------------------------------------------------- Click-to-detail */

export function tankDetailModal(productCode, movement, { onOpenLedger } = {}) {
  if (!movement) return;
  const hasDip = movement.physicalDip !== null && movement.physicalDip !== undefined;
  const within = hasDip && Math.abs(movement.variance) <= movement.tolerance;
  const pct = tankFillPct(movement);
  infoModal({
    title: `${productCode} · ${movement.tankName ?? "Tank"}`,
    content: html`
      <div class="muted">${movement.stationName ?? ""}${movement.date ? ` · ${date(movement.date)}` : ""}</div>
      <div class="drawer-value num">${number(movement.closing)} L</div>
      ${pct === null ? "" : html`<div class="tank-gauge" style="margin-bottom:10px"><div class="tank-gauge-fill ${productCode === "AGO" ? "amber" : ""}" style="width:${pct}%"></div></div><div class="hint" style="margin:-4px 0 10px">${pct}% of ${number(movement.capacity)} L capacity</div>`}
      <span class="pill ${!hasDip ? "gray" : within ? "green" : "red"}">${!hasDip ? "Awaiting today's dip" : within ? "Within tolerance" : "Variance exceeds tolerance"}</span>
      <div class="kv">
        <span>System closing</span><span>${number(movement.closing)} L</span>
        <span>Physical dip</span><span>${hasDip ? `${number(movement.physicalDip)} L` : "Not recorded today"}</span>
        <span>Variance</span><span>${hasDip ? `${signedNumber(movement.variance)} L` : "—"}</span>
        <span>Station tolerance</span><span>±${number(movement.tolerance)} L</span>
        <span>Opening</span><span>${number(movement.opening)} L</span>
        <span>Receipts today</span><span>${number(movement.receipts)} L</span>
        <span>Sales today</span><span>${number(movement.dispensed)} L</span>
        <span>RTT today</span><span>${number(movement.rtt)} L</span>
      </div>
      <div class="hint">The physical dip is a measured check against the system ledger — it never overwrites the ledger. Adjustments require a separate approved record.</div>
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
