/**
 * exceptions.service.ts — variances and delays that need management attention.
 *
 * Modules raise exceptions when a control is breached and resolve them when the
 * condition clears. Exceptions are keyed by (type, source) so raising again
 * updates the same row instead of creating duplicates.
 *
 * Lifecycle: open → reviewed (comment captured) → closed (resolution captured).
 */
import { and, count, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { stationFilter, assertStationAccess } from "../auth/scope.ts";
import { db, type Executor } from "../db/client.ts";
import { exceptions, stations, users, type ExceptionType } from "../db/schema/index.ts";
import type { Actor } from "../types.ts";
import { conflict, notFound } from "../utils/errors.ts";
import { paginationMeta } from "../utils/http.ts";
import { recordAudit } from "./audit.service.ts";

export interface RaiseInput {
  type: ExceptionType;
  severity: "high" | "medium";
  stationId: number | null;
  sourceType: string;
  sourceId: number;
  sourceRef: string;
  title: string;
  detail?: string | null;
  amount?: number | null;
  /** Reopen a reviewed/closed exception when its figures change (default true). */
  reopenOnChange?: boolean;
}

/** Returns true when an exception was newly opened or reopened. */
export async function raiseException(ex: Executor, input: RaiseInput): Promise<boolean> {
  const [existing] = await ex
    .select({ id: exceptions.id, status: exceptions.status, amount: exceptions.amount })
    .from(exceptions)
    .where(and(eq(exceptions.type, input.type), eq(exceptions.sourceType, input.sourceType), eq(exceptions.sourceId, input.sourceId)))
    .limit(1);

  const now = new Date();
  const values = {
    severity: input.severity,
    stationId: input.stationId,
    sourceRef: input.sourceRef,
    title: input.title.slice(0, 255),
    detail: input.detail?.slice(0, 500) ?? null,
    amount: input.amount ?? null,
  };

  if (!existing) {
    await ex.insert(exceptions).values({
      ...values,
      type: input.type,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      status: "open",
      raisedAt: now,
    });
    return true;
  }

  const figuresChanged = (existing.amount ?? null) !== (input.amount ?? null);
  const reopen = existing.status !== "open" && figuresChanged && input.reopenOnChange !== false;
  await ex
    .update(exceptions)
    .set({
      ...values,
      ...(reopen
        ? { status: "open" as const, raisedAt: now, reviewedBy: null, reviewedAt: null, reviewComment: null, closedBy: null, closedAt: null, resolution: null }
        : {}),
    })
    .where(eq(exceptions.id, existing.id));
  return reopen;
}

/** Closes an exception whose underlying condition no longer holds. */
export async function resolveException(
  ex: Executor,
  where: { type: ExceptionType; sourceType: string; sourceId: number },
  resolution: string,
  userId: number | null,
): Promise<void> {
  await ex
    .update(exceptions)
    .set({ status: "closed", closedAt: new Date(), closedBy: userId, resolution: resolution.slice(0, 500) })
    .where(
      and(
        eq(exceptions.type, where.type),
        eq(exceptions.sourceType, where.sourceType),
        eq(exceptions.sourceId, where.sourceId),
        ne(exceptions.status, "closed"),
      ),
    );
}

/** Mirrors a review done in the owning module (e.g. a cash reconciliation review). */
export async function markExceptionReviewed(
  ex: Executor,
  where: { type: ExceptionType; sourceType: string; sourceId: number },
  userId: number,
  comment: string,
): Promise<void> {
  await ex
    .update(exceptions)
    .set({ status: "reviewed", reviewedBy: userId, reviewedAt: new Date(), reviewComment: comment.slice(0, 500) })
    .where(
      and(
        eq(exceptions.type, where.type),
        eq(exceptions.sourceType, where.sourceType),
        eq(exceptions.sourceId, where.sourceId),
        eq(exceptions.status, "open"),
      ),
    );
}

export interface ExceptionQuery {
  status?: "open" | "reviewed" | "closed" | "active";
  type?: ExceptionType;
  stationId?: number;
  page: number;
  limit: number;
}

function scopeConditions(actor: Actor, q: { stationId?: number; status?: ExceptionQuery["status"]; type?: ExceptionType }): SQL[] {
  const conds: SQL[] = [];
  const station = stationFilter(actor, q.stationId);
  if (station !== null) conds.push(eq(exceptions.stationId, station));
  if (q.status === "active") conds.push(inArray(exceptions.status, ["open", "reviewed"]));
  else if (q.status) conds.push(eq(exceptions.status, q.status));
  if (q.type) conds.push(eq(exceptions.type, q.type));
  return conds;
}

export async function listExceptions(actor: Actor, q: ExceptionQuery) {
  const conds = scopeConditions(actor, q);
  const where = conds.length ? and(...conds) : undefined;
  const reviewer = alias(users, "reviewer");
  const closer = alias(users, "closer");

  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: exceptions.id,
        type: exceptions.type,
        severity: exceptions.severity,
        stationId: exceptions.stationId,
        stationName: stations.name,
        sourceType: exceptions.sourceType,
        sourceId: exceptions.sourceId,
        sourceRef: exceptions.sourceRef,
        title: exceptions.title,
        detail: exceptions.detail,
        amount: exceptions.amount,
        status: exceptions.status,
        raisedAt: exceptions.raisedAt,
        reviewedByName: reviewer.fullName,
        reviewedAt: exceptions.reviewedAt,
        reviewComment: exceptions.reviewComment,
        closedByName: closer.fullName,
        closedAt: exceptions.closedAt,
        resolution: exceptions.resolution,
      })
      .from(exceptions)
      .leftJoin(stations, eq(stations.id, exceptions.stationId))
      .leftJoin(reviewer, eq(reviewer.id, exceptions.reviewedBy))
      .leftJoin(closer, eq(closer.id, exceptions.closedBy))
      .where(where)
      .orderBy(sql`FIELD(${exceptions.status}, 'open', 'reviewed', 'closed')`, sql`FIELD(${exceptions.severity}, 'high', 'medium')`, desc(exceptions.raisedAt))
      .limit(q.limit)
      .offset((q.page - 1) * q.limit),
    db.select({ n: count() }).from(exceptions).where(where),
  ]);
  return { rows, pagination: paginationMeta(q.page, q.limit, total?.n ?? 0) };
}

