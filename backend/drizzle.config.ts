/**
 * drizzle.config.ts — used by drizzle-kit for migration generation and studio.
 *
 * `bun run db:generate` diffs src/db/schema against src/db/migrations and writes
 * the next SQL file. Migrations are applied by `bun run db:migrate`
 * (src/db/migrate.ts). `drizzle-kit push` is never used against real data.
 *
 * Run through `bunx --bun` so Bun loads backend/.env before this file executes.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "mysql",
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  casing: "snake_case",
  dbCredentials: {
    host: process.env.DATABASE_HOST ?? "127.0.0.1",
    port: Number(process.env.DATABASE_PORT ?? 3306),
    user: process.env.DATABASE_USER ?? "",
    password: process.env.DATABASE_PASSWORD ?? "",
    database: process.env.DATABASE_NAME ?? "",
  },
  strict: true,
  verbose: true,
});
