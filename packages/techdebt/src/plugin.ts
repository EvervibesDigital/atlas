import type { Plugin } from "@atlas/core";
import { scanForDebt, summarize, type DebtFinding } from "./scan";

/** Tech-Debt Hunter plugin (service "techdebt"). */
export function createTechDebtPlugin(): Plugin {
  return {
    manifest: { name: "techdebt", version: "0.1.0", capabilities: ["techdebt"], permissions: ["call:memory"], role: "executor" },
    register(ctx) {
      ctx.provide("techdebt", async (payload) => {
        const cmd = payload as { op: "scan"; dir: string; maxLines?: number };
        if (cmd.op !== "scan") throw new Error(`techdebt: unknown op "${(cmd as { op: string }).op}"`);

        const findings: DebtFinding[] = await scanForDebt(cmd.dir, { maxLines: cmd.maxLines });
        const summary = summarize(findings);
        try {
          await ctx.call("memory", { op: "remember", input: { kind: "project", content: `Tech-debt scan of ${cmd.dir}: ${summary.total} findings`, metadata: { summary } } });
        } catch {
          /* memory optional */
        }
        await ctx.emit("techdebt.scanned", summary);
        return { summary, findings };
      });
    },
  };
}
