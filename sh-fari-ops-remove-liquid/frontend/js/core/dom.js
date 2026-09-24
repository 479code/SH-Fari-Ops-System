/**
 * dom.js — small DOM helpers.
 *
 * `html` is a tagged template that HTML-escapes every interpolated value unless
 * it was produced by `raw()` or another `html` call. All dynamic markup in the
 * app goes through it, which is what keeps API data from becoming XSS.
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

class SafeHtml {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

export const raw = (value) => new SafeHtml(String(value ?? ""));

function interpolate(value) {
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(interpolate).join("");
  if (value === false || value === null || value === undefined) return "";
  return esc(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += interpolate(v) + strings[i + 1];
  });
  return new SafeHtml(out);
}

export function setHtml(element, markup) {
  if (element) element.innerHTML = markup instanceof SafeHtml ? markup.value : esc(markup);
}

/** Replaces a select's options; keeps the current value when still present. */
export function setOptions(select, items, { value = "id", label = "name", placeholder, keep = true, selected } = {}) {
  if (!select) return;
  const current = selected ?? (keep ? select.value : "");
  const parts = [];
  if (placeholder !== undefined) parts.push(`<option value="">${esc(placeholder)}</option>`);
  for (const item of items) {
    const v = typeof value === "function" ? value(item) : item[value];
    const l = typeof label === "function" ? label(item) : item[label];
    parts.push(`<option value="${esc(v)}">${esc(l)}</option>`);
  }
  select.innerHTML = parts.join("");
  if (current !== undefined && current !== null && Array.from(select.options).some((o) => o.value === String(current))) {
    select.value = String(current);
  }
}

export function debounce(fn, wait = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function on(root, event, selector, handler) {
  root.addEventListener(event, (e) => {
    const target = e.target.closest(selector);
    if (target && root.contains(target)) handler(e, target);
  });
}
