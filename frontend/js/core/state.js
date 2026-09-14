/**
 * state.js — the signed-in user, reference data and permission checks.
 *
 * Permission checks here only decide what to *show*. Every action is authorised
 * again by the API, so hiding a button is never the security boundary.
 */
import { api } from "../api/client.js";

export const state = {
  user: null,
  lookups: null,
  badges: null,
};

export function can(permission) {
  return Boolean(state.user?.permissions?.includes(permission));
}

export function canAny(...permissions) {
  return permissions.some(can);
}

/** Station-bound users always work on their own station. */
export function boundStation() {
  return state.user?.stationId ?? null;
}

export async function loadLookups() {
  const res = await api.get("/lookups");
  state.lookups = res.data;
  return state.lookups;
}

export function stationName(id) {
  return state.lookups?.stations.find((s) => s.id === Number(id))?.name ?? "";
}

export function productCode(id) {
  return state.lookups?.products.find((p) => p.id === Number(id))?.code ?? "";
}

export const today = () => state.lookups?.today ?? new Date().toISOString().slice(0, 10);
export const currentMonth = () => state.lookups?.currentMonth ?? today().slice(0, 7);

/** Default station for single-station screens: the user's own, else the first active one. */
export function defaultStationId() {
  return boundStation() ?? state.lookups?.stations[0]?.id ?? null;
}
