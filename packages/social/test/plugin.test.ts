import { describe, it, expect } from "vitest";
import { Atlas, ConfigVault, type GuardianLike } from "@atlas/core";
import { createSocialPlugin } from "../src/plugin";

function permissiveGuardian(): GuardianLike {
  return { grant: () => {}, check: () => ({ decision: "allow", reason: "test" }) };
}

describe("social plugin — getConnectUrl", () => {
  it("returns a real Meta OAuth URL built from META_APP_ID and a generated state", async () => {
    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({ META_APP_ID: "app-123" }) });
    await atlas.use(createSocialPlugin({ redirectUri: "https://atlas.evervibesdigital.com/api/social/oauth/callback" }));

    const result = (await atlas.invoke("social", { op: "getConnectUrl" })) as { url: string };
    expect(result.url).toContain("client_id=app-123");
    expect(result.url).toContain("state=");
  });

  it("throws a clear error when META_APP_ID isn't configured", async () => {
    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({}) });
    await atlas.use(createSocialPlugin({ redirectUri: "https://x/cb" }));

    await expect(atlas.invoke("social", { op: "getConnectUrl" })).rejects.toThrow(/META_APP_ID/);
  });
});
