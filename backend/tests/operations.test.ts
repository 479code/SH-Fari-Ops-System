import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../src/db/client.ts";
import { auditLogs, exceptions, stockLedger } from "../src/db/schema/index.ts";
import * as dsr from "../src/services/dsr.service.ts";
import * as git from "../src/services/git.service.ts";
import * as receipts from "../src/services/receipts.service.ts";
import * as rtt from "../src/services/rtt.service.ts";
import * as stock from "../src/services/stock.service.ts";
import type { Actor } from "../src/types.ts";
import { addDays, today } from "../src/utils/dates.ts";
import { AppError } from "../src/utils/errors.ts";
import { actorFor, adminActor, call, login, makeStation, makeUser, resetDatabase } from "./helpers.ts";

let admin: Actor;
let manager: Actor;
let s: Awaited<ReturnType<typeof makeStation>>;
const D0 = addDays(today(), -6);
const D1 = addDays(today(), -5);
const D2 = addDays(today(), -4);

async function balance(date?: string) {
  const summary = await stock.getMovementSummary(admin, { stationId: s.stationId, productId: s.productId, date: date ?? today() });
  return summary.closing;
}

async function rejects(promise: Promise<unknown>, code: AppError["code"]) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return err as AppError;
  }
  throw new Error(`expected the call to fail with ${code}`);
}

beforeAll(async () => {
  await resetDatabase();
  admin = await adminActor();
  s = await makeStation(admin, { openingStock: 10_000, openingDate: D0, price: 700, priceFrom: addDays(today(), -30) });
  const m = await makeUser({ roles: ["Station Manager"], stationId: s.stationId });
  manager = await actorFor(m.id);
});

describe("truck receiving", () => {
  test("a receipt only moves stock once verified", async () => {
    const r = await receipts.createReceipt(manager, {
      stationId: s.stationId, productId: s.productId, quantity: 5_000, orderPrice: 640, landingPrice: 650,
      waybillRef: "WB-OPS-1", truckPlate: "NGR-201-KJ", businessDate: D1,
    });
    expect(r.status).toBe("received");
    expect(await balance(D1)).toBe(10_000);
    await receipts.verifyReceipt(manager, r.id);
    expect(await balance(D1)).toBe(15_000);
    await rejects(receipts.verifyReceipt(manager, r.id), "CONFLICT");
  });
});

describe("DSR, RTT and the stock ledger", () => {
  let day1: number;

  test("net sales exclude RTT and closing stock follows the tank equation", async () => {
    const opened = await dsr.openDay(manager, { stationId: s.stationId, businessDate: D1 });
    day1 = opened.day!.id;
    expect(opened.readings[0]!.openingReading).toBe(1000);

    await rtt.createRtt(manager, { stationId: s.stationId, pumpId: s.pumpId, quantity: 20, reason: "Calibration", businessDate: D1 });
    await dsr.saveReadings(manager, day1, { readings: [{ pumpId: s.pumpId, closingReading: 3000 }] });

    // Closing a day needs dsr.close, which a pump officer does not have.
    const officer = await makeUser({ roles: ["Pump / Sales Officer"], stationId: s.stationId });
    const officerCookie = await login(officer.username);
    expect((await call("POST", `/dsr/${day1}/close`, { cookie: officerCookie, body: {} })).status).toBe(403);

    const closed = await dsr.closeDay(manager, day1);
    expect(closed.status).toBe("closed");
    const reading = closed.readings[0]!;
    expect(reading.dispensed).toBe(2000);
    expect(reading.rtt).toBe(20);
    expect(reading.netSales).toBe(1980);
    expect(reading.salesValue).toBe(1_386_000);

    const movement = await stock.getMovementSummary(admin, { stationId: s.stationId, productId: s.productId, date: D1 });
    expect(movement).toMatchObject({ opening: 10_000, receipts: 5_000, dispensed: 2_000, rtt: 20, closing: 13_020, netSales: 1_980 });
  });

  test("a closed day is locked", async () => {
    await rejects(rtt.createRtt(manager, { stationId: s.stationId, pumpId: s.pumpId, quantity: 5, reason: "Late", businessDate: D1 }), "CONFLICT");
    await rejects(dsr.saveReadings(manager, day1, { readings: [{ pumpId: s.pumpId, closingReading: 3100 }] }), "CONFLICT");
  });

  test("closing readings carry forward and only the latest day can be reopened", async () => {
    const opened = await dsr.openDay(manager, { stationId: s.stationId, businessDate: D2 });
    expect(opened.readings[0]!.openingReading).toBe(3000);
    expect(opened.readings[0]!.openingEditable).toBe(false);
    await rejects(dsr.reopenDay(admin, day1, "Correction"), "CONFLICT");

    await dsr.saveReadings(manager, opened.day!.id, { readings: [{ pumpId: s.pumpId, closingReading: 3500 }] });
    await dsr.closeDay(manager, opened.day!.id);
    expect(await balance(D2)).toBe(12_520);
  });

  test("physical dip variance is flagged, and recalculated after a reopen", async () => {
    const dip = await stock.recordDip(manager, { tankId: s.tankId, businessDate: D2, dipLitres: 12_000 });
    expect(dip).toMatchObject({ systemStock: 12_520, variance: -520, toleranceStatus: "exceeded" });
    const [flag] = await db.select().from(exceptions).where(and(eq(exceptions.type, "stock_variance"), eq(exceptions.sourceId, dip.id)));
    expect(flag!.status).toBe("open");

    const day = await dsr.getDay(admin, s.stationId, D2);
    const reopened = await dsr.reopenDay(admin, day.day!.id, "Closing reading mis-keyed");
    expect(reopened.status).toBe("open");
    expect(await balance(D2)).toBe(13_020); // the day's postings are voided while it is reopened
    const active = await db.select().from(stockLedger).where(and(eq(stockLedger.sourceType, "dsr_reading"), isNull(stockLedger.voidedAt)));
    expect(active.length).toBe(1);

    await dsr.saveReadings(manager, day.day!.id, { readings: [{ pumpId: s.pumpId, closingReading: 3800 }] });
    await dsr.closeDay(manager, day.day!.id);
    expect(await balance(D2)).toBe(12_220);

    const [after] = await db.select().from(exceptions).where(and(eq(exceptions.type, "stock_variance"), eq(exceptions.sourceId, dip.id)));
    expect(after!.status).toBe("closed"); // −220 L is within the ±300 L tolerance

    const audit = await db.select().from(auditLogs).where(eq(auditLogs.action, "reopened"));
    expect(audit.length).toBe(1);
    expect(audit[0]!.newValue).toMatchObject({ reason: "Closing reading mis-keyed" });
  });

  test("stock cannot go negative unless allowed, and the ledger traces every movement", async () => {
    await rejects(stock.recordAdjustment(admin, { tankId: s.tankId, businessDate: today(), quantity: -1_000_000, reason: "Test" }), "CONFLICT");
    const ledger = await stock.getLedger(admin, { stationId: s.stationId, productId: s.productId, from: D0, to: today(), page: 1, limit: 50, sortOrder: "asc" });
    expect(ledger.rows.at(-1)!.runningBalance).toBe(12_220);
    expect(ledger.rows.map((r) => r.movementType)).toEqual(["opening_balance", "receipt", "dispensed", "rtt", "dispensed"]);
    expect(ledger.dips.length).toBe(1);
  });
});

