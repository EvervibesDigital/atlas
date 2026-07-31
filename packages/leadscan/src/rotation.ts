/**
 * Fixed, built-in niche/city rotation for auto-search — "any niche, any
 * city" needs a real list to pick from, since findLeads takes one concrete
 * niche+city per call. Niches are common local-service businesses likely to
 * have outdated, non-compliant websites (the actual thing this business
 * finds and fixes); cities are mid-size-to-major US metros spread across
 * regions — populous enough for real search results, not so large they're
 * dominated by national chains.
 */
export const NICHES = [
  "plumbers",
  "electricians",
  "HVAC contractors",
  "dentists",
  "chiropractors",
  "small law firms",
  "real estate agents",
  "restaurants",
  "auto repair shops",
  "hair salons",
  "landscaping companies",
  "roofing contractors",
  "pest control companies",
  "veterinary clinics",
  "general contractors",
];

export const CITIES = [
  "Columbus, OH",
  "Austin, TX",
  "Denver, CO",
  "Charlotte, NC",
  "Nashville, TN",
  "Phoenix, AZ",
  "Tampa, FL",
  "Sacramento, CA",
  "Indianapolis, IN",
  "Kansas City, MO",
  "Raleigh, NC",
  "Salt Lake City, UT",
  "Portland, OR",
  "Milwaukee, WI",
  "Louisville, KY",
  "Richmond, VA",
  "Boise, ID",
  "Tucson, AZ",
  "Omaha, NE",
  "Providence, RI",
];

export interface NicheCityCombo {
  niche: string;
  city: string;
}

/** Full cartesian product — every niche gets tried in every city. 15 × 20 = 300. */
export const NICHE_CITY_COMBOS: NicheCityCombo[] = NICHES.flatMap((niche) => CITIES.map((city) => ({ niche, city })));

/** Picks one combo per hour as a pure function of the current time — no
 * persisted counter needed, so nothing to get out of sync. Same rotation
 * pattern as @atlas/orchestrator's deriveTopic(), just at hourly instead of
 * daily granularity since leadscan runs every cycle, not once a day. */
export function pickNicheCity(hourSeed: number, combos: NicheCityCombo[] = NICHE_CITY_COMBOS): NicheCityCombo {
  return combos[((hourSeed % combos.length) + combos.length) % combos.length]!;
}
