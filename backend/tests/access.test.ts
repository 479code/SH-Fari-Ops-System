import { beforeAll, describe, expect, test } from "bun:test";
import * as receipts from "../src/services/receipts.service.ts";
import { addDays, today } from "../src/utils/dates.ts";
import { adminActor, call, login, makeStation, makeUser, resetDatabase } from "./helpers.ts";

let stationA: Awaited<ReturnType<typeof makeStation>>;
let stationB: Awaited<ReturnType<typeof makeStation>>;
let receiptA: number;

beforeAll(async () => {
  await resetDatabase();
  const admin = await adminActor();
  const opening = { openingDate: addDays(today(), -10), priceFrom: addDays(today(), -30) };
  stationA = await makeStation(admin, opening);
  stationB = await makeStation(admin, opening);
  const r = await receipts.createReceipt(admin, {
    stationId: stationA.stationId, productId: stationA.productId, quantity: 1000, orderPrice: 640, landingPrice: 650,
    waybillRef: "WB-ACCESS-1", truckPlate: "NGR-100-AA",
  });
  receiptA = r.id;
});

describe("role-based access control", () => {
  test("a pump officer cannot see dashboards, close days or view cash", async () => {
    const officer = await makeUser({ roles: ["Pump / Sales Officer"], stationId: stationA.stationId });
    const cookie = await login(officer.username);
    expect((await call("GET", "/dashboard", { cookie })).status).toBe(403);
    expect((await call("GET", "/cash/position", { cookie })).status).toBe(403);
    expect((await call("POST", "/dsr/1/close", { cookie, body: {} })).status).toBe(403);
    expect((await call("GET", "/dsr/day", { cookie })).status).toBe(200);
  });

  test("read-only roles cannot write", async () => {
    const auditor = await makeUser({ roles: ["Auditor / Control"] });
    const cookie = await login(auditor.username);
    expect((await call("GET", "/audit", { cookie })).status).toBe(200);
    expect((await call("POST", `/receipts/${receiptA}/verify`, { cookie, body: {} })).status).toBe(403);
    expect((await call("POST", "/stations", { cookie, body: { code: "ZZ", name: "Nope" } })).status).toBe(403);
  });
});

describe("station segregation", () => {
  test("station-bound users cannot read another station's records (reported as not found)", async () => {
    const manager = await makeUser({ roles: ["Station Manager"], stationId: stationB.stationId });
    const cookie = await login(manager.username);
    expect((await call("GET", `/receipts/${receiptA}`, { cookie })).status).toBe(404);
    expect((await call("POST", `/receipts/${receiptA}/verify`, { cookie, body: {} })).status).toBe(404);
    expect((await call("GET", `/receipts?stationId=${stationA.stationId}`, { cookie })).status).toBe(403);

    const list = await call("GET", "/receipts", { cookie });
    expect(list.status).toBe(200);
    expect(list.body.data.every((r: { stationId: number }) => r.stationId === stationB.stationId)).toBe(true);
  });

  test("station-bound users cannot write to another station", async () => {
    const manager = await makeUser({ roles: ["Station Manager"], stationId: stationB.stationId });
    const cookie = await login(manager.username);
    const res = await call("POST", "/receipts", {
      cookie,
      body: { stationId: stationA.stationId, productId: stationA.productId, quantity: 10, orderPrice: 1, landingPrice: 1, waybillRef: "WB-X", truckPlate: "NGR-111-XX" },
    });
    expect(res.status).toBe(403);
  });
});

describe("validation and error envelope", () => {
  test("returns field-level errors with 422", async () => {
    const officer = await makeUser({ roles: ["Receiving / Operations Officer"] });
    const cookie = await login(officer.username);
    const res = await call("POST", "/receipts", { cookie, body: { stationId: "abc", quantity: "-5", waybillRef: "" } });
    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(Object.keys(res.body.error.fields)).toEqual(expect.arrayContaining(["stationId", "quantity", "waybillRef", "productId"]));
  });

  test("rejects non-JSON bodies and unknown routes consistently", async () => {
    const officer = await makeUser({ roles: ["Receiving / Operations Officer"] });
    const cookie = await login(officer.username);
    const text = await call("POST", "/receipts", { cookie, body: "hello", headers: { "Content-Type": "text/plain" } });
    expect(text.status).toBe(400);
    const missing = await call("GET", "/does-not-exist", { cookie });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });

  test("duplicate waybill references conflict", async () => {
    const officer = await makeUser({ roles: ["Receiving / Operations Officer"] });
    const cookie = await login(officer.username);
    const res = await call("POST", "/receipts", {
      cookie,
      body: { stationId: stationA.stationId, productId: stationA.productId, quantity: 500, orderPrice: 640, landingPrice: 650, waybillRef: "wb-access-1", truckPlate: "NGR 100 AA" },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.fields.waybillRef).toBeDefined();
  });

  test("station managers cannot administer users", async () => {
    const manager = await makeUser({ roles: ["Station Manager"] });
    const cookie = await login(manager.username);
    expect((await call("PATCH", "/users/1", { cookie, body: { status: "suspended" } })).status).toBe(403);
  });

  test("the last administrator cannot be stripped of access", async () => {
    const second = await makeUser({ roles: ["System Administrator"] });
    const cookie = await login(second.username);
    const roleList = (await call("GET", "/roles", { cookie })).body.data as { id: number; name: string }[];
    const managerRole = roleList.find((r) => r.name === "Station Manager")!.id;

    // Demoting the seeded admin is fine while `second` remains an administrator…
    expect((await call("PATCH", "/users/1", { cookie, body: { roleIds: [managerRole] } })).status).toBe(200);
    // …but `second` is now the only one, so demoting them is refused and rolled back.
    const res = await call("PATCH", `/users/${second.id}`, { cookie, body: { roleIds: [managerRole] } });
    expect(res.status).toBe(409);
    const still = await call("GET", `/users/${second.id}`, { cookie });
    expect(still.body.data.roles).toBe("System Administrator");
    expect((await call("PATCH", `/users/${second.id}`, { cookie, body: { status: "suspended" } })).status).toBe(403);
  });
});
