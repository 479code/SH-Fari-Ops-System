/**
 * charts.js — the dashboard's SVG charts, drawn from API data in the same
 * visual style as the prototype (area trend, donut, horizontal bars).
 */
import { html, raw } from "./dom.js";
import { compactLitres, litres, naira, shortDate } from "./format.js";

const COLORS = ["#F5A524", "#3E6DF6", "#1CA96B", "#7C5CFC", "#12A4A0", "#EF4B54"];

/**
 * Weekly area chart. With `partialLast`, the final point is the current week to
 * date: its segment is dashed so an incomplete week does not read as a collapse.
 */
export function areaChart(points, { partialLast = false } = {}) {
  if (!points.length || points.every((p) => p.value === 0)) {
    return html`<div class="chart-empty">No closed sales days in the last 8 weeks.</div>`;
  }
  const W = 640;
  const top = 34;
  const bottom = 180;
  const max = Math.max(...points.map((p) => p.value)) * 1.12 || 1;
  const step = W / (points.length - 1 || 1);
  const coords = points.map((p, i) => [Math.round(i * step), Math.round(bottom - (p.value / max) * (bottom - top))]);
  const toPath = (list) => list.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ");
  const dashed = partialLast && coords.length > 1;
  const solidLine = toPath(dashed ? coords.slice(0, -1) : coords);
  const tailLine = dashed ? toPath(coords.slice(-2)) : "";
  const area = `${toPath(coords)} L${W},${bottom} L0,${bottom} Z`;
  const peakIndex = points.reduce((best, p, i) => (p.value > points[best].value ? i : best), 0);
  const [px, py] = coords[peakIndex];
  const labelX = Math.min(Math.max(px, 56), W - 56);
  const labelY = Math.max(py - 44, 4);
  const label = (i) => (dashed && i === points.length - 1 ? "This wk" : shortDate(points[i].weekStart));
  return html`<svg width="100%" viewBox="0 0 ${W} 210" role="img" aria-label="Weekly sales trend">
    <defs><linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#F5A524" stop-opacity="0.28"/><stop offset="100%" stop-color="#F5A524" stop-opacity="0"/></linearGradient></defs>
    <g stroke="#EBECF2" stroke-width="1"><line x1="0" y1="20" x2="640" y2="20"/><line x1="0" y1="65" x2="640" y2="65"/><line x1="0" y1="110" x2="640" y2="110"/><line x1="0" y1="155" x2="640" y2="155"/></g>
    <path d="${area}" fill="url(#areaFill)"/>
    <path d="${solidLine}" fill="none" stroke="#F5A524" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${dashed ? html`<path d="${tailLine}" fill="none" stroke="#F5A524" stroke-width="2.5" stroke-dasharray="5 6" stroke-linecap="round"/>` : ""}
    ${coords.map(([x, y], i) => html`<circle cx="${x}" cy="${y}" r="${i === peakIndex ? 5 : 3}" fill="#fff" stroke="#F5A524" stroke-width="2.5"><title>${dashed && i === points.length - 1 ? "This week to date" : `Week of ${shortDate(points[i].weekStart)}`}: ${naira(points[i].value)}</title></circle>`)}
    <rect x="${labelX - 52}" y="${labelY}" width="104" height="30" rx="8" fill="#1D2140"/>
    <text x="${labelX}" y="${labelY + 19}" text-anchor="middle" fill="#fff" font-size="11.5" font-weight="700" font-family="Manrope">${naira(points[peakIndex].value, { compact: true })}</text>
    ${coords.map(([x], i) => html`<text x="${Math.min(Math.max(x, 18), W - 18)}" y="204" text-anchor="middle" fill="#9498AB" font-size="10" font-family="Manrope">${label(i)}</text>`)}
  </svg>`;
}

export function donut(segments, centerLabel = "litres") {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const C = 2 * Math.PI * 50;
  let offset = 0;
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((s, i) => {
      const len = (s.value / total) * C;
      const arc = html`<circle cx="66" cy="66" r="50" fill="none" stroke="${s.color ?? COLORS[i % COLORS.length]}" stroke-width="16" stroke-dasharray="${len.toFixed(1)} ${C.toFixed(1)}" stroke-dashoffset="${(-offset).toFixed(1)}" transform="rotate(-90 66 66)"/>`;
      offset += len;
      return arc;
    });
  const svg = html`<svg width="132" height="132" viewBox="0 0 132 132" role="img" aria-label="Distribution">
    <circle cx="66" cy="66" r="50" fill="none" stroke="#F0F1F5" stroke-width="16"/>
    ${arcs}
    <text x="66" y="62" text-anchor="middle" font-size="19" font-weight="800" fill="#171A2B" font-family="Manrope">${total > 0 ? compactLitres(total) : "0"}</text>
    <text x="66" y="78" text-anchor="middle" font-size="10.5" fill="#9498AB" font-family="Manrope">${centerLabel}</text>
  </svg>`;
  const legend = segments.length
    ? segments.map((s, i) => html`<div class="legend-row"><span class="legend-dot" style="background:${raw(s.color ?? COLORS[i % COLORS.length])}"></span>${s.label}<b>${litres(s.value, 0)}L</b></div>`)
    : html`<div class="legend-row">Nothing in transit.</div>`;
  return { svg, legend };
}

export function bars(items) {
  if (!items.length) return html`<div class="chart-empty">No stations.</div>`;
  const max = Math.max(...items.map((i) => i.value), 1);
  return html`${items.map(
    (item, i) =>
      html`<div class="bar-row"><div class="bar-label" title="${item.label}">${item.label}</div><div class="bar-track"><div class="bar-fill" style="width:${raw(Math.max(2, Math.round((item.value / max) * 100)))}%;background:${raw(COLORS[i % COLORS.length])}"></div></div><div class="bar-val">${naira(item.value, { compact: true })}</div></div>`,
  )}`;
}
