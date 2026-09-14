/**
 * request-context.ts — request id, client IP, per-request logger and access log.
 */
import { createMiddleware } from "hono/factory";
import { getConnInfo } from "hono/bun";
import type { Context } from "hono";
import { env } from "../config/env.ts";
import type { AppEnv } from "../types.ts";
import { logger } from "../utils/logger.ts";

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

function clientIp(c: Context<AppEnv>): string | null {
  if (env.TRUST_PROXY) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded.slice(0, 64);
  }
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    // app.request() in tests has no socket.
    return null;
  }
}

export const requestContext = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
  const ip = clientIp(c);
  const log = logger.child({ requestId });

  c.set("requestId", requestId);
  c.set("clientIp", ip);
  c.set("log", log);
  c.header("X-Request-Id", requestId);

  const started = performance.now();
  await next();

  const isApi = c.req.path.startsWith("/api/");
  const fields = {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Math.round(performance.now() - started),
    ip,
    userId: c.get("actor")?.id,
  };
  if (isApi) log.info("request", fields);
  else log.debug("static", fields);
});
