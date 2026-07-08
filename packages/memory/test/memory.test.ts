import { describe, it, expect, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/memory";
import { InMemoryStore, JsonFileStore } from "../src/stores";
import { TokenEmbedder, cosine } from "../src/embedder";

describe("TokenEmbedder", () => {
  it("is deterministic", async () => {
    const e = new TokenEmbedder();
    expect(await e.embed("hello world")).toEqual(await e.embed("hello world"));
  });

  it("scores related text higher than unrelated text", async () => {
    const e = new TokenEmbedder();
    const base = await e.embed("wholesale real estate deals for cash buyers");
    const near = await e.embed("cash buyers looking for real estate deals");
    const far = await e.embed("a recipe for chocolate chip cookies");
    expect(cosine(base, near)).toBeGreaterThan(cosine(base, far));
  });
});

describe("Memory", () => {
  it("remembers then finds by meaning", async () => {
    const mem = new Memory(new InMemoryStore());
    await mem.remember({ kind: "business", content: "TikTok hooks that start with a bold claim convert best" });
    await mem.remember({ kind: "business", content: "Blue button outperformed green on the pricing page" });

    const results = await mem.search("what kind of hook works on TikTok?");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.record.content).toMatch(/hooks/);
  });

  it("filters search by kind", async () => {
    const mem = new Memory(new InMemoryStore());
    await mem.remember({ kind: "success", content: "shipped the video pipeline" });
    await mem.remember({ kind: "failure", content: "the video pipeline crashed on empty script" });

    const failures = await mem.search("video pipeline", { kind: "failure" });
    expect(failures.every((r) => r.record.kind === "failure")).toBe(true);
    expect(failures[0]!.record.content).toMatch(/crashed/);
  });

  it("recalls most-recent first and forgets on demand", async () => {
    const mem = new Memory(new InMemoryStore());
    const a = await mem.remember({ kind: "timeline", content: "first" });
    await new Promise((r) => setTimeout(r, 2));
    await mem.remember({ kind: "timeline", content: "second" });

    const recent = await mem.recent("timeline");
    expect(recent[0]!.content).toBe("second");

    expect(await mem.forget(a.id)).toBe(true);
    expect((await mem.recent("timeline")).some((r) => r.id === a.id)).toBe(false);
  });
});

describe("JsonFileStore persistence", () => {
  const file = join(tmpdir(), `atlas-mem-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  afterEach(async () => {
    await rm(file, { force: true });
  });

  it("survives across store instances (persists to disk)", async () => {
    const mem1 = new Memory(new JsonFileStore(file));
    await mem1.remember({ kind: "project", content: "ATLAS memory layer built" });

    // A brand-new instance reading the same file must see the record.
    const mem2 = new Memory(new JsonFileStore(file));
    const found = await mem2.search("memory layer");
    expect(found.length).toBe(1);
    expect(found[0]!.record.content).toMatch(/ATLAS memory layer/);
  });
});
