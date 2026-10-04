/**
 * seed-demo.ts — realistic development data (refuses to run in production).
 *
 * Builds three stations and ~6 weeks of operations by calling the real service
 * layer — exactly what the API does — so every derived figure (stock ledger,
 * DSR sales, cash variances, debtor aging, GIT status, exceptions, audit trail)
 * is produced by the application's own business rules rather than inserted.
 *
 * Run on an empty database: `bun run db:migrate && bun run db:seed:demo`.
 */
import { eq } from "drizzle-orm";
import { isProduction } from "../config/env.ts";
import { runChecks } from "../jobs/scheduler.ts";
import { loadAccess } from "../services/auth.service.ts";
import * as cash from "../services/cash.service.ts";
import * as debtorsService from "../services/debtors.service.ts";
import * as dsr from "../services/dsr.service.ts";
import * as expenses from "../services/expenses.service.ts";
import * as git from "../services/git.service.ts";
import * as master from "../services/masterdata.service.ts";
import * as receipts from "../services/receipts.service.ts";
import * as rtt from "../services/rtt.service.ts";
import * as stationsService from "../services/stations.service.ts";
import * as stock from "../services/stock.service.ts";
import * as usersService from "../services/users.service.ts";
import type { Actor } from "../types.ts";
import { addDays, today } from "../utils/dates.ts";
import { logger } from "../utils/logger.ts";
import { money } from "../utils/numbers.ts";
import { closeDb, db } from "./client.ts";
import { seedCore } from "./seed.ts";
import { gitOrders, products, roles, stations, users } from "./schema/index.ts";

const DAYS = 45;
const DEMO_PASSWORD = "Password123";

/** Deterministic PRNG so every demo database is identical. */
function prng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(20260914);
const between = (min: number, max: number) => Math.round((min + rand() * (max - min)) * 10) / 10;

async function actorFor(username: string): Promise<Actor> {
  const [u] = await db.select().from(users).where(eq(users.username, username));
  if (!u) throw new Error(`Demo user ${username} missing`);
  const access = await loadAccess(u.id);
  return {
    id: u.id,
    username: u.username,
    fullName: u.fullName,
    stationId: u.stationId,
    roles: access.roles,
    permissions: new Set(access.permissions),
    sessionId: "seed-demo",
    mustChangePassword: false,
    ip: "127.0.0.1",
    userAgent: "seed-demo",
  };
}

async function roleId(name: string) {
  const [r] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name));
  return r!.id;
}

