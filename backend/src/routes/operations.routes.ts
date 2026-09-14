/** Operations API: truck receipts, GIT, DSR, RTT and stock. Handlers stay thin — logic lives in services. */
import { Hono } from "hono";
import { requireAnyPermission, requireAuth, requirePermission } from "../middleware/auth.ts";
import * as dsr from "../services/dsr.service.ts";
import * as git from "../services/git.service.ts";
import * as receipts from "../services/receipts.service.ts";
import * as rtt from "../services/rtt.service.ts";
import * as stock from "../services/stock.service.ts";
import type { AppEnv } from "../types.ts";
import { requireStation } from "../auth/scope.ts";
import { today } from "../utils/dates.ts";
import { created, ok, paged, readId, readJson, readQuery } from "../utils/http.ts";
import { reasonSchema } from "../validators/common.ts";
import { dsrDayQuery, dsrListQuery, dsrOpenSchema, dsrReadingsSchema } from "../validators/dsr.ts";
import {
  gitCreateSchema,
  gitDeliveriesSchema,
  gitExceptionSchema,
  gitListQuery,
  gitResolveSchema,
  gitStatusSchema,
  gitUpdateSchema,
  openDeliveriesQuery,
} from "../validators/git.ts";
import { receiptCreateSchema, receiptListQuery } from "../validators/receipts.ts";
import { rttCreateSchema, rttListQuery } from "../validators/rtt.ts";
import { adjustmentSchema, dipSchema, ledgerQuery, movementQuery, systemClosingQuery, tanksQuery } from "../validators/stock.ts";

/* Truck receipts ------------------------------------------------------------- */

export const receiptRoutes = new Hono<AppEnv>();
receiptRoutes.use(requireAuth);

receiptRoutes.get("/", requirePermission("receipts.view"), async (c) => {
  const result = await receipts.listReceipts(c.get("actor"), readQuery(c, receiptListQuery));
  return paged(c, result, { summary: result.summary });
});
receiptRoutes.post("/", requirePermission("receipts.create"), async (c) => {
  const input = await readJson(c, receiptCreateSchema);
  return created(c, await receipts.createReceipt(c.get("actor"), input), "Receipt recorded — stock updates on verification.");
});
receiptRoutes.get("/:id", requirePermission("receipts.view"), async (c) => ok(c, await receipts.getReceipt(c.get("actor"), readId(c))));
receiptRoutes.post("/:id/verify", requirePermission("receipts.verify"), async (c) =>
  ok(c, await receipts.verifyReceipt(c.get("actor"), readId(c)), "Receipt verified — stock updated."),
);
receiptRoutes.post("/:id/dispute", requirePermission("receipts.verify"), async (c) => {
  const { reason } = await readJson(c, reasonSchema);
  return ok(c, await receipts.disputeReceipt(c.get("actor"), readId(c), reason), "Receipt marked as disputed.");
});
receiptRoutes.post("/:id/cancel", requirePermission("receipts.cancel"), async (c) => {
  const { reason } = await readJson(c, reasonSchema);
  return ok(c, await receipts.cancelReceipt(c.get("actor"), readId(c), reason), "Receipt cancelled.");
});

/* GIT ---------------------------------------------------------------------------- */

export const gitRoutes = new Hono<AppEnv>();
gitRoutes.use(requireAuth);

gitRoutes.get("/", requirePermission("git.view"), async (c) => paged(c, await git.listOrders(c.get("actor"), readQuery(c, gitListQuery))));
gitRoutes.get("/open-deliveries", requireAnyPermission("receipts.create", "git.view"), async (c) =>
  ok(c, await git.openDeliveries(c.get("actor"), readQuery(c, openDeliveriesQuery))),
);
gitRoutes.post("/", requirePermission("git.create"), async (c) => {
  const input = await readJson(c, gitCreateSchema);
  return created(c, await git.createOrder(c.get("actor"), input), "GIT order created.");
});
gitRoutes.get("/:id", requirePermission("git.view"), async (c) => ok(c, await git.getOrder(c.get("actor"), readId(c))));
gitRoutes.patch("/:id", requirePermission("git.update"), async (c) => {
  const input = await readJson(c, gitUpdateSchema);
  return ok(c, await git.updateOrder(c.get("actor"), readId(c), input), "GIT order updated.");
});
gitRoutes.post("/:id/status", requirePermission("git.update"), async (c) => {
  const input = await readJson(c, gitStatusSchema);
  return ok(c, await git.changeStatus(c.get("actor"), readId(c), input), "Status updated.");
});
gitRoutes.put("/:id/deliveries", requirePermission("git.update"), async (c) => {
  const input = await readJson(c, gitDeliveriesSchema);
  return ok(c, await git.setDeliveries(c.get("actor"), readId(c), input.destinations), "Deliveries updated.");
});
gitRoutes.post("/:id/exception", requirePermission("git.update"), async (c) => {
  const input = await readJson(c, gitExceptionSchema);
  return ok(c, await git.flagException(c.get("actor"), readId(c), input), "Exception flagged.");
});
gitRoutes.post("/:id/exception/resolve", requirePermission("git.update"), async (c) => {
  const input = await readJson(c, gitResolveSchema);
  return ok(c, await git.resolveOrderException(c.get("actor"), readId(c), input.note), "Exception resolved.");
});

