import type { RiskLevel } from "@atlas/core";

/** Where a brief item came from — determines how "act" resolves it. */
export type BriefSource = "kdp" | "gigfinder" | "approvals";

/** One thing waiting on Mat this morning, normalized across every business. */
export interface BriefItem {
  id: string;
  source: BriefSource;
  title: string;
  detail?: string;
  risk: RiskLevel;
  createdAt?: string;
}

export type BriefAction = "approve" | "reject";

/** Commands accepted by the "brief" service (single-handler dispatch). */
export type BriefCommand = { op: "today" } | { op: "act"; source: BriefSource; id: string; action: BriefAction };
