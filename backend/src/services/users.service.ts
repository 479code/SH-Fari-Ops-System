/**
 * users.service.ts — user administration.
 *
 * New users receive an administrator-set temporary password and must change it
 * at first sign-in. Guards:
 *  - at least one active user must always hold users.manage and roles.manage;
 *  - nobody can grant, or act on an account holding, access they lack themselves
 *    (so a delegated user administrator cannot escalate to System Administrator).
 */
import { and, count, eq, inArray, isNull, like, ne, or, sql, type SQL } from "drizzle-orm";
import { hashPassword } from "../auth/password.ts";
import { db, selectRows, type Executor, type Tx } from "../db/client.ts";
import { permissions, rolePermissions, roles, sessions, stations, userRoles, users } from "../db/schema/index.ts";
import type { Actor } from "../types.ts";
import { AppError, conflict, notFound } from "../utils/errors.ts";
import { paginationMeta } from "../utils/http.ts";
import { num } from "../utils/numbers.ts";
import { likeContains } from "../utils/sql.ts";
import { recordAudit } from "./audit.service.ts";
import { issuePasswordReset } from "./auth.service.ts";

/** Throws (rolling back the transaction) if no active user could still administer access. */
export async function assertAdministratorsRemain(tx: Tx): Promise<void> {
  const rows = await selectRows<{ code: string; n: number }>(
    tx,
    sql`SELECT p.code, COUNT(DISTINCT u.id) AS n
        FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN role_permissions rp ON rp.role_id = ur.role_id
        JOIN permissions p ON p.id = rp.permission_id
        WHERE u.status = 'active' AND u.deleted_at IS NULL AND p.code IN ('users.manage', 'roles.manage')
        GROUP BY p.code`,
  );
  const has = (code: string) => num(rows.find((r) => r.code === code)?.n) > 0;
  if (!has("users.manage") || !has("roles.manage")) {
    throw conflict("This change would leave no active user able to manage users and roles.");
  }
}

/** Permission codes granted by a set of roles. */
export async function permissionsOfRoles(ex: Executor, roleIds: number[]): Promise<string[]> {
  if (roleIds.length === 0) return [];
  const rows = await ex
    .selectDistinct({ code: permissions.code })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(inArray(rolePermissions.roleId, roleIds));
  return rows.map((r) => r.code);
}

async function permissionsOfUser(ex: Executor, userId: number): Promise<string[]> {
  const roleRows = await ex.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, userId));
  return permissionsOfRoles(ex, roleRows.map((r) => r.roleId));
}

/** Rejects when `codes` includes a permission the actor does not hold. */
export function assertWithinActorAccess(actor: Actor, codes: string[], message: string): void {
  if (codes.some((code) => !actor.permissions.has(code))) throw new AppError("FORBIDDEN", message);
}

const OUTRANKED = "You cannot manage an account that has access you do not have.";

async function roleNames(tx: Tx, roleIds: number[]) {
  if (roleIds.length === 0) return [];
  const rows = await tx.select({ id: roles.id, name: roles.name }).from(roles).where(inArray(roles.id, roleIds));
  if (rows.length !== new Set(roleIds).size) {
    throw new AppError("VALIDATION_ERROR", "One or more selected roles do not exist.", { fields: { roleIds: "Select valid roles." } });
  }
  return rows.map((r) => r.name).sort();
}

async function assertStation(tx: Tx, stationId: number | null | undefined) {
  if (!stationId) return;
  const [s] = await tx.select({ id: stations.id }).from(stations).where(eq(stations.id, stationId));
  if (!s) throw new AppError("VALIDATION_ERROR", "Select a valid station.", { fields: { stationId: "Select a valid station." } });
}

const userColumns = {
  id: users.id,
  username: users.username,
  fullName: users.fullName,
  email: users.email,
  phone: users.phone,
  stationId: users.stationId,
  stationName: stations.name,
  status: users.status,
  mustChangePassword: users.mustChangePassword,
  lockedUntil: users.lockedUntil,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  roles: sql<string | null>`(SELECT GROUP_CONCAT(r.name ORDER BY r.name SEPARATOR ', ') FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ${users.id})`,
  roleIds: sql<string | null>`(SELECT GROUP_CONCAT(ur.role_id) FROM user_roles ur WHERE ur.user_id = ${users.id})`,
};

