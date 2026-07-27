import { describe, it, expect } from "vitest";
import { buildConnectUrl } from "../src/oauth";

describe("buildConnectUrl", () => {
  it("builds a Facebook Login for Business OAuth dialog URL with the app id, config, redirect, and state", () => {
    const url = buildConnectUrl("123456789", "cfg-abc-123", "https://atlas.evervibesdigital.com/api/social/oauth/callback", "abc-state-token");
    expect(url).toContain("https://www.facebook.com/v25.0/dialog/oauth?");
    expect(url).toContain("client_id=123456789");
    expect(url).toContain("config_id=cfg-abc-123");
    expect(url).toContain(encodeURIComponent("https://atlas.evervibesdigital.com/api/social/oauth/callback"));
    expect(url).toContain("state=abc-state-token");
    expect(url).toContain("response_type=code");
  });

  it("never includes a raw scope parameter — Meta requires config_id instead for business-type permissions like pages_manage_posts/instagram_content_publish", () => {
    const url = buildConnectUrl("id", "cfg-1", "https://x/cb", "s");
    expect(url).not.toContain("scope=");
  });
});
