/**
 * scope.ts — company-level and station-level data segregation.
 *
 * Two nested checks, enforced on every request:
 *
 *  1. Company scope. A user bound to a company (users.company_id) may never
 *     read or write a station — or anything hung off one — belonging to a
 *     different company, whatever filters the client sends. Only the
 *     platform super-admin (company_id = NULL) may cross companies.
 *  2. Station scope (unchanged from before multi-tenancy). A user bound to a
 *     station (users.station_id) may only read or change that station's
 *     records within their own company. A company-wide user (station_id
 *     NULL) may filter by any station belonging to their company.
 *
 * Every caller here passes the station row (or at least its companyId) it
 * already loaded for the request — this module does no DB access of its own,
 * so it stays trivially fast and side-effect free.
 */
import type { Actor } from "../types.ts";
import { AppError } from "../utils/errors.ts";

/** True only for the platform super-admin — the one actor allowed to cross companies. */
export function isPlatformAdmin(actor: Actor): boolean {
  return actor.companyId === null;
}

/**
 * Guards a station lookup/write against the actor's company. Out-of-company
 * stations are reported as not found, same as out-of-station-scope records,
 * so their existence is never disclosed to another tenant.
 */
export function assertCompanyAccess(actor: Actor, companyId: number | null, what = "Record"): void {
  if (!isPlatformAdmin(actor) && companyId !== actor.companyId) {
    throw new AppError("NOT_FOUND", `${what} not found.`);
  }
}

/** Resolves the company filter to apply to a list/aggregate query that spans stations. */
export function companyFilter(actor: Actor, requested?: number | null): number | null {
  if (!isPlatformAdmin(actor)) {
    if (requested && requested !== actor.companyId) {
      throw new AppError("FORBIDDEN", "You can only access records for your own company.");
    }
    return actor.companyId;
  }
  return requested ?? null;
}

/**
 * Resolves the station filter to apply to a list/aggregate query.
 * Returns null when the query should span all stations (within the actor's company).
 */
export function stationFilter(actor: Actor, requested?: number | null): number | null {
  if (actor.stationId !== null) {
    if (requested && requested !== actor.stationId) {
      throw new AppError("FORBIDDEN", "You can only access records for your assigned station.");
    }
    return actor.stationId;
  }
  return requested ?? null;
}

/** For screens that always work on one station (DSR, cash): bound users get theirs, others must choose. */
export function requireStation(actor: Actor, requested?: number | null): number {
  const station = stationFilter(actor, requested);
  if (station === null) {
    throw new AppError("VALIDATION_ERROR", "Select a station.", { fields: { stationId: "Select a station." } });
  }
  return station;
}

/**
 * Guards a single record given the station it belongs to. Callers that have
 * already loaded the station's companyId should prefer
 * `assertStationAndCompanyAccess` below, which checks both in one call — this
 * form is kept for existing call sites that only ever had a station id to
 * check (single-company call sites, or ones checking station scope only
 * after company scope was already enforced upstream for the same record).
 * Out-of-scope records are reported as not found so their existence is not
 * disclosed (prevents IDOR enumeration).
 */
export function assertStationAccess(actor: Actor, stationId: number | null, what = "Record"): void {
  if (actor.stationId !== null && stationId !== actor.stationId) {
    throw new AppError("NOT_FOUND", `${what} not found.`);
  }
}

/** Guards a single record given both the company and the station it belongs to. Prefer this whenever both are known. */
export function assertStationAndCompanyAccess(actor: Actor, companyId: number, stationId: number | null, what = "Record"): void {
  assertCompanyAccess(actor, companyId, what);
  assertStationAccess(actor, stationId, what);
}

/** For writes that name a station explicitly: bound users may only write to their own. */
export function assertCanWriteStation(actor: Actor, stationId: number): void {
  if (actor.stationId !== null && stationId !== actor.stationId) {
    throw new AppError("FORBIDDEN", "You can only record transactions for your assigned station.");
  }
}
