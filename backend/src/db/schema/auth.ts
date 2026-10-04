/** Users, RBAC, sessions and password-reset tokens. */
import { boolean, index, int, mysqlEnum, mysqlTable, primaryKey, varchar } from "drizzle-orm/mysql-core";
import { createdAt, fk, id, instant, updatedAt } from "./columns.ts";
import { stations } from "./master.ts";

export const users = mysqlTable(
  "users",
  {
    id: id(),
    username: varchar({ length: 60 }).notNull().unique(),
    fullName: varchar({ length: 120 }).notNull(),
    email: varchar({ length: 190 }).unique(),
    phone: varchar({ length: 30 }),
    passwordHash: varchar({ length: 255 }).notNull(),
    /** null = access to all stations. */
    stationId: fk().references(() => stations.id, { onDelete: "restrict" }),
    status: mysqlEnum(["active", "suspended"]).notNull().default("active"),
    mustChangePassword: boolean().notNull().default(false),
    failedLoginCount: int({ unsigned: true }).notNull().default(0),
    lockedUntil: instant(),
    lastLoginAt: instant(),
    passwordChangedAt: instant(),
    createdBy: fk(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: instant(),
  },
  (t) => [index("users_station_idx").on(t.stationId), index("users_status_idx").on(t.status)],
);

export const roles = mysqlTable("roles", {
  id: id(),
  name: varchar({ length: 80 }).notNull().unique(),
  description: varchar({ length: 255 }),
  /** System roles are seeded and cannot be deleted (their permissions can still be tuned). */
  isSystem: boolean().notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const permissions = mysqlTable("permissions", {
  id: id(),
  code: varchar({ length: 80 }).notNull().unique(),
  module: varchar({ length: 40 }).notNull(),
  description: varchar({ length: 255 }).notNull(),
});

export const rolePermissions = mysqlTable(
  "role_permissions",
  {
    roleId: fk()
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: fk()
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })],
);

export const userRoles = mysqlTable(
  "user_roles",
  {
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: fk()
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] }), index("user_roles_role_idx").on(t.roleId)],
);

export const sessions = mysqlTable(
  "sessions",
  {
    /** HMAC-SHA256 of the cookie token — the raw token is never stored. */
    id: varchar({ length: 64 }).primaryKey(),
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ipAddress: varchar({ length: 64 }),
    userAgent: varchar({ length: 255 }),
    createdAt: createdAt(),
    lastSeenAt: instant().notNull(),
    expiresAt: instant().notNull(),
    revokedAt: instant(),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

export const passwordResetTokens = mysqlTable(
  "password_reset_tokens",
  {
    id: id(),
    userId: fk()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar({ length: 64 }).notNull().unique(),
    expiresAt: instant().notNull(),
    usedAt: instant(),
    createdBy: fk().references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("password_reset_user_idx").on(t.userId)],
);
