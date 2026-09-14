import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.ts";
import { auditLogs, sessions, users } from "../src/db/schema/index.ts";
import { ADMIN_PASSWORD, call, login, makeUser, resetDatabase } from "./helpers.ts";

beforeAll(resetDatabase);

describe("authentication", () => {
  test("rejects unauthenticated API access", async () => {
    const res = await call("GET", "/dashboard");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
  });

  test("signs in with a hardened session cookie and never exposes the hash", async () => {
    const user = await makeUser({ roles: ["Management / ED"] });
    const res = await call("POST", "/auth/login", { body: { username: user.username, password: user.password } });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
    expect(res.body.data.permissions).toContain("dashboard.view");

    // Only the HMAC of the token is stored.
    const token = cookie.split(";")[0]!.split("=")[1]!;
    const stored = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, user.id));
    expect(stored.some((s) => s.id === token)).toBe(false);

    const me = await call("GET", "/auth/me", { cookie: cookie.split(";")[0] });
    expect(me.status).toBe(200);
    expect(me.body.data.username).toBe(user.username);
  });

  test("uses the same error for unknown users and wrong passwords", async () => {
    const user = await makeUser({ roles: ["Management / ED"] });
    const wrong = await call("POST", "/auth/login", { body: { username: user.username, password: "wrong-password1" } });
    const unknown = await call("POST", "/auth/login", { body: { username: "nobody-here", password: "wrong-password1" } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  test("locks the account after repeated failures, even for the right password", async () => {
    const user = await makeUser({ roles: ["Management / ED"] });
    for (let i = 0; i < 5; i++) {
      await call("POST", "/auth/login", { body: { username: user.username, password: "bad-password-1" } });
    }
    const locked = await call("POST", "/auth/login", { body: { username: user.username, password: user.password } });
    expect(locked.status).toBe(429);
    const failures = await db.select().from(auditLogs).where(eq(auditLogs.action, "login_failed"));
    expect(failures.length).toBeGreaterThanOrEqual(6);
  });

  test("blocks suspended users", async () => {
    const user = await makeUser({ roles: ["Management / ED"], status: "suspended" });
    const res = await call("POST", "/auth/login", { body: { username: user.username, password: user.password } });
    expect(res.status).toBe(403);
  });

  test("forces a password change before anything else", async () => {
    const cookie = await login("admin", ADMIN_PASSWORD);
    expect((await call("GET", "/dashboard", { cookie })).status).toBe(403);
    expect((await call("GET", "/auth/me", { cookie })).status).toBe(200);

    const weak = await call("POST", "/auth/change-password", { cookie, body: { currentPassword: ADMIN_PASSWORD, newPassword: "short" } });
    expect(weak.status).toBe(422);
    expect(weak.body.error.fields.newPassword).toBeDefined();

    const changed = await call("POST", "/auth/change-password", { cookie, body: { currentPassword: ADMIN_PASSWORD, newPassword: "NewAdminPass2026" } });
    expect(changed.status).toBe(200);
    expect((await call("GET", "/dashboard", { cookie })).status).toBe(200);
  });

  test("logout revokes the session server-side", async () => {
    const user = await makeUser({ roles: ["Management / ED"] });
    const cookie = await login(user.username, user.password);
    expect((await call("POST", "/auth/logout", { cookie, body: {} })).status).toBe(200);
    expect((await call("GET", "/auth/me", { cookie })).status).toBe(401);
  });

  test("password reset links are single-use and revoke existing sessions", async () => {
    const admin = await login("admin", "NewAdminPass2026");
    const user = await makeUser({ roles: ["Management / ED"] });
    const oldSession = await login(user.username, user.password);

    const issued = await call("POST", `/users/${user.id}/password-reset`, { cookie: admin, body: {} });
    expect(issued.status).toBe(201);
    const token = issued.body.data.token as string;

    const verify = await call("POST", "/auth/password-reset/verify", { body: { token } });
    expect(verify.body.data.username).toBe(user.username);

    const reset = await call("POST", "/auth/password-reset/confirm", { body: { token, newPassword: "Recovered2026x" } });
    expect(reset.status).toBe(200);
    expect((await call("POST", "/auth/password-reset/confirm", { body: { token, newPassword: "Another2026x" } })).status).toBe(400);
    expect((await call("GET", "/auth/me", { cookie: oldSession })).status).toBe(401);
    await login(user.username, "Recovered2026x");
  });

  test("rejects cross-site state-changing requests", async () => {
    const user = await makeUser({ roles: ["Management / ED"] });
    const cookie = await login(user.username, user.password);
    const res = await call("POST", "/auth/change-password", {
      cookie,
      headers: { Origin: "https://evil.example" },
      body: { currentPassword: user.password, newPassword: "Hijacked2026x" },
    });
    expect(res.status).toBe(403);
    const [row] = await db.select({ changed: users.passwordChangedAt }).from(users).where(eq(users.id, user.id));
    expect(row!.changed).toBeNull();
  });
});
