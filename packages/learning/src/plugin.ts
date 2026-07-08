import type { Plugin } from "@atlas/core";
import type { LearningCommand, Outcome, Reflection } from "./types";
import { MetricsTracker } from "./metrics";
import { reflect } from "./reflection";
import { generateProposals } from "./proposals";

const RECENT_CAP = 100;

/**
 * Learning plugin — exposes the "learning" service and auto-reflects on system
 * outcome events (reel.published, approval.granted/rejected). Each reflection
 * updates confidence metrics and is written to long-term Memory (best-effort).
 *
 * Role executor: it records outcomes; it never changes policy or acts on the
 * outside world. It only advises via proposals.
 */
export function createLearningPlugin(opts: { metrics?: MetricsTracker; metricsFile?: string } = {}): Plugin {
  const metrics = opts.metrics ?? new MetricsTracker(opts.metricsFile);
  const recent: Reflection[] = [];

  return {
    manifest: {
      name: "learning",
      version: "0.1.0",
      capabilities: ["learning"],
      permissions: ["call:memory"],
      role: "executor",
    },

    register(ctx) {
      async function record(event: string, outcome: Outcome, category: string, detail?: string): Promise<Reflection> {
        const r = reflect({ event, outcome, category, detail });
        recent.unshift(r);
        if (recent.length > RECENT_CAP) recent.pop();
        await metrics.record(category, outcome);
        // Persist the lesson to long-term memory. Best-effort: learning still
        // works if the memory plugin isn't loaded.
        try {
          await ctx.call("memory", {
            op: "remember",
            input: { kind: outcome === "success" ? "success" : "failure", content: r.lesson, metadata: { event, category } },
          });
        } catch {
          /* memory not available — metrics still recorded */
        }
        await ctx.emit("reflection.recorded", r);
        return r;
      }

      // ── Auto-reflect from the system's own outcome events ──────────────
      ctx.on("reel.published", async (payload) => {
        const p = payload as { result?: { status?: string; detail?: string }; personaHandle?: string };
        const outcome: Outcome = p.result?.status === "rejected" ? "failure" : "success";
        await record("reel.published", outcome, p.personaHandle ?? "publishing", p.result?.detail);
      });
      ctx.on("approval.granted", async (payload) => {
        const a = payload as { action?: string };
        await record("approval.granted", "success", "approval", a.action);
      });
      ctx.on("approval.rejected", async (payload) => {
        const a = payload as { action?: string };
        await record("approval.rejected", "failure", "approval", a.action);
      });

      ctx.provide("learning", async (payload) => {
        const cmd = payload as LearningCommand;
        switch (cmd.op) {
          case "reflect":
            return record(cmd.event, cmd.outcome, cmd.category, cmd.detail);
          case "metrics":
            return cmd.category ? metrics.get(cmd.category) : metrics.all();
          case "proposals":
            return generateProposals(await metrics.all());
          case "reflections":
            return recent.slice(0, cmd.limit ?? 20);
          default:
            throw new Error(`learning: unknown op "${(cmd as { op: string }).op}"`);
        }
      });
    },
  };
}
