import { describe, it, expect } from "vitest";
import { fetchRevenueSummary, type FetchLike } from "../src/revenue";

const SAMPLE = {
  as_of: "2026-07-26T00:00:00.000Z",
  mrr: 428,
  one_time_this_month: 156,
  breakdown: {
    saas_mrr: 329,
    saas_active_subscribers: 7,
    wholesale_investor_mrr: 99,
    wholesale_paying_investors: 1,
    module_purchases_this_month: 117,
    deal_unlocks_this_month: 39,
  },
};

describe("fetchRevenueSummary", () => {
  it("calls the n8n revenue-summary endpoint with a bearer token and returns the parsed summary", async () => {
    let seenUrl = "", seenAuth = "";
    const f: FetchLike = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      return { ok: true, status: 200, json: async () => SAMPLE } as Response;
    }) as unknown as FetchLike;

    const result = await fetchRevenueSummary("https://evervibesdigital.com", "secret-123", f);
    expect(seenUrl).toBe("https://evervibesdigital.com/api/n8n/revenue-summary");
    expect(seenAuth).toBe("Bearer secret-123");
    expect(result.mrr).toBe(428);
    expect(result.breakdown.saas_active_subscribers).toBe(7);
  });

  it("strips a trailing slash from the base URL", async () => {
    let seenUrl = "";
    const f: FetchLike = (async (url: string) => {
      seenUrl = String(url);
      return { ok: true, status: 200, json: async () => SAMPLE } as Response;
    }) as unknown as FetchLike;
    await fetchRevenueSummary("https://evervibesdigital.com/", "s", f);
    expect(seenUrl).toBe("https://evervibesdigital.com/api/n8n/revenue-summary");
  });

  it("throws with the HTTP status on a non-OK response", async () => {
    const f: FetchLike = (async () => ({ ok: false, status: 401 })) as unknown as FetchLike;
    await expect(fetchRevenueSummary("https://x.com", "wrong", f)).rejects.toThrow(/401/);
  });
});
