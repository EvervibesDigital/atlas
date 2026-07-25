import { describe, it, expect, afterEach, vi } from "vitest";
import { OllamaAdapter, stripReasoning } from "../src/adapters/ollama";
import type { ModelSpec } from "../src/types";

describe("OllamaAdapter model gating", () => {
  const original = process.env.ATLAS_ENABLE_QWEN36;
  afterEach(() => {
    if (original === undefined) delete process.env.ATLAS_ENABLE_QWEN36;
    else process.env.ATLAS_ENABLE_QWEN36 = original;
  });

  it("exposes only the 3B default model when Qwen3.6 isn't enabled", () => {
    delete process.env.ATLAS_ENABLE_QWEN36;
    const adapter = new OllamaAdapter();
    expect(adapter.models.map((m) => m.id)).toEqual(["llama3.2:3b"]);
  });

  it("adds Qwen3.6 35B-A3B only when ATLAS_ENABLE_QWEN36 is set", () => {
    process.env.ATLAS_ENABLE_QWEN36 = "1";
    const adapter = new OllamaAdapter();
    expect(adapter.models.map((m) => m.id)).toContain("qwen3.6:35b-a3b");
    // Speed must stay low so it doesn't win ordinary low-stakes requests over the 3B default.
    const qwen = adapter.models.find((m) => m.id === "qwen3.6:35b-a3b")!;
    expect(qwen.caps.speed ?? 1).toBeLessThan(0.5);
  });
});

describe("OllamaAdapter per-model timeout", () => {
  // Mat hit an AbortError on unfiltered chat (dolphin3:8b): the adapter used
  // one fixed 120s timeout for every model, but a real prompt (full system
  // prompt + history + memory) to the larger local models can legitimately
  // run past that on this CPU-only box. Verifies the slow models get a
  // longer fuse without needing to actually wait 4 real minutes.
  function pendingFetch(): { fetch: typeof fetch; wasAborted: () => boolean } {
    let aborted = false;
    const f = ((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("AbortError"));
        });
      });
    }) as unknown as typeof fetch;
    return { fetch: f, wasAborted: () => aborted };
  }

  it("aborts a slow model (dolphin3:8b) only after 240s, not 120s", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new OllamaAdapter();
      const { fetch: f, wasAborted } = pendingFetch();
      vi.stubGlobal("fetch", f);

      const model: ModelSpec = { id: "dolphin3:8b", label: "x", caps: { coding: 0, research: 0, reasoning: 0, creativity: 0, speed: 0 }, costUsd: 0, privacy: 1, free: true };
      const promise = adapter.generate(model, { prompt: "hi" }).catch(() => {});

      await vi.advanceTimersByTimeAsync(120000);
      expect(wasAborted()).toBe(false); // must NOT abort at the old 120s mark

      await vi.advanceTimersByTimeAsync(120001); // cross the 240s line
      expect(wasAborted()).toBe(true);

      await promise;
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("still aborts a normal-speed model at 120s", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new OllamaAdapter();
      const { fetch: f, wasAborted } = pendingFetch();
      vi.stubGlobal("fetch", f);

      const model: ModelSpec = { id: "llama3.2:3b", label: "x", caps: { coding: 0, research: 0, reasoning: 0, creativity: 0, speed: 0 }, costUsd: 0, privacy: 1, free: true };
      const promise = adapter.generate(model, { prompt: "hi" }).catch(() => {});

      await vi.advanceTimersByTimeAsync(120001);
      expect(wasAborted()).toBe(true);

      await promise;
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe("stripReasoning", () => {
  it("strips a full <think>...</think> block", () => {
    expect(stripReasoning("<think>pondering</think>final answer")).toBe("final answer");
  });
  it("leaves plain text untouched", () => {
    expect(stripReasoning("just an answer")).toBe("just an answer");
  });
});