function present<T extends { roleIds: string | null; lockedUntil: Date | null }>(row: T) {
  return {
    ...row,
    roleIds: (row.roleIds ?? "").split(",").filter(Boolean).map(Number),
    locked: row.lockedUntil !== null && row.lockedUntil.getTime() > Date.now(),
  };
}

export async function listUsers(q: { search?: string; stationId?: number; roleId?: number; status?: "active" | "suspended"; page: number; limit: number }) {
  const conds: SQL[] = [isNull(users.deletedAt)];
  if (q.search) {
    const p = likeContains(q.search);
    conds.push(or(like(users.fullName, p), like(users.username, p), like(users.email, p))!);
  }
  if (q.stationId) conds.push(eq(users.stationId, q.stationId));
  if (q.status) conds.push(eq(users.status, q.status));
  if (q.roleId) conds.push(sql`EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = ${users.id} AND ur.role_id = ${q.roleId})`);
  const where = and(...conds);

  const [rows, [total]] = await Promise.all([
    db
      .select(userColumns)
      .from(users)
      .leftJoin(stations, eq(stations.id, users.stationId))
      .where(where)
      .orderBy(users.status, users.fullName)
      .limit(q.limit)
      .offset((q.page - 1) * q.limit),
    db.select({ n: count() }).from(users).where(where),
  ]);
  return { rows: rows.map(present), pagination: paginationMeta(q.page, q.limit, total?.n ?? 0) };
}

export async function getUser(id: number) {
  const [row] = await db
    .select(userColumns)
    .from(users)
    .leftJoin(stations, eq(stations.id, users.stationId))
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .limit(1);
  if (!row) throw notFound("User");
  return present(row);
}

export async function createUser(
  actor: Actor,
  input: { username: string; fullName: string; email?: string | null; phone?: string | null; stationId?: number | null; roleIds: number[]; password: string },
) {
  const passwordHash = await hashPassword(input.password);
  const id = await db.transaction(async (tx) => {
    const [byUsername] = await tx.select({ id: users.id }).from(users).where(eq(users.username, input.username));
    if (byUsername) throw new AppError("CONFLICT", `Username ${input.username} is already taken.`, { fields: { username: "Username already taken." } });
    if (input.email) {
      const [byEmail] = await tx.select({ id: users.id }).from(users).where(eq(users.email, input.email));
      if (byEmail) throw new AppError("CONFLICT", "That email address is already in use.", { fields: { email: "Email already in use." } });
    }
    await assertStation(tx, input.stationId);
    const names = await roleNames(tx, input.roleIds);
    assertWithinActorAccess(actor, await permissionsOfRoles(tx, input.roleIds), "You cannot assign a role that grants access you do not have.");

    const [inserted] = await tx
      .insert(users)
      .values({
        username: input.username,
        fullName: input.fullName,
        email: input.email ?? null,
        phone: input.phone ?? null,
        stationId: input.stationId ?? null,
        passwordHash,
        mustChangePassword: true,
        createdBy: actor.id,
      })
      .$returningId();
    const userId = inserted!.id;
    await tx.insert(userRoles).values([...new Set(input.roleIds)].map((roleId) => ({ userId, roleId })));

    await recordAudit(tx, actor, {
      action: "created",
      resource: "user",
      resourceId: userId,
      recordRef: input.username,
      stationId: input.stationId ?? null,
      newValue: { username: input.username, fullName: input.fullName, email: input.email ?? null, stationId: input.stationId ?? null, roles: names },
    });
    return userId;
  });
  return getUser(id);
}

