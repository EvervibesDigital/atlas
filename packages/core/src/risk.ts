/**
 * Risk tiers, shared across the kernel, Executive, and Approval Gateway.
 *
 *   L0 — read-only / research           → always auto
 *   L1 — low-risk writes                 → auto
 *   L2 — moderate writes (posting, etc.) → human approval
 *   L3 — high-risk (money, credentials)  → human approval, always
 */
export type RiskLevel = 0 | 1 | 2 | 3;

/** Tasks at or below this tier auto-dispatch; above it they need approval. */
export const RISK_AUTO_MAX: RiskLevel = 1;

/** True when a task at this risk level requires human approval. */
export function needsApproval(risk: RiskLevel): boolean {
  return risk > RISK_AUTO_MAX;
}
