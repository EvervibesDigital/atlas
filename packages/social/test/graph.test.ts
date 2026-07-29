import { describe, it, expect, vi } from "vitest";
import { exchangeForLongLivedToken, fetchPagesWithInstagram } from "../src/graph";

describe("exchangeForLongLivedToken", () => {
  it("calls the fb_exchange_token grant and returns the long-lived token", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "LONG_LIVED_TOKEN", token_type: "bearer", expires_in: 5184000 }),
    });

    const result = await exchangeForLongLivedToken("SHORT_TOKEN", "app-id", "app-secret", fetcher);

    expect(result.accessToken).toBe("LONG_LIVED_TOKEN");
    const url = fetcher.mock.calls[0]![0] as string;
    expect(url).toContain("grant_type=fb_exchange_token");
    expect(url).toContain("fb_exchange_token=SHORT_TOKEN");
    expect(url).toContain("client_id=app-id");
  });

  it("throws with the real error text when Meta rejects it", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "This authorization code has expired." } }),
    });

    await expect(exchangeForLongLivedToken("STALE", "id", "secret", fetcher)).rejects.toThrow(/expired/);
  });
});

describe("fetchPagesWithInstagram", () => {
  it("returns each Page with its own token and linked Instagram account id", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: "page1", name: "Aria Vance", access_token: "PAGE1_TOKEN", instagram_business_account: { id: "ig111" } },
          { id: "page2", name: "Kai Rivers", access_token: "PAGE2_TOKEN" },
        ],
      }),
    });

    const pages = await fetchPagesWithInstagram("USER_TOKEN", fetcher);

    expect(pages).toEqual([
      { pageId: "page1", pageName: "Aria Vance", pageAccessToken: "PAGE1_TOKEN", igBusinessAccountId: "ig111" },
      { pageId: "page2", pageName: "Kai Rivers", pageAccessToken: "PAGE2_TOKEN", igBusinessAccountId: undefined },
    ]);
    const url = fetcher.mock.calls[0]![0] as string;
    expect(url).toContain("/me/accounts");
    expect(url).toContain("instagram_business_account");
  });

  it("returns an empty list when the user manages no Pages, without throwing", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) });
    expect(await fetchPagesWithInstagram("T", fetcher)).toEqual([]);
  });

  it("throws with the real error text when the Graph call fails", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: "Insufficient permission to list pages." } }),
    });
    await expect(fetchPagesWithInstagram("T", fetcher)).rejects.toThrow(/Insufficient permission/);
  });
});
