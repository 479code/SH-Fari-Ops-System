/**
 * scope.ts — station-level data segregation.
 *
 * A user bound to a station (users.station_id) may only read or change that
 * station's records, whatever filters the client sends. Global users (NULL
 * station) may filter by any station or see all.
 */
import type { Actor } from "../types.ts";
import { AppError } from "../utils/errors.ts";

/**
 * Resolves the station filter to apply to a list/aggregate query.
 * Returns null when the query should span all stations.
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
 * Guards a single record. Out-of-scope records are reported as not found so
 * their existence is not disclosed (prevents IDOR enumeration).
 */
export function assertStationAccess(actor: Actor, stationId: number | null, what = "Record"): void {
  if (actor.stationId !== null && stationId !== actor.stationId) {
    throw new AppError("NOT_FOUND", `${what} not found.`);
  }
}

/** For writes that name a station explicitly: bound users may only write to their own. */
export function assertCanWriteStation(actor: Actor, stationId: number): void {
  if (actor.stationId !== null && stationId !== actor.stationId) {
    throw new AppError("FORBIDDEN", "You can only record transactions for your assigned station.");
  }
}
