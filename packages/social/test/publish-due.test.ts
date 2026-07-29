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

const TOKEN_KEY = "bb".repeat(32);

describe("social plugin — publishDuePosts", () => {
  let dataDir: string, accountsFile: string, postsFile: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "atlas-social-publish-test-"));
    accountsFile = join(dataDir, "social-accounts.json");
    postsFile = join(dataDir, "social-posts.json");
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("publishes every due post via the Graph API and marks it published with the live post id", async () => {
    const { encryptToken } = await import("../src/crypto");
    const account: SocialAccount = {
      id: "acc1", platform: "instagram", personaLabel: "Aria Vance", pageId: "page1", igBusinessAccountId: "ig1",
      accessTokenEnc: encryptToken("PAGE_TOKEN", TOKEN_KEY), tokenObtainedAt: "t", connectedAt: "t", status: "connected",
    };
    await writeFile(accountsFile, JSON.stringify([account]), "utf8");
    const duePost: SocialPost = {
      id: "post1", contentItemId: "c1", accountId: "acc1", mediaType: "image", caption: "hi",
      mediaUrl: "https://x/1.jpg", status: "approved", scheduledFor: new Date(Date.now() - 60_000).toISOString(), createdAt: "t",
    };
    await writeFile(postsFile, JSON.stringify([duePost]), "utf8");

    const fetcher = async () => ({ ok: true, status: 200, json: async () => ({ id: "container1" }) }); // both container+publish calls return an id, sufficient for this test
    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({ SOCIAL_TOKEN_KEY: TOKEN_KEY }) });
    await atlas.use(createSocialPlugin({ redirectUri: "https://x/cb", accountsFile, postsFile, fetcher }));

    const result = (await atlas.invoke("social", { op: "publishDuePosts" })) as { published: number; failed: number };
    expect(result.published).toBe(1);
    expect(result.failed).toBe(0);

    const saved = JSON.parse(await readFile(postsFile, "utf8")) as SocialPost[];
    expect(saved[0]!.status).toBe("published");
    expect(saved[0]!.livePostId).toBeTruthy();
  });

  it("marks a post failed with the real error text rather than throwing and losing the other due posts", async () => {
    const { encryptToken } = await import("../src/crypto");
    const account: SocialAccount = {
      id: "acc1", platform: "facebook", personaLabel: "Aria Vance", pageId: "page1",
      accessTokenEnc: encryptToken("PAGE_TOKEN", TOKEN_KEY), tokenObtainedAt: "t", connectedAt: "t", status: "connected",
    };
    await writeFile(accountsFile, JSON.stringify([account]), "utf8");
    const duePost: SocialPost = {
      id: "post1", contentItemId: "c1", accountId: "acc1", mediaType: "image", caption: "hi",
      mediaUrl: "https://x/1.jpg", status: "approved", scheduledFor: new Date(Date.now() - 60_000).toISOString(), createdAt: "t",
    };
    await writeFile(postsFile, JSON.stringify([duePost]), "utf8");

    const fetcher = async () => ({ ok: false, status: 403, json: async () => ({ error: { message: "Page token has expired" } }) });
    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({ SOCIAL_TOKEN_KEY: TOKEN_KEY }) });
    await atlas.use(createSocialPlugin({ redirectUri: "https://x/cb", accountsFile, postsFile, fetcher }));

    const result = (await atlas.invoke("social", { op: "publishDuePosts" })) as { published: number; failed: number };
    expect(result.failed).toBe(1);
    const saved = JSON.parse(await readFile(postsFile, "utf8")) as SocialPost[];
    expect(saved[0]!.status).toBe("failed");
    expect(saved[0]!.error).toContain("expired");
  });
});
