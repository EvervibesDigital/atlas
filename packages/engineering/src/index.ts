import type { Plugin } from "@atlas/core";
import type { RiskLevel } from "@atlas/core";

/**
 * Engineering Department — intake for engineering work. Classifies a task by
 * type and risk so it can be routed (auto for low-risk, approval for risky) and
 * can trigger a tech-debt audit. The heavy code-writing is done by Claude Code
 * itself; this department organizes and gates the work.
 */
export type EngType = "feature" | "bug" | "refactor" | "chore" | "security";

export interface ClassifiedTask {
  title: string;
  type: EngType;
  risk: RiskLevel;
}

export function classify(task: { title: string; description?: string }): ClassifiedTask {
  const t = `${task.title} ${task.description ?? ""}`.toLowerCase();

  let type: EngType = "chore";
  if (/\b(fix|bug|broken|crash|error|regression)\b/.test(t)) type = "bug";
  else if (/\b(add|new|feature|implement|build|create)\b/.test(t)) type = "feature";
  else if (/\b(refactor|clean|simplify|restructure|rename)\b/.test(t)) type = "refactor";
  if (/\b(security|auth|credential|vulnerab|exploit|password|token)\b/.test(t)) type = "security";

  let risk: RiskLevel = type === "security" ? 3 : type === "bug" ? 2 : type === "feature" ? 1 : 0;
  if (/\b(production|deploy|migrate|migration|database|payment|billing)\b/.test(t)) {
    risk = Math.max(risk, 2) as RiskLevel;
  }

  return { title: task.title, type, risk };
}

export type EngineeringCommand = { op: "classify"; task: { title: string; description?: string } } | { op: "audit"; dir: string };

/** Engineering plugin (service "engineering", role planner — it organizes, it doesn't execute). */
export function createEngineeringPlugin(): Plugin {
  return {
    manifest: { name: "engineering", version: "0.1.0", capabilities: ["engineering"], permissions: ["call:techdebt"], role: "planner" },
    register(ctx) {
      ctx.provide("engineering", async (payload) => {
        const cmd = payload as EngineeringCommand;
        if (cmd.op === "classify") return classify(cmd.task);
        if (cmd.op === "audit") {
          try {
            return await ctx.call("techdebt", { op: "scan", dir: cmd.dir });
          } catch {
            return { summary: { total: 0, bySeverity: { 1: 0, 2: 0, 3: 0 } }, findings: [] };
          }
        }
        throw new Error(`engineering: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
