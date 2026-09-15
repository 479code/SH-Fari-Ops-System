/**
 * security.ts — browser-facing protections.
 *
 * CSRF: the session cookie is SameSite=Strict, the API only accepts JSON bodies
 * (which a cross-site form cannot send without a CORS preflight), and on top of
 * that every state-changing request from another site is rejected: browsers
 * label them `Sec-Fetch-Site: cross-site`, and any Origin header present must be
 * this site (as seen directly or through the trusted proxy) or an allowed CORS origin.
 */
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { secureHeaders } from "hono/secure-headers";
import { cors } from "hono/cors";
import { env } from "../config/env.ts";
import type { AppEnv } from "../types.ts";
import { AppError } from "../utils/errors.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const headers = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    // The existing UI uses inline style attributes extensively.
    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    fontSrc: ["'self'", "https://fonts.gstatic.com"],
    imgSrc: ["'self'", "data:"],
    connectSrc: ["'self'"],
    frameAncestors: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    objectSrc: ["'none'"],
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: "strict-origin-when-cross-origin",
});

export const apiCors = cors({
  origin: (origin) => (env.CORS_ORIGIN.includes(origin) ? origin : null),
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "X-Request-Id", "X-Background-Request"],
  exposeHeaders: ["X-Request-Id", "Content-Disposition"],
  maxAge: 600,
});

/** Origins under which this API is legitimately reached. */
function selfOrigins(c: Context<AppEnv>): string[] {
  const origins = [new URL(c.req.url).origin];
  if (env.TRUST_PROXY) {
    // Behind a TLS-terminating proxy the socket sees http://host while the
    // browser sends Origin https://host; reconstruct what the browser used.
    const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
    const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim() || c.req.header("host");
    if (host) origins.push(`${proto}://${host}`);
  }
  return origins;
}

export const originGuard = createMiddleware<AppEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  const origin = c.req.header("origin");
  const fetchSite = c.req.header("sec-fetch-site");
  const allowedCors = Boolean(origin && env.CORS_ORIGIN.includes(origin));

  if (fetchSite === "cross-site" && !allowedCors) {
    throw new AppError("FORBIDDEN", "Cross-site request blocked.");
  }
  // A browser that reports same-origin is authoritative; otherwise the Origin must match.
  if (origin && fetchSite !== "same-origin" && !allowedCors && !selfOrigins(c).includes(origin)) {
    throw new AppError("FORBIDDEN", "Cross-site request blocked.");
  }
  await next();
});

export const noStore = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});
