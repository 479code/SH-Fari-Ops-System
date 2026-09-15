/**
 * settings.service.ts — business-configurable control parameters.
 *
 * Each key is validated by the schema below, so a bad value can never be stored
 * and every consumer gets a typed, defaulted object.
 */
import { z } from "zod";
import { db, type Executor } from "../db/client.ts";
import { settings } from "../db/schema/index.ts";
import type { Actor } from "../types.ts";
import { recordAudit } from "./audit.service.ts";

const settingsShape = {
  /** Block DSR closes / adjustments that would take a tank below zero. */
  allowNegativeStock: z.boolean(),
  /** Days in transit after which a GIT order is flagged as delayed. */
  gitDelayDays: z.number().int().min(1).max(60),
  /** Discharge shortfall (litres) tolerated before a GIT delivery is flagged. */
  gitShortageToleranceLitres: z.number().min(0).max(100_000),
  /** Age (days) of the oldest unpaid debt at which a debtor is flagged. */
  debtorAgingAlertDays: z.number().int().min(1).max(365),
};

export const settingsSchema = z.object({
  allowNegativeStock: settingsShape.allowNegativeStock.default(false),
  gitDelayDays: settingsShape.gitDelayDays.default(5),
  gitShortageToleranceLitres: settingsShape.gitShortageToleranceLitres.default(100),
  debtorAgingAlertDays: settingsShape.debtorAgingAlertDays.default(90),
});

export type Settings = z.infer<typeof settingsSchema>;
// Built from the default-free shape: `.partial()` over defaulted fields would
// fill in every key the caller did not send and silently reset those settings.
export const settingsUpdateSchema = z.object(settingsShape).partial().strict();

export async function getSettings(executor: Executor = db): Promise<Settings> {
  const rows = await executor.select().from(settings);
  const raw: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      raw[row.key] = JSON.parse(row.value);
    } catch {
      // A corrupted value falls back to its default rather than breaking every page.
    }
  }
  const parsed = settingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : settingsSchema.parse({});
}

export async function updateSettings(actor: Actor, patch: Partial<Settings>): Promise<Settings> {
  return db.transaction(async (tx) => {
    const before = await getSettings(tx);
    const after = settingsSchema.parse({ ...before, ...patch });
    for (const [key, value] of Object.entries(patch)) {
      await tx
        .insert(settings)
        .values({ key, value: JSON.stringify(value), updatedBy: actor.id })
        .onDuplicateKeyUpdate({ set: { value: JSON.stringify(value), updatedBy: actor.id, updatedAt: new Date() } });
    }
    await recordAudit(tx, actor, {
      action: "settings_changed",
      resource: "settings",
      recordRef: "SETTINGS",
      oldValue: Object.fromEntries(Object.keys(patch).map((k) => [k, before[k as keyof Settings]])),
      newValue: patch,
    });
    return after;
  });
}
