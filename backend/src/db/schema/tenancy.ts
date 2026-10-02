/**
 * tenancy.ts — companies (tenants).
 *
 * Every station and every non-platform user belongs to exactly one company.
 * `users.companyId = null` (see auth.ts) is reserved for the platform
 * super-administrator, who can see and manage every company; every other
 * actor is confined to their own company by backend/src/auth/scope.ts.
 */
import { mysqlEnum, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { createdAt, id, updatedAt } from "./columns.ts";

export const companies = mysqlTable("companies", {
  id: id(),
  /** Short code used in document references, e.g. company-scoped station codes. */
  code: varchar({ length: 10 }).notNull().unique(),
  name: varchar({ length: 120 }).notNull().unique(),
  /** Public URL/path of the uploaded company logo, shown on login and in the shell for that company's users. */
  logoUrl: varchar({ length: 255 }),
  status: mysqlEnum(["active", "inactive"]).notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
