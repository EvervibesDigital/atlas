/**
 * Autonomy tiers — how much human involvement an actionable item needs before
 * it happens. This is a layer ON TOP of RiskLevel (see risk.ts): risk says how
 * dangerous an action is; tier says who pulls the trigger.
 *
 *   "auto" — ATLAS does it itself, unattended. ONLY for reversible, internal
 *            actions that touch no outside person and no money (e.g. adopting
 *            a self-improvement proposal into its own memory). Every "auto"
 *            action must be something a wrong call on could be undone with no
 *            real-world cost — the same bar self-healing meets (every change is
 *            a revertible git commit).
 *
 *   "bulk" — a human still approves, but many at once. For low-stakes outbound
 *            that Mat wants to glance over and clear in one tap rather than
 *            click-by-click — chiefly outbound emails (lead outreach, investor
 *            emails, gig pitches). Batched approval, NOT auto-send.
 *
 *   "ask"  — individual human approval, every time. Anything irreversible,
 *            costing money, or contacting a specific real person in a
 *            high-stakes way (a distressed homeowner, a phone call, a mass
 *            buyer blast). Never batched, never auto.
 *
 * When unsure, pick the MORE cautious tier (ask > bulk > auto). Autonomy is
 * only ever loosened deliberately, never by default.
 */
export type AutonomyTier = "auto" | "bulk" | "ask";

/** Ordering helper: higher number = more human oversight required. */
export const TIER_RANK: Record<AutonomyTier, number> = { auto: 0, bulk: 1, ask: 2 };

/** True when the item runs unattended (no human in the loop at all). */
export function isAuto(tier: AutonomyTier): boolean {
  return tier === "auto";
}

/** Return the more cautious (higher-oversight) of two tiers. */
export function maxTier(a: AutonomyTier, b: AutonomyTier): AutonomyTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}
