/**
 * auth.service.ts — sign-in, sessions, password change and password reset.
 *
 * Brute force is limited twice: per IP by the login rate limiter, and per
 * account here — LOGIN_MAX_ATTEMPTS consecutive failures lock the account for
 * LOGIN_LOCKOUT_MINUTES. Every attempt, success or failure, is audit logged.
 */
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { env } from "../config/env.ts";
import { db } from "../db/client.ts";
import {
  passwordResetTokens,
  permissions,
  rolePermissions,
  roles,
  sessions,
  stations,
  userRoles,
  users,
} from "../db/schema/index.ts";
import { burnPasswordCheck, hashPassword, verifyPassword } from "../auth/password.ts";
import { hashResetToken, hashSessionToken, newToken } from "../auth/tokens.ts";
import type { Actor } from "../types.ts";
import { AppError, notFound } from "../utils/errors.ts";
import { logger } from "../utils/logger.ts";
import { recordAudit } from "./audit.service.ts";

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export interface Profile {
  id: number;
  username: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  stationId: number | null;
  stationName: string | null;
  roles: string[];
  permissions: string[];
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
}

const who = (userId: number | null, client: ClientInfo) => ({ userId, ip: client.ip, userAgent: client.userAgent });

export async function loadAccess(userId: number): Promise<{ roles: string[]; permissions: string[] }> {
  const [roleRows, permRows] = await Promise.all([
    db
      .select({ name: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, userId)),
    db
      .selectDistinct({ code: permissions.code })
      .from(userRoles)
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(eq(userRoles.userId, userId)),
  ]);
  return { roles: roleRows.map((r) => r.name), permissions: permRows.map((p) => p.code).sort() };
}

export async function getProfile(userId: number): Promise<Profile> {
  const [row] = await db
    .select({
      id: users.id,
      username: users.username,
      fullName: users.fullName,
      email: users.email,
      phone: users.phone,
      stationId: users.stationId,
      stationName: stations.name,
      mustChangePassword: users.mustChangePassword,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .leftJoin(stations, eq(stations.id, users.stationId))
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!row) throw notFound("User");
  const access = await loadAccess(userId);
  return { ...row, ...access };
}

export async function login(
  username: string,
  password: string,
  client: ClientInfo,
): Promise<{ token: string; expiresAt: Date; profile: Profile }> {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.username, username), isNull(users.deletedAt)))
    .limit(1);

  const invalid = () => new AppError("UNAUTHORIZED", "Invalid username or password.");

  if (!user) {
    await burnPasswordCheck(password);
    await recordAudit(db, who(null, client), {
      action: "login_failed",
      resource: "auth",
      recordRef: username,
      newValue: { reason: "unknown_user" },
    });
    throw invalid();
  }

  const now = new Date();
  if (user.lockedUntil && user.lockedUntil > now) {
    await burnPasswordCheck(password);
    const minutes = Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60_000);
    await recordAudit(db, who(user.id, client), {
      action: "login_failed",
      resource: "auth",
      resourceId: user.id,
      recordRef: user.username,
      newValue: { reason: "account_locked" },
    });
    throw new AppError(
      "RATE_LIMITED",
      `This account is temporarily locked after repeated failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"} or contact your administrator.`,
    );
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    const lockUntil = new Date(now.getTime() + env.LOGIN_LOCKOUT_MINUTES * 60_000);
    const willLock = user.failedLoginCount + 1 >= env.LOGIN_MAX_ATTEMPTS;
    // Increment in SQL so concurrent failures are all counted.
    await db
      .update(users)
      .set({
        lockedUntil: sql`IF(${users.failedLoginCount} + 1 >= ${env.LOGIN_MAX_ATTEMPTS}, ${lockUntil}, ${users.lockedUntil})`,
        failedLoginCount: sql`IF(${users.failedLoginCount} + 1 >= ${env.LOGIN_MAX_ATTEMPTS}, 0, ${users.failedLoginCount} + 1)`,
      })
      .where(eq(users.id, user.id));
    await recordAudit(db, who(user.id, client), {
      action: "login_failed",
      resource: "auth",
      resourceId: user.id,
      recordRef: user.username,
      newValue: { reason: "wrong_password", accountLocked: willLock },
    });
    if (willLock) logger.warn("account locked after failed logins", { userId: user.id });
    throw invalid();
  }

  // Status is checked only after the password so suspension does not reveal valid usernames.
  if (user.status !== "active") {
    await recordAudit(db, who(user.id, client), {
      action: "login_failed",
      resource: "auth",
      resourceId: user.id,
      recordRef: user.username,
      newValue: { reason: "suspended" },
    });
    throw new AppError("FORBIDDEN", "This account is suspended. Contact your administrator.");
  }

  const token = newToken();
  const expiresAt = new Date(now.getTime() + env.SESSION_ABSOLUTE_HOURS * 3_600_000);
  await db.transaction(async (tx) => {
    await tx.insert(sessions).values({
      id: hashSessionToken(token),
      userId: user.id,
      ipAddress: client.ip,
      userAgent: client.userAgent?.slice(0, 255) ?? null,
      lastSeenAt: now,
      expiresAt,
    });
    await tx.update(users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now }).where(eq(users.id, user.id));
    await recordAudit(tx, who(user.id, client), {
      action: "login",
      resource: "auth",
      resourceId: user.id,
      recordRef: user.username,
    });
  });

  return { token, expiresAt, profile: await getProfile(user.id) };
}

