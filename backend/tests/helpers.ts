/**
 * Integration test harness.
 *
 * Runs against a real MariaDB test database (DATABASE_NAME in .env.test must end
 * in "_test"), through the real Hono app and service layer — no mocks — so the
 * suite catches what only a real server catches: SQL dialect issues, DECIMAL
 * handling, constraint violations and transaction behaviour.
 */
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { hashPassword } from "../src/auth/password.ts";
import { env } from "../src/config/env.ts";
import { db, pool } from "../src/db/client.ts";
import { products, roles, userRoles, users } from "../src/db/schema/index.ts";
import { seedCore } from "../src/db/seed.ts";
import { loadAccess } from "../src/services/auth.service.ts";
import * as master from "../src/services/masterdata.service.ts";
import * as stationsService from "../src/services/stations.service.ts";
import type { Actor } from "../src/types.ts";

export const app = createApp();
export const PASSWORD = "Password123";
export const ADMIN_PASSWORD = env.SEED_ADMIN_PASSWORD ?? "";

export async function resetDatabase(): Promise<void> {
  if (!env.DATABASE_NAME.endsWith("_test")) {
    throw new Error(`Refusing to wipe "${env.DATABASE_NAME}": tests only run against a *_test database.`);
  }
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      "SELECT TABLE_NAME AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND TABLE_NAME <> '__drizzle_migrations'",
    );
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const { t } of rows as { t: string }[]) await conn.query(`TRUNCATE TABLE \`${t}\``);
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    conn.release();
  }
  await seedCore();
}

let counter = 0;

export async function makeUser(options: {
  roles: string[];
  stationId?: number | null;
  status?: "active" | "suspended";
  mustChangePassword?: boolean;
  password?: string;
}): Promise<{ id: number; username: string; password: string }> {
  counter++;
  const username = `tester${counter}`;
  const password = options.password ?? PASSWORD;
  const [inserted] = await db
    .insert(users)
    .values({
      username,
      fullName: `Tester ${counter}`,
      passwordHash: await hashPassword(password),
      stationId: options.stationId ?? null,
      status: options.status ?? "active",
      mustChangePassword: options.mustChangePassword ?? false,
    })
    .$returningId();
  const roleRows = await db.select({ id: roles.id }).from(roles).where(inArray(roles.name, options.roles));
  if (roleRows.length !== options.roles.length) throw new Error(`Unknown role in ${options.roles.join(", ")}`);
  await db.insert(userRoles).values(roleRows.map((r) => ({ userId: inserted!.id, roleId: r.id })));
  return { id: inserted!.id, username, password };
}

export async function actorFor(userId: number): Promise<Actor> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  const access = await loadAccess(userId);
  return {
    id: u!.id,
    username: u!.username,
    fullName: u!.fullName,
    stationId: u!.stationId,
    roles: access.roles,
    permissions: new Set(access.permissions),
    sessionId: "test",
    mustChangePassword: false,
    ip: null,
    userAgent: "bun-test",
  };
}

export async function adminActor(): Promise<Actor> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.username, "admin"));
  return actorFor(u!.id);
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function call<T = any>(
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.cookie) headers.Cookie = options.cookie;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] ??= "application/json";
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }
  const res = await app.request(`/api/v1${path}`, { method, headers, body });
  const type = res.headers.get("content-type") ?? "";
  const parsed = type.includes("application/json") ? await res.json() : await res.text();
  return { status: res.status, body: parsed as T, headers: res.headers };
}

/** Signs in and returns the Cookie header value for subsequent calls. */
export async function login(username: string, password = PASSWORD): Promise<string> {
  const res = await call("POST", "/auth/login", { body: { username, password } });
  if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0]!;
}

export async function productId(code: string): Promise<number> {
  const [p] = await db.select({ id: products.id }).from(products).where(eq(products.code, code));
  return p!.id;
}

/** A station with one PMS tank (opening stock), one pump and a pump price. */
export async function makeStation(
  admin: Actor,
  options: { openingStock?: number; openingDate: string; price?: number; priceFrom: string; cashTolerance?: number; stockTolerance?: number; initialReading?: number },
) {
  counter++;
  const pms = await productId("PMS");
  const station = await stationsService.createStation(admin, {
    code: `T${counter}`,
    name: `Test Station ${counter}`,
    cashTolerance: options.cashTolerance ?? 20_000,
    stockTolerance: options.stockTolerance ?? 300,
  });
  await stationsService.createTank(admin, station.id, {
    productId: pms,
    name: "PMS Tank 1",
    openingStock: options.openingStock ?? 10_000,
    openingDate: options.openingDate,
  });
  const withTank = await stationsService.getStation(admin, station.id);
  const tankId = withTank.tanks[0]!.id;
  await stationsService.createPump(admin, station.id, { tankId, name: "Pump 1", meterLabel: "Meter A", initialReading: options.initialReading ?? 1000 });
  await master.addPrice(admin, pms, { stationId: station.id, price: options.price ?? 700, effectiveFrom: options.priceFrom });
  const detail = await stationsService.getStation(admin, station.id);
  return { stationId: station.id, tankId, pumpId: detail.pumps[0]!.id, productId: pms };
}
