import type { Plugin } from "@atlas/core";

/**
 * Digital Detective — answers "why did X happen?". Given a symptom it returns a
 * ranked list of likely causes, each with a concrete way to check it. A
 * diagnostic checklist so Mat isn't guessing.
 */
export type Area = "sales" | "traffic" | "rankings" | "engagement";

export interface Hypothesis {
  cause: string;
  likelihood: "high" | "medium" | "low";
  check: string;
}

const LIBRARY: Record<Area, Hypothesis[]> = {
  sales: [
    { cause: "Checkout or payment flow broken", likelihood: "high", check: "Place a real test order end-to-end" },
    { cause: "Traffic dropped (fewer visitors)", likelihood: "high", check: "Compare sessions week-over-week in analytics" },
    { cause: "Price or offer changed recently", likelihood: "medium", check: "Diff pricing/offer against last month" },
    { cause: "Seasonality / demand shift", likelihood: "low", check: "Compare to the same period last year" },
  ],
  traffic: [
    { cause: "SEO ranking drop", likelihood: "high", check: "Check Search Console impressions & positions" },
    { cause: "Paid campaign paused or out of budget", likelihood: "high", check: "Review ad account spend & status" },
    { cause: "Site down or slow", likelihood: "medium", check: "Run an uptime + PageSpeed test" },
    { cause: "Referral source dried up", likelihood: "low", check: "Compare traffic by source" },
  ],
  rankings: [
    { cause: "Google algorithm update", likelihood: "high", check: "Cross-reference the drop date with known updates" },
    { cause: "Technical SEO issue (noindex, robots, 404s)", likelihood: "high", check: "Crawl the site and check indexation" },
    { cause: "Lost backlinks", likelihood: "medium", check: "Compare backlink profile month-over-month" },
    { cause: "Competitor out-published you", likelihood: "low", check: "Review competitors' recent content" },
  ],
  engagement: [
    { cause: "Posting cadence dropped", likelihood: "high", check: "Count posts per week vs last month" },
    { cause: "Hook/format fatigue", likelihood: "high", check: "A/B test a new hook style (Experiment Lab)" },
    { cause: "Algorithm reach change", likelihood: "medium", check: "Compare reach across platforms" },
    { cause: "Audience mismatch", likelihood: "low", check: "Review follower demographics" },
  ],
};

const RANK = { high: 0, medium: 1, low: 2 };

export function investigate(area: Area): Hypothesis[] {
  return [...(LIBRARY[area] ?? [])].sort((a, b) => RANK[a.likelihood] - RANK[b.likelihood]);
}

export type DetectiveCommand = { op: "investigate"; area: Area };

/** Digital Detective plugin (service "detective"). */
export function createDetectivePlugin(): Plugin {
  return {
    manifest: { name: "detective", version: "0.1.0", capabilities: ["detective"], permissions: [], role: "executor" },
    register(ctx) {
      ctx.provide("detective", (payload) => {
        const cmd = payload as DetectiveCommand;
        if (cmd.op !== "investigate") throw new Error(`detective: unknown op "${(cmd as { op: string }).op}"`);
        return investigate(cmd.area);
      });
    },
  };
}
