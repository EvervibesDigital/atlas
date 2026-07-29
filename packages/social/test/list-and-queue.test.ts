import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, ConfigVault, type GuardianLike } from "@atlas/core";
import { createSocialPlugin } from "../src/plugin";
import type { SocialAccount } from "../src/store";
import type { SocialPost } from "../src/post-queue";

function permissiveGuardian(): GuardianLike {
  return { grant: () => {}, check: () => ({ decision: "allow", reason: "test" }) };
}

describe("social plugin — listAccounts / queuePosts", () => {
  let dataDir: string;
  let accountsFile: string;
  let postsFile: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "atlas-social-list-test-"));
    accountsFile = join(dataDir, "social-accounts.json");
    postsFile = join(dataDir, "social-posts.json");
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("listAccounts returns saved accounts without the encrypted token", async () => {
    const account: SocialAccount = {
      id: "acc1",
      platform: "instagram",
      personaLabel: "Aria Vance",
      pageId: "page1",
      igBusinessAccountId: "ig1",
      accessTokenEnc: { iv: "i", ct: "c", tag: "t" },
      tokenObtainedAt: "2026-01-01T00:00:00.000Z",
      connectedAt: "2026-01-01T00:00:00.000Z",
      status: "connected",
    };
    await writeFile(accountsFile, JSON.stringify([account]), "utf8");

    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({}) });
    await atlas.use(createSocialPlugin({ redirectUri: "https://x/cb", accountsFile, postsFile }));

    const result = (await atlas.invoke("social", { op: "listAccounts" })) as { accounts: Array<{ id: string; personaLabel: string; platform: string }> };
    expect(result.accounts).toEqual([{ id: "acc1", personaLabel: "Aria Vance", platform: "instagram" }]);
  });

  it("queuePosts stages the given items as staggered SocialPosts against the matching account", async () => {
    const account: SocialAccount = {
      id: "acc1",
      platform: "instagram",
      personaLabel: "Aria Vance",
      pageId: "page1",
      igBusinessAccountId: "ig1",
      accessTokenEnc: { iv: "i", ct: "c", tag: "t" },
      tokenObtainedAt: "2026-01-01T00:00:00.000Z",
      connectedAt: "2026-01-01T00:00:00.000Z",
      status: "connected",
    };
    await writeFile(accountsFile, JSON.stringify([account]), "utf8");

    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({}) });
    await atlas.use(createSocialPlugin({ redirectUri: "https://x/cb", accountsFile, postsFile }));

    const result = (await atlas.invoke("social", {
      op: "queuePosts",
      accountId: "acc1",
      items: [{ contentItemId: "c1", caption: "hello", mediaUrl: "https://x/1.jpg" }],
    })) as { queued: number };

    expect(result.queued).toBe(1);
    const saved = JSON.parse(await readFile(postsFile, "utf8")) as SocialPost[];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ accountId: "acc1", contentItemId: "c1", status: "approved" });
  });

  it("throws a clear error when queuePosts is given an unknown accountId", async () => {
    await writeFile(accountsFile, JSON.stringify([]), "utf8");
    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({}) });
    await atlas.use(createSocialPlugin({ redirectUri: "https://x/cb", accountsFile, postsFile }));

    await expect(atlas.invoke("social", { op: "queuePosts", accountId: "missing", items: [] })).rejects.toThrow(/missing/);
  });
});
