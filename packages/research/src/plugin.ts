import type { Plugin } from "@atlas/core";
import type { Discovery, ResearchCommand } from "./core";
import { rankDiscoveries } from "./core";

/**
 * Research plugin (service "research") — a curiosity engine. Ingested
 * discoveries accumulate; `report` ranks them into a prioritized digest and
 * files it in Memory. Real source scanners (GitHub/Reddit/HN/…) can feed
 * `ingest` later without changing the ranking.
 */
export function createResearchPlugin(): Plugin {
  return {
    manifest: {
      name: "research",
      version: "0.1.0",
      capabilities: ["research"],
      permissions: ["call:memory"],
      role: "executor",
    },

    register(ctx) {
      const feed: Discovery[] = [];

      ctx.provide("research", async (payload) => {
        const cmd = payload as ResearchCommand;

        if (cmd.op === "ingest") {
          feed.push(cmd.discovery);
          try {
            await ctx.call("memory", { op: "remember", input: { kind: "semantic", content: `Discovery: ${cmd.discovery.title} — ${cmd.discovery.summary}`, metadata: { url: cmd.discovery.url } } });
          } catch {
            /* memory optional */
          }
          return { ingested: feed.length };
        }

        if (cmd.op === "rank") return rankDiscoveries(cmd.discoveries);

        if (cmd.op === "report") {
          const ranked = rankDiscoveries(feed).slice(0, cmd.limit ?? 10);
          await ctx.emit("research.report", { count: ranked.length, top: ranked[0]?.title });
          return ranked;
        }

        throw new Error(`research: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