/* DSR ------------------------------------------------------------------------------ */

export const dsrRoutes = new Hono<AppEnv>();
dsrRoutes.use(requireAuth);

dsrRoutes.get("/", requirePermission("dsr.view"), async (c) => paged(c, await dsr.listDays(c.get("actor"), readQuery(c, dsrListQuery))));
dsrRoutes.get("/day", requirePermission("dsr.view"), async (c) => {
  const q = readQuery(c, dsrDayQuery);
  const actor = c.get("actor");
  return ok(c, await dsr.getDay(actor, requireStation(actor, q.stationId), q.date ?? today()));
});
dsrRoutes.post("/open", requirePermission("dsr.record"), async (c) => {
  const input = await readJson(c, dsrOpenSchema);
  return created(c, await dsr.openDay(c.get("actor"), input), "Business day opened.");
});
dsrRoutes.put("/:id/readings", requirePermission("dsr.record"), async (c) => {
  const input = await readJson(c, dsrReadingsSchema);
  return ok(c, await dsr.saveReadings(c.get("actor"), readId(c), input), "Readings saved.");
});
dsrRoutes.post("/:id/close", requirePermission("dsr.close"), async (c) =>
  ok(c, await dsr.closeDay(c.get("actor"), readId(c)), "Day closed and locked — sales posted to stock."),
);
dsrRoutes.post("/:id/reopen", requirePermission("dsr.reopen"), async (c) => {
  const { reason } = await readJson(c, reasonSchema);
  return ok(c, await dsr.reopenDay(c.get("actor"), readId(c), reason), "Day reopened for correction.");
});

/* RTT ------------------------------------------------------------------------------- */

export const rttRoutes = new Hono<AppEnv>();
rttRoutes.use(requireAuth);

rttRoutes.get("/", requirePermission("rtt.view"), async (c) => {
  const result = await rtt.listRtt(c.get("actor"), readQuery(c, rttListQuery));
  return paged(c, result, { summary: result.summary });
});
rttRoutes.post("/", requirePermission("rtt.create"), async (c) => {
  const input = await readJson(c, rttCreateSchema);
  return created(c, await rtt.createRtt(c.get("actor"), input), "RTT logged — excluded from sales.");
});
rttRoutes.get("/:id", requirePermission("rtt.view"), async (c) => ok(c, await rtt.getRtt(c.get("actor"), readId(c))));
rttRoutes.post("/:id/cancel", requirePermission("rtt.cancel"), async (c) => {
  const { reason } = await readJson(c, reasonSchema);
  return ok(c, await rtt.cancelRtt(c.get("actor"), readId(c), reason), "RTT entry cancelled.");
});

/* Stock ------------------------------------------------------------------------------ */

export const stockRoutes = new Hono<AppEnv>();
stockRoutes.use(requireAuth);

stockRoutes.get("/movement", requirePermission("stock.view"), async (c) => ok(c, await stock.getMovementSummary(c.get("actor"), readQuery(c, movementQuery))));
stockRoutes.get("/ledger", requirePermission("stock.view"), async (c) => {
  const result = await stock.getLedger(c.get("actor"), readQuery(c, ledgerQuery));
  return paged(c, result, { dips: result.dips, range: result.range });
});
stockRoutes.get("/tanks", requirePermission("stock.view"), async (c) => ok(c, await stock.getTankStatus(c.get("actor"), readQuery(c, tanksQuery))));
stockRoutes.get("/system-closing", requirePermission("stock.view"), async (c) => {
  const q = readQuery(c, systemClosingQuery);
  return ok(c, await stock.getSystemClosing(c.get("actor"), q.tankId, q.date));
});
stockRoutes.post("/dips", requirePermission("stock.dip"), async (c) => {
  const input = await readJson(c, dipSchema);
  return created(c, await stock.recordDip(c.get("actor"), input), "Dip recorded — variance calculated.");
});
stockRoutes.post("/adjustments", requirePermission("stock.adjust"), async (c) => {
  const input = await readJson(c, adjustmentSchema);
  return created(c, await stock.recordAdjustment(c.get("actor"), input), "Stock adjustment posted.");
});
