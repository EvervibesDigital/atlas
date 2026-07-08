import type { Plugin } from "@atlas/core";
import type { BrainRequest, ProviderAdapter } from "./types";
import { BrainRouter } from "./router";
import { StubAdapter } from "./adapters/stub";
import { GroqAdapter } from "./adapters/groq";
import { OpenRouterAdapter } from "./adapters/openrouter";
import { GeminiAdapter } from "./adapters/gemini";

/**
 * Brain plugin — exposes the "brain" service other plugins call to generate
 * text. It reads provider keys through the Guardian-brokered `secret()` path,
 * builds the router (stub + whichever real providers have keys), and emits
 * `brain.ready` announcing what's live.
 *
 * With no keys, only the offline stub is active — ATLAS still runs.
 */
export function createBrainPlugin(): Plugin {
  return {
    manifest: {
      name: "brain",
      version: "0.1.0",
      capabilities: ["brain"],
      permissions: ["secret:*"],
      role: "executor",
    },

    async register(ctx) {
      const groqKey = await ctx.secret("GROQ_API_KEY");
      const openRouterKey = await ctx.secret("OPENROUTER_API_KEY");
      const geminiKey = await ctx.secret("GEMINI_API_KEY");

      const adapters: ProviderAdapter[] = [
        new StubAdapter(),
        new GroqAdapter(groqKey),
        new OpenRouterAdapter(openRouterKey),
        new GeminiAdapter(geminiKey),
      ];

      const router = new BrainRouter(adapters);

      ctx.provide("brain", (payload) => router.generate(payload as BrainRequest));

      await ctx.emit("brain.ready", {
        providers: router.availableModels().map((c) => `${c.adapter.name}:${c.model.id}`),
      });
    },
  };
}
