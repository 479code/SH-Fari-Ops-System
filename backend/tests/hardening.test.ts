/** Regression tests for issues found in the security & correctness audit. */
import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { hashSessionToken } from "../src/auth/tokens.ts";
import { db } from "../src/db/client.ts";
import { sessions, settings } from "../src/db/schema/index.ts";
import * as dsr from "../src/services/dsr.service.ts";
import { raiseException } from "../src/services/exceptions.service.ts";
import { exceptions } from "../src/db/schema/index.ts";
import { addDays, today } from "../src/utils/dates.ts";
import { AppError } from "../src/utils/errors.ts";
import { adminActor, call, login, makeStation, makeUser, resetDatabase } from "./helpers.ts";

beforeAll(resetDatabase);

async function rejects(promise: Promise<unknown>, code: AppError["code"]) {
  try {
    await promise;
  } catch (err) {
    expect((err as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

type RoleRow = { id: number; name: string };

describe("settings", () => {
  test("a partial update changes only the keys that were sent", async () => {
    const cookie = await login((await makeUser({ roles: ["System Administrator"] })).username);
    expect((await call("PUT", "/settings", { cookie, body: { allowNegativeStock: true, gitDelayDays: 9 } })).status).toBe(200);
    const res = await call("PUT", "/settings", { cookie, body: { debtorAgingAlertDays: 45 } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ allowNegativeStock: true, gitDelayDays: 9, debtorAgingAlertDays: 45 });
    const stored = Object.fromEntries((await db.select().from(settings)).map((s) => [s.key, s.value]));
    expect(stored).toMatchObject({ allowNegativeStock: "true", gitDelayDays: "9" });
  });
});

describe("no privilege escalation", () => {
  test("a delegated user administrator cannot grant, or take over, access they lack", async () => {
    const adminCookie = await login((await makeUser({ roles: ["System Administrator"] })).username);
    const created = await call("POST", "/roles", { cookie: adminCookie, body: { name: "User desk", permissions: ["users.view", "users.manage", "roles.view"] } });
    expect(created.status).toBe(201);
    const roleList = created.body.data as RoleRow[];
    const idOf = (name: string) => roleList.find((r) => r.name === name)!.id;

    const desk = await makeUser({ roles: ["User desk"] });
    const deskCookie = await login(desk.username);
    const officer = await makeUser({ roles: ["Pump / Sales Officer"] });

    // Granting the administrator role — to themselves or a new user — is refused.
    expect((await call("PATCH", `/users/${desk.id}`, { cookie: deskCookie, body: { roleIds: [idOf("User desk"), idOf("System Administrator")] } })).status).toBe(403);
    expect(
      (await call("POST", "/users", { cookie: deskCookie, body: { username: "escalate1", fullName: "E", roleIds: [idOf("System Administrator")], password: "Password1234" } })).status,
    ).toBe(403);
    // Taking over accounts with more access is refused.
    expect((await call("POST", "/users/1/password-reset", { cookie: deskCookie, body: {} })).status).toBe(403);
    expect((await call("PATCH", "/users/1", { cookie: deskCookie, body: { status: "suspended" } })).status).toBe(403);
    expect((await call("PATCH", `/users/${officer.id}`, { cookie: deskCookie, body: { fullName: "Changed" } })).status).toBe(403);
    // Within their own access it still works.
    expect((await call("PATCH", `/users/${desk.id}`, { cookie: deskCookie, body: { fullName: "Desk Person" } })).status).toBe(200);
  });

  test("a role manager cannot mint permissions they do not hold", async () => {
    const adminCookie = await login((await makeUser({ roles: ["System Administrator"] })).username);
    const created = await call("POST", "/roles", { cookie: adminCookie, body: { name: "Role desk", permissions: ["roles.view", "roles.manage"] } });
    const adminRole = (created.body.data as RoleRow[]).find((r) => r.name === "System Administrator")!.id;
    const deskCookie = await login((await makeUser({ roles: ["Role desk"] })).username);

    expect((await call("POST", "/roles", { cookie: deskCookie, body: { name: "Super", permissions: ["audit.export"] } })).status).toBe(403);
    expect((await call("PATCH", `/roles/${adminRole}`, { cookie: deskCookie, body: { description: "renamed" } })).status).toBe(403);
    expect((await call("POST", "/roles", { cookie: deskCookie, body: { name: "Viewer", permissions: ["roles.view"] } })).status).toBe(201);
  });
});

describe("DSR discard", () => {
  test("a day opened by mistake can be discarded so the previous day can be corrected", async () => {
    const admin = await adminActor();
    const s = await makeStation(admin, { openingDate: addDays(today(), -6), priceFrom: addDays(today(), -30) });
    const first = await dsr.openDay(admin, { stationId: s.stationId, businessDate: addDays(today(), -3) });
    await dsr.saveReadings(admin, first.day!.id, { readings: [{ pumpId: s.pumpId, closingReading: 1500 }] });
    await dsr.closeDay(admin, first.day!.id);

    const mistake = await dsr.openDay(admin, { stationId: s.stationId, businessDate: addDays(today(), -2) });
    await rejects(dsr.reopenDay(admin, first.day!.id, "Fix"), "CONFLICT");

    const officerCookie = await login((await makeUser({ roles: ["Pump / Sales Officer"], stationId: s.stationId })).username);
    expect((await call("POST", `/dsr/${mistake.day!.id}/discard`, { cookie: officerCookie, body: { reason: "x" } })).status).toBe(403);

    const discarded = await dsr.discardDay(admin, mistake.day!.id, "Opened the wrong date");
    expect(discarded.status).toBe("not_opened");

    const reopened = await dsr.reopenDay(admin, first.day!.id, "Correct the closing reading");
    expect(reopened.status).toBe("open");
    // A previously closed day cannot be discarded — its sales were already posted once.
    await rejects(dsr.discardDay(admin, first.day!.id, "No"), "CONFLICT");
  });
});

describe("sessions", () => {
  test("background polling does not keep an idle session alive", async () => {
    const user = await makeUser({ roles: ["Management / ED"] });
    const cookie = await login(user.username);
    const sessionId = hashSessionToken(cookie.split("=")[1]!);
    const stale = new Date(Date.now() - 5 * 60_000);
    await db.update(sessions).set({ lastSeenAt: stale }).where(eq(sessions.id, sessionId));

    expect((await call("GET", "/dashboard/badges", { cookie, headers: { "X-Background-Request": "1" } })).status).toBe(200);
    let [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(Math.abs(row!.lastSeenAt.getTime() - stale.getTime())).toBeLessThan(1500);

    expect((await call("GET", "/auth/me", { cookie })).status).toBe(200);
    [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(row!.lastSeenAt.getTime()).toBeGreaterThan(stale.getTime() + 60_000);
  });
});

describe("cross-site protection", () => {
  test("browser fetch metadata is honoured; cross-site requests are refused", async () => {
    const user = await makeUser({ roles: ["Management / ED"] });
    const cookie = await login(user.username);
    const body = { currentPassword: "not-my-password-1", newPassword: "Whatever2026x" };
    const crossSite = await call("POST", "/auth/change-password", { cookie, body, headers: { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" } });
    expect(crossSite.status).toBe(403);
    // Same-origin per the browser, even though the socket origin differs (TLS proxy): reaches the handler.
    const sameOrigin = await call("POST", "/auth/change-password", { cookie, body, headers: { "Sec-Fetch-Site": "same-origin", Origin: "https://ops.example" } });
    expect(sameOrigin.status).toBe(422);
  });
});

describe("exceptions", () => {
  test("raising the same exception concurrently does not fail either caller", async () => {
    const input = { type: "debtor_aging" as const, severity: "medium" as const, stationId: null, sourceType: "debtor", sourceId: 999_001, sourceRef: "Race Ltd", title: "Race" };
    await Promise.all([raiseException(db, input), raiseException(db, input), raiseException(db, input)]);
    const rows = await db.select().from(exceptions).where(eq(exceptions.sourceId, 999_001));
    expect(rows.length).toBe(1);
  });
});
