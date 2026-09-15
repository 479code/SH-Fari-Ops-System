import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cookieSecure, env } from "../config/env.ts";
import { SESSION_COOKIE } from "../auth/tokens.ts";
import { requireAuth } from "../middleware/auth.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import * as authService from "../services/auth.service.ts";
import type { AppEnv } from "../types.ts";
import { ok, readJson } from "../utils/http.ts";
import { changePasswordSchema, loginSchema, resetConfirmSchema, resetTokenSchema } from "../validators/auth.ts";

const client = (c: Context<AppEnv>) => ({ ip: c.get("clientIp"), userAgent: c.req.header("user-agent") ?? null });

const loginLimiter = rateLimit({
  windowMs: 60_000,
  max: env.LOGIN_RATE_LIMIT_PER_MINUTE,
  keyPrefix: "login",
  message: "Too many sign-in attempts. Please wait a minute and try again.",
});

const resetLimiter = rateLimit({ windowMs: 60_000, max: 20, keyPrefix: "password-reset" });

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/login", loginLimiter, async (c) => {
  const input = await readJson(c, loginSchema);
  const result = await authService.login(input.username, input.password, client(c));
  setCookie(c, SESSION_COOKIE, result.token, {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: "Strict",
    path: "/",
    expires: result.expiresAt,
  });
  return ok(c, result.profile, "Signed in successfully.");
});

authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await authService.logout(token, client(c));
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: cookieSecure });
  return ok(c, null, "Signed out.");
});

authRoutes.get("/me", requireAuth, async (c) => ok(c, await authService.getProfile(c.get("actor").id)));

authRoutes.post("/change-password", requireAuth, async (c) => {
  const input = await readJson(c, changePasswordSchema);
  await authService.changePassword(c.get("actor"), input.currentPassword, input.newPassword);
  return ok(c, await authService.getProfile(c.get("actor").id), "Password changed successfully.");
});

authRoutes.post("/password-reset/verify", resetLimiter, async (c) => {
  const input = await readJson(c, resetTokenSchema);
  return ok(c, await authService.checkPasswordReset(input.token));
});

authRoutes.post("/password-reset/confirm", resetLimiter, async (c) => {
  const input = await readJson(c, resetConfirmSchema);
  await authService.confirmPasswordReset(input.token, input.newPassword, client(c));
  return ok(c, null, "Password has been reset. You can now sign in.");
});
