import { eq } from "drizzle-orm";
import type { Tx } from "../db/client.ts";
import { trucks } from "../db/schema/index.ts";

/** Returns the id of the truck with this (already normalised) plate, registering it on first use. */
export async function upsertTruck(tx: Tx, plateNumber: string): Promise<number> {
  await tx.insert(trucks).ignore().values({ plateNumber });
  const [row] = await tx.select({ id: trucks.id }).from(trucks).where(eq(trucks.plateNumber, plateNumber)).limit(1);
  return row!.id;
}
