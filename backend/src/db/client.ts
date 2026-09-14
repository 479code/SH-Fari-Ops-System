/**
 * client.ts — the MariaDB pool and Drizzle handle.
 *
 * STANDING CONSTRAINT: never use Drizzle's relational query API (`db.query.*`).
 * It emits LATERAL joins, which MariaDB does not support. Every query here is an
 * explicit select/join.
 */
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { sql, type SQL } from "drizzle-orm";
import mysql from "mysql2/promise";
import { env } from "../config/env.ts";
import { logger } from "../utils/logger.ts";

export const pool = mysql.createPool({
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
  database: env.DATABASE_NAME,
  connectionLimit: env.DATABASE_POOL_SIZE,
  waitForConnections: true,
  enableKeepAlive: true,
  // DECIMAL/SUM come back as numbers; rounding is handled explicitly (utils/numbers.ts).
  decimalNumbers: true,
  supportBigNumbers: false,
  timezone: "Z",
  charset: "utf8mb4_unicode_ci",
});

// Every instant is UTC. Pin the session zone so CURRENT_TIMESTAMP defaults agree
// with the values Drizzle serialises from JS Dates.
pool.on("connection", (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

export const db: MySql2Database = drizzle({
  client: pool,
  casing: "snake_case",
  logger:
    env.LOG_LEVEL === "debug"
      ? { logQuery: (query: string, params: unknown[]) => logger.debug("sql", { query, paramCount: params.length }) }
      : false,
});

export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything a repository can run a query against: the pool or an open transaction. */
export type Executor = Db | Tx;

/** Runs a raw SELECT and returns its rows. */
export async function selectRows<T>(executor: Executor, query: SQL): Promise<T[]> {
  const [rows] = (await executor.execute(query)) as unknown as [T[], unknown];
  return rows;
}

export async function pingDb(): Promise<boolean> {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch (err) {
    logger.error("database ping failed", { err });
    return false;
  }
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
