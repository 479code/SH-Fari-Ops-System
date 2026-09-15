/**
 * roles.service.ts — roles and their permission sets.
 *
 * A role manager can only create or edit roles within their own access, so
 * roles.manage cannot be used to mint a more powerful role.
 */
import { and, count, eq, inArray, ne } from "drizzle-orm";
import { db, type Tx } from "../db/client.ts";
import { permissions, rolePermissions, roles, userRoles } from "../db/schema/index.ts";
import type { Actor } from "../types.ts";
import { AppError, conflict, notFound } from "../utils/errors.ts";
import { recordAudit } from "./audit.service.ts";
import { assertAdministratorsRemain, assertWithinActorAccess, permissionsOfRoles } from "./users.service.ts";

const BEYOND_OWN = "You cannot grant permissions you do not have.";
const OUTRANKED = "You cannot change a role that has access you do not have.";

export async function listRoles() {
  const [roleRows, grants, counts] = await Promise.all([
    db.select().from(roles).orderBy(roles.name),
    db
      .select({ roleId: rolePermissions.roleId, code: permissions.code })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId)),
    db.select({ roleId: userRoles.roleId, n: count() }).from(userRoles).groupBy(userRoles.roleId),
  ]);
  return roleRows.map((r) => ({
    ...r,
    permissions: grants.filter((g) => g.roleId === r.id).map((g) => g.code).sort(),
    userCount: counts.find((c) => c.roleId === r.id)?.n ?? 0,
  }));
}

export async function listPermissionCatalogue() {
  const rows = await db.select().from(permissions).orderBy(permissions.module, permissions.code);
  const modules = new Map<string, { code: string; description: string }[]>();
  for (const r of rows) {
    const list = modules.get(r.module) ?? [];
    list.push({ code: r.code, description: r.description });
    modules.set(r.module, list);
  }
  return [...modules.entries()].map(([module, items]) => ({ module, permissions: items }));
}

async function permissionIds(tx: Tx, codes: string[]) {
  const unique = [...new Set(codes)];
  if (unique.length === 0) return [];
  const rows = await tx.select({ id: permissions.id, code: permissions.code }).from(permissions).where(inArray(permissions.code, unique));
  if (rows.length !== unique.length) {
    throw new AppError("VALIDATION_ERROR", "Some permissions are not installed. Run `bun run db:seed` to sync the permission catalogue.", {
      fields: { permissions: "Unknown permission." },
    });
  }
  return rows.map((r) => r.id);
}

export async function createRole(actor: Actor, input: { name: string; description?: string | null; permissions: string[] }) {
  assertWithinActorAccess(actor, input.permissions, BEYOND_OWN);
  await db.transaction(async (tx) => {
    const [dup] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, input.name));
    if (dup) throw new AppError("CONFLICT", `A role named ${input.name} already exists.`, { fields: { name: "Role name already in use." } });
    const ids = await permissionIds(tx, input.permissions);
    const [inserted] = await tx.insert(roles).values({ name: input.name, description: input.description ?? null }).$returningId();
    if (ids.length > 0) await tx.insert(rolePermissions).values(ids.map((permissionId) => ({ roleId: inserted!.id, permissionId })));
    await recordAudit(tx, actor, {
      action: "permissions_changed",
      resource: "role",
      resourceId: inserted!.id,
      recordRef: input.name,
      newValue: { name: input.name, permissions: [...new Set(input.permissions)].sort() },
    });
  });
  return listRoles();
}

export async function updateRole(actor: Actor, id: number, input: { name?: string; description?: string | null; permissions?: string[] }) {
  await db.transaction(async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, id)).for("update");
    if (!role) throw notFound("Role");
    assertWithinActorAccess(actor, await permissionsOfRoles(tx, [id]), OUTRANKED);
    if (input.name && input.name !== role.name) {
      const [dup] = await tx.select({ id: roles.id }).from(roles).where(and(eq(roles.name, input.name), ne(roles.id, id)));
      if (dup) throw new AppError("CONFLICT", `A role named ${input.name} already exists.`, { fields: { name: "Role name already in use." } });
      if (role.isSystem) throw conflict("System roles cannot be renamed.");
    }
    const patch: Partial<typeof roles.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (Object.keys(patch).length > 0) await tx.update(roles).set(patch).where(eq(roles.id, id));

    let added: string[] = [];
    let removed: string[] = [];
    if (input.permissions) {
      assertWithinActorAccess(actor, input.permissions, BEYOND_OWN);
      const current = (
        await tx
          .select({ code: permissions.code })
          .from(rolePermissions)
          .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
          .where(eq(rolePermissions.roleId, id))
      ).map((r) => r.code);
      const next = [...new Set(input.permissions)];
      added = next.filter((c) => !current.includes(c)).sort();
      removed = current.filter((c) => !next.includes(c)).sort();
      if (added.length || removed.length) {
        const ids = await permissionIds(tx, next);
        await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
        if (ids.length > 0) await tx.insert(rolePermissions).values(ids.map((permissionId) => ({ roleId: id, permissionId })));
        await assertAdministratorsRemain(tx);
      }
    }
    await recordAudit(tx, actor, {
      action: added.length || removed.length ? "permissions_changed" : "updated",
      resource: "role",
      resourceId: id,
      recordRef: role.name,
      oldValue: { name: role.name, description: role.description, ...(removed.length ? { removed } : {}) },
      newValue: { ...patch, ...(added.length ? { added } : {}), ...(removed.length ? { removed } : {}) },
    });
  });
  return listRoles();
}

export async function deleteRole(actor: Actor, id: number) {
  await db.transaction(async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, id)).for("update");
    if (!role) throw notFound("Role");
    if (role.isSystem) throw conflict("System roles cannot be deleted.");
    assertWithinActorAccess(actor, await permissionsOfRoles(tx, [id]), OUTRANKED);
    const [assigned] = await tx.select({ n: count() }).from(userRoles).where(eq(userRoles.roleId, id));
    if (assigned && assigned.n > 0) throw conflict(`This role is assigned to ${assigned.n} user(s). Reassign them first.`);
    await tx.delete(roles).where(eq(roles.id, id));
    await recordAudit(tx, actor, { action: "deleted", resource: "role", resourceId: id, recordRef: role.name, oldValue: { name: role.name } });
  });
}
