import type { Plugin } from "@atlas/core";

/**
 * Automation Hunter — finds repetitive, manual work worth automating. It ranks
 * processes by how much time they waste each week (frequency × duration),
 * weighted by how many manual steps they involve. Output: "automate this first".
 */
export interface Process {
  name: string;
  frequencyPerWeek: number;
  minutesEach: number;
  manualSteps: number;
}

export interface AutomationCandidate extends Process {
  weeklyMinutes: number;
  score: number;
  recommendation: string;
}

export function scoreProcess(p: Process): { score: number; weeklyMinutes: number } {
  const weeklyMinutes = p.frequencyPerWeek * p.minutesEach;
  // More time + more manual steps = more worth automating.
  const score = Number((weeklyMinutes * (1 + 0.1 * p.manualSteps)).toFixed(2));
  return { score, weeklyMinutes };
}

export function rankProcesses(list: Process[]): AutomationCandidate[] {
  return list
    .map((p) => {
      const { score, weeklyMinutes } = scoreProcess(p);
      const recommendation = weeklyMinutes >= 60 ? "Automate now — high time drain" : weeklyMinutes >= 20 ? "Automate soon" : "Low priority";
      return { ...p, score, weeklyMinutes, recommendation };
    })
    .sort((a, b) => b.score - a.score);
}

export type AutomationCommand =
  | { op: "ingest"; process: Process }
  | { op: "rank"; processes: Process[] }
  | { op: "top"; limit?: number };

/** Automation Hunter plugin (service "automation"). */
export function createAutomationPlugin(): Plugin {
  return {
    manifest: { name: "automation", version: "0.1.0", capabilities: ["automation"], permissions: [], role: "executor" },
    register(ctx) {
      const feed: Process[] = [];
      ctx.provide("automation", async (payload) => {
        const cmd = payload as AutomationCommand;
        if (cmd.op === "ingest") {
          feed.push(cmd.process);
          return { tracked: feed.length };
        }
        if (cmd.op === "rank") return rankProcesses(cmd.processes);
        if (cmd.op === "top") {
          const ranked = rankProcesses(feed).slice(0, cmd.limit ?? 5);
          await ctx.emit("automation.found", { top: ranked[0]?.name, weeklyMinutes: ranked[0]?.weeklyMinutes });
          return ranked;
        }
        throw new Error(`automation: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