/** Resolves a cookie token to an Actor, enforcing absolute and idle expiry. */
export async function resolveSession(token: string, client: ClientInfo): Promise<Actor | null> {
  if (token.length < 20 || token.length > 128) return null;
  const sessionId = hashSessionToken(token);
  const [row] = await db
    .select({
      userId: sessions.userId,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
      username: users.username,
      fullName: users.fullName,
      stationId: users.stationId,
      status: users.status,
      deletedAt: users.deletedAt,
      mustChangePassword: users.mustChangePassword,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (!row || row.revokedAt) return null;

  const now = Date.now();
  const idleExpired = row.lastSeenAt.getTime() + env.SESSION_IDLE_MINUTES * 60_000 <= now;
  if (row.expiresAt.getTime() <= now || idleExpired || row.status !== "active" || row.deletedAt) {
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
    return null;
  }

  // Touch at most once a minute to keep writes off the hot path.
  if (now - row.lastSeenAt.getTime() > 60_000) {
    await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, sessionId));
  }

  const access = await loadAccess(row.userId);
  return {
    id: row.userId,
    username: row.username,
    fullName: row.fullName,
    stationId: row.stationId,
    roles: access.roles,
    permissions: new Set(access.permissions),
    sessionId,
    mustChangePassword: row.mustChangePassword,
    ip: client.ip,
    userAgent: client.userAgent,
  };
}

/** Revokes the session behind a raw cookie token (works even if the session already expired). */
export async function logout(token: string, client: ClientInfo): Promise<void> {
  const sessionId = hashSessionToken(token);
  const [session] = await db.select({ userId: sessions.userId, revokedAt: sessions.revokedAt }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!session || session.revokedAt) return;
  await db.transaction(async (tx) => {
    await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
    await recordAudit(tx, who(session.userId, client), { action: "logout", resource: "auth", resourceId: session.userId });
  });
}

export async function changePassword(actor: Actor, currentPassword: string, newPassword: string): Promise<void> {
  const [user] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, actor.id)).limit(1);
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new AppError("VALIDATION_ERROR", "Current password is incorrect.", {
      fields: { currentPassword: "Current password is incorrect." },
    });
  }
  const passwordHash = await hashPassword(newPassword);
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: false, passwordChangedAt: new Date() })
      .where(eq(users.id, actor.id));
    // Sign out every other device; keep the session that made the change.
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, actor.id), ne(sessions.id, actor.sessionId), isNull(sessions.revokedAt)));
    await recordAudit(tx, actor, { action: "password_changed", resource: "users", resourceId: actor.id, recordRef: actor.username });
  });
}

/**
 * Issues a single-use reset token for a user. There is no outbound email service
 * in this deployment, so the administrator receives the link and hands it over;
 * only the token's HMAC is stored.
 */
export async function issuePasswordReset(actor: Actor, userId: number): Promise<{ token: string; expiresAt: Date }> {
  const [user] = await db
    .select({ id: users.id, username: users.username, stationId: users.stationId })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!user) throw notFound("User");

  const token = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + env.PASSWORD_RESET_TTL_MINUTES * 60_000);
  await db.transaction(async (tx) => {
    // Any earlier unused link stops working.
    await tx
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
    await tx.insert(passwordResetTokens).values({ userId, tokenHash: hashResetToken(token), expiresAt, createdBy: actor.id });
    await recordAudit(tx, actor, {
      action: "password_reset_issued",
      resource: "users",
      resourceId: userId,
      recordRef: user.username,
      newValue: { expiresAt: expiresAt.toISOString() },
    });
  });
  return { token, expiresAt };
}

async function findUsableResetToken(token: string) {
  const [row] = await db
    .select({
      id: passwordResetTokens.id,
      userId: passwordResetTokens.userId,
      expiresAt: passwordResetTokens.expiresAt,
      usedAt: passwordResetTokens.usedAt,
      username: users.username,
      fullName: users.fullName,
      deletedAt: users.deletedAt,
    })
    .from(passwordResetTokens)
    .innerJoin(users, eq(users.id, passwordResetTokens.userId))
    .where(eq(passwordResetTokens.tokenHash, hashResetToken(token)))
    .limit(1);
  if (!row || row.usedAt || row.deletedAt || row.expiresAt.getTime() <= Date.now()) {
    throw new AppError("BAD_REQUEST", "This password reset link is invalid or has expired. Ask your administrator for a new one.");
  }
  return row;
}

export async function checkPasswordReset(token: string): Promise<{ username: string; fullName: string; expiresAt: Date }> {
  const row = await findUsableResetToken(token);
  return { username: row.username, fullName: row.fullName, expiresAt: row.expiresAt };
}

export async function confirmPasswordReset(token: string, newPassword: string, client: ClientInfo): Promise<void> {
  const row = await findUsableResetToken(token);
  const passwordHash = await hashPassword(newPassword);
  const now = new Date();
  await db.transaction(async (tx) => {
    // Conditional update makes the token single-use even under a double submit.
    const [result] = await tx
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(and(eq(passwordResetTokens.id, row.id), isNull(passwordResetTokens.usedAt)));
    if (result.affectedRows !== 1) {
      throw new AppError("BAD_REQUEST", "This password reset link has already been used.");
    }
    await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: false, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, row.userId));
    await tx.update(sessions).set({ revokedAt: now }).where(and(eq(sessions.userId, row.userId), isNull(sessions.revokedAt)));
    await recordAudit(tx, who(row.userId, client), {
      action: "password_reset_completed",
      resource: "users",
      resourceId: row.userId,
      recordRef: row.username,
    });
  });
}

/** Housekeeping for the scheduler: drops sessions and reset tokens long past expiry. */
export async function purgeExpiredCredentials(): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 24 * 3_600_000);
  await db.delete(sessions).where(sql`${sessions.expiresAt} < ${cutoff}`);
  await db.delete(passwordResetTokens).where(sql`${passwordResetTokens.expiresAt} < ${cutoff}`);
}
