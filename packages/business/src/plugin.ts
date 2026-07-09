import type { Plugin } from "@atlas/core";
import type { BusinessCommand, UnitMetric } from "./core";
import { DEFAULT_UNITS, prioritize } from "./core";
import { BusinessRegistry, type Business, type BusinessInput } from "./registry";

/** Research a business by reading its site (via the web service) into notes. */
type ResearchResult = { business: Business; notes: string } | { skipped: string };

/**
 * Business plugin (service "business") — the COO. `brief` pulls confidence
 * metrics from the Learning layer, turns them into a prioritized recommendation
 * list, files the brief in Memory, and emits `business.brief`. This is where
 * ATLAS's self-knowledge becomes a to-do list for Mat.
 */
export function createBusinessPlugin(opts: { units?: typeof DEFAULT_UNITS; registry?: BusinessRegistry; businessFile?: string } = {}): Plugin {
  const units = opts.units ?? DEFAULT_UNITS;
  const registry = opts.registry ?? new BusinessRegistry(opts.businessFile);

  return {
    manifest: {
      name: "business",
      version: "0.1.0",
      capabilities: ["business"],
      permissions: ["call:learning", "call:memory", "call:web"],
      role: "executor",
    },

    register(ctx) {
      async function research(business: Business): Promise<ResearchResult> {
        if (!business.url) return { skipped: `${business.name} has no URL to research` };
        let notes = "";
        try {
          const learned = (await ctx.call("web", { op: "learn", url: business.url })) as { notes: string };
          notes = learned.notes;
        } catch (e) {
          return { skipped: `could not read ${business.url}: ${(e as Error).message}` };
        }
        try {
          await ctx.call("memory", {
            op: "remember",
            input: { kind: "business", content: `Business "${business.name}" (${business.url}): ${notes}`.slice(0, 2000), metadata: { businessId: business.id } },
          });
        } catch {
          /* memory optional */
        }
        await registry.markResearched(business.id);
        await ctx.emit("business.researched", { id: business.id, name: business.name });
        return { business, notes };
      }

      ctx.provide("business", async (payload) => {
        const cmd = payload as BusinessCommand;

        if (cmd.op === "units") return units;

        if (cmd.op === "add") return registry.add(cmd.business as BusinessInput);
        if (cmd.op === "listBusinesses") return registry.list();
        if (cmd.op === "research") {
          const b = await registry.get(cmd.id);
          if (!b) throw new Error(`no business "${cmd.id}"`);
          return research(b);
        }
        if (cmd.op === "research-next") {
          const b = await registry.nextToResearch();
          if (!b) return { skipped: "no businesses with a URL yet" };
          return research(b);
        }

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
