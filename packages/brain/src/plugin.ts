import type { Plugin } from "@atlas/core";
import type { BrainRequest, ProviderAdapter } from "./types";
import { BrainRouter } from "./router";
import { OllamaAdapter } from "./adapters/ollama";
import { StubAdapter } from "./adapters/stub";
import { GroqAdapter } from "./adapters/groq";

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

      // Router priority: local Ollama (unlimited) → Groq (1K req/day free) → stub (offline).
      // No fallback to lower-quality models (Gemini, OpenRouter) — consistency over coverage.
      const adapters: ProviderAdapter[] = [
        new OllamaAdapter(),
        new StubAdapter(),
        new GroqAdapter(groqKey),
      ];

      const router = new BrainRouter(adapters);

      ctx.provide("brain", (payload) => router.generate(payload as BrainRequest));

      await ctx.emit("brain.ready", {
        providers: router.availableModels().map((c) => `${c.adapter.name}:${c.model.id}`),
      });
    },
  };
}
