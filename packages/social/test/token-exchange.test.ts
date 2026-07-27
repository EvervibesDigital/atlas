import { describe, it, expect, vi } from "vitest";
import { exchangeCodeForToken } from "../src/token-exchange";

describe("exchangeCodeForToken", () => {
  it("posts the code + app credentials and returns the access token", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "EAAB...token", token_type: "bearer", expires_in: 5184000 }),
    });

    const result = await exchangeCodeForToken("the-code", "app-id", "app-secret", "https://x/cb", fetcher);

    expect(result).toEqual({ accessToken: "EAAB...token", expiresIn: 5184000 });
    const calledUrl = fetcher.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("client_id=app-id");
    expect(calledUrl).toContain("client_secret=app-secret");
    expect(calledUrl).toContain("code=the-code");
  });

  it("throws with the response body when the exchange fails", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "Invalid verification code format." } }),
    });

    await expect(exchangeCodeForToken("bad-code", "id", "secret", "https://x/cb", fetcher)).rejects.toThrow(/400/);
  });
});
