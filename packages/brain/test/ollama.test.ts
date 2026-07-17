import { describe, it, expect, afterEach } from "vitest";
import { OllamaAdapter, stripReasoning } from "../src/adapters/ollama";

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

describe("stripReasoning", () => {
  it("strips a full <think>...</think> block", () => {
    expect(stripReasoning("<think>pondering</think>final answer")).toBe("final answer");
  });
  it("leaves plain text untouched", () => {
    expect(stripReasoning("just an answer")).toBe("just an answer");
  });
});
