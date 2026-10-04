/**
 * seed.ts — idempotent baseline data required by every installation.
 *
 * - syncs the permission catalogue (src/auth/permissions.ts) into the database
 * - creates the system roles (existing roles keep any permission customisation;
 *   System Administrator is always granted every permission)
 * - registers the core products (PMS, AGO, DPK) and default control settings
 * - creates the first administrator if no active administrator exists
 *
 * Safe to run on every deploy. It never touches transactional data and never
 * changes an existing account's password — use `bun run admin:reset-password`.
 */
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { env } from "../config/env.ts";
import { ALL_PERMISSIONS, PERMISSIONS, SYSTEM_ROLES } from "../auth/permissions.ts";
import { hashPassword } from "../auth/password.ts";
import { settingsSchema } from "../services/settings.service.ts";
import { logger } from "../utils/logger.ts";
import { closeDb, db } from "./client.ts";
import { permissions, products, rolePermissions, roles, settings, userRoles, users } from "./schema/index.ts";

const CORE_PRODUCTS = [
  { code: "PMS", name: "Premium Motor Spirit" },
  { code: "AGO", name: "Automotive Gas Oil" },
  { code: "DPK", name: "Dual Purpose Kerosene" },
];

export interface SeedResult {
  adminCreated: boolean;
  generatedPassword?: string;
  /** Active administrators that already existed (when none was created). */
  existingAdmins: string[];
}

export async function seedCore(): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    // Permissions
    for (const code of ALL_PERMISSIONS) {
      const meta = PERMISSIONS[code];
      await tx
        .insert(permissions)
        .values({ code, module: meta.module, description: meta.description })
        .onDuplicateKeyUpdate({ set: { module: meta.module, description: meta.description } });
    }
    await tx.delete(permissions).where(notInArray(permissions.code, ALL_PERMISSIONS));
    const permRows = await tx.select({ id: permissions.id, code: permissions.code }).from(permissions);
    const permId = new Map(permRows.map((p) => [p.code, p.id]));

    // System roles
    for (const def of SYSTEM_ROLES) {
      const [existing] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, def.name));
      let roleId = existing?.id;
      if (!roleId) {
        const [inserted] = await tx.insert(roles).values({ name: def.name, description: def.description, isSystem: true }).$returningId();
        roleId = inserted!.id;
        await tx.insert(rolePermissions).values(def.permissions.map((code) => ({ roleId: roleId!, permissionId: permId.get(code)! })));
      } else {
        await tx.update(roles).set({ isSystem: true }).where(eq(roles.id, roleId));
        if (def.name === "System Administrator") {
          await tx.insert(rolePermissions).ignore().values(ALL_PERMISSIONS.map((code) => ({ roleId: roleId!, permissionId: permId.get(code)! })));
        }
      }
    }

    // Products and settings
    await tx.insert(products).ignore().values(CORE_PRODUCTS);
    const defaults = settingsSchema.parse({});
    await tx.insert(settings).ignore().values(Object.entries(defaults).map(([key, value]) => ({ key, value: JSON.stringify(value) })));

    // First administrator
    const [adminRole] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, "System Administrator"));
    const activeAdmins = await tx
      .select({ username: users.username })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .where(and(eq(userRoles.roleId, adminRole!.id), eq(users.status, "active"), isNull(users.deletedAt)));
    if (activeAdmins.length > 0) return { adminCreated: false, existingAdmins: activeAdmins.map((a) => a.username) };

    const username = env.SEED_ADMIN_USERNAME.toLowerCase();
    const [taken] = await tx.select({ id: users.id }).from(users).where(inArray(users.username, [username]));
    if (taken) {
      throw new Error(
        `No active administrator exists, but username "${username}" is taken. Run \`bun run admin:reset-password ${username} --password '<password>'\` to recover it, or set SEED_ADMIN_USERNAME to a free username.`,
      );
    }

    const generatedPassword = env.SEED_ADMIN_PASSWORD ? undefined : `${randomBytes(9).toString("base64url")}7a`;
    const [admin] = await tx
      .insert(users)
      .values({
        username,
        fullName: env.SEED_ADMIN_NAME,
        passwordHash: await hashPassword(env.SEED_ADMIN_PASSWORD ?? generatedPassword!),
        mustChangePassword: true,
      })
      .$returningId();
    await tx.insert(userRoles).values({ userId: admin!.id, roleId: adminRole!.id });
    return { adminCreated: true, generatedPassword, existingAdmins: [] };
  });
}

if (import.meta.main) {
  try {
    const result = await seedCore();
    logger.info("core seed complete", { adminCreated: result.adminCreated, adminUsername: result.adminCreated ? env.SEED_ADMIN_USERNAME : undefined });
    if (result.adminCreated) {
      // Printed once to the operator's terminal only; never logged as structured data.
      console.log(
        `\nAdministrator created: username "${env.SEED_ADMIN_USERNAME.toLowerCase()}"${result.generatedPassword ? `, temporary password: ${result.generatedPassword}` : " (password from SEED_ADMIN_PASSWORD)"}.\nIt must be changed at first sign-in.\n`,
      );
    } else {
      const wanted = env.SEED_ADMIN_USERNAME.toLowerCase();
      const exists = result.existingAdmins.includes(wanted);
      console.log(
        `\nAn active administrator already exists (${result.existingAdmins.join(", ")}), so no account was created and SEED_ADMIN_PASSWORD was NOT applied — seeding never changes existing passwords.\n` +
          `To set a password on this server, run:\n  bun run admin:reset-password ${wanted} --password '<temporary password>'${exists ? "" : " --create"}\n`,
      );
    }
    await closeDb();
    process.exit(0);
  } catch (err) {
    logger.error("core seed failed", { err });
    console.error(`\n${(err as Error).message}\n`);
    await closeDb();
    process.exit(1);
  }
}
