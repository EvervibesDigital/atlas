import { describe, it, expect } from "vitest";
import { buildConnectUrl } from "../src/oauth";

describe("buildConnectUrl", () => {
  it("builds a Facebook OAuth dialog URL with the app id, redirect, and state", () => {
    const url = buildConnectUrl("123456789", "https://atlas.evervibesdigital.com/api/social/oauth/callback", "abc-state-token");
    expect(url).toContain("https://www.facebook.com/v21.0/dialog/oauth?");
    expect(url).toContain("client_id=123456789");
    expect(url).toContain(encodeURIComponent("https://atlas.evervibesdigital.com/api/social/oauth/callback"));
    expect(url).toContain("state=abc-state-token");
  });

  it("requests every scope posting and DM/comment reading needs", () => {
    const url = buildConnectUrl("id", "https://x/cb", "s");
    for (const scope of ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "pages_messaging", "instagram_basic", "instagram_content_publish", "instagram_manage_comments"]) {
      expect(url).toContain(scope);
    }
  });
});
