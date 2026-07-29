# Comment/DM Auto-Reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read new comments/DMs on connected accounts, draft a reply for each, auto-send confident ones, queue the rest as individual ("ask"-tier) Brief approvals.

**Architecture:** Extends `@atlas/social`. Polling happens once per hourly cycle (orchestrator step, matching kdp/mediaFactory's own pattern — not a separate fast interval, since comments/DMs don't need 2-minute responsiveness the way a scheduled post does). Comments are polled per published Instagram post (`SocialPost.livePostId` IS the IG media id the `media_publish` call returns — confirmed, no separate lookup needed). DMs are polled per connected Page. Every new item gets a drafted reply + confidence score; ≥90 auto-sends, below that becomes an individual Brief item.

**Tech Stack:** TypeScript, vitest, extends `@atlas/social` (Plans 2-3) and `@atlas/brief`.

**Plan 4 of 4** for the AI Influencer Social Platform. Final plan in the spec: `docs/superpowers/specs/2026-07-27-social-media-platform-design.md`.

**Honest scope note:** Same posture as every other Meta API call this project — verified against Meta's current live documentation (comments: `GET /{ig-media-id}/comments`, reply via `POST /{comment-id}/replies`; DMs: `GET /{page-id}/conversations?platform=INSTAGRAM`, send via `POST /{page-id}/messages`), but the conversations endpoint's exact nested message-field shape needs field expansion I haven't run against a live response yet. Flagged in Task 1 for a live check the first time it actually polls a real account with real messages.

---

### Task 1: Inbox Graph API client

**Files:**
- Create: `packages/social/src/inbox-graph.ts`
- Test: `packages/social/test/inbox-graph.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/social/test/inbox-graph.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { fetchComments, replyToComment, fetchConversationMessages, sendDirectMessage } from "../src/inbox-graph";

describe("fetchComments", () => {
  it("returns each comment's id, text, and timestamp", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ data: [{ id: "c1", text: "love this!", timestamp: "2026-01-01T00:00:00+0000" }] }),
    });
    const comments = await fetchComments("ig_media_1", "PAGE_TOKEN", fetcher);
    expect(comments).toEqual([{ id: "c1", text: "love this!", timestamp: "2026-01-01T00:00:00+0000" }]);
    expect(fetcher.mock.calls[0]![0] as string).toContain("/ig_media_1/comments");
  });

  it("throws with the real error text on failure", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: "Unsupported request" } }) });
    await expect(fetchComments("bad", "t", fetcher)).rejects.toThrow(/Unsupported request/);
  });
});

describe("replyToComment", () => {
  it("posts to the comment's /replies edge", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "reply1" }) });
    const result = await replyToComment("c1", "thank you!", "PAGE_TOKEN", fetcher);
    expect(result).toEqual({ replyId: "reply1" });
    expect(fetcher.mock.calls[0]![0] as string).toContain("/c1/replies");
  });
});

describe("fetchConversationMessages", () => {
  it("returns each conversation's latest message with sender id and text", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        data: [
          { id: "conv1", messages: { data: [{ id: "m1", message: "hi there", from: { id: "igsid1" }, created_time: "2026-01-01T00:00:00+0000" }] } },
        ],
      }),
    });
    const messages = await fetchConversationMessages("page1", "PAGE_TOKEN", fetcher);
    expect(messages).toEqual([{ id: "m1", text: "hi there", fromId: "igsid1", timestamp: "2026-01-01T00:00:00+0000" }]);
    expect(fetcher.mock.calls[0]![0] as string).toContain("/page1/conversations");
    expect(fetcher.mock.calls[0]![0] as string).toContain("platform=INSTAGRAM");
  });
});

describe("sendDirectMessage", () => {
  it("posts to /messages with the recipient igsid and text", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ recipient_id: "igsid1", message_id: "msg1" }) });
    const result = await sendDirectMessage("page1", "igsid1", "hello!", "PAGE_TOKEN", fetcher);
    expect(result).toEqual({ messageId: "msg1" });
    expect(fetcher.mock.calls[0]![0] as string).toContain("/page1/messages");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/social/test/inbox-graph.test.ts`
