import type { Plugin } from "@atlas/core";
import { convene } from "./council";

/** Strategy Council plugin (service "strategy"). */
export function createStrategyPlugin(): Plugin {
  return {
    manifest: { name: "strategy", version: "0.1.0", capabilities: ["strategy"], permissions: ["call:memory"], role: "executor" },
    register(ctx) {
      ctx.provide("strategy", async (payload) => {
        const cmd = payload as { op: "convene"; decision: string };
        if (cmd.op !== "convene") throw new Error(`strategy: unknown op "${(cmd as { op: string }).op}"`);

        const verdict = convene(cmd.decision);
        try {
          await ctx.call("memory", { op: "remember", input: { kind: "project", content: `Council on "${cmd.decision}": ${verdict.consensus} — ${verdict.recommendation}`, metadata: { risks: verdict.risks } } });
        } catch {
          /* memory optional */
        }
        await ctx.emit("strategy.verdict", { decision: cmd.decision, consensus: verdict.consensus });
        return verdict;
      });
    },
  };
}
