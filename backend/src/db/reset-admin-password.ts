/**
 * reset-admin-password.ts — operator recovery from the server shell.
 *
 *   bun run admin:reset-password <username> --password '<temporary password>'
 *   bun run admin:reset-password <username> --password '<temporary password>' --create
 *
 * `db:seed` never changes an existing account's password (it runs on every
 * deploy), so this is the supported way to set or recover one. The account is
 * reactivated and unlocked, all its sessions are revoked, and the password must
 * be changed at the next sign-in. Without --password, SEED_ADMIN_PASSWORD is
 * used; if that is empty too, a strong temporary password is generated and
 * printed once. --create adds the user as a System Administrator if missing.
 */
import { and, eq, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../auth/password.ts";
import { env } from "../config/env.ts";
import { recordAudit } from "../services/audit.service.ts";
import { logger } from "../utils/logger.ts";
import { closeDb, db } from "./client.ts";
import { roles, sessions, userRoles, users } from "./schema/index.ts";

export interface ResetResult {
  username: string;
  created: boolean;
  generatedPassword?: string;
  /** The temporary password is below the normal password policy. */
  weak: boolean;
}

export async function resetUserPassword(options: { username: string; password?: string; create?: boolean }): Promise<ResetResult> {
  const username = options.username.trim().toLowerCase();
  if (!username) throw new Error("A username is required.");
  const generatedPassword = options.password ? undefined : `${randomBytes(9).toString("base64url")}7a`;
  const password = options.password ?? generatedPassword!;
  const passwordHash = await hashPassword(password);
  const weak = password.length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password);

  const created = await db.transaction(async (tx) => {
    const [user] = await tx.select({ id: users.id, deletedAt: users.deletedAt }).from(users).where(eq(users.username, username)).limit(1);
    const now = new Date();

    if (user?.deletedAt) throw new Error(`User "${username}" was deleted and cannot be restored. Choose a different username with --create.`);

    if (user) {
      await tx
        .update(users)
        .set({ passwordHash, status: "active", mustChangePassword: true, failedLoginCount: 0, lockedUntil: null, passwordChangedAt: now })
        .where(eq(users.id, user.id));
      await tx.update(sessions).set({ revokedAt: now }).where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)));
      await recordAudit(tx, null, {
        action: "password_reset_completed",
        resource: "users",
        resourceId: user.id,
        recordRef: username,
        newValue: { via: "server command", reactivated: true, unlocked: true },
      });
      return false;
    }

    if (!options.create) {
      throw new Error(`No user named "${username}". Re-run with --create to add them as a System Administrator.`);
    }
    const [adminRole] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, "System Administrator"));
    if (!adminRole) throw new Error("Roles are not installed yet. Run `bun run db:migrate` and `bun run db:seed` first.");
    const [inserted] = await tx.insert(users).values({ username, fullName: env.SEED_ADMIN_NAME, passwordHash, mustChangePassword: true }).$returningId();
    await tx.insert(userRoles).values({ userId: inserted!.id, roleId: adminRole.id });
    await recordAudit(tx, null, {
      action: "created",
      resource: "user",
      resourceId: inserted!.id,
      recordRef: username,
      newValue: { via: "server command", roles: ["System Administrator"] },
    });
    return true;
  });

  return { username, created, generatedPassword, weak };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const passwordIndex = args.indexOf("--password");
  const passwordArg = passwordIndex === -1 ? undefined : args[passwordIndex + 1];
  const positional = args.filter((a, i) => !a.startsWith("--") && i !== passwordIndex + 1);
  const username = positional[0] ?? env.SEED_ADMIN_USERNAME;
  const password = passwordArg || env.SEED_ADMIN_PASSWORD || undefined;

  try {
    const result = await resetUserPassword({ username, password, create: args.includes("--create") });
    console.log(`\n${result.created ? "Created administrator" : "Password set for"} "${result.username}" (account active and unlocked).`);
    if (result.generatedPassword) console.log(`Temporary password: ${result.generatedPassword}`);
    console.log("This password must be changed at the first sign-in.");
    if (result.weak && !result.generatedPassword) {
      console.log("Note: it is below the password policy, so the new password chosen at sign-in must be at least 10 characters with letters and numbers.");
    }
    console.log("");
    await closeDb();
    process.exit(0);
  } catch (err) {
    logger.error("password reset command failed", { err });
    console.error(`\n${(err as Error).message}\n`);
    await closeDb();
    process.exit(1);
  }
}
