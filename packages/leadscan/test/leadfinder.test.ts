import { describe, it, expect } from "vitest";
import { findLeads } from "../src/leadfinder";

describe("findLeads", () => {
  it("sends the googleMaps grounding tool and parses the JSON array out of Gemini's text response", async () => {
    let sawBody: any = null;
    let sawUrl = "";
    const f = (async (url: string, init?: RequestInit) => {
      sawUrl = url;
      sawBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Here you go:\n[{"businessName":"Joe\'s Plumbing","website":"https://joesplumbing.com","phone":"555-1234","email":null}]' }] } }],
        }),
      } as Response;
    }) as typeof fetch;

    const leads = await findLeads("plumbing", "Columbus, OH", "test-key", f);
    expect(sawUrl).toContain("key=test-key");
    expect(sawBody.tools).toEqual([{ googleMaps: {} }]);
    expect(leads).toHaveLength(1);
    expect(leads[0]!.businessName).toBe("Joe's Plumbing");
    expect(leads[0]!.website).toBe("https://joesplumbing.com");
  });

  it("returns [] if Gemini's response has no parseable JSON array", async () => {
    const f = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "Sorry, I can't help with that." }] } }] }),
    })) as unknown as typeof fetch;
    expect(await findLeads("plumbing", "Columbus, OH", "test-key", f)).toEqual([]);
  });

  it("throws a clear error on a non-OK response", async () => {
    const f = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    await expect(findLeads("plumbing", "Columbus, OH", "test-key", f)).rejects.toThrow(/404/);
  });
});