export async function countExceptions(actor: Actor, stationId?: number) {
  const conds = scopeConditions(actor, { stationId, status: "open" });
  const rows = await db
    .select({ type: exceptions.type, n: count() })
    .from(exceptions)
    .where(and(...conds))
    .groupBy(exceptions.type);
  const byType = Object.fromEntries(rows.map((r) => [r.type, r.n])) as Partial<Record<ExceptionType, number>>;
  return { open: rows.reduce((s, r) => s + r.n, 0), byType };
}

async function loadForAction(actor: Actor, id: number) {
  const [row] = await db.select().from(exceptions).where(eq(exceptions.id, id)).limit(1);
  if (!row) throw notFound("Exception");
  assertStationAccess(actor, row.stationId, "Exception");
  if (actor.stationId !== null && row.stationId === null) throw notFound("Exception");
  return row;
}

export async function reviewException(actor: Actor, id: number, comment: string) {
  const row = await loadForAction(actor, id);
  if (row.status !== "open") throw conflict(`This exception is already ${row.status}.`);
  await db.transaction(async (tx) => {
    await tx
      .update(exceptions)
      .set({ status: "reviewed", reviewedBy: actor.id, reviewedAt: new Date(), reviewComment: comment })
      .where(eq(exceptions.id, id));
    await recordAudit(tx, actor, {
      action: "reviewed",
      resource: "exception",
      resourceId: id,
      recordRef: row.sourceRef,
      stationId: row.stationId,
      oldValue: { status: row.status },
      newValue: { status: "reviewed", comment },
    });
  });
}

export async function closeException(actor: Actor, id: number, resolution: string) {
  const row = await loadForAction(actor, id);
  if (row.status === "closed") throw conflict("This exception is already closed.");
  await db.transaction(async (tx) => {
    await tx
      .update(exceptions)
      .set({ status: "closed", closedBy: actor.id, closedAt: new Date(), resolution })
      .where(eq(exceptions.id, id));
    await recordAudit(tx, actor, {
      action: "resolved",
      resource: "exception",
      resourceId: id,
      recordRef: row.sourceRef,
      stationId: row.stationId,
      oldValue: { status: row.status },
      newValue: { status: "closed", resolution },
    });
  });
}
