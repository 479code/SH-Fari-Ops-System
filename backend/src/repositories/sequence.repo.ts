import { sql } from "drizzle-orm";
import { selectRows, type Tx } from "../db/client.ts";

/**
 * Allocates the next value of a named counter.
 *
 * `LAST_INSERT_ID(expr)` makes the increment and the read a single atomic step
 * on the connection; the UPDATE's row lock serialises concurrent allocators.
 * It must run inside a transaction so both statements share one connection.
 */
export async function nextSequence(tx: Tx, name: string, start = 1): Promise<number> {
  await tx.execute(sql`INSERT IGNORE INTO ref_sequences (name, value) VALUES (${name}, ${start - 1})`);
  await tx.execute(sql`UPDATE ref_sequences SET value = LAST_INSERT_ID(value + 1) WHERE name = ${name}`);
  const [row] = await selectRows<{ v: number | string }>(tx, sql`SELECT LAST_INSERT_ID() AS v`);
  return Number(row?.v);
}

/** e.g. formatRef("GIT", 1042) → "GIT-1042"; pads to `width` digits. */
export function formatRef(prefix: string, value: number, width = 4): string {
  return `${prefix}-${String(value).padStart(width, "0")}`;
}
