/**
 * client.js — the single place the frontend talks to the API.
 *
 * - Base URL comes from <meta name="api-base"> (defaults to same-origin /api/v1).
 * - Sends JSON, includes the session cookie, times out slow requests.
 * - Normalises failures into ApiError { status, code, message, fields }.
 * - Broadcasts `auth:expired` on 401 so the shell can return to sign-in.
 */

const BASE = (document.querySelector('meta[name="api-base"]')?.getAttribute("content") || "/api/v1").replace(/\/$/, "");
const baseOrigin = new URL(BASE, window.location.origin).origin;
const CREDENTIALS = baseOrigin === window.location.origin ? "same-origin" : "include";
const DEFAULT_TIMEOUT_MS = 30_000;

const FALLBACK_MESSAGES = {
  0: "Cannot reach the server. Check your connection and try again.",
  400: "The request could not be processed.",
  401: "Please sign in to continue.",
  403: "You do not have permission to perform this action.",
  404: "The requested record was not found.",
  409: "This conflicts with the current state of the record.",
  422: "Some fields are invalid. Please review and try again.",
  429: "Too many requests. Please wait a moment and try again.",
  500: "Something went wrong on the server. Please try again.",
};

export class ApiError extends Error {
  constructor(status, code, message, fields = null, requestId = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.requestId = requestId;
  }
}

function buildUrl(path, query) {
  const url = new URL(BASE + path, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function request(method, path, { body, query, timeout = DEFAULT_TIMEOUT_MS, raw = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      credentials: CREDENTIALS,
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    throw new ApiError(0, timedOut ? "TIMEOUT" : "NETWORK_ERROR", timedOut ? "The server took too long to respond." : FALLBACK_MESSAGES[0]);
  } finally {
    clearTimeout(timer);
  }

  if (raw && response.ok) return response;

  let payload = null;
  if ((response.headers.get("content-type") || "").includes("application/json")) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  }

  if (!response.ok || payload?.success === false) {
    const error = payload?.error ?? {};
    const status = response.status;
    if (status === 401 && !path.startsWith("/auth/login")) {
      window.dispatchEvent(new CustomEvent("auth:expired"));
    }
    throw new ApiError(
      status,
      error.code ?? `HTTP_${status}`,
      error.message ?? FALLBACK_MESSAGES[status] ?? FALLBACK_MESSAGES[500],
      error.fields ?? null,
      error.requestId ?? null,
    );
  }
  return payload;
}

/** Downloads a file response (e.g. CSV export) without leaving the page. */
async function download(path, query, fallbackName) {
  const response = await request("GET", path, { query, raw: true, timeout: 120_000 });
  const disposition = response.headers.get("content-disposition") || "";
  const match = /filename="?([^";]+)"?/.exec(disposition);
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = match?.[1] || fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export const api = {
  get: (path, query) => request("GET", path, { query }),
  post: (path, body = {}) => request("POST", path, { body }),
  put: (path, body = {}) => request("PUT", path, { body }),
  patch: (path, body = {}) => request("PATCH", path, { body }),
  delete: (path) => request("DELETE", path),
  download,
};
