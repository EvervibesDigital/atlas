import { describe, it, expect } from "vitest";
import { tavilySearch, serperSearch, githubRepoSearch, type FetchLike } from "../src/index";

const fake =
  (payload: unknown): FetchLike =>
  async () => ({ ok: true, status: 200, json: async () => payload });

describe("search adapters", () => {
  it("normalizes Tavily results", async () => {
    const r = await tavilySearch("k", "free tts api", 3, fake({ results: [{ title: "edge-tts", url: "https://x", content: "free microsoft tts" }] }));
    expect(r[0]).toMatchObject({ title: "edge-tts", url: "https://x" });
  });
  it("normalizes Serper results", async () => {
    const r = await serperSearch("k", "q", 3, fake({ organic: [{ title: "T", link: "https://y", snippet: "s" }] }));
    expect(r[0]!.url).toBe("https://y");
  });
  it("normalizes GitHub repo search with stars", async () => {
    const r = await githubRepoSearch("tok", "ai agent", 3, fake({ items: [{ full_name: "org/agent", html_url: "https://gh", description: "cool", stargazers_count: 1200 }] }));
    expect(r[0]!.title).toBe("org/agent");
    expect(r[0]!.snippet).toContain("⭐1200");
  });
});
