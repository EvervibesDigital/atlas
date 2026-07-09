import { describe, it, expect } from "vitest";
import { parseKeyLines, parseUrls } from "../src/server";

describe("parseKeyLines", () => {
  it("parses mixed formats and ignores noise", () => {
    const text = [
      "GROQ_API_KEY=gsk_abc123",
      "  export GEMINI_API_KEY = AIza-xyz  ",
      "OPENROUTER_API_KEY: or_key",
      'GITHUB_TOKEN="ghp_quoted"',
      "SUPABASE_TOKEN sbp_spaced",
      "# a comment",
      "",
      "not a valid line here",
    ].join("\n");
    const pairs = parseKeyLines(text);
    const map = Object.fromEntries(pairs.map((p) => [p.name, p.value]));
    expect(map.GROQ_API_KEY).toBe("gsk_abc123");
    expect(map.GEMINI_API_KEY).toBe("AIza-xyz");
    expect(map.OPENROUTER_API_KEY).toBe("or_key");
    expect(map.GITHUB_TOKEN).toBe("ghp_quoted"); // quotes stripped
    expect(map.SUPABASE_TOKEN).toBe("sbp_spaced");
    expect(pairs).toHaveLength(5); // comment/blank/prose ignored
  });
});

describe("parseUrls", () => {
  it("extracts http(s) URLs, adds https to bare domains, dedupes, ignores prose", () => {
    const urls = parseUrls(["https://a.com", "example.com/pricing", "http://b.io", "https://a.com", "# note", "just some words"].join("\n"));
    expect(urls).toContain("https://a.com");
    expect(urls).toContain("https://example.com/pricing");
    expect(urls).toContain("http://b.io");
    expect(urls.filter((u) => u === "https://a.com")).toHaveLength(1); // deduped
    expect(urls).toHaveLength(3);
  });
});