async function main() {
  if (isProduction) throw new Error("Refusing to load demo data into a production environment.");
  await seedCore();
  const existing = await db.select({ id: stations.id }).from(stations).limit(1);
  if (existing.length > 0) throw new Error("Demo data needs an empty database (stations already exist). Recreate the database and run migrations first.");

  const [adminRow] = await db.select().from(users).limit(1);
  const admin = await actorFor(adminRow!.username);
  const T = today();
  const START = addDays(T, -DAYS);
  const pms = (await db.select().from(products).where(eq(products.code, "PMS")))[0]!;
  const ago = (await db.select().from(products).where(eq(products.code, "AGO")))[0]!;

  logger.info("demo: master data");
  for (const name of ["GTBank", "Zenith Bank", "Access Bank", "First Bank", "UBA"]) await master.createBank(admin, { name });
  for (const [name, approvalThreshold] of [
    ["Generator diesel", null],
    ["Pump maintenance", 100_000],
    ["Security wages", null],
    ["Waybill / logistics", 50_000],
    ["Office supplies", 20_000],
  ] as const) {
    await master.createNarration(admin, { name, approvalThreshold });
  }

  // Users — station assignments are set after stations exist.
  const people = [
    { username: "c.nwachukwu", fullName: "C. Nwachukwu", roles: ["Station Manager", "Cashier / Accounts Officer"] },
    { username: "b.adewale", fullName: "B. Adewale", roles: ["Pump / Sales Officer"] },
    { username: "k.musa", fullName: "K. Musa", roles: ["Station Manager"] },
    { username: "r.olawale", fullName: "R. Olawale", roles: ["Cashier / Accounts Officer"] },
    { username: "t.ojo", fullName: "T. Ojo", roles: ["Pump / Sales Officer"] },
    { username: "h.bello", fullName: "H. Bello", roles: ["Station Manager"] },
    { username: "m.garba", fullName: "M. Garba", roles: ["Cashier / Accounts Officer"] },
    { username: "y.ibrahim", fullName: "Y. Ibrahim", roles: ["Pump / Sales Officer"] },
    { username: "f.okoro", fullName: "F. Okoro", roles: ["Receiving / Operations Officer"] },
    { username: "a.danjuma", fullName: "A. Danjuma", roles: ["Management / ED"] },
    { username: "s.audu", fullName: "S. Audu", roles: ["Auditor / Control"] },
  ];
  const userIds = new Map<string, number>();
  for (const p of people) {
    const created = await usersService.createUser(admin, {
      username: p.username,
      fullName: p.fullName,
      roleIds: await Promise.all(p.roles.map(roleId)),
      password: DEMO_PASSWORD,
    });
    userIds.set(p.username, created.id);
  }

  logger.info("demo: stations, tanks, pumps");
  const openingDate = addDays(START, -1);
  const stationPlan = [
    {
      code: "LA", name: "Lagos – Apapa", manager: "c.nwachukwu", cashTolerance: 20_000, stockTolerance: 300,
      staff: { manager: "c.nwachukwu", cashier: "c.nwachukwu", pump: "b.adewale", approver: "admin" },
      tanks: [
        { name: "PMS Tank 1", product: pms.id, capacity: 90_000, opening: 42_000 },
        { name: "AGO Tank 1", product: ago.id, capacity: 60_000, opening: 30_000 },
      ],
      pumps: [
        { name: "Pump 1", tank: "PMS Tank 1", meter: "Meter A", initial: 184_220.4, range: [2300, 2900] },
        { name: "Pump 2", tank: "PMS Tank 1", meter: "Meter B", initial: 97_410.1, range: [2100, 2700] },
        { name: "Pump 3", tank: "AGO Tank 1", meter: "Meter A", initial: 52_110, range: [1500, 1900] },
        { name: "Pump 4", tank: "AGO Tank 1", meter: "Meter B", initial: 21_870.5, range: [1300, 1700] },
      ],
      receipts: [
        { tank: "PMS Tank 1", every: 6, offset: 0, qty: 33_000 },
        { tank: "AGO Tank 1", every: 9, offset: 1, qty: 33_000 },
      ],
    },
    {
      code: "IB", name: "Ibadan – Ring Rd", manager: "k.musa", cashTolerance: 20_000, stockTolerance: 300,
      staff: { manager: "k.musa", cashier: "r.olawale", pump: "t.ojo", approver: "k.musa" },
      tanks: [
        { name: "PMS Tank 1", product: pms.id, capacity: 70_000, opening: 36_000 },
        { name: "AGO Tank 1", product: ago.id, capacity: 45_000, opening: 20_000 },
      ],
      pumps: [
        { name: "Pump 1", tank: "PMS Tank 1", meter: "Meter A", initial: 66_402, range: [2200, 2700] },
        { name: "Pump 2", tank: "PMS Tank 1", meter: "Meter B", initial: 58_119.6, range: [2000, 2500] },
        { name: "Pump 3", tank: "AGO Tank 1", meter: "Meter A", initial: 31_005.2, range: [1400, 1800] },
      ],
      receipts: [
        { tank: "PMS Tank 1", every: 6, offset: 2, qty: 30_000 },
        { tank: "AGO Tank 1", every: 9, offset: 3, qty: 15_000 },
      ],
    },
    {
      code: "YL", name: "Yola", manager: "h.bello", cashTolerance: 15_000, stockTolerance: 250,
      staff: { manager: "h.bello", cashier: "m.garba", pump: "y.ibrahim", approver: "h.bello" },
      tanks: [
        { name: "PMS Tank 1", product: pms.id, capacity: 50_000, opening: 26_000 },
        { name: "PMS Tank 2", product: pms.id, capacity: 50_000, opening: 24_000 },
        { name: "AGO Tank 1", product: ago.id, capacity: 40_000, opening: 18_000 },
      ],
      pumps: [
        { name: "Pump 1", tank: "PMS Tank 1", meter: "Meter A", initial: 40_310, range: [1800, 2200] },
        { name: "Pump 2", tank: "PMS Tank 2", meter: "Meter A", initial: 38_774.3, range: [1600, 2000] },
        { name: "Pump 3", tank: "AGO Tank 1", meter: "Meter A", initial: 19_250.8, range: [1100, 1500] },
      ],
      receipts: [
        { tank: "PMS Tank 1", every: 12, offset: 4, qty: 28_000 },
        { tank: "PMS Tank 2", every: 12, offset: 10, qty: 28_000 },
        { tank: "AGO Tank 1", every: 10, offset: 5, qty: 15_000 },
      ],
    },
  ];

  const built: Array<{
    plan: (typeof stationPlan)[number];
    id: number;
    tankIds: Map<string, number>;
    tankProduct: Map<number, number>;
    pumps: { id: number; name: string; range: number[]; productId: number }[];
  }> = [];

  for (const plan of stationPlan) {
    const station = await stationsService.createStation(admin, {
      code: plan.code,
      name: plan.name,
      managerUserId: userIds.get(plan.manager)!,
      cashTolerance: plan.cashTolerance,
      stockTolerance: plan.stockTolerance,
    });
    for (const t of plan.tanks) {
      await stationsService.createTank(admin, station.id, { productId: t.product, name: t.name, capacity: t.capacity, openingStock: t.opening, openingDate });
    }
    const detail = await stationsService.getStation(admin, station.id);
    const tankIds = new Map(detail.tanks.map((t) => [t.name, t.id]));
    const tankProduct = new Map(detail.tanks.map((t) => [t.id, t.productId]));
    for (const p of plan.pumps) {
      await stationsService.createPump(admin, station.id, { tankId: tankIds.get(p.tank)!, name: p.name, meterLabel: p.meter, initialReading: p.initial });
    }
    const withPumps = await stationsService.getStation(admin, station.id);
    built.push({
      plan,
      id: station.id,
      tankIds,
      tankProduct,
      pumps: withPumps.pumps.map((p) => ({ id: p.id, name: p.name, range: plan.pumps.find((x) => x.name === p.name)!.range, productId: tankProduct.get(p.tankId)! })),
    });
    // Bind station staff (managers, cashiers, pump officers) to their station.
    for (const username of new Set(Object.values(plan.staff))) {
      if (username === "admin") continue;
      await usersService.updateUser(admin, userIds.get(username)!, { stationId: station.id });
    }
  }
  // Demo convenience: staff can sign in straight away with the demo password.
  for (const id of userIds.values()) await db.update(users).set({ mustChangePassword: false }).where(eq(users.id, id));

  logger.info("demo: prices");
  await master.addPrice(admin, pms.id, { price: 670, effectiveFrom: addDays(START, -5) });
  await master.addPrice(admin, pms.id, { price: 678, effectiveFrom: addDays(T, -10) });
  await master.addPrice(admin, ago.id, { price: 975, effectiveFrom: addDays(START, -5) });
  await master.addPrice(admin, pms.id, { stationId: built[2]!.id, price: 690, effectiveFrom: addDays(START, -5) });

  const receiving = await actorFor("f.okoro");

  logger.info("demo: debtors");
  const debtorPlan = [
    { station: 0, name: "Coastal Fleet Services", opening: 1_800_000, openingDays: 75, limit: 4_000_000 },
    { station: 0, name: "Adeyemi & Sons", opening: 640_000, openingDays: 50, limit: null },
    { station: 1, name: "Femi Transport Ltd", opening: 2_100_000, openingDays: 120, limit: 5_000_000 },
    { station: 1, name: "Oyo Haulage Co.", opening: 350_000, openingDays: 20, limit: 2_000_000 },
    { station: 2, name: "Sahel Logistics", opening: 980_000, openingDays: 40, limit: 3_000_000 },
  ];
  const debtorIds: number[][] = [[], [], []];
  for (const d of debtorPlan) {
    const cashier = await actorFor(built[d.station]!.plan.staff.cashier);
    const debtor = await debtorsService.createDebtor(cashier, {
      stationId: built[d.station]!.id,
      name: d.name,
      creditLimit: d.limit,
      openingBalance: d.opening,
      openingDate: addDays(T, -d.openingDays),
    });
    debtorIds[d.station]!.push(debtor.id);
  }

  const narrations = await master.listNarrations();
  const banks = await master.listBanks();
  let teller = 88_100;

  logger.info("demo: daily operations", { days: DAYS });
  for (let i = 0; i < DAYS; i++) {
    const date = addDays(START, i);
    for (const [si, s] of built.entries()) {
      const pump = await actorFor(s.plan.staff.pump);
      const manager = await actorFor(s.plan.staff.manager);
      const cashier = await actorFor(s.plan.staff.cashier);
      const approver = s.plan.staff.approver === "admin" ? admin : await actorFor(s.plan.staff.approver);

      // Deliveries first so the day's stock includes them.
      for (const r of s.plan.receipts) {
        if ((i - r.offset) % r.every !== 0 || i < r.offset) continue;
        const tankId = s.tankIds.get(r.tank)!;
        const productId = s.tankProduct.get(tankId)!;
        const isPms = productId === pms.id;
        const received = await receipts.createReceipt(receiving, {
          stationId: s.id,
          productId,
          tankId,
          quantity: r.qty,
          orderPrice: isPms ? 645 : 930,
          landingPrice: isPms ? between(650, 654) : between(939, 943),
          waybillRef: `WB-${String(80_000 + i * 10 + si).padStart(5, "0")}${r.tank.endsWith("2") ? "B" : ""}${isPms ? "" : "G"}`,
          truckPlate: `NGR-${String(100 + ((i * 7 + si * 13) % 800)).padStart(3, "0")}-${isPms ? "KJ" : "XY"}`,
          businessDate: date,
        });
        await receipts.verifyReceipt(receiving, received.id);
      }

      await dsr.openDay(pump, { stationId: s.id, businessDate: date });
      const day = await dsr.getDay(pump, s.id, date);

      if (i % 6 === 0) {
        await rtt.createRtt(pump, { stationId: s.id, pumpId: s.pumps[0]!.id, quantity: 40, reason: "Meter calibration test", businessDate: date });
      }
      if (i % 10 === 3) {
        await rtt.createRtt(pump, { stationId: s.id, pumpId: s.pumps[s.pumps.length - 1]!.id, quantity: 15, reason: "Trial dispensing after seal change", businessDate: date });
      }

      await dsr.saveReadings(pump, day.day!.id, {
        readings: day.readings.map((r) => {
          const p = s.pumps.find((x) => x.id === r.pumpId)!;
          return { pumpId: r.pumpId, closingReading: Math.round((r.openingReading + between(p.range[0]!, p.range[1]!)) * 10) / 10 };
        }),
      });
      await dsr.closeDay(manager, day.day!.id);

      // Expenses
      if (i % 3 === si % 3) {
        const n = narrations[(i + si) % narrations.length]!;
        const amount = n.approvalThreshold !== null && i % 2 === 0 ? n.approvalThreshold + 80_000 : Math.round(between(20_000, 95_000) / 1000) * 1000;
        const cappedAmount = n.approvalThreshold !== null && i % 2 !== 0 ? Math.min(amount, n.approvalThreshold) : amount;
        const expense = await expenses.createExpense(cashier, {
          stationId: s.id,
          narrationId: n.id,
          amount: cappedAmount,
          payee: n.name === "Pump maintenance" ? "TechFix Nig. Ltd" : n.name === "Waybill / logistics" ? "Transporter" : "Station float",
          businessDate: date,
          paymentMethod: n.name === "Pump maintenance" ? "transfer" : "cash",
        });
        if (expense.status === "pending" && i < DAYS - 3) {
          if (cashier.id === approver.id) await expenses.approveExpense(admin, expense.id, "Approved by head office");
          else await expenses.approveExpense(approver, expense.id, null);
        }
      }

      // Debtors: credit sales and repayments
      const stationDebtors = debtorIds[si]!;
      if (i % 4 === 1 && stationDebtors.length > 0) {
        await debtorsService.recordTransaction(cashier, stationDebtors[i % stationDebtors.length]!, {
          type: "credit_sale",
          amount: Math.round(between(80_000, 220_000) / 1000) * 1000,
          businessDate: date,
          reference: `INV-${s.plan.code}-${i}`,
        });
      }
      if (i % 7 === 5 && stationDebtors.length > 0) {
        const debtorId = stationDebtors[(i + 1) % stationDebtors.length]!;
        const detail = await debtorsService.getDebtor(cashier, debtorId);
        const amount = Math.min(detail.balance, Math.round(between(100_000, 300_000) / 1000) * 1000);
        if (amount > 0) {
          await debtorsService.recordTransaction(cashier, debtorId, {
            type: "repayment",
            amount,
            businessDate: date,
            paymentMethod: i % 2 === 0 ? "cash" : "transfer",
            reference: `RCPT-${s.plan.code}-${i}`,
          });
        }
      }

      // Cash: POS, deposits teller-wise, CIT and cash at hand, with occasional variances.
      const pos = await cash.getPosition(cashier, s.id, date);
      const posAmount = money(Math.round((pos.figures.salesValue * between(0.14, 0.22)) / 100) * 100);
      const expected = money(pos.figures.expectedCash - posAmount);
      const variance = i % 9 === 4 ? -84_000 : i % 5 === 2 ? -Math.round(between(2_000, 9_000) / 100) * 100 : 0;
      const closingCit = i % 7 === 6 ? 202_000 : 0;
      const cashAtHand = i % 4 === 0 ? 2_400 : 0;
      const toDeposit = money(pos.figures.broughtForward + expected + variance - closingCit - cashAtHand);
      if (toDeposit > 0) {
        const first = money(Math.round((toDeposit * 0.55) / 1000) * 1000);
        const parts = first > 0 && first < toDeposit ? [first, money(toDeposit - first)] : [toDeposit];
        for (const [pi, amount] of parts.entries()) {
          teller++;
          await cash.recordDeposit(cashier, {
            stationId: s.id,
            businessDate: date,
            bankId: banks[(si + pi) % 2]!.id,
            tellerRef: `TLR-${teller}`,
            amount,
            depositTime: pi === 0 ? "09:40" : "15:10",
          });
        }
      }
      const declared = await cash.saveDeclaration(cashier, { stationId: s.id, businessDate: date, posAmount, closingCit, cashAtHand, notes: null });
      if (i < DAYS - 3 && declared.declaration) {
        await cash.closePosition(
          manager,
          declared.declaration.id,
          declared.figures.toleranceStatus === "exceeded" ? "Shortfall investigated — attendant surcharge raised" : null,
        );
      }

      // Physical dips — observations with a little noise, and an occasional loss.
      for (const [tankName, tankId] of s.tankIds) {
        const closing = await stock.getSystemClosing(manager, tankId, date);
        const loss = i % 11 === 7 && tankName.startsWith("PMS") ? -between(600, 680) : 0;
        await stock.recordDip(manager, {
          tankId,
          businessDate: date,
          dipLitres: Math.max(0, Math.round((closing.systemStock + between(-120, 110) + loss) * 10) / 10),
        });
      }
    }
    if (i % 10 === 9) logger.info("demo: progress", { day: i + 1, of: DAYS });
  }

  logger.info("demo: goods in transit and today's activity");
  const [la, ib, yl] = built;
  const laPump = await actorFor("b.adewale");

  // Delivered order linked to a receipt (completes on verification).
  const completed = await git.createOrder(receiving, {
    productId: pms.id, quantity: 33_000, orderPrice: 645, truckPlate: "NGR-201-KJ", isMultiDelivery: false,
    destinations: [{ stationId: la!.id }], orderDate: addDays(T, -3), source: "Lagos Apapa depot",
  });
  await git.changeStatus(receiving, completed.id, { status: "in_transit" });
  await git.changeStatus(receiving, completed.id, { status: "arrived" });
  const deliveries = await git.openDeliveries(receiving, { stationId: la!.id, productId: pms.id });
  const todays = await receipts.createReceipt(receiving, {
    stationId: la!.id, productId: pms.id, quantity: 33_000, orderPrice: 645, landingPrice: 652.4,
    waybillRef: "WB-88213", truckPlate: "NGR-201-KJ", gitDeliveryId: deliveries.find((d) => d.orderId === completed.id)!.deliveryId,
  });
  await receipts.verifyReceipt(receiving, todays.id);

  // Delayed in-transit order (6 days in transit).
  const delayed = await git.createOrder(receiving, {
    productId: ago.id, quantity: 33_000, orderPrice: 930, truckPlate: "NGR-482-XY", isMultiDelivery: false,
    destinations: [{ stationId: la!.id }], orderDate: addDays(T, -8), source: "Lagos Apapa depot",
  });
  await git.changeStatus(receiving, delayed.id, { status: "in_transit" });
  // Demo only: backdate the transit start so the delay control has something to flag.
  await db.update(gitOrders).set({ inTransitAt: new Date(Date.now() - 6 * 86_400_000) }).where(eq(gitOrders.id, delayed.id));
  await receipts.createReceipt(receiving, {
    stationId: la!.id, productId: ago.id, quantity: 33_000, orderPrice: 930, landingPrice: 941.1,
    waybillRef: "WB-88190", truckPlate: "NGR-482-XY",
    gitDeliveryId: (await git.openDeliveries(receiving, { stationId: la!.id, productId: ago.id })).find((d) => d.orderId === delayed.id)!.deliveryId,
  });

  // Arrived at Yola, awaiting discharge.
  const arrived = await git.createOrder(receiving, {
    productId: pms.id, quantity: 28_000, orderPrice: 644, truckPlate: "NGR-301-DC", isMultiDelivery: false,
    destinations: [{ stationId: yl!.id }], orderDate: addDays(T, -4), source: "Port Harcourt depot",
  });
  await git.changeStatus(receiving, arrived.id, { status: "in_transit" });
  await git.changeStatus(receiving, arrived.id, { status: "arrived" });

  // Multi-delivery order, truck assigned.
  await git.createOrder(receiving, {
    productId: pms.id, quantity: 30_000, orderPrice: 646, truckPlate: "NGR-640-MD", isMultiDelivery: true,
    destinations: [{ stationId: ib!.id, quantity: 15_000 }, { stationId: yl!.id, quantity: 15_000 }], orderDate: addDays(T, -1),
  });

  // Shortage: 15,000 L ordered for Ibadan, 14,600 L received.
  const short = await git.createOrder(receiving, {
    productId: ago.id, quantity: 15_000, orderPrice: 928, truckPlate: "NGR-559-TR", isMultiDelivery: false,
    destinations: [{ stationId: ib!.id }], orderDate: addDays(T, -5),
  });
  await git.changeStatus(receiving, short.id, { status: "in_transit" });
  await git.changeStatus(receiving, short.id, { status: "arrived" });
  const shortReceipt = await receipts.createReceipt(receiving, {
    stationId: ib!.id, productId: ago.id, quantity: 14_600, orderPrice: 928, landingPrice: 935.6,
    waybillRef: "WB-88140", truckPlate: "NGR-559-TR",
    gitDeliveryId: (await git.openDeliveries(receiving, { stationId: ib!.id, productId: ago.id })).find((d) => d.orderId === short.id)!.deliveryId,
  });
  await receipts.verifyReceipt(receiving, shortReceipt.id);

  // A disputed receipt awaiting resolution.
  const disputed = await receipts.createReceipt(receiving, {
    stationId: ib!.id, productId: pms.id, quantity: 33_000, orderPrice: 644, landingPrice: 651.2, waybillRef: "WB-88112", truckPlate: "NGR-064-LM",
  });
  await receipts.disputeReceipt(receiving, disputed.id, "Seal numbers do not match the waybill");

  // Today at Lagos: the day is open (not yet locked) with RTT logged.
  await dsr.openDay(laPump, { stationId: la!.id, businessDate: T });
  await rtt.createRtt(laPump, { stationId: la!.id, pumpId: la!.pumps[0]!.id, quantity: 40, reason: "Meter calibration test" });
  await rtt.createRtt(laPump, { stationId: la!.id, pumpId: la!.pumps[2]!.id, quantity: 15, reason: "Trial dispensing after seal change" });

  // A pending above-threshold expense for Ibadan.
  const ibCashier = await actorFor("r.olawale");
  const maintenance = narrations.find((n) => n.name === "Pump maintenance")!;
  await expenses.createExpense(ibCashier, { stationId: ib!.id, narrationId: maintenance.id, amount: 180_000, payee: "TechFix Nig. Ltd", paymentMethod: "transfer" });

  await runChecks();
  logger.info("demo: complete");
  console.log(`\nDemo data loaded. Staff accounts use password "${DEMO_PASSWORD}":`);
  for (const p of people) console.log(`  ${p.username.padEnd(12)} ${p.roles.join(", ")}`);
  console.log(`Administrator: ${adminRow!.username} (password from SEED_ADMIN_PASSWORD; must be changed at first sign-in)\n`);
}

try {
  await main();
  await closeDb();
  process.exit(0);
} catch (err) {
  logger.error("demo seed failed", { err });
  await closeDb();
  process.exit(1);
}