describe("goods in transit", () => {
  test("a linked verified receipt discharges the order and flags shortages; cancelling reverses it", async () => {
    const order = await git.createOrder(admin, {
      productId: s.productId, quantity: 5_000, orderPrice: 640, truckPlate: "NGR-482-XY", isMultiDelivery: false,
      destinations: [{ stationId: s.stationId }],
    });
    expect(order.status).toBe("truck_assigned");
    await git.changeStatus(admin, order.id, { status: "in_transit" });
    await git.changeStatus(admin, order.id, { status: "arrived" });
    await rejects(git.changeStatus(admin, order.id, { status: "in_transit" }), "CONFLICT");

    const [delivery] = await git.openDeliveries(admin, { stationId: s.stationId, productId: s.productId });
    const receipt = await receipts.createReceipt(manager, {
      stationId: s.stationId, productId: s.productId, quantity: 4_800, orderPrice: 640, landingPrice: 652,
      waybillRef: "WB-GIT-1", truckPlate: "NGR-482-XY", gitDeliveryId: delivery!.deliveryId,
    });
    await receipts.verifyReceipt(manager, receipt.id);

    const done = await git.getOrder(admin, order.id);
    expect(done.status).toBe("completed");
    expect(done.exceptionType).toBe("shortage");
    const [shortage] = await db.select().from(exceptions).where(eq(exceptions.type, "git_shortage"));
    expect(shortage!.amount).toBe(200);

    await receipts.cancelReceipt(manager, receipt.id, "Wrong truck");
    const reverted = await git.getOrder(admin, order.id);
    expect(reverted.status).toBe("arrived");
    expect(reverted.exceptionType).toBeNull();
    const [closed] = await db.select().from(exceptions).where(eq(exceptions.type, "git_shortage"));
    expect(closed!.status).toBe("closed");
  });

  test("deliveries must allocate the full order quantity and the original price is immutable", async () => {
    const order = await git.createOrder(admin, {
      productId: s.productId, quantity: 1000, orderPrice: 600, isMultiDelivery: false, destinations: [{ stationId: s.stationId }],
    });
    expect(order.status).toBe("order_created");
    await rejects(git.setDeliveries(admin, order.id, [{ stationId: s.stationId, quantity: 400 }]), "VALIDATION_ERROR");

    const cookie = await login((await makeUser({ roles: ["Receiving / Operations Officer"] })).username);
    const res = await call("PATCH", `/git-orders/${order.id}`, { cookie, body: { orderPrice: 1, quantity: 5, truckPlate: "NGR-900-ZZ" } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ orderPrice: 600, quantity: 1000, truckPlate: "NGR-900-ZZ", status: "truck_assigned" });
  });
});
