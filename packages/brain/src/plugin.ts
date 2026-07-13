import type { Plugin } from "@atlas/core";
import type { BrainRequest, ProviderAdapter } from "./types";
import { BrainRouter } from "./router";
import { GeminiAdapter } from "./adapters/gemini";
import { HuggingFaceAdapter } from "./adapters/huggingface";
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
      const geminiKey = await ctx.secret("GEMINI_API_KEY");
      const groqKey = await ctx.secret("GROQ_API_KEY");
      const huggingFaceKey = await ctx.secret("HUGGINGFACE_API_KEY");

      // The router scores by capability + honest caps, not list order. Only
      // adapters whose keys are present are `available()`; the rest sit idle.
      //   Gemini 3.5 Flash — free, generous rate limit (needs GEMINI_API_KEY)
      //   Groq 70B         — free, very fast, ~1K req/day (needs GROQ_API_KEY)
      //   HuggingFace      — free tier, 45K+ specialized models (needs HUGGINGFACE_API_KEY)
      //   Ollama           — local, offline, unlimited; always available
      //   stub             — last-resort offline echo so ATLAS never hard-fails
      const adapters: ProviderAdapter[] = [
        new GeminiAdapter(geminiKey),
        new GroqAdapter(groqKey),
        new HuggingFaceAdapter(huggingFaceKey),
        new OllamaAdapter(),
        new StubAdapter(),
      ];

      const router = new BrainRouter(adapters);

      ctx.provide("brain", (payload) => router.generate(payload as BrainRequest));

      await ctx.emit("brain.ready", {
        providers: router.availableModels().map((c) => `${c.adapter.name}:${c.model.id}`),
      });
    },
  };
}
