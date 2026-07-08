import type { Plugin } from "@atlas/core";
import { forecast, roi, type CfoCommand } from "./finance";

/** CFO plugin (service "cfo"). */
export function createCfoPlugin(): Plugin {
  return {
    manifest: { name: "cfo", version: "0.1.0", capabilities: ["cfo"], permissions: ["call:memory"], role: "executor" },
    register(ctx) {
      ctx.provide("cfo", async (payload) => {
        const cmd = payload as CfoCommand;
        if (cmd.op === "forecast") {
          const result = forecast(cmd.inputs);
          try {
            await ctx.call("memory", { op: "remember", input: { kind: "business", content: `CFO forecast: ${result.verdict}, runway ${result.runwayMonths ?? "∞"} months`, metadata: { result } } });
          } catch {
            /* memory optional */
          }
          if (result.verdict === "critical") await ctx.emit("cfo.alert", { runwayMonths: result.runwayMonths });
          return result;
        }
        if (cmd.op === "roi") return { roi: roi(cmd.cost, cmd.expectedReturn) };
        throw new Error(`cfo: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
