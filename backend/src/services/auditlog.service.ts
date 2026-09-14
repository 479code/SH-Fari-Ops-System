/** auditlog.service.ts — reading and exporting the audit trail. */
import { and, count, desc, eq, gte, like, lt, or, type SQL } from "drizzle-orm";
import { db } from "../db/client.ts";
import { auditLogs, users } from "../db/schema/index.ts";
import type { Actor } from "../types.ts";
import { addDays, businessInstant } from "../utils/dates.ts";
import { AppError } from "../utils/errors.ts";
import { paginationMeta } from "../utils/http.ts";
import { likeContains } from "../utils/sql.ts";

export interface AuditQuery {
  action?: string;
  userId?: number;
  resource?: string;
  search?: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
}

function conditions(actor: Actor, q: Omit<AuditQuery, "page" | "limit">): SQL[] {
  const conds: SQL[] = [];
  if (actor.stationId !== null) conds.push(eq(auditLogs.stationId, actor.stationId));
  if (q.action) conds.push(eq(auditLogs.action, q.action));
  if (q.userId) conds.push(eq(auditLogs.userId, q.userId));
  if (q.resource) conds.push(eq(auditLogs.resource, q.resource));
  if (q.search) {
    const p = likeContains(q.search);
    conds.push(or(like(auditLogs.recordRef, p), like(auditLogs.resourceId, p))!);
  }
  if (q.from && q.to && q.from > q.to) {
    throw new AppError("VALIDATION_ERROR", "'From' date must be on or before 'to' date.", { fields: { from: "Must be on or before the 'to' date." } });
  }
  // Dates are business dates; convert their boundaries to UTC instants.
  if (q.from) conds.push(gte(auditLogs.createdAt, businessInstant(q.from, "00:00")));
  if (q.to) conds.push(lt(auditLogs.createdAt, businessInstant(addDays(q.to, 1), "00:00")));
  return conds;
}

const columns = {
  id: auditLogs.id,
  createdAt: auditLogs.createdAt,
  userId: auditLogs.userId,
  userName: users.fullName,
  action: auditLogs.action,
  resource: auditLogs.resource,
  resourceId: auditLogs.resourceId,
  recordRef: auditLogs.recordRef,
  stationId: auditLogs.stationId,
  oldValue: auditLogs.oldValue,
  newValue: auditLogs.newValue,
  ipAddress: auditLogs.ipAddress,
};

export async function listAudit(actor: Actor, q: AuditQuery) {
  const conds = conditions(actor, q);
  const where = conds.length ? and(...conds) : undefined;
  const [rows, [total]] = await Promise.all([
    db
      .select(columns)
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.userId))
      .where(where)
      .orderBy(desc(auditLogs.id))
      .limit(q.limit)
      .offset((q.page - 1) * q.limit),
    db.select({ n: count() }).from(auditLogs).where(where),
  ]);
  return {
    rows: rows.map((r) => ({ ...r, userName: r.userName ?? "System" })),
    pagination: paginationMeta(q.page, q.limit, total?.n ?? 0),
  };
}

export async function exportAudit(actor: Actor, q: Omit<AuditQuery, "page" | "limit">, maxRows: number) {
  const conds = conditions(actor, q);
  const rows = await db
    .select(columns)
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(auditLogs.id))
    .limit(maxRows + 1);
  return { rows: rows.slice(0, maxRows).map((r) => ({ ...r, userName: r.userName ?? "System" })), truncated: rows.length > maxRows };
}

export async function auditFacets(actor: Actor) {
  const scope = actor.stationId !== null ? eq(auditLogs.stationId, actor.stationId) : undefined;
  const [actions, resources] = await Promise.all([
    db.selectDistinct({ value: auditLogs.action }).from(auditLogs).where(scope).orderBy(auditLogs.action),
    db.selectDistinct({ value: auditLogs.resource }).from(auditLogs).where(scope).orderBy(auditLogs.resource),
  ]);
  return { actions: actions.map((a) => a.value), resources: resources.map((r) => r.value) };
}
