import type { Plugin } from "@atlas/core";
import { TwinClient, type FetchLike } from "./twin-client";
import type { SurplusLead, SurplusRole } from "./types";

/**
 * Surplus plugin (service "surplus") — brings Mat's "Surplus Funds Platform
 * v2" into ATLAS. That platform is a real, working 6-agent pipeline he built
 * on Twin AI (build.twin.so): County Discovery → Scraper → Enricher →
 * Outreach → Attorney Match/Recruit. It scrapes county foreclosure/tax-sale
 * records for surplus >= $5,000 and its leads already live in Mat's own
 * Google Sheets.
 *
 * Migration posture (phase 1): ATLAS ORCHESTRATES the existing Twin pipeline
 * over its REST API — list agents, trigger runs, see what's scheduled/billing,
 * pull each agent's instructions as the blueprint for a future native rebuild.
 * We deliberately do NOT rebuild the working county scrapers yet
 * ([[feedback_dont_build_workarounds]]); this is the bridge that gets the
 * business "into ATLAS" and de-risks turning Twin off later.
 *
 * Nothing here auto-contacts a property owner or attorney. Outreach stays a
 * gated, human-approved step — same posture as every other ATLAS business.
 *
 * Requires TWIN_API_KEY in the vault (Keys tab). Gracefully reports itself
 * unavailable if unset, same pattern as kdp needing KDP_CRON_SECRET.
 */

/** The six agents that make up the platform, mapped to their Twin agent ids (from the 2026-07-21 pull). */
const AGENT_IDS: Record<SurplusRole, string> = {
  "county-discovery": "019cbf0d-76f6-70e1-b106-9150e93b6e0f",
  scraper: "019cbebb-e091-7dc1-beee-0e9e9a8477ec",
  enricher: "019cbec9-0515-7ef3-9632-7bef4873f711",
  outreach: "019cbedd-7f20-70c2-a3d3-f75a79d7f258",
  "attorney-match": "019cbedd-9dd8-7e81-8ee9-4dee5847a0e6",
  "attorney-recruit": "019cbedd-c62f-7d12-98ec-65be0137a3ad",
};

export type SurplusCommand =
  | { op: "listAgents" }
  | { op: "schedules" }
  | { op: "blueprint"; role: SurplusRole }
  | { op: "run"; role: SurplusRole; message?: string }
  | { op: "runEvents"; role: SurplusRole; runId: string }
  | { op: "pause"; role: SurplusRole };

export function createSurplusPlugin(opts: { fetcher?: FetchLike; twinBase?: string } = {}): Plugin {
  return {
    manifest: {
      name: "surplus",
      version: "0.1.0",
      capabilities: ["surplus"],
      permissions: ["secret:*", "call:memory"],
      role: "executor",
    },

    register(ctx) {
      async function client(): Promise<TwinClient> {
        const key = await ctx.secret("TWIN_API_KEY");
        if (!key) throw new Error("surplus: no TWIN_API_KEY set — add it in the Keys tab to let ATLAS reach your Twin surplus-funds agents");
        return new TwinClient(key, opts.fetcher ?? fetch, opts.twinBase);
      }

      function agentId(role: SurplusRole): string {
        const id = AGENT_IDS[role];
        if (!id) throw new Error(`surplus: unknown role "${role}"`);
        return id;
      }

      ctx.provide("surplus", async (payload) => {
        const cmd = payload as SurplusCommand;
        const c = await client();

        if (cmd.op === "listAgents") {
          const agents = await c.listAgents(50);
          return { agents };
        }

        if (cmd.op === "schedules") {
          const schedules = await c.listSchedules();
          return { schedules };
        }

        if (cmd.op === "blueprint") {
          const instructions = await c.getInstructions(agentId(cmd.role));
          return { role: cmd.role, instructions };
        }

        if (cmd.op === "run") {
          const res = await c.triggerRun(agentId(cmd.role), cmd.message);
          try {
            await ctx.call("memory", { op: "remember", input: { kind: "task", content: `Surplus: triggered Twin "${cmd.role}" agent (run ${res.run_id ?? "?"})` } });
          } catch {
            /* memory optional */
          }
          await ctx.emit("surplus.run", { role: cmd.role, runId: res.run_id });
          return res;
        }

        if (cmd.op === "runEvents") {
          const events = await c.getRunEvents(agentId(cmd.role), cmd.runId, 150);
          return { events };
        }

        if (cmd.op === "pause") {
          await c.pauseSchedule(agentId(cmd.role));
          return { paused: cmd.role };
        }

        throw new Error(`surplus: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}

export type { SurplusLead };
