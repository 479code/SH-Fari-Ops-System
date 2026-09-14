/** Finance API: cash/POS/bank reconciliation, debtors and expenses. */
import { Hono } from "hono";
import { requireAnyPermission, requireAuth, requirePermission } from "../middleware/auth.ts";
import * as cash from "../services/cash.service.ts";
import * as debtors from "../services/debtors.service.ts";
import * as expenses from "../services/expenses.service.ts";
import type { AppEnv } from "../types.ts";
import { created, ok, paged, readId, readJson, readQuery } from "../utils/http.ts";
import { closeSchema, declarationSchema, depositSchema, historyQuery, positionQuery, reviewSchema } from "../validators/cash.ts";
import { reasonSchema } from "../validators/common.ts";
import { debtorCreateSchema, debtorListQuery, debtorSummaryQuery, debtorTransactionSchema, debtorUpdateSchema } from "../validators/debtors.ts";
import { approveSchema, expenseCreateSchema, expenseListQuery } from "../validators/expenses.ts";

/* Cash, POS & bank ------------------------------------------------------------ */

export const cashRoutes = new Hono<AppEnv>();
cashRoutes.use(requireAuth);

cashRoutes.get("/position", requirePermission("cash.view"), async (c) => {
  const q = readQuery(c, positionQuery);
  return ok(c, await cash.getPosition(c.get("actor"), q.stationId, q.date));
});
cashRoutes.get("/history", requirePermission("cash.view"), async (c) => {
  const q = readQuery(c, historyQuery);
  return ok(c, await cash.getHistory(c.get("actor"), q.stationId, q));
});
cashRoutes.post("/deposits", requirePermission("cash.record"), async (c) => {
  const input = await readJson(c, depositSchema);
  return created(c, await cash.recordDeposit(c.get("actor"), input), "Deposit recorded.");
});
cashRoutes.post("/deposits/:id/cancel", requirePermission("cash.record"), async (c) => {
  const { reason } = await readJson(c, reasonSchema);
  return ok(c, await cash.cancelDeposit(c.get("actor"), readId(c), reason), "Deposit cancelled.");
});
cashRoutes.put("/declarations", requirePermission("cash.record"), async (c) => {
  const input = await readJson(c, declarationSchema);
  return ok(c, await cash.saveDeclaration(c.get("actor"), input), "Cash declaration saved — variance recalculated.");
});
cashRoutes.post("/positions/:id/review", requirePermission("cash.review"), async (c) => {
  const { comment } = await readJson(c, reviewSchema);
  return ok(c, await cash.reviewPosition(c.get("actor"), readId(c), comment), "Reconciliation reviewed.");
});
cashRoutes.post("/positions/:id/close", requirePermission("cash.review"), async (c) => {
  const { comment } = await readJson(c, closeSchema);
  return ok(c, await cash.closePosition(c.get("actor"), readId(c), comment), "Reconciliation closed.");
});

/* Debtors ---------------------------------------------------------------------- */

export const debtorRoutes = new Hono<AppEnv>();
debtorRoutes.use(requireAuth);

debtorRoutes.get("/", requirePermission("debtors.view"), async (c) => {
  const result = await debtors.listDebtors(c.get("actor"), readQuery(c, debtorListQuery));
  return paged(c, result, { range: result.range });
});
debtorRoutes.get("/summary", requirePermission("debtors.view"), async (c) => {
  const q = readQuery(c, debtorSummaryQuery);
  return ok(c, await debtors.debtorSummary(c.get("actor"), q.stationId));
});
debtorRoutes.post("/", requirePermission("debtors.create"), async (c) => {
  const input = await readJson(c, debtorCreateSchema);
  return created(c, await debtors.createDebtor(c.get("actor"), input), "Debtor registered.");
});
debtorRoutes.post("/transactions/:id/void", requirePermission("debtors.void"), async (c) => {
  const { reason } = await readJson(c, reasonSchema);
  return ok(c, await debtors.voidTransaction(c.get("actor"), readId(c), reason), "Transaction voided.");
});
debtorRoutes.get("/:id", requirePermission("debtors.view"), async (c) => ok(c, await debtors.getDebtor(c.get("actor"), readId(c))));
debtorRoutes.patch("/:id", requirePermission("debtors.create"), async (c) => {
  const input = await readJson(c, debtorUpdateSchema);
  return ok(c, await debtors.updateDebtor(c.get("actor"), readId(c), input), "Debtor updated.");
});
debtorRoutes.post("/:id/transactions", requirePermission("debtors.transact"), async (c) => {
  const input = await readJson(c, debtorTransactionSchema);
  const message = input.type === "repayment" ? "Repayment recorded." : "Credit sale recorded.";
  return created(c, await debtors.recordTransaction(c.get("actor"), readId(c), input), message);
});

/* Expenses ----------------------------------------------------------------------- */

export const expenseRoutes = new Hono<AppEnv>();
expenseRoutes.use(requireAuth);

expenseRoutes.get("/", requirePermission("expenses.view"), async (c) => {
  const result = await expenses.listExpenses(c.get("actor"), readQuery(c, expenseListQuery));
  return paged(c, result, { summary: result.summary });
});
expenseRoutes.post("/", requirePermission("expenses.create"), async (c) => {
  const input = await readJson(c, expenseCreateSchema);
  const expense = await expenses.createExpense(c.get("actor"), input);
  return created(c, expense, expense.status === "pending" ? "Expense logged — pending approval (above threshold)." : "Expense logged.");
});
expenseRoutes.get("/:id", requirePermission("expenses.view"), async (c) => ok(c, await expenses.getExpense(c.get("actor"), readId(c))));
expenseRoutes.post("/:id/approve", requirePermission("expenses.approve"), async (c) => {
  const { note } = await readJson(c, approveSchema);
  return ok(c, await expenses.approveExpense(c.get("actor"), readId(c), note), "Expense approved.");
});
expenseRoutes.post("/:id/reject", requirePermission("expenses.approve"), async (c) => {
  const { reason } = await readJson(c, reasonSchema);
  return ok(c, await expenses.rejectExpense(c.get("actor"), readId(c), reason), "Expense rejected.");
});
expenseRoutes.post("/:id/cancel", requireAnyPermission("expenses.create", "expenses.approve"), async (c) => {
  const { reason } = await readJson(c, reasonSchema);
  return ok(c, await expenses.cancelExpense(c.get("actor"), readId(c), reason), "Expense cancelled.");
});
