/**
 * rate-limit.ts — fixed-window, in-memory request limiting.
 *
 * Sufficient for a single API instance. Running several instances behind a load
 * balancer would need a shared store (Redis/MariaDB) — noted in the README.
 * Account-level brute-force protection does not depend on this: failed logins
 * are counted per user in the database (see auth.service.ts).
 */
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { AppEnv } from "../types.ts";
import { AppError } from "../utils/errors.ts";

interface Window {
  count: number;
  resetAt: number;
}

export function rateLimit(options: {
  windowMs: number;
  max: number;
  keyPrefix: string;
  key?: (c: Context<AppEnv>) => string;
  message?: string;
}) {
  const hits = new Map<string, Window>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, w] of hits) if (w.resetAt <= now) hits.delete(k);
  }, options.windowMs);
  sweep.unref?.();

  return createMiddleware<AppEnv>(async (c, next) => {
    const key = `${options.keyPrefix}:${options.key ? options.key(c) : (c.get("clientIp") ?? "unknown")}`;
    const now = Date.now();
    let w = hits.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + options.windowMs };
      hits.set(key, w);
    }
    w.count += 1;

    c.header("RateLimit-Limit", String(options.max));
    c.header("RateLimit-Remaining", String(Math.max(0, options.max - w.count)));
    if (w.count > options.max) {
      c.header("Retry-After", String(Math.ceil((w.resetAt - now) / 1000)));
      throw new AppError("RATE_LIMITED", options.message ?? "Too many requests. Please slow down and try again shortly.");
    }
    await next();
  });
}
