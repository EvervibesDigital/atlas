import type { Plugin } from "@atlas/core";
import type { BusinessCommand, UnitMetric } from "./core";
import { DEFAULT_UNITS, prioritize } from "./core";

/**
 * Business plugin (service "business") — the COO. `brief` pulls confidence
 * metrics from the Learning layer, turns them into a prioritized recommendation
 * list, files the brief in Memory, and emits `business.brief`. This is where
 * ATLAS's self-knowledge becomes a to-do list for Mat.
 */
export function createBusinessPlugin(opts: { units?: typeof DEFAULT_UNITS } = {}): Plugin {
  const units = opts.units ?? DEFAULT_UNITS;

  return {
    manifest: {
      name: "business",
      version: "0.1.0",
      capabilities: ["business"],
      permissions: ["call:learning", "call:memory"],
      role: "executor",
    },

    register(ctx) {
      ctx.provide("business", async (payload) => {
        const cmd = payload as BusinessCommand;

        if (cmd.op === "units") return units;

        if (cmd.op === "brief") {
          let metrics: UnitMetric[] = [];
          try {
            metrics = (await ctx.call("learning", { op: "metrics" })) as UnitMetric[];
          } catch {
            /* learning optional */
          }
          const recommendations = prioritize(metrics);
          const summary = recommendations.length
            ? `${recommendations.filter((r) => r.priority === "high").length} high-priority item(s) across ${recommendations.length} tracked areas.`
            : "No performance data yet — start shipping to generate signal.";

          try {
            await ctx.call("memory", { op: "remember", input: { kind: "business", content: `CEO brief: ${summary}`, metadata: { recommendations } } });
          } catch {
            /* memory optional */
          }
          await ctx.emit("business.brief", { summary, count: recommendations.length });
          return { summary, recommendations };
        }

        throw new Error(`business: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
