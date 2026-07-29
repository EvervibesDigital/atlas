# Social Posting Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get Media Factory's reviewed content actually posted to real Instagram/Facebook accounts — grouped by creator in the Brief, one bulk approval per creator, staggered publish times so a batch doesn't post all at once.

**Architecture:** A Graph API posting client (pure, mocked-fetch tested — no live account exists yet to verify against, same honest posture as Plan 2's token exchange). A `SocialPost` queue (same enqueue/due/mark-done pattern as the video-render queue from Plan 1). A new `fromSocial()` Brief source groups ready content by creator (`personaLabel`), tier `bulk`. Approval queues staggered posts; a background worker (same 2-minute interval pattern as the video worker) fires any post whose time has arrived.

**Tech Stack:** TypeScript, vitest, extends `@atlas/social` (Plan 2) and `@atlas/brief`.

**Plan 3 of 4** for the AI Influencer Social Platform. Plan 4 (comment/DM auto-reply) follows this one. See spec: `docs/superpowers/specs/2026-07-27-social-media-platform-design.md`; Plan 1: `docs/superpowers/plans/2026-07-27-media-factory-scaling.md`; Plan 2: `docs/superpowers/plans/2026-07-27-social-account-connection.md`.

**Honest scope note:** No account is connected yet (verified — `data/social-accounts.json` doesn't exist on the VPS). Every Graph API call in this plan is written against Meta's current, verified-live documentation and tested with mocked fetch, but the *real* publish call needs to be watched live the first time it actually runs against a connected account, same posture Plan 2 took with the token exchange (which turned out to need a real fix once tested against reality — expect the same discipline here).

---

### Task 1: Graph API posting client

**Files:**
- Create: `packages/social/src/posting.ts`
- Test: `packages/social/test/posting.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/social/test/posting.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { postToInstagram, postToFacebookPage } from "../src/posting";

describe("postToInstagram", () => {
  it("creates a media container then publishes it, returning the live post id", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "container123" }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "post456" }) });

    const result = await postToInstagram({
      igBusinessAccountId: "ig111",
      imageUrl: "https://example.com/photo.jpg",
      caption: "hello world",
      pageAccessToken: "PAGE_TOKEN",
      fetcher,
    });

    expect(result).toEqual({ livePostId: "post456" });
    const containerUrl = fetcher.mock.calls[0]![0] as string;
    expect(containerUrl).toContain("/ig111/media");
    expect(containerUrl).toContain("image_url=");
    expect(containerUrl).toContain("access_token=PAGE_TOKEN");
    const publishUrl = fetcher.mock.calls[1]![0] as string;
    expect(publishUrl).toContain("/ig111/media_publish");
    expect(publishUrl).toContain("creation_id=container123");
  });

  it("throws with the real error text when container creation fails", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: "Invalid image URL" } }) });
    await expect(postToInstagram({ igBusinessAccountId: "ig1", imageUrl: "bad", caption: "c", pageAccessToken: "t", fetcher })).rejects.toThrow(/Invalid image URL/);
  });
});

describe("postToFacebookPage", () => {
  it("posts a photo with caption to the Page's /photos endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "page_post_789", post_id: "page1_789" }) });

    const result = await postToFacebookPage({
      pageId: "page1",
      imageUrl: "https://example.com/photo.jpg",
      caption: "hello world",
      pageAccessToken: "PAGE_TOKEN",
      fetcher,
    });

    expect(result).toEqual({ livePostId: "page1_789" });
    const url = fetcher.mock.calls[0]![0] as string;
    expect(url).toContain("/page1/photos");
    expect(url).toContain("access_token=PAGE_TOKEN");
  });

  it("throws with the real error text when the Page post fails", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: { message: "Page token has expired" } }) });
    await expect(postToFacebookPage({ pageId: "p1", imageUrl: "x", caption: "c", pageAccessToken: "t", fetcher })).rejects.toThrow(/expired/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/social/test/posting.test.ts`
Expected: FAIL — module `../src/posting` doesn't exist.

- [ ] **Step 3: Implement**

Create `packages/social/src/posting.ts`:

```typescript
import type { FetchLike } from "./token-exchange";

export interface PostResult {
  livePostId: string;
}

/**
 * Instagram Content Publishing API — a two-step flow: create a media
 * container from the image URL, then publish that container. Verified
 * against Meta's current documented shape; not yet run against a real
 * account (see this plan's header note).
 */
export async function postToInstagram(input: {
  igBusinessAccountId: string;
  imageUrl: string;
  caption: string;
  pageAccessToken: string;
  fetcher: FetchLike;
}): Promise<PostResult> {
  const createParams = new URLSearchParams({ image_url: input.imageUrl, caption: input.caption, access_token: input.pageAccessToken });
  const createRes = await input.fetcher(`https://graph.facebook.com/v25.0/${input.igBusinessAccountId}/media?${createParams.toString()}`, { method: "POST" });
  const createData = (await createRes.json()) as { id?: string; error?: { message?: string } };
  if (!createRes.ok) throw new Error(`Instagram media container failed: HTTP ${createRes.status} ${createData.error?.message ?? JSON.stringify(createData).slice(0, 200)}`);
  if (!createData.id) throw new Error(`Instagram media container returned no id: ${JSON.stringify(createData).slice(0, 200)}`);

  const publishParams = new URLSearchParams({ creation_id: createData.id, access_token: input.pageAccessToken });
  const publishRes = await input.fetcher(`https://graph.facebook.com/v25.0/${input.igBusinessAccountId}/media_publish?${publishParams.toString()}`, { method: "POST" });
  const publishData = (await publishRes.json()) as { id?: string; error?: { message?: string } };
  if (!publishRes.ok) throw new Error(`Instagram publish failed: HTTP ${publishRes.status} ${publishData.error?.message ?? JSON.stringify(publishData).slice(0, 200)}`);
  if (!publishData.id) throw new Error(`Instagram publish returned no id: ${JSON.stringify(publishData).slice(0, 200)}`);
  return { livePostId: publishData.id };
}

/** Facebook Page photo post — single call, no container step. */
export async function postToFacebookPage(input: {
  pageId: string;
  imageUrl: string;
  caption: string;
  pageAccessToken: string;
  fetcher: FetchLike;
}): Promise<PostResult> {
  const params = new URLSearchParams({ url: input.imageUrl, caption: input.caption, access_token: input.pageAccessToken });
  const res = await input.fetcher(`https://graph.facebook.com/v25.0/${input.pageId}/photos?${params.toString()}`, { method: "POST" });
  const data = (await res.json()) as { id?: string; post_id?: string; error?: { message?: string } };
  if (!res.ok) throw new Error(`Facebook Page post failed: HTTP ${res.status} ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
  const livePostId = data.post_id ?? data.id;
  if (!livePostId) throw new Error(`Facebook Page post returned no id: ${JSON.stringify(data).slice(0, 200)}`);
  return { livePostId };
}
```

- [ ] **Step 4: Confirm it passes**

Run: `npx vitest run packages/social/test/posting.test.ts`
Expected: 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/social/src/posting.ts packages/social/test/posting.test.ts
git commit -m "Add Instagram/Facebook Graph API posting client"
```

---

### Task 2: SocialPost queue (pure data layer)

**Files:**
- Create: `packages/social/src/post-queue.ts`
- Test: `packages/social/test/post-queue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/social/test/post-queue.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { enqueueStaggeredPosts, duePosts, markPublished, markFailed, type SocialPost } from "../src/post-queue";

function post(id: string, scheduledFor: string, status: SocialPost["status"] = "approved"): SocialPost {
  return { id, contentItemId: "c1", accountId: "a1", mediaType: "image", caption: "hi", mediaUrl: "https://x/1.jpg", status, scheduledFor, createdAt: "2026-01-01T00:00:00.000Z" };
}

describe("enqueueStaggeredPosts", () => {
  it("assigns each post a scheduledFor time spread across the given hours, starting now", () => {
    const now = new Date("2026-01-01T10:00:00.000Z");
    const posts = enqueueStaggeredPosts(
      [
        { contentItemId: "c1", accountId: "a1", mediaType: "image", caption: "one", mediaUrl: "https://x/1.jpg" },
        { contentItemId: "c2", accountId: "a1", mediaType: "image", caption: "two", mediaUrl: "https://x/2.jpg" },
        { contentItemId: "c3", accountId: "a1", mediaType: "image", caption: "three", mediaUrl: "https://x/3.jpg" },
      ],
      now,
      6, // spread across 6 hours
    );
    expect(posts).toHaveLength(3);
    expect(posts[0]!.scheduledFor).toBe("2026-01-01T10:00:00.000Z"); // first is immediate
    expect(new Date(posts[1]!.scheduledFor).getTime()).toBeGreaterThan(new Date(posts[0]!.scheduledFor).getTime());
    expect(new Date(posts[2]!.scheduledFor).getTime()).toBeGreaterThan(new Date(posts[1]!.scheduledFor).getTime());
    // last post lands within the 6-hour spread window
    expect(new Date(posts[2]!.scheduledFor).getTime()).toBeLessThanOrEqual(now.getTime() + 6 * 3_600_000);
    expect(posts.every((p) => p.status === "approved")).toBe(true);
  });

  it("gives a single post an immediate scheduledFor time (no unnecessary delay)", () => {
    const now = new Date("2026-01-01T10:00:00.000Z");
    const posts = enqueueStaggeredPosts([{ contentItemId: "c1", accountId: "a1", mediaType: "image", caption: "one", mediaUrl: "https://x/1.jpg" }], now, 6);
    expect(posts[0]!.scheduledFor).toBe(now.toISOString());
  });
});

describe("duePosts", () => {
  it("returns approved posts whose scheduledFor has passed, oldest first", () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const posts = [post("p1", "2026-01-01T13:00:00.000Z"), post("p2", "2026-01-01T11:00:00.000Z"), post("p3", "2026-01-01T11:30:00.000Z")];
    const due = duePosts(posts, now);
    expect(due.map((p) => p.id)).toEqual(["p2", "p3"]);
  });

  it("never returns posts that aren't in approved status", () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const posts = [post("p1", "2026-01-01T11:00:00.000Z", "published"), post("p2", "2026-01-01T11:00:00.000Z", "failed")];
    expect(duePosts(posts, now)).toEqual([]);
  });
});

describe("markPublished / markFailed", () => {
  it("updates the matching post to published with the live post id", () => {
    const posts = [post("p1", "2026-01-01T11:00:00.000Z")];
    const updated = markPublished(posts, "p1", "live_post_999");
    expect(updated[0]).toMatchObject({ status: "published", livePostId: "live_post_999" });
    expect(updated[0]!.publishedAt).toBeTruthy();
  });

  it("updates the matching post to failed with the error message", () => {
    const posts = [post("p1", "2026-01-01T11:00:00.000Z")];
    const updated = markFailed(posts, "p1", "Invalid image URL");
    expect(updated[0]).toMatchObject({ status: "failed", error: "Invalid image URL" });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/social/test/post-queue.test.ts`
Expected: FAIL — module `../src/post-queue` doesn't exist.

- [ ] **Step 3: Implement**

Create `packages/social/src/post-queue.ts`:

```typescript
import { randomUUID } from "node:crypto";

export interface SocialPost {
  id: string;
  contentItemId: string;
  accountId: string;
  mediaType: "image" | "video";
  caption: string;
  mediaUrl: string;
  status: "approved" | "published" | "failed";
  scheduledFor: string;
  publishedAt?: string;
  livePostId?: string;
  error?: string;
  createdAt: string;
}

export type NewSocialPost = Pick<SocialPost, "contentItemId" | "accountId" | "mediaType" | "caption" | "mediaUrl">;

/**
 * Spread a batch of posts across `spreadHours` starting at `now` — posting
 * everything in a batch in the same instant reads as automated and risks
 * Meta's own abuse heuristics even through the official API. The first post
 * fires immediately; the rest are evenly spaced up to the spread window.
 */
export function enqueueStaggeredPosts(newPosts: NewSocialPost[], now: Date, spreadHours: number): SocialPost[] {
  const stepMs = newPosts.length > 1 ? (spreadHours * 3_600_000) / (newPosts.length - 1) : 0;
  return newPosts.map((p, i) => ({
    ...p,
    id: randomUUID(),
    status: "approved" as const,
    scheduledFor: new Date(now.getTime() + i * stepMs).toISOString(),
    createdAt: now.toISOString(),
  }));
}

/** Approved posts whose time has arrived, oldest scheduledFor first. */
export function duePosts(posts: SocialPost[], now: Date): SocialPost[] {
  return posts
    .filter((p) => p.status === "approved" && new Date(p.scheduledFor).getTime() <= now.getTime())
    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
}

export function markPublished(posts: SocialPost[], id: string, livePostId: string): SocialPost[] {
  return posts.map((p) => (p.id === id ? { ...p, status: "published" as const, livePostId, publishedAt: new Date().toISOString() } : p));
}

export function markFailed(posts: SocialPost[], id: string, error: string): SocialPost[] {
  return posts.map((p) => (p.id === id ? { ...p, status: "failed" as const, error } : p));
}
```

- [ ] **Step 4: Confirm it passes**

Run: `npx vitest run packages/social/test/post-queue.test.ts`
Expected: 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/social/src/post-queue.ts packages/social/test/post-queue.test.ts
git commit -m "Add staggered SocialPost queue (pure data layer)"
```

---

### Task 3: `listAccounts` + `queuePosts` ops on the social plugin

**Files:**
- Modify: `packages/social/src/plugin.ts`
- Modify: `packages/social/src/store.ts` (add `loadAccounts` helper — read-only, matches the read pattern already used inline in `completeConnection`)
- Test: `packages/social/test/list-and-queue.test.ts`

This task exposes two new ops: `listAccounts` (read-only, for the Brief to know which creators have a connected account) and `queuePosts` (given a creator's ready Media Factory content items, stagger them into `SocialPost`s and save).

- [ ] **Step 1: Write the failing test**

Create `packages/social/test/list-and-queue.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/social/test/list-and-queue.test.ts`
Expected: FAIL — `postsFile` option not accepted, `listAccounts`/`queuePosts` ops unknown.

- [ ] **Step 3: Implement**

In `packages/social/src/store.ts`, add after `findAccount`:

```typescript
export async function loadAccounts(accountsFile: string): Promise<SocialAccount[]> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(accountsFile, "utf8").catch(() => "[]");
  return JSON.parse(raw) as SocialAccount[];
}
```

In `packages/social/src/plugin.ts`, update imports and the options type:

```typescript
import { addAccount, loadAccounts, type SocialAccount } from "./store";
import { enqueueStaggeredPosts, type SocialPost, type NewSocialPost } from "./post-queue";
```

```typescript
export type SocialCommand =
  | { op: "getConnectUrl" }
  | { op: "completeConnection"; code: string }
  | { op: "listAccounts" }
  | { op: "queuePosts"; accountId: string; items: Array<Pick<NewSocialPost, "contentItemId" | "caption" | "mediaUrl">> };

export function createSocialPlugin(opts: { redirectUri: string; accountsFile?: string; postsFile?: string; fetcher?: FetchLike }): Plugin {
  const accountsFile = opts.accountsFile ?? "data/social-accounts.json";
  const postsFile = opts.postsFile ?? "data/social-posts.json";
  const fetcher: FetchLike = opts.fetcher ?? (fetch as unknown as FetchLike);
```

(`accountsFile` already existed from Plan 2 — this replaces its default-value line with the same default, no behavior change there. `postsFile` is new.)

Add two new branches inside `ctx.provide("social", ...)`, after the `completeConnection` branch:

```typescript
        if (cmd.op === "listAccounts") {
          const accounts = await loadAccounts(accountsFile);
          return { accounts: accounts.map((a) => ({ id: a.id, personaLabel: a.personaLabel, platform: a.platform })) };
        }

        if (cmd.op === "queuePosts") {
          const accounts = await loadAccounts(accountsFile);
          const account = accounts.find((a) => a.id === cmd.accountId);
          if (!account) throw new Error(`social: account "${cmd.accountId}" not found — it may have been disconnected`);

          const mediaType = account.platform === "instagram" ? "image" : "image"; // video support waits on Media Factory's multi-scene gap, see Plan 1's "Next"
          const newPosts: NewSocialPost[] = cmd.items.map((i) => ({ contentItemId: i.contentItemId, accountId: cmd.accountId, mediaType, caption: i.caption, mediaUrl: i.mediaUrl }));
          const staggered = enqueueStaggeredPosts(newPosts, new Date(), 6);

          const existingRaw = await readFile(postsFile, "utf8").catch(() => "[]");
          const existing = JSON.parse(existingRaw) as SocialPost[];
          await writeFile(postsFile, JSON.stringify([...existing, ...staggered]), "utf8");
          return { queued: staggered.length };
        }
```

- [ ] **Step 4: Confirm it passes**

Run: `npx vitest run packages/social/test/list-and-queue.test.ts`
Expected: 3 tests passing.

- [ ] **Step 5: Typecheck and run every social test**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run packages/social`
Expected: clean typecheck, all social tests passing.

- [ ] **Step 6: Commit**

```bash
git add packages/social/src/plugin.ts packages/social/src/store.ts packages/social/test/list-and-queue.test.ts
git commit -m "Add listAccounts and queuePosts ops to the social plugin"
```

---

### Task 4: `fromSocial()` Brief source, grouped by creator

**Files:**
- Modify: `packages/brief/src/types.ts` (add `"social"` to `BriefSource`)
- Modify: `packages/brief/src/plugin.ts` (new `fromSocial()`, wire into `collectAll()` and `actOne()`)
- Modify: `packages/brief/test/brief.test.ts`

- [ ] **Step 1: Read the current collectAll/actOne shape**

Run: `grep -n "fromLearning\|collectAll\|actOne" packages/brief/src/plugin.ts`

Confirm the exact current list inside `Promise.all([...])` in `collectAll()` and the exact `if (source === "learning")` branch shape in `actOne()` — match those patterns exactly, don't guess at them.

- [ ] **Step 2: Write the failing test**

Find the existing `describe("wholesale source"` block in `packages/brief/test/brief.test.ts` (`grep -n "describe(" packages/brief/test/brief.test.ts`) to copy its exact `ConfigVault`/fake-fetcher setup style, then add:

```typescript
describe("social source", () => {
  it("groups ready content by creator into one bulk item, not one per post", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
    await atlas.use(createBriefPlugin());
    await atlas.use({
      manifest: { name: "social", version: "1", capabilities: ["social"], permissions: [], role: "executor" },
      register(ctx) {
        ctx.provide("social", async (payload: any) => {
          if (payload.op === "listAccounts") return { accounts: [{ id: "acc1", personaLabel: "Aria Vance", platform: "instagram" }] };
          throw new Error("unexpected social op in test: " + payload.op);
        });
      },
    });
    await atlas.use({
      manifest: { name: "mediaFactory", version: "1", capabilities: ["mediaFactory"], permissions: [], role: "executor" },
      register(ctx) {
        ctx.provide("mediaFactory", async (payload: any) => {
          if (payload.op === "listCreators") return [{ id: "creator1", name: "Aria Vance" }];
          if (payload.op === "listContent") {
            return [
              { id: "item1", creator_id: "creator1", platform: "instagram", status: "review", title: "t1", caption: "cap1", assets: { image_path: "/img1.jpg" } },
              { id: "item2", creator_id: "creator1", platform: "instagram", status: "review", title: "t2", caption: "cap2", assets: { image_path: "/img2.jpg" } },
              { id: "item3", creator_id: "creator1", platform: "instagram", status: "planned", title: "t3" }, // not ready yet, excluded
            ];
          }
          throw new Error("unexpected mediaFactory op in test: " + payload.op);
        });
      },
    });

    const brief = (await atlas.invoke("brief", { op: "today" })) as { items: Array<{ source: string; title: string; tier: string; detail?: string }> };
    const socialItems = brief.items.filter((i) => i.source === "social");
    expect(socialItems).toHaveLength(1); // one item for the whole creator, not one per post
    expect(socialItems[0]!.title).toContain("Aria Vance");
    expect(socialItems[0]!.title).toContain("2"); // 2 ready posts
    expect(socialItems[0]!.tier).toBe("bulk");
  });
});
```

Replace `Atlas`/`Guardian`/`ConfigVault`/`createBriefPlugin` imports with whatever's already imported at the top of the file — check first with `grep -n "^import" packages/brief/test/brief.test.ts` and match exactly.

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run packages/brief/test/brief.test.ts -t "groups ready content by creator"`
Expected: FAIL — no items with `source === "social"` (the source doesn't exist yet).

- [ ] **Step 4: Add "social" to BriefSource**

In `packages/brief/src/types.ts`, change:

```typescript
export type BriefSource = "kdp" | "gigfinder" | "approvals" | "surplus" | "wholesale" | "leadscan" | "learning";
```

to:

```typescript
export type BriefSource = "kdp" | "gigfinder" | "approvals" | "surplus" | "wholesale" | "leadscan" | "learning" | "social";
```

- [ ] **Step 5: Implement `fromSocial()` and wire it in**

In `packages/brief/src/plugin.ts`, add after `fromLearning()`:

```typescript
      async function fromSocial(): Promise<BriefItem[]> {
        const { accounts } = (await ctx.call("social", { op: "listAccounts" })) as { accounts: Array<{ id: string; personaLabel: string; platform: string }> };
        if (accounts.length === 0) return [];

        const creators = (await ctx.call("mediaFactory", { op: "listCreators" })) as Array<{ id: string; name: string }>;
        const allContent = (await ctx.call("mediaFactory", { op: "listContent" })) as Array<{ id: string; creator_id: string; status: string; caption?: string; assets?: { image_path?: string } }>;

        const items: BriefItem[] = [];
        for (const account of accounts) {
          const creator = creators.find((c) => c.name === account.personaLabel);
          if (!creator) continue;
          const ready = allContent.filter((c) => c.creator_id === creator.id && c.status === "review" && c.assets?.image_path);
          if (ready.length === 0) continue;

          items.push({
            id: account.id,
            source: "social" as const,
            title: `${account.personaLabel} — ${ready.length} post${ready.length === 1 ? "" : "s"} ready`,
            detail: `Approving queues ${ready.length} post(s) to ${account.platform}, spread over the next 6 hours (not posted all at once).`,
            risk: 1 as const,
            // Posting AI-generated content live, batched like every other
            // outbound-content source (leadscan/wholesale email) — reviewed
            // per creator, one tap, never silently posted.
            tier: "bulk" as const,
          });
        }
        return items;
      }
```

Find the `collectAll()` function's `Promise.all([...])` block and its return line (`grep -n "collectAll" packages/brief/src/plugin.ts`). Add `collect(fromSocial)` to the array and `...social` to the spread in the return statement — match the exact existing pattern for `fromLearning`/`learning` there (same variable-naming convention, don't invent a different style).

Find `actOne()`'s `if (source === "learning")` branch and add, right after it:

```typescript
        if (source === "social") {
          if (action === "reject") return { skipped: id };
          const { accounts } = (await ctx.call("social", { op: "listAccounts" })) as { accounts: Array<{ id: string; personaLabel: string }> };
          const account = accounts.find((a) => a.id === id);
          if (!account) throw new Error(`brief: social account "${id}" not found`);
          const creators = (await ctx.call("mediaFactory", { op: "listCreators" })) as Array<{ id: string; name: string }>;
          const creator = creators.find((c) => c.name === account.personaLabel);
          if (!creator) throw new Error(`brief: no Media Factory creator matches account "${id}"`);
          const allContent = (await ctx.call("mediaFactory", { op: "listContent" })) as Array<{ id: string; creator_id: string; status: string; caption?: string; assets?: { image_path?: string } }>;
          const ready = allContent.filter((c) => c.creator_id === creator.id && c.status === "review" && c.assets?.image_path);
          return ctx.call("social", {
            op: "queuePosts",
            accountId: id,
            items: ready.map((c) => ({ contentItemId: c.id, caption: c.caption ?? "", mediaUrl: c.assets!.image_path! })),
          });
        }
```

Also add `"call:social"` and `"call:mediaFactory"` to the brief plugin's manifest `permissions` array if either isn't already there (`grep -n "permissions:" packages/brief/src/plugin.ts`).

- [ ] **Step 6: Confirm the test passes**

Run: `npx vitest run packages/brief/test/brief.test.ts`
Expected: all brief tests passing, including the new one.

- [ ] **Step 7: Typecheck and run the full suite**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: clean typecheck, all tests passing.

- [ ] **Step 8: Commit**

```bash
git add packages/brief/src/types.ts packages/brief/src/plugin.ts packages/brief/test/brief.test.ts
git commit -m "Add fromSocial Brief source, grouped by creator not by post"
```

---

### Task 5: Publish worker + deploy

**Files:**
- Modify: `packages/social/src/plugin.ts` (new `publishDuePosts` op)
- Modify: `packages/server/src/server.ts` (background interval, same pattern as `processOneVideoJob`)
- Modify: `packages/app/src/build.ts` (thread `postsFile` option through, same pattern as Plan 2's `accountsFile`)
- Test: `packages/social/test/publish-due.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/social/test/publish-due.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run packages/social/test/publish-due.test.ts`
Expected: FAIL — `publishDuePosts` op unknown.

- [ ] **Step 3: Implement**

In `packages/social/src/plugin.ts`, add imports:

```typescript
import { postToInstagram, postToFacebookPage } from "./posting";
import { duePosts, markPublished, markFailed, type SocialPost } from "./post-queue";
import { decryptToken } from "./crypto";
```

Add `"publishDuePosts"` to the `SocialCommand` union:

```typescript
  | { op: "publishDuePosts" };
```

Add the branch inside `ctx.provide("social", ...)`:

```typescript
        if (cmd.op === "publishDuePosts") {
          const tokenKey = await ctx.secret("SOCIAL_TOKEN_KEY");
          if (!tokenKey) throw new Error("social: SOCIAL_TOKEN_KEY not set");

          const accounts = await loadAccounts(accountsFile);
          const rawPosts = await readFile(postsFile, "utf8").catch(() => "[]");
          let posts = JSON.parse(rawPosts) as SocialPost[];
          const due = duePosts(posts, new Date());

          let published = 0, failed = 0;
          for (const post of due) {
            const account = accounts.find((a) => a.id === post.accountId);
            if (!account) {
              posts = markFailed(posts, post.id, `account "${post.accountId}" no longer connected`);
              failed++;
              continue;
            }
            try {
              const pageAccessToken = decryptToken(account.accessTokenEnc, tokenKey);
              const result = account.platform === "instagram" && account.igBusinessAccountId
                ? await postToInstagram({ igBusinessAccountId: account.igBusinessAccountId, imageUrl: post.mediaUrl, caption: post.caption, pageAccessToken, fetcher })
                : await postToFacebookPage({ pageId: account.pageId, imageUrl: post.mediaUrl, caption: post.caption, pageAccessToken, fetcher });
              posts = markPublished(posts, post.id, result.livePostId);
              published++;
            } catch (err) {
              posts = markFailed(posts, post.id, (err as Error).message);
              failed++;
            }
          }
          await writeFile(postsFile, JSON.stringify(posts), "utf8");
          return { published, failed };
        }
```

- [ ] **Step 4: Confirm it passes**

Run: `npx vitest run packages/social/test/publish-due.test.ts`
Expected: 2 tests passing.

- [ ] **Step 5: Wire `postsFile` through `AtlasOptions`/`buildAtlas`**

In `packages/app/src/build.ts`, add near `socialAccountsFile?: string;`:

```typescript
  socialPostsFile?: string;
```

Update the `createSocialPlugin` call:

```typescript
  await atlas.use(createSocialPlugin({
    redirectUri: `${process.env.ATLAS_PUBLIC_URL ?? "https://atlas.evervibesdigital.com"}/api/social/oauth/callback`,
    accountsFile: opts.socialAccountsFile,
    postsFile: opts.socialPostsFile,
  }));
```

- [ ] **Step 6: Add the background worker to server.ts**

In `packages/server/src/server.ts`, near `videoJobsFile`:

```typescript
  const socialPostsFile = `${dataDir}/social-posts.json`;
```

In `rebuildAtlas()`'s `buildAtlas({...})` call, add:

```typescript
      socialAccountsFile: `${dataDir}/social-accounts.json`,
      socialPostsFile: socialPostsFile,
```

Near `processOneVideoJob`, add:

```typescript
  /** Fires any social posts whose scheduled time has arrived — same 2-minute
   * interval pattern as the video job worker, independent of the hourly
   * business cycle. */
  async function publishDueSocialPosts(): Promise<void> {
    if (!vault.unlocked) return;
    try {
      const a = await ensureAtlas();
      const result = (await a.invoke("social", { op: "publishDuePosts" })) as { published: number; failed: number };
      if (result.published > 0 || result.failed > 0) {
        console.log(`[SOCIAL] Published ${result.published}, failed ${result.failed}.`);
      }
    } catch (err) {
      console.error("[SOCIAL] publishDuePosts tick failed:", (err as Error).message);
    }
  }

  setInterval(() => void publishDueSocialPosts(), 2 * 60 * 1000);
```

- [ ] **Step 7: Typecheck and run the full suite**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: clean typecheck, all tests passing.

- [ ] **Step 8: Commit, push, deploy**

```bash
git add packages/social/src/plugin.ts packages/app/src/build.ts packages/server/src/server.ts packages/social/test/publish-due.test.ts
git commit -m "Add publishDuePosts op and background worker that fires scheduled posts"
git push origin main
```

```bash
scp -i ~/.ssh/atlas_deploy packages/social/src/*.ts root@72.62.168.207:/opt/atlas/app/packages/social/src/
scp -i ~/.ssh/atlas_deploy packages/brief/src/*.ts root@72.62.168.207:/opt/atlas/app/packages/brief/src/
scp -i ~/.ssh/atlas_deploy packages/app/src/build.ts root@72.62.168.207:/opt/atlas/app/packages/app/src/
scp -i ~/.ssh/atlas_deploy packages/server/src/server.ts root@72.62.168.207:/opt/atlas/app/packages/server/src/
ssh -i ~/.ssh/atlas_deploy root@72.62.168.207 "docker restart atlas && sleep 8 && curl -s -o /dev/null -w '%{http_code}\n' localhost:4317/api/health"
```

Expected: `200`, clean startup log.

---

## Next

Plan 4 (comment/DM polling + AI-drafted replies) follows this one, reusing the same connected-account foundation. Real live verification of the actual publish call (Task 1/5) still needs to happen the first time Mat approves a real post to a real connected account — watch it together, same as the token exchange in Plan 2.
