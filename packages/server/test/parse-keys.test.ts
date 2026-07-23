import { describe, it, expect } from "vitest";
import { parseKeyLines, parseUrls, detectSecrets, redactSecrets, trivialReply, chatNeeds, routeChatIntent, formatIntentResult, validateSecretValue } from "../src/server";

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

describe("frugal chat layer", () => {
  it("answers greetings/acks with no LLM call", () => {
    expect(trivialReply("hi")).toBeTruthy();
    expect(trivialReply("thanks!")).toBeTruthy();
    expect(trivialReply("ok")).toBeTruthy();
  });
  it("passes real questions through to the LLM", () => {
    expect(trivialReply("what should I focus on this week?")).toBeNull();
  });
  it("routes simple asks to a cheap model and hard asks to a strong one", () => {
    expect(chatNeeds("what time is it").reasoning).toBeLessThan(0.5); // cheap
    expect(chatNeeds("analyze my wholesale strategy and compare the options").reasoning).toBeGreaterThan(0.8); // strong
  });
});

describe("routeChatIntent (chat can DO things)", () => {
  it("routes 'find free tts apis' to the search agent", () => {
    const i = routeChatIntent("find free tts apis");
    expect(i?.service).toBe("search");
    expect((i?.payload as { op: string }).op).toBe("freeApis");
  });
  it("routes 'scout github for agent frameworks' to a repo scout", () => {
    const i = routeChatIntent("scout github for agent frameworks");
    expect(i?.kind).toBe("scout");
  });
  it("routes 'run today's cycle' to the orchestrator", () => {
    expect(routeChatIntent("run today's cycle")?.service).toBe("orchestrator");
  });
  it("routes 'red team: my dentist SaaS idea' to the red team", () => {
    const i = routeChatIntent("red team: my dentist SaaS idea");
    expect(i?.service).toBe("redteam");
    expect((i?.payload as { idea: string }).idea).toMatch(/dentist/);
  });
  it("lets normal conversation fall through", () => {
    expect(routeChatIntent("what do you think about my week")).toBeNull();
  });
  it("routes 'surplus funds status' to the surplus service", () => {
    const i = routeChatIntent("show me my surplus funds status");
    expect(i?.service).toBe("surplus");
    expect((i?.payload as { op: string }).op).toBe("listAgents");
  });
  it("formats surplus agents into a readable list", () => {
    const out = formatIntentResult("surplus", { agents: [{ name: "Surplus Funds Lead Scraper", latest_run_status: "completed", last_activity_at: "2026-07-21T02:50:20Z" }] });
    expect(out).toContain("Surplus Funds Lead Scraper");
    expect(out).toContain("completed");
  });
  it("routes 'morning brief' to the brief service, distinct from 'business brief'", () => {
    const morning = routeChatIntent("what's my morning brief look like");
    expect(morning?.service).toBe("brief");
    expect(morning?.kind).toBe("morningBrief");
    const business = routeChatIntent("give me the business brief");
    expect(business?.service).toBe("business");
    expect(business?.kind).toBe("brief");
  });
  it("formats the morning brief's items across sources", () => {
    const out = formatIntentResult("morningBrief", { items: [{ source: "kdp", title: "2027 Gratitude Journal", detail: "Ready to upload" }] });
    expect(out).toContain("[kdp]");
    expect(out).toContain("2027 Gratitude Journal");
  });
  it("routes 'n8n workflows status' to the outreach service", () => {
    const i = routeChatIntent("show me n8n workflows status");
    expect(i?.service).toBe("outreach");
    expect((i?.payload as { op: string }).op).toBe("listWorkflows");
  });
  it("formats outreach workflows with an active/inactive marker", () => {
    const out = formatIntentResult("outreach", { workflows: [{ name: "New Lead Intake", active: false }, { name: "W1 Multi-Niche Scraper", active: true }] });
    expect(out).toContain("New Lead Intake");
    expect(out).toContain("🟢");
    expect(out).toContain("⚪");
  });
  it("formats search results as a list", () => {
    expect(formatIntentResult("freeApis", { results: [{ title: "edge-tts", url: "https://x" }] })).toContain("edge-tts");
  });
});

describe("detectSecrets — database connection strings", () => {
  it("detects a Postgres connection string as DATABASE_URL", () => {
    const url = "postgres" + "ql://postgres:testpass123@db.abcxyz.supabase.co:5432/postgres";
    const found = detectSecrets(`here you go: ${url}`);
    expect(found.map((s) => s.name)).toContain("DATABASE_URL");
    expect(found.find((s) => s.name === "DATABASE_URL")!.value).toBe(url);
  });
});

describe("validateSecretValue", () => {
  it("accepts a well-formed Postgres connection string", () => {
    const url = "postgres" + "ql://postgres:testpass123@db.abcxyz.supabase.co:5432/postgres";
    expect(validateSecretValue("DATABASE_URL", url)).toBeNull();
  });

  it("rejects a connection string with an unresolved [YOUR-PASSWORD] placeholder", () => {
    const url = "postgres" + "ql://postgres:[YOUR-PASSWORD]@db.abcxyz.supabase.co:5432/postgres";
    const problem = validateSecretValue("DATABASE_URL", url);
    expect(problem).toMatch(/placeholder/i);
  });

  it("rejects a malformed URL with a helpful message, not a raw parser crash", () => {
    const problem = validateSecretValue("DATABASE_URL", "not a url at all");
    expect(problem).toMatch(/valid URL/i);
  });

  it("leaves non-database secrets alone", () => {
    expect(validateSecretValue("GROQ_API_KEY", "gsk_" + "z".repeat(40))).toBeNull();
  });

  it("also validates a bare postgres:// value even under a different key name", () => {
    const url = "postgres://postgres:[YOUR-PASSWORD]@host:5432/postgres";
    expect(validateSecretValue("SOME_OTHER_NAME", url)).toMatch(/placeholder/i);
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
