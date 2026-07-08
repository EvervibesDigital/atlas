import type { RiskLevel } from "@atlas/core";

/**
 * Approval Gateway types. This is the backbone of the "daily approval list":
 * anything ATLAS wants to do that exceeds the auto-risk tier lands here as a
 * pending Approval and waits for Mat.
 */
export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Approval {
  id: string;
  /** What ATLAS wants to do, e.g. "Post video to TikTok". */
  action: string;
  /** Human-readable context for the decision. */
  detail?: string;
  risk: RiskLevel;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt?: string;
}

/** Commands accepted by the "approvals" service (single-handler dispatch). */
export type ApprovalCommand =
  | { op: "request"; action: string; detail?: string; risk: RiskLevel }
  | { op: "list"; status?: ApprovalStatus }
  | { op: "approve"; id: string }
  | { op: "reject"; id: string };
