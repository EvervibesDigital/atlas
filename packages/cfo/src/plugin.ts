import type { Plugin } from "@atlas/core";
import { forecast, roi, type CfoCommand } from "./finance";
import { fetchRevenueSummary, type FetchLike, type RevenueSummary } from "./revenue";

/**
 * CFO plugin (service "cfo") — protects the money. `forecast`/`roi` are pure
 * math; `pullReal` bridges to evervibes' actual Stripe-fed revenue (see
 * revenue.ts) so ATLAS finally has a real dollar signal instead of only
 * activity counts. When `forecast`'s `inputs.monthlyRevenue` is omitted, it's
 * auto-filled from that real MRR — cashOnHand/monthlyExpenses stay
 * Mat-supplied since nothing tracks a bank balance or business expenses yet.
 */
export function createCfoPlugin(opts: { fetcher?: FetchLike } = {}): Plugin {
  const f = opts.fetcher ?? fetch;

  return {
    manifest: { name: "cfo", version: "0.1.0", capabilities: ["cfo"], permissions: ["call:memory", "secret:*"], role: "executor" },
    register(ctx) {
      async function pullReal(): Promise<RevenueSummary> {
        const url = (await ctx.secret("EVERVIBES_APP_URL")) || "https://evervibesdigital.com";
        const secret = await ctx.secret("KDP_CRON_SECRET"); // shared bridge secret, same value as evervibes' CRON_SECRET
        if (!secret) throw new Error("cfo: no KDP_CRON_SECRET set — add it in API Keys (same value as evervibes' CRON_SECRET env var)");
        return fetchRevenueSummary(url, secret, f);
      }

      ctx.provide("cfo", async (payload) => {
        const cmd = payload as CfoCommand;

        if (cmd.op === "pullReal") return pullReal();

        if (cmd.op === "forecast") {
          let monthlyRevenue = cmd.inputs.monthlyRevenue;
          let realRevenueUsed = false;
          if (monthlyRevenue === undefined) {
            try {
              const real = await pullReal();
              monthlyRevenue = real.mrr;
              realRevenueUsed = true;
            } catch {
              monthlyRevenue = 0; // no real bridge configured — forecast still runs, honestly at $0
            }
          }
          const result = forecast({ ...cmd.inputs, monthlyRevenue });
          try {
            await ctx.call("memory", { op: "remember", input: { kind: "business", content: `CFO forecast: ${result.verdict}, runway ${result.runwayMonths ?? "∞"} months`, metadata: { result, realRevenueUsed } } });
          } catch {
            /* memory optional */
          }
          if (result.verdict === "critical") await ctx.emit("cfo.alert", { runwayMonths: result.runwayMonths });
          return { ...result, realRevenueUsed, monthlyRevenue };
        }

        if (cmd.op === "roi") return { roi: roi(cmd.cost, cmd.expectedReturn) };

        throw new Error(`cfo: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
