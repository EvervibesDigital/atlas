// Types for the surplus-funds business, mirroring the data model of the
// "Surplus Funds Platform v2" Mat built on Twin AI (build.twin.so). ATLAS
// orchestrates that existing, working pipeline via Twin's REST API rather
// than rebuilding the county scrapers from scratch (they work today).

/** A Twin agent as returned by GET /v1/agents (name lives under agent_name.name). */
export interface TwinAgent {
  agent_id: string;
  name: string;
  latest_run_id?: string;
  latest_run_status?: string;
  last_activity_at?: string;
  has_runs?: boolean;
}

/** One scheduled agent from GET /v1/schedules — the recurring (billable) surface. */
export interface TwinSchedule {
  agent_id: string;
  cron: string;
  next_run?: number;
  paused: boolean;
  consecutive_failures?: number;
  auto_paused?: boolean;
}

/** A single surplus lead — the shape the v2_leads sheet stores. */
export interface SurplusLead {
  lead_id?: string;
  county?: string;
  state?: string;
  property_address?: string;
  case_number?: string;
  auction_date?: string;
  sale_price?: number;
  debt_owed?: number;
  estimated_surplus?: number;
  lead_tier?: string; // Pre-Surplus / Confirmed / Court-Held
  lead_score?: string;
  owner_name?: string;
}

/** The six agents that make up the Surplus Funds Platform v2 pipeline, in order. */
export type SurplusRole = "county-discovery" | "scraper" | "enricher" | "outreach" | "attorney-match" | "attorney-recruit";
