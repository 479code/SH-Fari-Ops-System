import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.ts";
import { resetUserPassword } from "../src/db/reset-admin-password.ts";
import { users } from "../src/db/schema/index.ts";
import { seedCore } from "../src/db/seed.ts";
import { call, resetDatabase } from "./helpers.ts";

beforeAll(resetDatabase);

describe("administrator recovery", () => {
  test("re-running the seed reports the existing admin instead of changing its password", async () => {
    const result = await seedCore();
    expect(result.adminCreated).toBe(false);
    expect(result.existingAdmins).toContain("admin");
  });

  test("the reset command sets a password on an existing admin and reactivates it", async () => {
    await db
      .update(users)
      .set({ status: "suspended", failedLoginCount: 4, lockedUntil: new Date(Date.now() + 3_600_000) })
      .where(eq(users.username, "admin"));

    const result = await resetUserPassword({ username: "Admin", password: "admin" });
    expect(result).toMatchObject({ username: "admin", created: false, weak: true });

    const res = await call("POST", "/auth/login", { body: { username: "admin", password: "admin" } });
    expect(res.status).toBe(200);
    expect(res.body.data.mustChangePassword).toBe(true);
  });

  test("unknown users are refused unless --create is given", async () => {
    await expect(resetUserPassword({ username: "ops.admin", password: "Temp12345678" })).rejects.toThrow("--create");
    const created = await resetUserPassword({ username: "ops.admin", password: "Temp12345678", create: true });
    expect(created.created).toBe(true);
    const res = await call("POST", "/auth/login", { body: { username: "ops.admin", password: "Temp12345678" } });
    expect(res.status).toBe(200);
    expect(res.body.data.roles).toEqual(["System Administrator"]);
  });

  test("without a password a strong temporary one is generated", async () => {
    const result = await resetUserPassword({ username: "ops.admin" });
    expect(result.generatedPassword).toMatch(/^[A-Za-z0-9_-]{12}7a$/);
    expect(result.weak).toBe(false);
    expect((await call("POST", "/auth/login", { body: { username: "ops.admin", password: result.generatedPassword } })).status).toBe(200);
  });
});
