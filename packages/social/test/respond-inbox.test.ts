import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, ConfigVault, type GuardianLike } from "@atlas/core";
import { createSocialPlugin } from "../src/plugin";
import type { SocialAccount } from "../src/store";
import type { InboxItem } from "../src/inbox-store";

function permissiveGuardian(): GuardianLike {
  return { grant: () => {}, check: () => ({ decision: "allow", reason: "test" }) };
}

const TOKEN_KEY = "dd".repeat(32);

describe("social plugin — listPendingInboxItems / respondToInboxItem", () => {
  let dataDir: string, accountsFile: string, postsFile: string, inboxFile: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "atlas-social-respond-test-"));
    accountsFile = join(dataDir, "social-accounts.json");
    postsFile = join(dataDir, "social-posts.json");
    inboxFile = join(dataDir, "social-inbox.json");
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("listPendingInboxItems returns only pending_approval items", async () => {
    const items: InboxItem[] = [
      { id: "i1", accountId: "acc1", kind: "comment", externalId: "c1", fromUsername: "u1", text: "hi", draftReply: "hey", confidence: 40, status: "pending_approval", createdAt: "t" },
      { id: "i2", accountId: "acc1", kind: "comment", externalId: "c2", fromUsername: "u2", text: "hi2", draftReply: "hey2", confidence: 95, status: "auto_replied", createdAt: "t" },
    ];
    await writeFile(inboxFile, JSON.stringify(items), "utf8");
    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({}) });
    await atlas.use(createSocialPlugin({ redirectUri: "https://x/cb", accountsFile, postsFile, inboxFile }));

    const result = (await atlas.invoke("social", { op: "listPendingInboxItems" })) as { items: InboxItem[] };
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe("i1");
  });

  it("respondToInboxItem approve sends the reply and marks it approved", async () => {
    const { encryptToken } = await import("../src/crypto");
    const account: SocialAccount = {
      id: "acc1", platform: "instagram", personaLabel: "Aria Vance", pageId: "page1", igBusinessAccountId: "ig1",
      accessTokenEnc: encryptToken("PAGE_TOKEN", TOKEN_KEY), tokenObtainedAt: "t", connectedAt: "t", status: "connected",
    };
    await writeFile(accountsFile, JSON.stringify([account]), "utf8");
    const items: InboxItem[] = [{ id: "i1", accountId: "acc1", kind: "comment", externalId: "c1", fromUsername: "u1", text: "hi", draftReply: "hey there!", confidence: 40, status: "pending_approval", createdAt: "t" }];
    await writeFile(inboxFile, JSON.stringify(items), "utf8");

    let replySent = false;
    const fetcher = async (url: string) => {
      if (url.includes("/c1/replies")) { replySent = true; return { ok: true, status: 200, json: async () => ({ id: "reply1" }) }; }
      throw new Error("unexpected fetch: " + url);
    };
    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({ SOCIAL_TOKEN_KEY: TOKEN_KEY }) });
    await atlas.use(createSocialPlugin({ redirectUri: "https://x/cb", accountsFile, postsFile, inboxFile, fetcher }));

    const result = (await atlas.invoke("social", { op: "respondToInboxItem", id: "i1", action: "approve" })) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(replySent).toBe(true);

    const saved = JSON.parse(await readFile(inboxFile, "utf8")) as InboxItem[];
    expect(saved[0]!.status).toBe("approved");
  });

  it("respondToInboxItem reject marks it rejected without sending anything", async () => {
    const items: InboxItem[] = [{ id: "i1", accountId: "acc1", kind: "comment", externalId: "c1", fromUsername: "u1", text: "hi", draftReply: "hey there!", confidence: 40, status: "pending_approval", createdAt: "t" }];
    await writeFile(inboxFile, JSON.stringify(items), "utf8");
    const fetcher = async () => { throw new Error("should never fetch on reject"); };
    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({}) });
    await atlas.use(createSocialPlugin({ redirectUri: "https://x/cb", accountsFile, postsFile, inboxFile, fetcher }));

    const result = (await atlas.invoke("social", { op: "respondToInboxItem", id: "i1", action: "reject" })) as { ok: boolean };
    expect(result.ok).toBe(true);
    const saved = JSON.parse(await readFile(inboxFile, "utf8")) as InboxItem[];
    expect(saved[0]!.status).toBe("rejected");
  });
});
