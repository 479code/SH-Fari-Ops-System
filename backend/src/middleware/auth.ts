/**
 * auth.ts — session authentication and permission guards.
 *
 * Every protected route runs `requireAuth` and then `requirePermission(...)`.
 * The frontend hides controls a user cannot use, but that is presentation only;
 * these guards are the enforcement.
 */
import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { Permission } from "../auth/permissions.ts";
import { SESSION_COOKIE } from "../auth/tokens.ts";
import { resolveSession } from "../services/auth.service.ts";
import type { AppEnv } from "../types.ts";
import { AppError } from "../utils/errors.ts";

/** Routes a user who must change their password may still reach. */
const PASSWORD_CHANGE_ALLOWED = new Set(["/api/v1/auth/me", "/api/v1/auth/logout", "/api/v1/auth/change-password"]);

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) throw new AppError("UNAUTHORIZED", "Please sign in to continue.");

  const actor = await resolveSession(token, {
    ip: c.get("clientIp"),
    userAgent: c.req.header("user-agent") ?? null,
  });
  if (!actor) throw new AppError("UNAUTHORIZED", "Your session has expired. Please sign in again.");

  if (actor.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(c.req.path)) {
    throw new AppError("FORBIDDEN", "You must change your password before continuing.");
  }

  c.set("actor", actor);
  c.set("log", c.get("log").child({ userId: actor.id }));
  await next();
});

/** Requires every listed permission. */
export function requirePermission(...required: Permission[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const actor = c.get("actor");
    const missing = required.filter((p) => !actor.permissions.has(p));
    if (missing.length > 0) {
      c.get("log").warn("permission denied", { path: c.req.path, missing });
      throw new AppError("FORBIDDEN", "You do not have permission to perform this action.");
    }
    await next();
  });
}

/** Requires at least one of the listed permissions. */
export function requireAnyPermission(...options: Permission[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const actor = c.get("actor");
    if (!options.some((p) => actor.permissions.has(p))) {
      c.get("log").warn("permission denied", { path: c.req.path, anyOf: options });
      throw new AppError("FORBIDDEN", "You do not have permission to perform this action.");
    }
    await next();
  });
}
