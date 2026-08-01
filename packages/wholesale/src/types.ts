// Types for the wholesale bridge. Mirrors evervibes' real, already-built
// pending_actions approval gate (lib/wholesale/queue-pending-action.ts) —
// ATLAS reads and resolves those same rows, it does not reimplement the
// ROI scoring, the n8n sends, or the deal-blast firing logic.

export type WholesaleActionType = "deal_blast" | "sms_deal_alert" | "bland_call" | "outreach_email";
export type WholesaleActionStatus = "pending" | "approved" | "vetoed" | "fired" | "failed";

export interface PendingAction {
  id: string;
  action_type: WholesaleActionType;
  status: WholesaleActionStatus;
  roi_score: number;
  target_count: number;
  target_summary: string | null;
  reason: string | null;
  payload: Record<string, unknown>;
  expires_at: string | null;
  created_at: string;
}

/** Commands accepted by the "wholesale" service (single-handler dispatch). */
export type WholesaleCommand =
  | { op: "list" }
  | { op: "approve"; id: string }
  | { op: "veto"; id: string; reason?: string }
  /** Contact-coverage stats across every buyer source. Free, read-only. */
  | { op: "buyerStats" }
  | { op: "listBuyers"; mailableOnly?: boolean; limit?: number }
  /** Spends trace credits unless dryRun (which DEFAULTS to true). */
  | { op: "traceTopBuyers"; count?: number; dryRun?: boolean; confirmSpend?: boolean }
  /** FREE. Returns the real copy that WOULD be sent, so the wording itself
   * can be approved. Sends nothing, records nothing. */
  | { op: "previewIntros"; max?: number }
  /** Sends REAL emails. Requires confirmSend: true. Pass `drafts` (from
   * previewIntros, after approval) to send that exact copy verbatim. */
  | {
      op: "sendIntros";
      max?: number;
      confirmSend?: boolean;
      drafts?: Array<{ id: string; subject: string; body: string }>;
    };
