/** format.js — display formatting for money, litres, dates and statuses. */
import { html } from "./dom.js";

const NG = "en-NG";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const isNum = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

export function number(value, dp = 0) {
  if (!isNum(value)) return "—";
  return Number(value).toLocaleString(NG, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** ₦3,486,000 — or compact ₦214.6M / ₦84.9K */
export function naira(value, { compact = false, dp = 0, signed = false } = {}) {
  if (!isNum(value)) return "—";
  const n = Number(value);
  const sign = n < 0 ? "−" : signed && n > 0 ? "+" : "";
  const abs = Math.abs(n);
  if (compact) {
    if (abs >= 1e9) return `${sign}₦${(abs / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `${sign}₦${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1e4) return `${sign}₦${(abs / 1e3).toFixed(1)}K`;
  }
  return `${sign}₦${abs.toLocaleString(NG, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

export const price = (value) => naira(value, { dp: 2 });

export function litres(value, dp = 1, { signed = false } = {}) {
  if (!isNum(value)) return "—";
  const n = Number(value);
  const sign = n < 0 ? "−" : signed && n > 0 ? "+" : "";
  return `${sign}${Math.abs(n).toLocaleString(NG, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

export function compactLitres(value) {
  if (!isNum(value)) return "—";
  const n = Number(value);
  return Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K` : String(Math.round(n));
}

export function pct(value) {
  if (!isNum(value)) return null;
  return `${Math.abs(Number(value)).toFixed(1)}%`;
}

/** '2026-09-13' → '13 Sep 2026' */
export function date(iso, { year = true } = {}) {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return `${d} ${MONTHS[Number(m) - 1]}${year ? ` ${y}` : ""}`;
}

export const shortDate = (iso) => date(iso, { year: false });

export function monthLabel(month) {
  const [y, m] = month.split("-");
  return `${MONTHS_LONG[Number(m) - 1]} ${y}`;
}

export function dateTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function initials(name) {
  return String(name || "?")
    .replace(/[^A-Za-z\s.]/g, "")
    .split(/[\s.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");
}

/** Month options for filter selects, newest first. */
export function recentMonths(currentMonth, count = 12) {
  const [y, m] = currentMonth.split("-").map(Number);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const value = d.toISOString().slice(0, 7);
    return { value, label: monthLabel(value) };
  });
}

const STATUS = {
  // receipts
  received: ["amber", "Awaiting verification"],
  verified: ["green", "Verified"],
  disputed: ["red", "Disputed"],
  cancelled: ["gray", "Cancelled"],
  // DSR
  open: ["amber", "Open"],
  closed: ["green", "Locked"],
  not_opened: ["gray", "Not opened"],
  // GIT
  order_created: ["gray", "Order created"],
  truck_assigned: ["violet", "Truck assigned"],
  in_transit: ["amber", "In transit"],
  arrived: ["blue", "Arrived"],
  discharging: ["blue", "Discharging"],
  completed: ["green", "Completed"],
  pending: ["amber", "Pending"],
  discharged: ["green", "Discharged"],
  // cash / variance
  reconciled: ["green", "Reconciled"],
  within_tolerance: ["amber", "Within tolerance"],
  exceeded: ["red", "Exceeded"],
  reviewed: ["blue", "Reviewed"],
  not_declared: ["gray", "Not declared"],
  confirmed: ["green", "Confirmed"],
  // expenses
  approved: ["green", "Approved"],
  rejected: ["red", "Rejected"],
  // debtor aging
  current: ["green", "Current"],
  "31_60": ["amber", "31–60 days"],
  "61_90": ["amber", "60–90 days"],
  "90_plus": ["red", "90+ days"],
  settled: ["gray", "Settled"],
  credit: ["blue", "In credit"],
  none: ["gray", "No activity"],
  // generic
  active: ["green", "Active"],
  inactive: ["gray", "Inactive"],
  suspended: ["red", "Suspended"],
};

export function statusPill(status, label) {
  const [color, text] = STATUS[status] ?? ["gray", String(status ?? "—").replaceAll("_", " ")];
  return html`<span class="pill ${color}">${label ?? text}</span>`;
}

export function statusText(status) {
  return (STATUS[status] ?? [null, String(status ?? "").replaceAll("_", " ")])[1];
}

const ACTION_COLORS = {
  created: "blue",
  opened: "blue",
  verified: "green",
  approved: "green",
  closed: "green",
  resolved: "green",
  reviewed: "blue",
  reopened: "amber",
  updated: "amber",
  status_changed: "violet",
  settings_changed: "amber",
  permissions_changed: "amber",
  flagged: "red",
  disputed: "red",
  rejected: "red",
  cancelled: "red",
  voided: "red",
  deleted: "red",
  login_failed: "red",
  login: "gray",
  logout: "gray",
  password_changed: "gray",
  password_reset_issued: "amber",
  password_reset_completed: "gray",
};

export function actionPill(action) {
  const label = String(action).replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase());
  return html`<span class="pill ${ACTION_COLORS[action] ?? "gray"}">${label}</span>`;
}

/** Compact one-line rendering of audit old/new JSON values. */
export function auditValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value !== "object") return String(value);
  const entries = Object.entries(value);
  if (entries.length === 0) return "—";
  if (entries.length === 1 && ["status", "note"].includes(entries[0][0])) return String(entries[0][1]);
  return entries
    .map(([k, v]) => `${k}: ${v !== null && typeof v === "object" ? JSON.stringify(v) : v ?? "—"}`)
    .join(" · ");
}
