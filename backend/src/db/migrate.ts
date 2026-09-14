/**
 * migrate.ts — applies pending migrations from src/db/migrations.
 *
 * Run as a deploy step (`bun run db:migrate`), never on API boot: two instances
 * starting together would race, and a bad migration should fail the deploy
 * before traffic reaches the new version.
 */
import { migrate } from "drizzle-orm/mysql2/migrator";
import { db, closeDb } from "./client.ts";
import { logger } from "../utils/logger.ts";

export const migrationsFolder = new URL("./migrations", import.meta.url).pathname;

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder });
}

if (import.meta.main) {
  const started = Date.now();
  try {
    await runMigrations();
    logger.info("migrations applied", { durationMs: Date.now() - started });
    await closeDb();
    process.exit(0);
  } catch (err) {
    logger.error("migration failed", { err });
    await closeDb();
    process.exit(1);
  }
}
