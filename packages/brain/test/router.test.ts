import { describe, it, expect } from "vitest";
import { BrainRouter } from "../src/router";
import { StubAdapter } from "../src/adapters/stub";
import { scoreModel } from "../src/scorer";
import type { BrainRequest, ModelSpec, ProviderAdapter } from "../src/types";

/** A fake cloud provider we can configure to succeed or fail. */
class FakeAdapter implements ProviderAdapter {
  calls = 0;
  constructor(
    public name: string,
    public models: ModelSpec[],
    private behavior: "ok" | "fail" = "ok",
  ) {}
  available() {
    return true;
  }
  async generate(model: ModelSpec): Promise<{ text: string; costUsd: number }> {
    this.calls++;
    if (this.behavior === "fail") throw new Error(`${this.name} boom`);
    return { text: `${this.name}:${model.id} says hi`, costUsd: 0 };
  }
}

const fast: ModelSpec = { id: "fast", label: "fast", caps: { speed: 0.9, reasoning: 0.4 }, costUsd: 0, privacy: 0, free: true };
const smart: ModelSpec = { id: "smart", label: "smart", caps: { speed: 0.3, reasoning: 0.95 }, costUsd: 0, privacy: 0, free: true };

describe("scorer", () => {
  it("prefers the fast model when speed is what matters", () => {
    expect(scoreModel(fast, { speed: 1 })).toBeGreaterThan(scoreModel(smart, { speed: 1 }));
  });
  it("prefers the smart model when reasoning is what matters", () => {
    expect(scoreModel(smart, { reasoning: 1 })).toBeGreaterThan(scoreModel(fast, { reasoning: 1 }));
  });
});

describe("BrainRouter", () => {
  it("routes a reasoning task to the smart model", async () => {
    const router = new BrainRouter([new FakeAdapter("cloud", [fast, smart])]);
    const res = await router.generate({ prompt: "solve", needs: { reasoning: 1 } });
    expect(res.model).toBe("smart");
    expect(res.provider).toBe("cloud");
  });

  it("falls back to the next provider when the first errors", async () => {
    const bad = new FakeAdapter("bad", [smart], "fail");
    const good = new FakeAdapter("good", [fast], "ok");
    const router = new BrainRouter([bad, good]);
    const res = await router.generate({ prompt: "hi", needs: { reasoning: 1 } });
    expect(res.provider).toBe("good");
    expect(res.fallbackFrom).toContain("bad:smart");
    expect(bad.calls).toBe(1);
  });

  it("serves a cache hit without calling a provider again", async () => {
    const cloud = new FakeAdapter("cloud", [fast]);
    const router = new BrainRouter([cloud]);
    const req: BrainRequest = { prompt: "same question" };
    const first = await router.generate(req);
    const second = await router.generate(req);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(cloud.calls).toBe(1); // provider hit only once
  });

  it("runs offline with only the stub when no real provider exists", async () => {
    const router = new BrainRouter([new StubAdapter()]);
    const res = await router.generate({ prompt: "hello world" });
    expect(res.provider).toBe("stub");
    expect(res.costUsd).toBe(0);
    expect(res.text).toContain("hello world");
  });

  it("forces a high-privacy request to a local/private model, not the cloud", async () => {
    const cloud = new FakeAdapter("cloud", [smart]); // privacy 0
    const router = new BrainRouter([cloud, new StubAdapter()]); // stub privacy 1
    const res = await router.generate({ prompt: "secret", needs: { privacy: 1 } });
    expect(res.provider).toBe("stub");
    expect(cloud.calls).toBe(0);
  });

  it("throws a clear error when no provider is available at all", async () => {
    const router = new BrainRouter([]);
    await expect(router.generate({ prompt: "x" })).rejects.toThrow(/no available LLM providers/);
  });
});
