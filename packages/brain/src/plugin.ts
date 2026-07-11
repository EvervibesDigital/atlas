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

      // The router scores by capability, not list order. Given the honest speed
      // caps (Groq is fast; local is slow on this GPU-less machine), the effect is:
      //   Groq 70B (fast, free 1K/day)  → chosen when a key is present
      //   local Ollama (unlimited)      → takes over when Groq errors/limits out
      //   stub (offline)                → last resort only
      // Gemini/OpenRouter removed so there's never a switch to a low-quality model.
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
