/**
 * Business / COO core — turns raw performance metrics into a prioritized set of
 * recommendations (the "CEO brief"). Underperforming areas become high-priority
 * "fix" actions; healthy areas become low-priority "scale" actions.
 */
export interface BusinessUnit {
  id: string;
  name: string;
  goal: string;
}

export const DEFAULT_UNITS: BusinessUnit[] = [
  { id: "digital", name: "EverVibes Digital", goal: "Grow content + digital-product sales" },
  { id: "wholesale", name: "EverVibes Wholesale", goal: "Close real-estate wholesale deals" },
  { id: "saas", name: "SaaS Factory", goal: "Ship & monetize micro-SaaS" },
  { id: "creator", name: "AI Creator Studio", goal: "Grow the AI-influencer audience" },
];

export interface UnitMetric {
  category: string;
  successRate: number;
  total: number;
}

export interface Recommendation {
  category: string;
  action: string;
  priority: "high" | "medium" | "low";
  rationale: string;
}

/** Rank recommendations from metrics: underperforming → high priority to fix. */
export function prioritize(metrics: UnitMetric[]): Recommendation[] {
  const recs = metrics
    .filter((m) => m.total > 0)
    .map<Recommendation>((m) => {
      const pct = Math.round(m.successRate * 100);
      if (m.successRate < 0.4) return { category: m.category, action: `Fix underperforming "${m.category}"`, priority: "high", rationale: `${pct}% success over ${m.total} attempts` };
      if (m.successRate < 0.7) return { category: m.category, action: `Improve "${m.category}"`, priority: "medium", rationale: `${pct}% success over ${m.total} attempts` };
      return { category: m.category, action: `Scale "${m.category}"`, priority: "low", rationale: `${pct}% success over ${m.total} attempts` };
    });
  const rank = { high: 0, medium: 1, low: 2 };
  return recs.sort((a, b) => rank[a.priority] - rank[b.priority]);
}

export type BusinessCommand =
  | { op: "units" }
  | { op: "brief" }
  | { op: "add"; business: { name: string; url?: string; goal?: string; stage?: string } }
  | { op: "listBusinesses" }
  | { op: "research"; id: string }
  | { op: "research-next" };
