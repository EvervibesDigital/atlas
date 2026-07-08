import type { Plugin } from "@atlas/core";

/**
 * Analytics Agent — the numbers person. Rolls the Learning layer's per-category
 * metrics up into headline KPIs: overall success rate, what's working best, and
 * what's dragging. Feeds the daily executive report.
 */
export interface MetricRow {
  category: string;
  successes: number;
  failures: number;
  total: number;
  successRate: number;
}

export interface Kpis {
  totalActions: number;
  overallSuccessRate: number;
  categoriesTracked: number;
  topCategory: string | null;
  weakestCategory: string | null;
}

export function computeKpis(rows: MetricRow[]): Kpis {
  const withData = rows.filter((r) => r.total > 0);
  const totalActions = withData.reduce((s, r) => s + r.total, 0);
  const totalSuccesses = withData.reduce((s, r) => s + r.successes, 0);
  let top: MetricRow | null = null;
  let weak: MetricRow | null = null;
  for (const r of withData) {
    if (!top || r.successRate > top.successRate) top = r;
    if (!weak || r.successRate < weak.successRate) weak = r;
  }
  return {
    totalActions,
    overallSuccessRate: totalActions ? Number((totalSuccesses / totalActions).toFixed(3)) : 0,
    categoriesTracked: withData.length,
    topCategory: top?.category ?? null,
    weakestCategory: weak?.category ?? null,
  };
}

export type AnalyticsCommand = { op: "kpis" } | { op: "compute"; rows: MetricRow[] };

/** Analytics plugin (service "analytics"). */
export function createAnalyticsPlugin(): Plugin {
  return {
    manifest: { name: "analytics", version: "0.1.0", capabilities: ["analytics"], permissions: ["call:learning"], role: "executor" },
    register(ctx) {
      ctx.provide("analytics", async (payload) => {
        const cmd = payload as AnalyticsCommand;
        if (cmd.op === "compute") return computeKpis(cmd.rows);
        if (cmd.op === "kpis") {
          let rows: MetricRow[] = [];
          try {
            rows = (await ctx.call("learning", { op: "metrics" })) as MetricRow[];
          } catch {
            /* learning optional */
          }
          const kpis = computeKpis(rows);
          await ctx.emit("analytics.kpis", kpis);
          return kpis;
        }
        throw new Error(`analytics: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
