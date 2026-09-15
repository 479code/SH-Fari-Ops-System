/**
 * drizzle.config.ts — used by drizzle-kit (generate, migrate, studio).
 *
 * Migrations are the committed SQL files in src/db/migrations. Prefer
 * `bun run db:migrate`; `drizzle-kit migrate` applies the same files and records
 * them in the same `__drizzle_migrations` table, so either works.
 *
 * `bunx drizzle-kit …` runs under Node, which does not read `.env` (only Bun
 * does). This file therefore loads backend/.env itself for any variable the
 * environment has not already set, so CI/SSH deploys hit the configured
 * database instead of silently falling back to an empty user and database.
 */
import { defineConfig } from "drizzle-kit";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match as unknown as [string, string, string];
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) > 0) {
      value = value.slice(1, value.indexOf(quote, 1));
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    process.env[key] = value;
  }
}

loadDotEnv(resolve(process.cwd(), ".env"));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`drizzle.config.ts: ${name} is not set (checked the environment and ${resolve(process.cwd(), ".env")}).`);
  return value;
}

export default defineConfig({
  dialect: "mysql",
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  casing: "snake_case",
  dbCredentials: {
    host: process.env.DATABASE_HOST || "127.0.0.1",
    port: Number(process.env.DATABASE_PORT || 3306),
    user: required("DATABASE_USER"),
    password: process.env.DATABASE_PASSWORD ?? "",
    database: required("DATABASE_NAME"),
  },
  strict: true,
  verbose: true,
});
