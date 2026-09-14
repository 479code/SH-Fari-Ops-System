/** Insight API: dashboard, exceptions, reports, audit trail, global search and lookups. */
import { Hono, type Context } from "hono";
import { requireAuth, requirePermission } from "../middleware/auth.ts";
import * as auditLog from "../services/auditlog.service.ts";
import * as dashboard from "../services/dashboard.service.ts";
import * as exceptionsService from "../services/exceptions.service.ts";
import { getLookups } from "../services/lookups.service.ts";
import * as reports from "../services/reports.service.ts";
import { search } from "../services/search.service.ts";
import type { AppEnv } from "../types.ts";
import { toCsv } from "../utils/csv.ts";
import { currentMonth, today } from "../utils/dates.ts";
import { AppError } from "../utils/errors.ts";
import { ok, paged, readId, readJson, readQuery } from "../utils/http.ts";
import {
  auditListQuery,
  comparisonQuery,
  dashboardQuery,
  exceptionCloseSchema,
  exceptionListQuery,
  exceptionReviewSchema,
  globalSearchQuery,
  reportQuery,
} from "../validators/system.ts";

function csv(c: Context<AppEnv>, filename: string, body: string) {
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
  return c.body(body);
}

/* Dashboard ---------------------------------------------------------------------- */

export const dashboardRoutes = new Hono<AppEnv>();
dashboardRoutes.use(requireAuth);

dashboardRoutes.get("/", requirePermission("dashboard.view"), async (c) =>
  ok(c, await dashboard.getDashboard(c.get("actor"), readQuery(c, dashboardQuery))),
);
dashboardRoutes.get("/comparison", requirePermission("dashboard.view"), async (c) => {
  const q = readQuery(c, comparisonQuery);
  return ok(c, await dashboard.stationComparison(c.get("actor"), q.month ?? currentMonth()));
});
dashboardRoutes.get("/badges", async (c) => ok(c, await dashboard.getBadges(c.get("actor"))));

/* Exceptions ----------------------------------------------------------------------- */

export const exceptionRoutes = new Hono<AppEnv>();
exceptionRoutes.use(requireAuth);

exceptionRoutes.get("/", requirePermission("exceptions.view"), async (c) =>
  paged(c, await exceptionsService.listExceptions(c.get("actor"), readQuery(c, exceptionListQuery))),
);
exceptionRoutes.post("/:id/review", requirePermission("exceptions.review"), async (c) => {
  const { comment } = await readJson(c, exceptionReviewSchema);
  await exceptionsService.reviewException(c.get("actor"), readId(c), comment);
  return ok(c, null, "Exception marked as reviewed.");
});
exceptionRoutes.post("/:id/close", requirePermission("exceptions.review"), async (c) => {
  const { resolution } = await readJson(c, exceptionCloseSchema);
  await exceptionsService.closeException(c.get("actor"), readId(c), resolution);
  return ok(c, null, "Exception closed.");
});

/* Reports ----------------------------------------------------------------------------- */

export const reportRoutes = new Hono<AppEnv>();
reportRoutes.use(requireAuth);

reportRoutes.get("/", requirePermission("reports.view"), async (c) => ok(c, reports.listReports(c.get("actor"))));
reportRoutes.get("/:key", requirePermission("reports.view"), async (c) => {
  const actor = c.get("actor");
  const { format, ...filters } = readQuery(c, reportQuery);
  const key = c.req.param("key");
  const def = reports.findReport(key);
  if (!def) throw new AppError("NOT_FOUND", "Report not found.");
  if (format === "csv" && !actor.permissions.has(def.exportPermission)) {
    throw new AppError("FORBIDDEN", "You do not have permission to export this report.");
  }
  const result = await reports.runReport(actor, key, filters);
  if (format === "csv") return csv(c, `${key}-${today()}.csv`, toCsv(result.columns, result.rows));
  return ok(c, result);
});

/* Audit trail ------------------------------------------------------------------------ */

export const auditRoutes = new Hono<AppEnv>();
auditRoutes.use(requireAuth);

auditRoutes.get("/", requirePermission("audit.view"), async (c) => paged(c, await auditLog.listAudit(c.get("actor"), readQuery(c, auditListQuery))));
auditRoutes.get("/facets", requirePermission("audit.view"), async (c) => ok(c, await auditLog.auditFacets(c.get("actor"))));
auditRoutes.get("/export", requirePermission("audit.export"), async (c) => {
  const { page: _page, limit: _limit, sortOrder: _sort, ...q } = readQuery(c, auditListQuery);
  const result = await auditLog.exportAudit(c.get("actor"), q, reports.MAX_ROWS);
  const rows = result.rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    oldValue: r.oldValue === null ? "" : JSON.stringify(r.oldValue),
    newValue: r.newValue === null ? "" : JSON.stringify(r.newValue),
  }));
  return csv(
    c,
    `audit-trail-${today()}.csv`,
    toCsv(
      [
        { key: "createdAt", label: "Timestamp (UTC)" },
        { key: "userName", label: "User" },
        { key: "action", label: "Action" },
        { key: "resource", label: "Resource" },
        { key: "recordRef", label: "Record" },
        { key: "oldValue", label: "Old value" },
        { key: "newValue", label: "New value" },
        { key: "ipAddress", label: "IP address" },
      ],
      rows,
    ),
  );
});

/* Search & lookups ------------------------------------------------------------------- */

export const searchRoutes = new Hono<AppEnv>();
searchRoutes.use(requireAuth);
searchRoutes.get("/", async (c) => {
  const { q } = readQuery(c, globalSearchQuery);
  return ok(c, await search(c.get("actor"), q));
});

export const lookupRoutes = new Hono<AppEnv>();
lookupRoutes.use(requireAuth);
lookupRoutes.get("/", async (c) => ok(c, await getLookups(c.get("actor"))));
