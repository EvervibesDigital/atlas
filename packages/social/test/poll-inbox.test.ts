import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, ConfigVault, type GuardianLike } from "@atlas/core";
import { createSocialPlugin } from "../src/plugin";
import type { SocialAccount } from "../src/store";
import type { SocialPost } from "../src/post-queue";
import type { InboxItem } from "../src/inbox-store";

function permissiveGuardian(): GuardianLike {
  return { grant: () => {}, check: () => ({ decision: "allow", reason: "test" }) };
}

const TOKEN_KEY = "cc".repeat(32);

describe("social plugin — pollInbox", () => {
  let dataDir: string, accountsFile: string, postsFile: string, inboxFile: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "atlas-social-inbox-test-"));
    accountsFile = join(dataDir, "social-accounts.json");
    postsFile = join(dataDir, "social-posts.json");
    inboxFile = join(dataDir, "social-inbox.json");
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("drafts a reply for a new comment, auto-sends it (high confidence), and records it", async () => {
    const { encryptToken } = await import("../src/crypto");
    const account: SocialAccount = {
      id: "acc1", platform: "instagram", personaLabel: "Aria Vance", pageId: "page1", igBusinessAccountId: "ig1",
      accessTokenEnc: encryptToken("PAGE_TOKEN", TOKEN_KEY), tokenObtainedAt: "t", connectedAt: "t", status: "connected",
    };
    await writeFile(accountsFile, JSON.stringify([account]), "utf8");
    const publishedPost: SocialPost = {
      id: "post1", contentItemId: "c1", accountId: "acc1", mediaType: "image", caption: "hi",
      mediaUrl: "https://x/1.jpg", status: "published", scheduledFor: "t", livePostId: "ig_media_99", createdAt: "t",
    };
    await writeFile(postsFile, JSON.stringify([publishedPost]), "utf8");

    const fetcher = async (url: string) => {
      if (url.includes("/ig_media_99/comments")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "comment1", text: "love this!!", timestamp: "2026-01-01T00:00:00+0000" }] }) };
      if (url.includes("/replies")) return { ok: true, status: 200, json: async () => ({ id: "reply1" }) };
      if (url.includes("/conversations")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      throw new Error("unexpected fetch: " + url);
    };
    const brain = async () => ({ text: "Thank you so much! 🙌" });

    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({ SOCIAL_TOKEN_KEY: TOKEN_KEY }) });
    await atlas.use(createSocialPlugin({ redirectUri: "https://x/cb", accountsFile, postsFile, inboxFile, fetcher, brain }));

    const result = (await atlas.invoke("social", { op: "pollInbox" })) as { newItems: number; autoReplied: number; pendingApproval: number };
    expect(result.newItems).toBe(1);
    expect(result.autoReplied).toBe(1);
    expect(result.pendingApproval).toBe(0);

    const saved = JSON.parse(await readFile(inboxFile, "utf8")) as InboxItem[];
    expect(saved[0]).toMatchObject({ externalId: "comment1", status: "auto_replied", text: "love this!!" });
  });

  it("queues a low-confidence comment for approval instead of auto-sending", async () => {
    const { encryptToken } = await import("../src/crypto");
    const account: SocialAccount = {
      id: "acc1", platform: "instagram", personaLabel: "Aria Vance", pageId: "page1", igBusinessAccountId: "ig1",
      accessTokenEnc: encryptToken("PAGE_TOKEN", TOKEN_KEY), tokenObtainedAt: "t", connectedAt: "t", status: "connected",
    };
    await writeFile(accountsFile, JSON.stringify([account]), "utf8");
    const publishedPost: SocialPost = {
      id: "post1", contentItemId: "c1", accountId: "acc1", mediaType: "image", caption: "hi",
      mediaUrl: "https://x/1.jpg", status: "published", scheduledFor: "t", livePostId: "ig_media_99", createdAt: "t",
    };
    await writeFile(postsFile, JSON.stringify([publishedPost]), "utf8");

    let replyPosted = false;
    const fetcher = async (url: string) => {
      if (url.includes("/ig_media_99/comments")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "comment2", text: "why is this broken and terrible?", timestamp: "t" }] }) };
      if (url.includes("/replies")) { replyPosted = true; return { ok: true, status: 200, json: async () => ({ id: "reply1" }) }; }
      if (url.includes("/conversations")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      throw new Error("unexpected fetch: " + url);
    };
    const brain = async () => ({ text: "Sorry to hear that, can you tell us more?" });

    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({ SOCIAL_TOKEN_KEY: TOKEN_KEY }) });
    await atlas.use(createSocialPlugin({ redirectUri: "https://x/cb", accountsFile, postsFile, inboxFile, fetcher, brain }));

    const result = (await atlas.invoke("social", { op: "pollInbox" })) as { newItems: number; autoReplied: number; pendingApproval: number };
    expect(result.pendingApproval).toBe(1);
    expect(result.autoReplied).toBe(0);
    expect(replyPosted).toBe(false);
  });

  it("does not re-process a comment already seen on a previous poll", async () => {
    const { encryptToken } = await import("../src/crypto");
    const account: SocialAccount = {
      id: "acc1", platform: "instagram", personaLabel: "Aria Vance", pageId: "page1", igBusinessAccountId: "ig1",
      accessTokenEnc: encryptToken("PAGE_TOKEN", TOKEN_KEY), tokenObtainedAt: "t", connectedAt: "t", status: "connected",
    };
    await writeFile(accountsFile, JSON.stringify([account]), "utf8");
    await writeFile(postsFile, JSON.stringify([{ id: "post1", contentItemId: "c1", accountId: "acc1", mediaType: "image", caption: "hi", mediaUrl: "https://x/1.jpg", status: "published", scheduledFor: "t", livePostId: "ig_media_99", createdAt: "t" }]), "utf8");

    const fetcher = async (url: string) => {
      if (url.includes("/comments")) return { ok: true, status: 200, json: async () => ({ data: [{ id: "comment1", text: "hi!", timestamp: "t" }] }) };
      if (url.includes("/replies")) return { ok: true, status: 200, json: async () => ({ id: "reply1" }) };
      if (url.includes("/conversations")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      throw new Error("unexpected fetch: " + url);
    };
    const brain = async () => ({ text: "Thanks!" });
    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({ SOCIAL_TOKEN_KEY: TOKEN_KEY }) });
    await atlas.use(createSocialPlugin({ redirectUri: "https://x/cb", accountsFile, postsFile, inboxFile, fetcher, brain }));

    await atlas.invoke("social", { op: "pollInbox" });
    const second = (await atlas.invoke("social", { op: "pollInbox" })) as { newItems: number };
    expect(second.newItems).toBe(0);
  });
});
