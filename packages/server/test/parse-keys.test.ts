import { describe, it, expect } from "vitest";
import { parseKeyLines, parseUrls, detectSecrets, redactSecrets } from "../src/server";

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

describe("detectSecrets", () => {
  // Fixtures are built by concatenation so no literal key-shaped string exists
  // in this file (which would trip GitHub's secret-scanning push protection).
  const groqKey = "gsk_" + "z".repeat(40);
  const orKey = "sk-or-" + "v1-" + "0".repeat(30);
  const stripeKey = "rk_" + "live_" + "q".repeat(24);

  it("recognizes keys by shape and never keeps the value in redacted text", () => {
    const msg = `groq api key -- ${groqKey} and openrouter ${orKey}`;
    const found = detectSecrets(msg);
    expect(found.map((s) => s.name)).toEqual(expect.arrayContaining(["GROQ_API_KEY", "OPENROUTER_API_KEY"]));
    const safe = redactSecrets(msg, found);
    expect(safe).not.toContain(groqKey);
    expect(safe).toContain("[saved:GROQ_API_KEY]");
  });

  it("flags a live Stripe key as sensitive", () => {
    const found = detectSecrets(`stripe ${stripeKey}`);
    expect(found[0]!.name).toBe("STRIPE_RESTRICTED_KEY");
    expect(found[0]!.sensitive).toBe(true);
  });

  it("keeps only one value per env name", () => {
    const found = detectSecrets(`gsk_${"a".repeat(40)} gsk_${"b".repeat(40)}`);
    expect(found.filter((s) => s.name === "GROQ_API_KEY")).toHaveLength(1);
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
