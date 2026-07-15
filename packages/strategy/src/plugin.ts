import type { Plugin } from "@atlas/core";
import { convene, type CouncilVerdict } from "./council";

/** Strategy Council plugin (service "strategy"). */
export function createStrategyPlugin(): Plugin {
  return {
    manifest: { name: "strategy", version: "0.1.0", capabilities: ["strategy"], permissions: ["call:memory", "call:brain"], role: "executor" },
    register(ctx) {
      ctx.provide("strategy", async (payload) => {
        const cmd = payload as { op: "convene"; decision: string };
        if (cmd.op !== "convene") throw new Error(`strategy: unknown op "${(cmd as { op: string }).op}"`);

        let verdict: CouncilVerdict;
        try {
          const brainResponse = (await ctx.call("brain", {
            system: `You are the ATLAS Strategy Council, convening a multi-perspective debate.
Evaluate the proposed decision from 7 distinct perspectives:
1. Finance (cost, ROI)
2. Security (privacy, credentials, scrapers)
3. Engineering (technical debt, testability, rush jobs)
4. Marketing (brand, customer trust, pillars)
5. Operations (scalability, automated vs manual drag)
6. Legal (copyright, scraping, GDPR, terms of service)
7. Customer (user value, support, trust)

Synthesize their debate and respond strictly with a JSON object of this shape:
{
  "consensus": "for" | "against" | "split",
  "opinions": [
    { "perspective": "finance" | "security" | "engineering" | "marketing" | "operations" | "legal" | "customer", "vote": "for" | "against" | "neutral", "concern": "string description of concern if voting against or neutral" }
  ],
  "risks": ["list of key risk strings"],
  "recommendation": "one sentence action recommendation"
}`,
            prompt: `Proposed decision: "${cmd.decision}"`,
            needs: { reasoning: 0.8, creativity: 0.4, cost: 1 },
            maxTokens: 1000,
            task: "strategy.council",
          })) as { text: string };

          const text = brainResponse.text;
          const jsonStart = text.indexOf("{");
          const jsonEnd = text.lastIndexOf("}") + 1;
          if (jsonStart !== -1 && jsonEnd !== -1) {
            const parsed = JSON.parse(text.slice(jsonStart, jsonEnd)) as Omit<CouncilVerdict, "decision">;
            verdict = {
              decision: cmd.decision,
              consensus: parsed.consensus ?? "split",
              opinions: parsed.opinions ?? [],
              risks: parsed.risks ?? [],
              recommendation: parsed.recommendation ?? "Proceed with caution.",
            };
          } else {
            throw new Error("Invalid JSON returned by brain");
          }
        } catch (e) {
          // Fall back to offline deterministic rules if the brain call fails or returns invalid JSON.
          verdict = convene(cmd.decision);
        }

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
