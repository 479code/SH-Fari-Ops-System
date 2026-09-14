/**
 * tokens.ts — opaque random tokens and their keyed hashes.
 *
 * The browser holds the raw token; the database holds only HMAC(secret, token).
 * A read-only database leak therefore yields nothing that can be replayed.
 */
import { createHmac, randomBytes } from "node:crypto";
import { env, isProduction } from "../config/env.ts";

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(token).digest("hex");
}

export function hashResetToken(token: string): string {
  return createHmac("sha256", env.AUTH_SECRET).update(token).digest("hex");
}

/** `__Host-` forces Secure, Path=/ and no Domain — only possible over HTTPS. */
export const SESSION_COOKIE = isProduction ? "__Host-shfari_session" : "shfari_session";
