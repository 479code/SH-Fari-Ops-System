import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client.ts";
import { exceptions } from "../src/db/schema/index.ts";
import * as cash from "../src/services/cash.service.ts";
import * as debtors from "../src/services/debtors.service.ts";
import * as dsr from "../src/services/dsr.service.ts";
import * as expenses from "../src/services/expenses.service.ts";
import * as master from "../src/services/masterdata.service.ts";
import * as receipts from "../src/services/receipts.service.ts";
import type { Actor } from "../src/types.ts";
import { addDays, today } from "../src/utils/dates.ts";
import { AppError } from "../src/utils/errors.ts";
import { actorFor, adminActor, call, login, makeStation, makeUser, resetDatabase } from "./helpers.ts";

let admin: Actor;
let cashier: Actor;
let manager: Actor;
let cashierLogin: { username: string };
let s: Awaited<ReturnType<typeof makeStation>>;
let bankId: number;
let narrationId: number;
let debtorId: number;
const D0 = addDays(today(), -4);
const D1 = addDays(today(), -3);
const D2 = addDays(today(), -2);

async function rejects(promise: Promise<unknown>, code: AppError["code"]) {
  try {
    await promise;
  } catch (err) {
    expect((err as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

beforeAll(async () => {
  await resetDatabase();
  admin = await adminActor();
  s = await makeStation(admin, { openingStock: 50_000, openingDate: D0, price: 800, priceFrom: addDays(today(), -30), cashTolerance: 10_000 });
  const c = await makeUser({ roles: ["Cashier / Accounts Officer"], stationId: s.stationId });
  cashierLogin = c;
  cashier = await actorFor(c.id);
  manager = await actorFor((await makeUser({ roles: ["Station Manager"], stationId: s.stationId })).id);
  bankId = (await master.createBank(admin, { name: "GTBank" })).id;
  narrationId = (await master.createNarration(admin, { name: "Generator diesel", approvalThreshold: 100_000 })).id;

  // Cost basis, then a closed day with 1,000 L sold at ₦800.
  const r = await receipts.createReceipt(admin, {
    stationId: s.stationId, productId: s.productId, quantity: 1_000, orderPrice: 690, landingPrice: 700, waybillRef: "WB-FIN-1", truckPlate: "NGR-300-FN", businessDate: D1,
  });
  await receipts.verifyReceipt(admin, r.id);
  const day = await dsr.openDay(manager, { stationId: s.stationId, businessDate: D1 });
  await dsr.saveReadings(manager, day.day!.id, { readings: [{ pumpId: s.pumpId, closingReading: 2000 }] });
  await dsr.closeDay(manager, day.day!.id);

  const debtor = await debtors.createDebtor(cashier, { stationId: s.stationId, name: "Sahel Logistics", openingBalance: 100_000, openingDate: D0, creditLimit: 150_000 });
  debtorId = debtor.id;
});

describe("debtors", () => {
  test("balances are transaction-driven", async () => {
    await debtors.recordTransaction(cashier, debtorId, { type: "credit_sale", amount: 50_000, businessDate: D1 });
    const after = await debtors.recordTransaction(cashier, debtorId, { type: "repayment", amount: 20_000, businessDate: D1, paymentMethod: "cash" });
    expect(after.balance).toBe(130_000);
    expect(after.transactions.map((t) => t.runningBalance)).toEqual([130_000, 150_000, 100_000]);
  });

  test("repayments cannot exceed the balance and credit limits are enforced", async () => {
    await rejects(debtors.recordTransaction(cashier, debtorId, { type: "repayment", amount: 1_000_000, businessDate: D1, paymentMethod: "cash" }), "VALIDATION_ERROR");
    await rejects(debtors.recordTransaction(cashier, debtorId, { type: "credit_sale", amount: 30_000, businessDate: D1 }), "CONFLICT");
  });

  test("the list shows opening, additions, payments and closing for the period", async () => {
    const list = await debtors.listDebtors(cashier, { hasBalance: false, sortBy: "name", sortOrder: "asc", from: D1, to: D1, page: 1, limit: 10 });
    expect(list.rows[0]).toMatchObject({ opening: 100_000, additions: 50_000, payments: 20_000, closing: 130_000 });
  });
});

describe("expenses", () => {
  test("within-threshold expenses are approved immediately", async () => {
    const e = await expenses.createExpense(cashier, { stationId: s.stationId, narrationId, amount: 30_000, payee: "Station float", businessDate: D1, paymentMethod: "cash" });
    expect(e.status).toBe("approved");
  });

  test("above-threshold expenses need approval from someone else", async () => {
    const e = await expenses.createExpense(manager, { stationId: s.stationId, narrationId, amount: 150_000, payee: "TechFix", businessDate: D2, paymentMethod: "transfer" });
    expect(e.status).toBe("pending");
    await rejects(expenses.approveExpense(manager, e.id), "FORBIDDEN");
    const approved = await expenses.approveExpense(admin, e.id, "OK");
    expect(approved.status).toBe("approved");
  });
});

describe("cash reconciliation", () => {
  test("expected cash, variance and tolerance follow the documented formula", async () => {
    await cash.recordDeposit(cashier, { stationId: s.stationId, businessDate: D1, bankId, tellerRef: "TLR-1", amount: 600_000, depositTime: "09:40" });
    const position = await cash.saveDeclaration(cashier, { stationId: s.stationId, businessDate: D1, posAmount: 100_000, closingCit: 20_000, cashAtHand: 5_000 });
    // 800,000 sales − 100,000 POS − 50,000 credit + 20,000 cash repayment − 30,000 cash expense
    expect(position.figures.expectedCash).toBe(640_000);
    // 600,000 + 20,000 + 5,000 − 640,000
    expect(position.figures.variance).toBe(-15_000);
    expect(position.figures.toleranceStatus).toBe("exceeded");
    const [flag] = await db.select().from(exceptions).where(and(eq(exceptions.type, "cash_variance"), eq(exceptions.sourceId, position.declaration!.id)));
    expect(flag!.status).toBe("open");
  });

  test("a further deposit brings it within tolerance and clears the exception", async () => {
    const position = await cash.recordDeposit(cashier, { stationId: s.stationId, businessDate: D1, bankId, tellerRef: "TLR-2", amount: 10_000 });
    expect(position.figures.variance).toBe(-5_000);
    expect(position.figures.toleranceStatus).toBe("within_tolerance");
    const [flag] = await db.select().from(exceptions).where(eq(exceptions.type, "cash_variance"));
    expect(flag!.status).toBe("closed");
    await rejects(cash.recordDeposit(cashier, { stationId: s.stationId, businessDate: D1, bankId, tellerRef: "tlr-2", amount: 1 }), "CONFLICT");
  });

  test("CIT and cash at hand carry forward to the next day", async () => {
    const next = await cash.getPosition(cashier, s.stationId, D2);
    expect(next.figures.broughtForward).toBe(25_000);
  });

  test("a closed reconciliation freezes the day's cash inputs", async () => {
    const position = await cash.getPosition(cashier, s.stationId, D1);
    // Closing needs cash.review, which a cashier does not have.
    const cashierCookie = await login(cashierLogin.username);
    expect((await call("POST", `/cash/positions/${position.declaration!.id}/close`, { cookie: cashierCookie, body: {} })).status).toBe(403);
    const closed = await cash.closePosition(manager, position.declaration!.id, null);
    expect(closed.declaration!.status).toBe("closed");
    await rejects(cash.recordDeposit(cashier, { stationId: s.stationId, businessDate: D1, bankId, tellerRef: "TLR-3", amount: 1_000 }), "CONFLICT");
    await rejects(debtors.recordTransaction(cashier, debtorId, { type: "repayment", amount: 1_000, businessDate: D1, paymentMethod: "cash" }), "CONFLICT");
  });
});

describe("dashboard and reports", () => {
  test("station comparison reflects approved records and profit rules", async () => {
    const res = await call("GET", `/dashboard/comparison?month=${D1.slice(0, 7)}`, { cookie: await login((await makeUser({ roles: ["Management / ED"] })).username) });
    expect(res.status).toBe(200);
    const row = res.body.data.rows.find((r: { stationId: number }) => r.stationId === s.stationId);
    const sameMonth = D2.slice(0, 7) === D1.slice(0, 7);
    expect(row.salesValue).toBe(800_000);
    expect(row.costOfSales).toBe(700_000);
    expect(row.expenses).toBe(sameMonth ? 180_000 : 30_000);
    expect(row.netProfit).toBe(800_000 - 700_000 - row.expenses);
    expect(row.trucksReceived).toBe(1);
  });

  test("reports render as JSON and export to CSV only with permission", async () => {
    const cookie = await login((await makeUser({ roles: ["Management / ED"] })).username);
    const json = await call("GET", `/reports/daily-sales?from=${D1}&to=${D1}`, { cookie });
    expect(json.status).toBe(200);
    expect(json.body.data.totals).toMatchObject({ netSales: 1_000, value: 800_000 });

    const csv = await call("GET", `/reports/daily-sales?from=${D1}&to=${D1}&format=csv`, { cookie });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(String(csv.body)).toContain("Net sales (L)");

    const cashierCookie = await login(cashierLogin.username);
    expect((await call("GET", `/reports/daily-sales?format=csv`, { cookie: cashierCookie })).status).toBe(403);
    expect((await call("GET", `/reports/audit`, { cookie: cashierCookie })).status).toBe(403);
  });

  test("lists are paginated and every change is in the audit trail", async () => {
    const cookie = await login((await makeUser({ roles: ["Auditor / Control"] })).username);
    const page = await call("GET", "/expenses?limit=1&month=" + D1.slice(0, 7), { cookie });
    expect(page.body.pagination).toMatchObject({ page: 1, limit: 1 });
    expect(page.body.data.length).toBe(1);

    const audit = await call("GET", "/audit?search=WB-FIN-1", { cookie });
    const actions = audit.body.data.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["created", "verified"]));
  });
});
