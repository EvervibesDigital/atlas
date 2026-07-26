import type { AutonomyTier } from "@atlas/core";
import type { VitalsInput, VitalsReport, VitalsSnapshot } from "./types";

/** Items sitting longer than this (days) count as "stalled". */
export const STALL_DAYS = 3;
/** Below this success rate, the approach gets flagged for adjustment. */
const LOW_SUCCESS_RATE = 0.4;
const MS_PER_DAY = 86_400_000;

function ageDays(createdAt: string | undefined, now: number): number | null {
  if (!createdAt) return null;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return null;
  return (now - t) / MS_PER_DAY;
}

/**
 * Compute ATLAS's self-assessment across output / growth / learning, and the
 * flags that let it notice its OWN problems (a backing-up pipeline, a learning
 * loop with no data, knowledge that's stopped growing). Pure and
 * deterministic — the plugin gathers the inputs; this decides what they mean.
 *
 * Returns both the report and the fresh snapshot to persist for next time.
 */
export function computeVitals(input: VitalsInput, now: number = Date.now()): { report: VitalsReport; snapshot: VitalsSnapshot } {
  const { pending, knowledge, metrics, prev, mrr } = input;

  // ── Output: is work flowing? ──────────────────────────────────────────
  const byTier: Record<AutonomyTier, number> = { auto: 0, bulk: 0, ask: 0 };
  let stalled = 0;
  let oldestAgeDays = 0;
  for (const item of pending) {
    if (item.tier) byTier[item.tier]++;
    const age = ageDays(item.createdAt, now);
    if (age !== null) {
      if (age > oldestAgeDays) oldestAgeDays = age;
      if (age > STALL_DAYS) stalled++;
    }
  }

  // ── Learning: is it recording outcomes and improving? ─────────────────
  const outcomes = metrics.reduce((sum, m) => sum + m.total, 0);
  const categories = metrics.length;
  const avgSuccessRate = outcomes > 0 ? metrics.reduce((sum, m) => sum + m.successRate * m.total, 0) / outcomes : null;

  // ── Growth deltas (only meaningful once we have a previous snapshot) ───
  const knowledgeDelta = prev ? knowledge - prev.knowledge : null;
  const pendingDelta = prev ? pending.length - prev.pending : null;
  const outcomesDelta = prev ? outcomes - prev.outcomes : null;
  // mrrDelta only computed when BOTH snapshots actually have a real number —
  // prev.mrr being undefined means the bridge wasn't configured yet back
  // then, not that revenue was $0, so a delta against it would be fiction.
  const mrrDelta = mrr !== undefined && prev?.mrr !== undefined ? Number((mrr - prev.mrr).toFixed(2)) : null;

  // ── Flags: ATLAS noticing its own idleness / stalls ───────────────────
  const flags: string[] = [];

  if (stalled > 0) {
    flags.push(`${stalled} item(s) have sat unactioned for more than ${STALL_DAYS} days (oldest: ${Math.floor(oldestAgeDays)}d) — the pipeline is backing up.`);
  }
  if (outcomes === 0) {
    flags.push("The learning loop has recorded 0 outcomes — nothing has completed end-to-end yet, so ATLAS has no results to improve from.");
  } else if (avgSuccessRate !== null && avgSuccessRate < LOW_SUCCESS_RATE) {
    flags.push(`Overall success rate is low (${Math.round(avgSuccessRate * 100)}%) — the current approach needs adjustment.`);
  }
  // Growth stalls — only assert these once there's a baseline to compare to.
  if (knowledgeDelta !== null && knowledgeDelta <= 0) {
    flags.push("Knowledge hasn't grown since the last check — no new research or scouting landed.");
  }
  if (outcomesDelta !== null && outcomesDelta === 0 && pending.length > 0) {
    flags.push("Items are queuing but none are completing — throughput is stalled, not just quiet.");
  }
  if (mrrDelta !== null && mrrDelta < 0) {
    flags.push(`Real MRR dropped $${Math.abs(mrrDelta).toFixed(2)} since the last check.`);
  }

  const report: VitalsReport = {
    output: { pending: pending.length, stalled, oldestAgeDays: Math.floor(oldestAgeDays), byTier },
    growth: { knowledge, knowledgeDelta, pendingDelta },
    learning: { outcomes, outcomesDelta, categories, avgSuccessRate },
    revenue: { mrr: mrr ?? null, mrrDelta },
    flags,
    healthy: flags.length === 0,
  };

  const snapshot: VitalsSnapshot = { at: new Date(now).toISOString(), knowledge, pending: pending.length, outcomes, ...(mrr !== undefined ? { mrr } : {}) };

  return { report, snapshot };
}