export async function updateUser(
  actor: Actor,
  id: number,
  input: { fullName?: string; email?: string | null; phone?: string | null; stationId?: number | null; roleIds?: number[]; status?: "active" | "suspended" },
) {
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(and(eq(users.id, id), isNull(users.deletedAt))).for("update");
    if (!user) throw notFound("User");
    if (id === actor.id && input.status === "suspended") throw new AppError("FORBIDDEN", "You cannot suspend your own account.");
    assertWithinActorAccess(actor, await permissionsOfUser(tx, id), OUTRANKED);
    if (input.email && input.email !== user.email) {
      const [byEmail] = await tx.select({ id: users.id }).from(users).where(and(eq(users.email, input.email), ne(users.id, id)));
      if (byEmail) throw new AppError("CONFLICT", "That email address is already in use.", { fields: { email: "Email already in use." } });
    }
    if (input.stationId !== undefined) await assertStation(tx, input.stationId);

    const { roleIds, ...fields } = input;
    const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const oldValue: Record<string, unknown> = Object.fromEntries(Object.keys(patch).map((k) => [k, user[k as keyof typeof user]]));
    const newValue: Record<string, unknown> = { ...patch };

    if (Object.keys(patch).length > 0) await tx.update(users).set(patch).where(eq(users.id, id));

    let rolesChanged = false;
    if (roleIds) {
      const current = await tx.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, id));
      const before = current.map((r) => r.roleId).sort((a, b) => a - b);
      const after = [...new Set(roleIds)].sort((a, b) => a - b);
      if (before.join(",") !== after.join(",")) {
        rolesChanged = true;
        oldValue.roles = await roleNames(tx, before);
        newValue.roles = await roleNames(tx, after);
        assertWithinActorAccess(actor, await permissionsOfRoles(tx, after), "You cannot assign a role that grants access you do not have.");
        await tx.delete(userRoles).where(eq(userRoles.userId, id));
        await tx.insert(userRoles).values(after.map((roleId) => ({ userId: id, roleId })));
      }
    }
    if (Object.keys(newValue).length === 0) return;

    if (input.status === "suspended" && user.status !== "suspended") {
      await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)));
    }
    await assertAdministratorsRemain(tx);
    await recordAudit(tx, actor, {
      action: rolesChanged ? "permissions_changed" : "updated",
      resource: "user",
      resourceId: id,
      recordRef: user.username,
      stationId: user.stationId,
      oldValue,
      newValue,
    });
  });
  return getUser(id);
}

export async function deleteUser(actor: Actor, id: number) {
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(and(eq(users.id, id), isNull(users.deletedAt))).for("update");
    if (!user) throw notFound("User");
    if (id === actor.id) throw new AppError("FORBIDDEN", "You cannot delete your own account.");
    assertWithinActorAccess(actor, await permissionsOfUser(tx, id), OUTRANKED);
    const now = new Date();
    await tx.update(users).set({ deletedAt: now, status: "suspended" }).where(eq(users.id, id));
    await tx.update(sessions).set({ revokedAt: now }).where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)));
    await assertAdministratorsRemain(tx);
    await recordAudit(tx, actor, {
      action: "deleted",
      resource: "user",
      resourceId: id,
      recordRef: user.username,
      stationId: user.stationId,
      oldValue: { status: user.status },
      newValue: { deleted: true },
    });
  });
}

export async function unlockUser(actor: Actor, id: number) {
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(and(eq(users.id, id), isNull(users.deletedAt))).for("update");
    if (!user) throw notFound("User");
    await tx.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, id));
    await recordAudit(tx, actor, {
      action: "updated",
      resource: "user",
      resourceId: id,
      recordRef: user.username,
      oldValue: { lockedUntil: user.lockedUntil },
      newValue: { unlocked: true },
    });
  });
  return getUser(id);
}

/** A reset link hands over the account, so the same no-escalation rule applies. */
export async function issueUserPasswordReset(actor: Actor, id: number) {
  const [user] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, id), isNull(users.deletedAt))).limit(1);
  if (!user) throw notFound("User");
  assertWithinActorAccess(actor, await permissionsOfUser(db, id), OUTRANKED);
  return issuePasswordReset(actor, id);
}
