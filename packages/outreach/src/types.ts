// Types for the n8n-backed outreach bridge. n8n.evervibes.org already runs
// the real send-side plumbing for two businesses: the compliance bot's lead
// intake / onboarding sequences, and wholesale's buyer/seller alerts
// (SMS deal alerts, bird-dog phone verification via Bland AI). ATLAS
// orchestrates those existing workflows rather than rebuilding an email/SMS
// sender from scratch — same bridge posture as @atlas/surplus's Twin client.

/** A workflow as returned by GET /api/v1/workflows. */
export interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
}

/** The specific webhook-triggerable workflows this bridge knows how to invoke. */
export type OutreachTarget = "new-lead" | "deal-alert-sms" | "bird-dog-verify";

/** Commands accepted by the "outreach" service (single-handler dispatch). */
export type OutreachCommand =
  | { op: "listWorkflows" }
  | { op: "setActive"; id: string; active: boolean }
  | { op: "notify"; target: OutreachTarget; payload: Record<string, unknown> };
