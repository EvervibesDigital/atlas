import type { Plugin } from "@atlas/core";
import { evaluate, type EvaluationInput, type EvaluationResult } from "./evaluator";

export type EvaluationCommand = { op: "score" } & EvaluationInput;

/**
 * Evaluation Layer plugin (service "evaluation") — the missing "check this
 * output before it's trusted" step: scores brain-generated text for
 * unverifiable action-claims and, when source context is supplied, how well
 * grounded the text is in it. Purely a judge — it never blocks, edits, or acts;
 * callers (chat, gigfinder, kdp, etc.) decide what to do with a low score.
 * role: "planner" per the Guardian's model — decides/advises, never executes.
 */
export function createEvaluationPlugin(): Plugin {
  return {
    manifest: { name: "evaluation", version: "0.1.0", capabilities: ["evaluation"], permissions: [], role: "planner" },

    register(ctx) {
      ctx.provide("evaluation", async (payload) => {
        const cmd = payload as EvaluationCommand;
        if (cmd.op !== "score") throw new Error(`evaluation: unknown op "${(cmd as { op: string }).op}"`);

        const result: EvaluationResult = evaluate({ task: cmd.task, text: cmd.text, context: cmd.context });
        if (result.issues.length > 0) {
          await ctx.emit("evaluation.flagged", { task: cmd.task, confidence: result.confidence, issues: result.issues });
        }
        return result;
      });
    },
  };
}
