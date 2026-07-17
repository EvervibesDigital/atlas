import { describe, it, expect } from "vitest";
import { Atlas, type Plugin } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createEvaluationPlugin, type EvaluationResult } from "../src/index";

describe("evaluation plugin", () => {
  it("scores text via the 'evaluation' service and emits evaluation.flagged when issues are found", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createEvaluationPlugin());

    let flagged: unknown;
    let result: EvaluationResult | undefined;
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:evaluation"], role: "executor" },
      async register(ctx) {
        ctx.on("evaluation.flagged", (payload) => {
          flagged = payload;
        });
        result = (await ctx.call("evaluation", {
          op: "score",
          text: "I've successfully registered your account and it is now live.",
        })) as EvaluationResult;
      },
    } satisfies Plugin);

    expect(result!.confidence).toBeLessThan(1);
    expect(flagged).toBeDefined();
  });

  it("rejects an unknown op", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createEvaluationPlugin());

    await atlas.use({
      manifest: { name: "caller2", version: "1", capabilities: [], permissions: ["call:evaluation"], role: "executor" },
      async register(ctx) {
        await expect(ctx.call("evaluation", { op: "bogus" })).rejects.toThrow(/unknown op/);
      },
    } satisfies Plugin);
  });
});
