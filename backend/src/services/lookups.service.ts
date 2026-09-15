/**
 * lookups.service.ts — reference data for dropdowns and filters, scoped to what
 * the signed-in user may see. One request populates every select on the page.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.ts";
import { banks, expenseNarrations, products, pumps, roles, stations, tanks, users } from "../db/schema/index.ts";
import type { Actor } from "../types.ts";
import { currentMonth, today } from "../utils/dates.ts";
import { getSettings } from "./settings.service.ts";

export async function getLookups(actor: Actor) {
  const scoped = <T>(column: T) => (actor.stationId !== null ? eq(column as never, actor.stationId) : undefined);
  const can = (p: string) => actor.permissions.has(p);

  const [stationRows, productRows, tankRows, pumpRows, narrationRows, bankRows, userRows, roleRows, settings] = await Promise.all([
    db
      .select({ id: stations.id, code: stations.code, name: stations.name, cashTolerance: stations.cashTolerance, stockTolerance: stations.stockTolerance })
      .from(stations)
      // A station-bound user always gets their own station, even once it is deactivated.
      .where(actor.stationId !== null ? eq(stations.id, actor.stationId) : eq(stations.status, "active"))
      .orderBy(asc(stations.name)),
    db.select({ id: products.id, code: products.code, name: products.name }).from(products).where(eq(products.status, "active")).orderBy(asc(products.code)),
    db
      .select({ id: tanks.id, name: tanks.name, stationId: tanks.stationId, productId: tanks.productId, productCode: products.code })
      .from(tanks)
      .innerJoin(products, eq(products.id, tanks.productId))
      .where(and(eq(tanks.status, "active"), scoped(tanks.stationId)))
      .orderBy(asc(tanks.name)),
    db
      .select({ id: pumps.id, name: pumps.name, meterLabel: pumps.meterLabel, stationId: pumps.stationId, tankId: pumps.tankId, productId: tanks.productId, productCode: products.code })
      .from(pumps)
      .innerJoin(tanks, eq(tanks.id, pumps.tankId))
      .innerJoin(products, eq(products.id, tanks.productId))
      .where(and(eq(pumps.status, "active"), scoped(pumps.stationId)))
      .orderBy(asc(pumps.name)),
    db
      .select({ id: expenseNarrations.id, name: expenseNarrations.name, approvalThreshold: expenseNarrations.approvalThreshold })
      .from(expenseNarrations)
      .where(eq(expenseNarrations.status, "active"))
      .orderBy(asc(expenseNarrations.name)),
    db.select({ id: banks.id, name: banks.name }).from(banks).where(eq(banks.status, "active")).orderBy(asc(banks.name)),
    can("users.view") || can("audit.view") || can("stations.manage")
      ? db
          .select({ id: users.id, fullName: users.fullName, stationId: users.stationId, status: users.status })
          .from(users)
          .where(isNull(users.deletedAt))
          .orderBy(asc(users.fullName))
      : Promise.resolve([]),
    can("users.view") || can("roles.view") ? db.select({ id: roles.id, name: roles.name }).from(roles).orderBy(asc(roles.name)) : Promise.resolve([]),
    getSettings(),
  ]);

  return {
    stations: stationRows,
    products: productRows,
    tanks: tankRows,
    pumps: pumpRows,
    narrations: narrationRows,
    banks: bankRows,
    users: userRows,
    roles: roleRows,
    settings,
    today: today(),
    currentMonth: currentMonth(),
  };
}
