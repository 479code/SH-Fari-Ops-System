/**
 * audit.service.ts — writes the audit trail.
 *
 * Audit rows are written inside the same transaction as the change they
 * describe, so a change can never commit without its audit entry (or vice versa).
 */
import type { Executor } from "../db/client.ts";
import { auditLogs } from "../db/schema/index.ts";
import type { Actor, AuditActor } from "../types.ts";
import { logger } from "../utils/logger.ts";

export type AuditAction =
  | "created"
  | "updated"
  | "deleted"
  | "verified"
  | "disputed"
  | "cancelled"
  | "voided"
  | "approved"
  | "rejected"
  | "opened"
  | "closed"
  | "reopened"
  | "reviewed"
  | "flagged"
  | "resolved"
  | "status_changed"
  | "login"
  | "login_failed"
  | "logout"
  | "password_changed"
  | "password_reset_issued"
  | "password_reset_completed"
  | "permissions_changed"
  | "settings_changed";

export interface AuditEntry {
  action: AuditAction;
  resource: string;
  resourceId?: string | number | null;
  recordRef?: string | null;
  stationId?: number | null;
  oldValue?: unknown;
  newValue?: unknown;
}

const SYSTEM: AuditActor = { userId: null, ip: null, userAgent: null };

export function auditActorOf(actor: Actor | null): AuditActor {
  return actor ? { userId: actor.id, ip: actor.ip, userAgent: actor.userAgent } : SYSTEM;
}

export async function recordAudit(executor: Executor, who: Actor | AuditActor | null, entry: AuditEntry): Promise<void> {
  const by: AuditActor = who === null ? SYSTEM : "userId" in who ? who : auditActorOf(who);
  await executor.insert(auditLogs).values({
    userId: by.userId,
    action: entry.action,
    resource: entry.resource,
    resourceId: entry.resourceId === undefined || entry.resourceId === null ? null : String(entry.resourceId),
    recordRef: entry.recordRef ?? null,
    stationId: entry.stationId ?? null,
    oldValue: entry.oldValue ?? null,
    newValue: entry.newValue ?? null,
    ipAddress: by.ip,
    userAgent: by.userAgent?.slice(0, 255) ?? null,
  });
  logger.info("audit", {
    action: entry.action,
    resource: entry.resource,
    resourceId: entry.resourceId,
    recordRef: entry.recordRef,
    userId: by.userId,
  });
}
