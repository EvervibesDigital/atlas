import type { RiskLevel, AutonomyTier } from "@atlas/core";

/** Where a brief item came from — determines how "act" resolves it. */
export type BriefSource = "kdp" | "gigfinder" | "approvals" | "surplus" | "wholesale" | "leadscan" | "learning" | "social";

/** One thing waiting on Mat this morning, normalized across every business. */
export interface BriefItem {
  id: string;
  source: BriefSource;
  title: string;
  detail?: string;
  risk: RiskLevel;
  /**
   * How much human involvement this item needs (see @atlas/core AutonomyTier):
   * "auto" runs unattended, "bulk" is batch-approved, "ask" is individual.
   * Defaults to "ask" for any source that doesn't set it — safest default.
   */
  tier: AutonomyTier;
  createdAt?: string;
}

export type BriefAction = "approve" | "reject";

/** Commands accepted by the "brief" service (single-handler dispatch). */
export type BriefCommand =
  | { op: "today" }
  | { op: "act"; source: BriefSource; id: string; action: BriefAction }
  // Autopilot: act on every "auto"-tier item at once, unattended. Run each
  // cycle. Only ever touches reversible/internal items by construction.
  | { op: "autopilot" }
  // Bulk approve/reject a whole tier (default "bulk") in one call — this is the
  // "approve all emails" button. Optionally scope to one source.
  | { op: "actBulk"; tier?: AutonomyTier; source?: BriefSource; action: BriefAction };