Expected: FAIL — module `../src/inbox-graph` doesn't exist.

- [ ] **Step 3: Implement**

Create `packages/social/src/inbox-graph.ts`:

```typescript
import type { FetchLike } from "./token-exchange";

export interface Comment {
  id: string;
  text: string;
  timestamp: string;
}

/** Verified against Meta's current docs: GET /{ig-media-id}/comments. */
export async function fetchComments(igMediaId: string, pageAccessToken: string, fetcher: FetchLike): Promise<Comment[]> {
  const params = new URLSearchParams({ access_token: pageAccessToken });
  const res = await fetcher(`https://graph.facebook.com/v25.0/${igMediaId}/comments?${params.toString()}`);
  const data = (await res.json()) as { data?: Comment[]; error?: { message?: string } };
  if (!res.ok) throw new Error(`fetching comments failed: HTTP ${res.status} ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
  return data.data ?? [];
}

/** Reply to a specific comment (not a new top-level comment) via its /replies edge. */
export async function replyToComment(commentId: string, message: string, pageAccessToken: string, fetcher: FetchLike): Promise<{ replyId: string }> {
  const params = new URLSearchParams({ message, access_token: pageAccessToken });
  const res = await fetcher(`https://graph.facebook.com/v25.0/${commentId}/replies?${params.toString()}`, { method: "POST" });
  const data = (await res.json()) as { id?: string; error?: { message?: string } };
  if (!res.ok) throw new Error(`replying to comment failed: HTTP ${res.status} ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
  if (!data.id) throw new Error(`reply returned no id: ${JSON.stringify(data).slice(0, 200)}`);
  return { replyId: data.id };
}

export interface InboxMessage {
  id: string;
  text: string;
  fromId: string;
  timestamp: string;
}

/**
 * Flattens each conversation's latest message. Field-expansion shape
 * (`messages{...}`) matches Meta's documented pattern for the conversations
 * edge — not yet run against a real account with real messages; watch this
 * specific call the first time it polls something real.
 */
export async function fetchConversationMessages(pageId: string, pageAccessToken: string, fetcher: FetchLike): Promise<InboxMessage[]> {
  const params = new URLSearchParams({ platform: "INSTAGRAM", fields: "messages{message,from,created_time}", access_token: pageAccessToken });
  const res = await fetcher(`https://graph.facebook.com/v25.0/${pageId}/conversations?${params.toString()}`);
  const data = (await res.json()) as {
    data?: Array<{ id: string; messages?: { data?: Array<{ id: string; message: string; from: { id: string }; created_time: string }> } }>;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`fetching conversations failed: HTTP ${res.status} ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
  const messages: InboxMessage[] = [];
  for (const conv of data.data ?? []) {
    const latest = conv.messages?.data?.[0];
    if (latest) messages.push({ id: latest.id, text: latest.message, fromId: latest.from.id, timestamp: latest.created_time });
  }
  return messages;
}

export async function sendDirectMessage(pageId: string, recipientIgsid: string, text: string, pageAccessToken: string, fetcher: FetchLike): Promise<{ messageId: string }> {
  const params = new URLSearchParams({ access_token: pageAccessToken });
  const res = await fetcher(`https://graph.facebook.com/v25.0/${pageId}/messages?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: recipientIgsid }, message: { text } }),
  });
  const data = (await res.json()) as { message_id?: string; error?: { message?: string } };
  if (!res.ok) throw new Error(`sending DM failed: HTTP ${res.status} ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
  if (!data.message_id) throw new Error(`DM send returned no message_id: ${JSON.stringify(data).slice(0, 200)}`);
  return { messageId: data.message_id };
}
```

- [ ] **Step 4: Confirm it passes**

Run: `npx vitest run packages/social/test/inbox-graph.test.ts`
Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/social/src/inbox-graph.ts packages/social/test/inbox-graph.test.ts
git commit -m "Add comment/DM Graph API client (fetch + reply)"
```

---

### Task 2: Confidence scoring (pure)

**Files:**
- Create: `packages/social/src/confidence.ts`
- Test: `packages/social/test/confidence.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/social/test/confidence.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { scoreConfidence } from "../src/confidence";

describe("scoreConfidence", () => {
  it("scores a short, clearly positive message high", () => {
    expect(scoreConfidence("love this!!")).toBeGreaterThanOrEqual(90);
    expect(scoreConfidence("so good, thank you")).toBeGreaterThanOrEqual(90);
  });

  it("scores a question low, regardless of tone", () => {
    expect(scoreConfidence("how much does this cost?")).toBeLessThan(90);
    expect(scoreConfidence("is this real??")).toBeLessThan(90);
  });

  it("scores a long message low", () => {
    const long = "This is a much longer message that goes into detail about a complaint or a complex question that really needs a human to actually read and think about before replying to it properly.";
    expect(scoreConfidence(long)).toBeLessThan(90);
  });

  it("scores a message with negative-sentiment words low", () => {
    expect(scoreConfidence("this is terrible and broken")).toBeLessThan(90);
    expect(scoreConfidence("worst purchase ever, refund now")).toBeLessThan(90);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/social/test/confidence.test.ts`
Expected: FAIL — module `../src/confidence` doesn't exist.

- [ ] **Step 3: Implement**

Create `packages/social/src/confidence.ts`:

```typescript
const NEGATIVE_WORDS = ["terrible", "worst", "broken", "refund", "scam", "hate", "awful", "bad", "angry", "disappointed"];

/**
 * Starting heuristic (0-100), not a trained model — refine once real data
 * exists. High-confidence = safe to auto-send: short, no question, no
 * negative-sentiment words. Anything else defers to a human — a wrong
 * auto-reply from a fake persona is a worse outcome than a slower one.
 */
export function scoreConfidence(text: string): number {
  let score = 95;
  if (text.includes("?")) score -= 40;
  if (text.length > 80) score -= 30;
  const lower = text.toLowerCase();
  if (NEGATIVE_WORDS.some((w) => lower.includes(w))) score -= 50;
  return Math.max(0, Math.min(100, score));
}
```

- [ ] **Step 4: Confirm it passes**

Run: `npx vitest run packages/social/test/confidence.test.ts`
Expected: 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/social/src/confidence.ts packages/social/test/confidence.test.ts
git commit -m "Add starting confidence heuristic for auto-reply decisions"
```

---

### Task 3: InboxItem store (pure)

**Files:**
- Create: `packages/social/src/inbox-store.ts`
- Test: `packages/social/test/inbox-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/social/test/inbox-store.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { newItems, markAutoReplied, markPendingApproval, type InboxItem } from "../src/inbox-store";

function item(externalId: string): Omit<InboxItem, "id" | "createdAt" | "status"> {
  return { accountId: "a1", kind: "comment", externalId, fromUsername: "user1", text: "hi", draftReply: "thanks!", confidence: 95 };
}

describe("newItems", () => {
  it("excludes anything whose externalId already exists in the store", () => {
    const existing: InboxItem[] = [{ ...item("c1"), id: "i1", status: "auto_replied", createdAt: "t" } as InboxItem];
    const candidates = [item("c1"), item("c2")];
    const fresh = newItems(candidates, existing);
    expect(fresh.map((i) => i.externalId)).toEqual(["c2"]);
  });
});

describe("markAutoReplied / markPendingApproval", () => {
  it("adds a new item with status auto_replied", () => {
    const result = markAutoReplied([], item("c1"));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ externalId: "c1", status: "auto_replied" });
    expect(result[0]!.id).toBeTruthy();
  });

  it("adds a new item with status pending_approval", () => {
    const result = markPendingApproval([], item("c1"));
    expect(result[0]).toMatchObject({ externalId: "c1", status: "pending_approval" });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/social/test/inbox-store.test.ts`
Expected: FAIL — module `../src/inbox-store` doesn't exist.

- [ ] **Step 3: Implement**

Create `packages/social/src/inbox-store.ts`:

```typescript
import { randomUUID } from "node:crypto";

export interface InboxItem {
  id: string;
  accountId: string;
  kind: "comment" | "dm";
  externalId: string;
  fromUsername: string;
  text: string;
  draftReply: string;
  confidence: number;
  status: "auto_replied" | "pending_approval" | "approved" | "rejected";
  createdAt: string;
}

export type NewInboxItem = Omit<InboxItem, "id" | "status" | "createdAt">;

/** Candidates not already represented in the store, by externalId (Meta's
 * comment/message id — stable, dedupes across repeated polls). */
export function newItems(candidates: NewInboxItem[], existing: InboxItem[]): NewInboxItem[] {
  const seen = new Set(existing.map((i) => i.externalId));
  return candidates.filter((c) => !seen.has(c.externalId));
}

export function markAutoReplied(items: InboxItem[], newItem: NewInboxItem): InboxItem[] {
  return [...items, { ...newItem, id: randomUUID(), status: "auto_replied" as const, createdAt: new Date().toISOString() }];
}

export function markPendingApproval(items: InboxItem[], newItem: NewInboxItem): InboxItem[] {
  return [...items, { ...newItem, id: randomUUID(), status: "pending_approval" as const, createdAt: new Date().toISOString() }];
}
```

- [ ] **Step 4: Confirm it passes**

Run: `npx vitest run packages/social/test/inbox-store.test.ts`
Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/social/src/inbox-store.ts packages/social/test/inbox-store.test.ts
git commit -m "Add InboxItem store with externalId-based dedupe"
```

---

### Task 4: `pollInbox` op on the social plugin

**Files:**
- Modify: `packages/social/src/plugin.ts`
- Test: `packages/social/test/poll-inbox.test.ts`

This is the largest task — it wires Tasks 1-3 together with the Brain (for drafting replies) and the post/account stores.

- [ ] **Step 1: Write the failing test**

Create `packages/social/test/poll-inbox.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/social/test/poll-inbox.test.ts`
Expected: FAIL — `inboxFile`/`brain` options and `pollInbox` op don't exist yet.

- [ ] **Step 3: Implement**

In `packages/social/src/plugin.ts`, update imports and options:

```typescript
import { fetchComments, replyToComment, fetchConversationMessages, sendDirectMessage } from "./inbox-graph";
import { scoreConfidence } from "./confidence";
import { newItems, markAutoReplied, markPendingApproval, type InboxItem, type NewInboxItem } from "./inbox-store";
```

```typescript
export interface BrainLike {
  (payload: { prompt: string; system?: string }): Promise<{ text: string }>;
}

export function createSocialPlugin(opts: {
  redirectUri: string;
  accountsFile?: string;
  postsFile?: string;
  inboxFile?: string;
  fetcher?: FetchLike;
  brain?: BrainLike;
}): Plugin {
  const accountsFile = opts.accountsFile ?? "data/social-accounts.json";
  const postsFile = opts.postsFile ?? "data/social-posts.json";
  const inboxFile = opts.inboxFile ?? "data/social-inbox.json";
  const fetcher: FetchLike = opts.fetcher ?? (fetch as unknown as FetchLike);
```

Add `"pollInbox"` to `SocialCommand`:

```typescript
  | { op: "pollInbox" };
```

Add the branch inside `ctx.provide("social", ...)`, after `publishDuePosts`:

```typescript
        if (cmd.op === "pollInbox") {
          const tokenKey = await ctx.secret("SOCIAL_TOKEN_KEY");
          if (!tokenKey) throw new Error("social: SOCIAL_TOKEN_KEY not set");
          const brain: BrainLike = opts.brain ?? (async (p) => (await ctx.call("brain", p)) as { text: string });

          const accounts = await loadAccounts(accountsFile);
          const rawPosts = await readFile(postsFile, "utf8").catch(() => "[]");
          const posts = JSON.parse(rawPosts) as SocialPost[];
          const rawInbox = await readFile(inboxFile, "utf8").catch(() => "[]");
          let inbox = JSON.parse(rawInbox) as InboxItem[];

          const candidates: Array<NewInboxItem & { pageAccessToken: string; pageId: string; replyTarget: string; via: "comment" | "dm" }> = [];

          for (const account of accounts) {
            const pageAccessToken = decryptToken(account.accessTokenEnc, tokenKey);

            if (account.platform === "instagram") {
              const publishedOnThisAccount = posts.filter((p) => p.accountId === account.id && p.status === "published" && p.livePostId);
              for (const post of publishedOnThisAccount) {
                const comments = await fetchComments(post.livePostId!, pageAccessToken, fetcher).catch(() => []);
                for (const c of comments) {
                  candidates.push({ accountId: account.id, kind: "comment", externalId: c.id, fromUsername: "", text: c.text, draftReply: "", confidence: 0, pageAccessToken, pageId: account.pageId, replyTarget: c.id, via: "comment" });
                }
              }
            }

            const messages = await fetchConversationMessages(account.pageId, pageAccessToken, fetcher).catch(() => []);
            for (const m of messages) {
              candidates.push({ accountId: account.id, kind: "dm", externalId: m.id, fromUsername: m.fromId, text: m.text, draftReply: "", confidence: 0, pageAccessToken, pageId: account.pageId, replyTarget: m.fromId, via: "dm" });
            }
          }

          const fresh = newItems(candidates, inbox);
          let autoReplied = 0;
          let pendingApproval = 0;

          for (const item of fresh) {
            const { text } = await brain({ prompt: `Someone left this ${item.kind === "comment" ? "comment" : "DM"} on a social post: "${item.text}"\n\nDraft a short, friendly reply in character.`, system: "You reply as a friendly social media persona. Keep it under 2 sentences." });
            const confidence = scoreConfidence(item.text);
            const full: NewInboxItem = { accountId: item.accountId, kind: item.kind, externalId: item.externalId, fromUsername: item.fromUsername, text: item.text, draftReply: text, confidence };

            if (confidence >= 90) {
              if (item.via === "comment") await replyToComment(item.replyTarget, text, item.pageAccessToken, fetcher);
              else await sendDirectMessage(item.pageId, item.replyTarget, text, item.pageAccessToken, fetcher);
              inbox = markAutoReplied(inbox, full);
              autoReplied++;
            } else {
              inbox = markPendingApproval(inbox, full);
              pendingApproval++;
            }
          }

          await writeFile(inboxFile, JSON.stringify(inbox), "utf8");
          return { newItems: fresh.length, autoReplied, pendingApproval };
        }
```

- [ ] **Step 4: Confirm it passes**

Run: `npx vitest run packages/social/test/poll-inbox.test.ts`
Expected: 3 tests passing.

- [ ] **Step 5: Typecheck and run every social test**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run packages/social`
Expected: clean typecheck, all social tests passing.

- [ ] **Step 6: Commit**

```bash
git add packages/social/src/plugin.ts packages/social/test/poll-inbox.test.ts
git commit -m "Add pollInbox op: draft replies, auto-send confident ones, queue the rest"
```

---

### Task 5: Brief integration for pending-approval inbox items

**Files:**
- Modify: `packages/social/src/plugin.ts` (new `listPendingInboxItems` + `respondToInboxItem` ops)
- Modify: `packages/brief/src/plugin.ts` (extend `fromSocial()`, extend `actOne()`'s `"social"` branch)
- Modify: `packages/brief/test/brief.test.ts`

- [ ] **Step 1: Add two more ops to the social plugin**

In `packages/social/src/plugin.ts`, add to `SocialCommand`:

```typescript
  | { op: "listPendingInboxItems" }
  | { op: "respondToInboxItem"; id: string; action: "approve" | "reject" };
```

Add branches after `pollInbox`:

```typescript
        if (cmd.op === "listPendingInboxItems") {
          const rawInbox = await readFile(inboxFile, "utf8").catch(() => "[]");
          const inbox = JSON.parse(rawInbox) as InboxItem[];
          return { items: inbox.filter((i) => i.status === "pending_approval") };
        }

        if (cmd.op === "respondToInboxItem") {
          const rawInbox = await readFile(inboxFile, "utf8").catch(() => "[]");
          let inbox = JSON.parse(rawInbox) as InboxItem[];
          const item = inbox.find((i) => i.id === cmd.id);
          if (!item) throw new Error(`social: inbox item "${cmd.id}" not found`);

          if (cmd.action === "approve") {
            const tokenKey = await ctx.secret("SOCIAL_TOKEN_KEY");
            if (!tokenKey) throw new Error("social: SOCIAL_TOKEN_KEY not set");
            const accounts = await loadAccounts(accountsFile);
            const account = accounts.find((a) => a.id === item.accountId);
            if (!account) throw new Error(`social: account for inbox item "${cmd.id}" not found`);
            const pageAccessToken = decryptToken(account.accessTokenEnc, tokenKey);
            if (item.kind === "comment") await replyToComment(item.externalId, item.draftReply, pageAccessToken, fetcher);
            else await sendDirectMessage(account.pageId, item.fromUsername, item.draftReply, pageAccessToken, fetcher);
          }

          inbox = inbox.map((i) => (i.id === cmd.id ? { ...i, status: cmd.action === "approve" ? ("approved" as const) : ("rejected" as const) } : i));
          await writeFile(inboxFile, JSON.stringify(inbox), "utf8");
          return { ok: true };
        }
```

- [ ] **Step 2: Write the failing Brief test**

Add to `packages/brief/test/brief.test.ts`, inside the existing `describe("social source", ...)` block:

```typescript
  it("surfaces a pending-approval inbox item as an individual ask-tier item", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
    await atlas.use(createBriefPlugin());
    await atlas.use({
      manifest: { name: "social", version: "1", capabilities: ["social"], permissions: [], role: "executor" },
      register(ctx) {
        ctx.provide("social", async (payload: unknown) => {
          const cmd = payload as { op: string };
          if (cmd.op === "listAccounts") return { accounts: [] };
          if (cmd.op === "listPendingInboxItems") {
            return { items: [{ id: "inbox1", accountId: "acc1", kind: "comment", externalId: "c1", fromUsername: "user1", text: "why is this broken?", draftReply: "Sorry to hear that!", confidence: 40, status: "pending_approval", createdAt: "2026-01-01T00:00:00.000Z" }] };
          }
          throw new Error("unexpected social op: " + cmd.op);
        });
      },
    });

    const brief = (await atlas.invoke("brief", { op: "today" })) as { items: Array<{ id: string; source: string; title: string; tier: string; detail?: string }> };
    const inboxItem = brief.items.find((i) => i.id === "inbox1");
    expect(inboxItem).toBeTruthy();
    expect(inboxItem!.tier).toBe("ask"); // individual, never batched
    expect(inboxItem!.detail).toContain("Sorry to hear that!");
  });
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run packages/brief/test/brief.test.ts -t "surfaces a pending-approval inbox item"`
Expected: FAIL — no matching item (fromSocial doesn't fetch pending inbox items yet).

- [ ] **Step 4: Implement**

In `packages/brief/src/plugin.ts`'s `fromSocial()`, add after the existing per-account "ready posts" loop, still inside the function, before `return items;`:

```typescript
        const { items: pendingInbox } = (await ctx.call("social", { op: "listPendingInboxItems" })) as {
          items: Array<{ id: string; text: string; draftReply: string; fromUsername: string; kind: string }>;
        };
        for (const inboxItem of pendingInbox) {
          items.push({
            id: inboxItem.id,
            source: "social" as const,
            title: `Reply needed: "${inboxItem.text.slice(0, 60)}"`,
            detail: `Drafted reply: "${inboxItem.draftReply}" — low confidence, review before sending.`,
            risk: 1 as const,
            // A specific reply to a specific person — same bar as a phone
            // call, never batched with the "approve all" button.
            tier: "ask" as const,
          });
        }
```

In `actOne()`'s `if (source === "social")` branch, the existing code handles the "ready posts" case by id-matching against `accounts`. Distinguish inbox-item ids from account ids by checking the id prefix pattern used above (inbox items use whatever id `respondToInboxItem` expects — same `id` as returned by `listPendingInboxItems`). Add a check before the existing account lookup:

```typescript
        if (source === "social") {
          const { items: pendingInbox } = (await ctx.call("social", { op: "listPendingInboxItems" })) as { items: Array<{ id: string }> };
          if (pendingInbox.some((i) => i.id === id)) {
            return ctx.call("social", { op: "respondToInboxItem", id, action });
          }
          if (action === "reject") return { skipped: id };
          // ... existing account-lookup code for queuing posts continues below, unchanged
```

(The rest of the existing `"social"` branch — account lookup, creator match, `queuePosts` call — stays exactly as it is; this just adds an inbox-item check before it.)

- [ ] **Step 5: Confirm it passes**

Run: `npx vitest run packages/brief/test/brief.test.ts`
Expected: all brief tests passing, including the new one.

- [ ] **Step 6: Typecheck and run the full suite**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: clean typecheck, all tests passing.

- [ ] **Step 7: Commit**

```bash
git add packages/social/src/plugin.ts packages/brief/src/plugin.ts packages/brief/test/brief.test.ts
git commit -m "Surface pending-approval inbox replies as individual Brief items"
```

---

### Task 6: Wire `pollInbox` into the hourly cycle + deploy

**Files:**
- Modify: `packages/orchestrator/src/plugin.ts` (add `social.pollInbox` to the intel `Promise.all`)
- Modify: `packages/app/src/build.ts` (thread `socialInboxFile`)
- Modify: `packages/server/src/server.ts` (thread `socialInboxFile` into `rebuildAtlas()`)

- [ ] **Step 1: Add the orchestrator step**

In `packages/orchestrator/src/plugin.ts`, find the intel `Promise.all([...])` block (same one `kdpGenerateIfRoom`/`mediaFactory` live in) and add:

```typescript
          optional<unknown>(ctx.call, "social", { op: "pollInbox" }, health),
```

Add the corresponding destructured variable and `intel` object field, matching the exact existing pattern for `mediaFactory` there (same array-position/object-key convention).

- [ ] **Step 2: Thread the file path through**

In `packages/app/src/build.ts`, add near `socialPostsFile?: string;`:

```typescript
  socialInboxFile?: string;
```

Update the `createSocialPlugin` call:

```typescript
    inboxFile: opts.socialInboxFile,
```

In `packages/server/src/server.ts`, add near `socialPostsFile`:

```typescript
  const socialInboxFile = `${dataDir}/social-inbox.json`;
```

Add to the `buildAtlas({...})` call:

```typescript
      socialInboxFile: socialInboxFile,
```

- [ ] **Step 3: Typecheck and run the full suite**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: clean typecheck, all tests passing.

- [ ] **Step 4: Commit, push, deploy**

```bash
git add packages/orchestrator/src/plugin.ts packages/app/src/build.ts packages/server/src/server.ts
git commit -m "Wire social.pollInbox into the hourly cycle"
git push origin main
```

```bash
scp -i ~/.ssh/atlas_deploy packages/social/src/*.ts root@72.62.168.207:/opt/atlas/app/packages/social/src/
scp -i ~/.ssh/atlas_deploy packages/brief/src/plugin.ts root@72.62.168.207:/opt/atlas/app/packages/brief/src/
scp -i ~/.ssh/atlas_deploy packages/orchestrator/src/plugin.ts root@72.62.168.207:/opt/atlas/app/packages/orchestrator/src/
scp -i ~/.ssh/atlas_deploy packages/app/src/build.ts root@72.62.168.207:/opt/atlas/app/packages/app/src/
scp -i ~/.ssh/atlas_deploy packages/server/src/server.ts root@72.62.168.207:/opt/atlas/app/packages/server/src/
ssh -i ~/.ssh/atlas_deploy root@72.62.168.207 "docker restart atlas && sleep 8 && curl -s -o /dev/null -w '%{http_code}\n' localhost:4317/api/health"
```

Expected: `200`, clean startup log.

---

## Next

All four plans for the AI Influencer Social Platform are now built. The remaining real work is verification against a live connected account (flagged throughout: token exchange, publish call, conversations field shape) and the two items outside this spec's scope: Media Factory's video-for-posting gap and any KDP browser-automation work, tracked separately.
