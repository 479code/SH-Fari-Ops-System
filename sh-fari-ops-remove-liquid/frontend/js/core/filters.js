/** filters.js — populating the station / product / month / date controls from lookups. */
import { setOptions } from "./dom.js";
import { recentMonths } from "./format.js";
import { boundStation, currentMonth, defaultStationId, state, today } from "./state.js";

/** Station select. Station-bound users only ever get their own station. */
export function stationOptions(select, { all = false, allLabel = "All stations", selected } = {}) {
  const stations = state.lookups?.stations ?? [];
  const bound = boundStation();
  if (bound !== null) {
    setOptions(select, stations.filter((s) => s.id === bound));
    select.value = String(bound);
    return;
  }
  setOptions(select, stations, { placeholder: all ? allLabel : undefined, selected });
  if (!all && !select.value && stations[0]) select.value = String(selected ?? defaultStationId());
}

export function productOptions(select, { all = false, allLabel = "All products", items } = {}) {
  setOptions(select, items ?? state.lookups?.products ?? [], { label: "code", placeholder: all ? allLabel : undefined });
}

export function monthOptions(select, { selected } = {}) {
  setOptions(select, recentMonths(currentMonth(), 18), { value: "value", label: "label", keep: false });
  select.value = selected ?? currentMonth();
}

export function dateInput(input, value) {
  input.max = today();
  input.value = value ?? today();
}

export const tanksFor = (stationId, productId) =>
  (state.lookups?.tanks ?? []).filter((t) => t.stationId === Number(stationId) && (!productId || t.productId === Number(productId)));

export const pumpsFor = (stationId) => (state.lookups?.pumps ?? []).filter((p) => p.stationId === Number(stationId));

export const monthStart = (isoDate) => `${isoDate.slice(0, 7)}-01`;

export const optionalNumber = (value) => (value === undefined || value === null || value === "" ? undefined : Number(value));
