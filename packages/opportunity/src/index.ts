import type { Plugin } from "@atlas/core";

/**
 * Opportunity Engine — scores and ranks business opportunities by value vs
 * effort so ATLAS surfaces the highest-leverage moves first. Value comes from
 * impact and fit; effort discounts the score.
 */
export interface Opportunity {
  title: string;
  description: string;
  /** 0..1 */
  impact: number;
  /** 0..1 (higher = more work) */
  effort: number;
  /** 0..1 (how well it fits Mat's existing businesses) */
  fit: number;
}

export interface ScoredOpportunity extends Opportunity {
  score: number;
  priority: "now" | "soon" | "later";
}

export function scoreOpportunity(o: Opportunity): number {
  const value = o.impact * 0.6 + o.fit * 0.4;
  return Number((value * (1 - 0.5 * o.effort)).toFixed(4));
}

export function rankOpportunities(list: Opportunity[]): ScoredOpportunity[] {
  return list
    .map((o) => {
      const score = scoreOpportunity(o);
      const priority: ScoredOpportunity["priority"] = score >= 0.6 ? "now" : score >= 0.35 ? "soon" : "later";
      return { ...o, score, priority };
    })
    .sort((a, b) => b.score - a.score);
}

export type OpportunityCommand =
  | { op: "ingest"; opportunity: Opportunity }
  | { op: "rank"; opportunities: Opportunity[] }
  | { op: "top"; limit?: number };

/** Opportunity Engine plugin (service "opportunity"). */
export function createOpportunityPlugin(): Plugin {
  return {
    manifest: { name: "opportunity", version: "0.1.0", capabilities: ["opportunity"], permissions: ["call:memory"], role: "executor" },
    register(ctx) {
      const feed: Opportunity[] = [];
      ctx.provide("opportunity", async (payload) => {
        const cmd = payload as OpportunityCommand;
        if (cmd.op === "ingest") {
          feed.push(cmd.opportunity);
          try {
            await ctx.call("memory", { op: "remember", input: { kind: "project", content: `Opportunity: ${cmd.opportunity.title} — ${cmd.opportunity.description}` } });
          } catch {
            /* memory optional */
          }
          return { ingested: feed.length };
        }
        if (cmd.op === "rank") return rankOpportunities(cmd.opportunities);
        if (cmd.op === "top") {
          const ranked = rankOpportunities(feed).slice(0, cmd.limit ?? 5);
          await ctx.emit("opportunity.ranked", { top: ranked[0]?.title });
          return ranked;
        }
        throw new Error(`opportunity: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
