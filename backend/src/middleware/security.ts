/**
 * security.ts — browser-facing protections.
 *
 * CSRF: the session cookie is SameSite=Strict, the API only accepts JSON bodies
 * (which a cross-site form cannot send without a CORS preflight), and on top of
 * that every state-changing request whose Origin is present must be same-origin
 * or an explicitly allowed CORS origin.
 */
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
  allowHeaders: ["Content-Type", "X-Request-Id"],
  exposeHeaders: ["X-Request-Id", "Content-Disposition"],
  maxAge: 600,
});

export const originGuard = createMiddleware<AppEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  const origin = c.req.header("origin");
  const fetchSite = c.req.header("sec-fetch-site");
  if (origin) {
    const self = new URL(c.req.url).origin;
    const forwardedHost = env.TRUST_PROXY ? c.req.header("x-forwarded-host") : undefined;
    const forwardedProto = env.TRUST_PROXY ? c.req.header("x-forwarded-proto") : undefined;
    const proxied = forwardedHost ? `${forwardedProto ?? "https"}://${forwardedHost}` : null;
    if (origin !== self && origin !== proxied && !env.CORS_ORIGIN.includes(origin)) {
      throw new AppError("FORBIDDEN", "Cross-site request blocked.");
    }
  } else if (fetchSite === "cross-site") {
    throw new AppError("FORBIDDEN", "Cross-site request blocked.");
  }
  await next();
});

export const noStore = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});
