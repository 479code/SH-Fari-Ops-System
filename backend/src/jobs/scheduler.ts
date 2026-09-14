/**
 * scheduler.ts — periodic control checks.
 *
 * Time-based exceptions (GIT delays, debtor aging) cannot be raised by a user
 * action, so they are evaluated here. Every check is idempotent (exceptions are
 * upserted), so running on several instances or re-running is harmless.
 */
import { scanDelays } from "../services/git.service.ts";
import { scanAging } from "../services/debtors.service.ts";
import { purgeExpiredCredentials } from "../services/auth.service.ts";
import { logger } from "../utils/logger.ts";

const INTERVAL_MS = 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function runChecks(): Promise<void> {
  if (running) return;
  running = true;
  const started = Date.now();
  try {
    const git = await scanDelays();
    const debtors = await scanAging();
    await purgeExpiredCredentials();
    logger.info("scheduled checks complete", { gitDelaysFlagged: git.flagged, gitDelaysResolved: git.resolved, debtorsFlagged: debtors.flagged, durationMs: Date.now() - started });
  } catch (err) {
    logger.error("scheduled checks failed", { err });
  } finally {
    running = false;
  }
}

export function startScheduler(): void {
  if (timer) return;
  setTimeout(() => void runChecks(), 10_000).unref?.();
  timer = setInterval(() => void runChecks(), INTERVAL_MS);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
