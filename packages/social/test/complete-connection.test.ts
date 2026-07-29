import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, ConfigVault, type GuardianLike } from "@atlas/core";
import { createSocialPlugin } from "../src/plugin";
import { decryptToken } from "../src/crypto";
import type { SocialAccount } from "../src/store";

function permissiveGuardian(): GuardianLike {
  return { grant: () => {}, check: () => ({ decision: "allow", reason: "test" }) };
}

const TOKEN_KEY = "aa".repeat(32); // 32 bytes hex, valid AES-256 key

function fakeFetcher() {
  return async (url: string) => {
    if (url.includes("/oauth/access_token") && url.includes("grant_type=fb_exchange_token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "LONG_LIVED_USER_TOKEN", expires_in: 5184000 }) };
    }
    if (url.includes("/oauth/access_token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "SHORT_LIVED_TOKEN" }) };
    }
    if (url.includes("/me/accounts")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "page1", name: "Aria Vance", access_token: "PAGE1_TOKEN", instagram_business_account: { id: "ig111" } },
            { id: "page2", name: "No Instagram Page", access_token: "PAGE2_TOKEN" },
          ],
        }),
      };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
}

describe("social plugin — completeConnection", () => {
  let dataDir: string;
  let accountsFile: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "atlas-social-test-"));
    accountsFile = join(dataDir, "social-accounts.json");
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("exchanges the code, fetches Pages, and saves one instagram + one facebook account per Page with an Instagram link", async () => {
    const atlas = new Atlas({
      guardian: permissiveGuardian(),
      config: new ConfigVault({ META_APP_ID: "app-1", META_APP_SECRET: "secret-1", SOCIAL_TOKEN_KEY: TOKEN_KEY, SOCIAL_LOGIN_CONFIG_ID: "cfg-1" }),
    });
    await atlas.use(createSocialPlugin({ redirectUri: "https://x/cb", accountsFile, fetcher: fakeFetcher() }));

    const result = (await atlas.invoke("social", { op: "completeConnection", code: "real-code-123" })) as {
      connected: Array<{ platform: string; personaLabel: string }>;
    };

    expect(result.connected).toHaveLength(3); // page1 gets both facebook + instagram (2); page2 gets facebook only (1)
    expect(result.connected.filter((c) => c.platform === "instagram")).toHaveLength(1);
    expect(result.connected.filter((c) => c.platform === "facebook")).toHaveLength(2);

    const saved = JSON.parse(await readFile(accountsFile, "utf8")) as SocialAccount[];
    expect(saved).toHaveLength(3);
    const igAccount = saved.find((a) => a.platform === "instagram")!;
    expect(igAccount.igBusinessAccountId).toBe("ig111");
    expect(igAccount.pageId).toBe("page1");
    expect(decryptToken(igAccount.accessTokenEnc, TOKEN_KEY)).toBe("PAGE1_TOKEN");
  });

  it("throws a clear error when SOCIAL_TOKEN_KEY isn't configured", async () => {
    const atlas = new Atlas({
      guardian: permissiveGuardian(),
      config: new ConfigVault({ META_APP_ID: "app-1", META_APP_SECRET: "secret-1" }),
    });
    await atlas.use(createSocialPlugin({ redirectUri: "https://x/cb", accountsFile, fetcher: fakeFetcher() }));

    await expect(atlas.invoke("social", { op: "completeConnection", code: "c" })).rejects.toThrow(/SOCIAL_TOKEN_KEY/);
  });

  it("throws with the real Meta error text when the code exchange fails (e.g. an expired/reused code)", async () => {
    const atlas = new Atlas({
      guardian: permissiveGuardian(),
      config: new ConfigVault({ META_APP_ID: "app-1", META_APP_SECRET: "secret-1", SOCIAL_TOKEN_KEY: TOKEN_KEY }),
    });
    const failingFetcher = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "This authorization code has been used." } }) });
    await atlas.use(createSocialPlugin({ redirectUri: "https://x/cb", accountsFile, fetcher: failingFetcher }));

    await expect(atlas.invoke("social", { op: "completeConnection", code: "stale" })).rejects.toThrow(/has been used/);
  });
});
