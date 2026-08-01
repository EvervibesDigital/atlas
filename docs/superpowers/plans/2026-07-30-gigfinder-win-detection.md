# Gig Finder Win Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@atlas/gigfinder` a `checkWins` op that reads recent email, matches it against pending bids, and either confidently marks a gig `"won"` or queues an ambiguous reply in the Brief — closing the one manual step left in "find → bid → win → do the work → I approve → it submits" (this is sub-project 1 of 4; work-execution, and auto-submit come later).

**Architecture:** Two new pure functions (`scoreWinConfidence`, `matchGigForEmail`) in a new `win-detection.ts` module do the actual classification, mirroring `@atlas/social`'s existing `scoreConfidence` heuristic exactly (same 0–100 shape, same ≥90 auto-act threshold). The one impure piece, `checkWins`, calls the already-existing `@atlas/email` plugin's `check` op and the gigfinder registry, wired into the orchestrator's existing hourly cycle right next to `gigfinder.search`.

**Tech Stack:** TypeScript, Vitest, reuses `@atlas/email` (already built, IMAP-based) and `@atlas/brief` (already built) — no new dependencies.

**One deliberate refinement to the approved spec, made during planning:** the spec described adding new `confirmWin`/`dismissWin`/`get` ops on the gigfinder plugin, with Brief looking up a gig's status and routing to the right op. Reading the actual code turned up a simpler path: the existing `reject` op already works unchanged for both "new" and "responded" gigs (it just sets status to `"rejected"` either way — exactly right for "not a win, drop it" too). Only `approve` needs a new branch: if the gig it's approving is already `"responded"` (client replied), mark it `"won"` instead of drafting a bid. This means **no new ops, no Brief-side status lookup, no `get` op** — `packages/brief/src/plugin.ts`'s `actOne` needs zero changes; only `fromGigFinder` (which items get *listed*) changes. Smaller diff, same behavior the spec asked for.

---

### Task 1: `"won"` status + pure win-detection functions

**Files:**
- Modify: `packages/gigfinder/src/types.ts`
- Create: `packages/gigfinder/src/win-detection.ts`
- Test: `packages/gigfinder/test/win-detection.test.ts`

- [ ] **Step 1: Add `"won"` to `GigStatus`**

In `packages/gigfinder/src/types.ts`, change the first line from:

```typescript
export type GigStatus = "new" | "approved" | "rejected" | "submitted" | "responded" | "completed" | "paid";
```

to:

```typescript
export type GigStatus = "new" | "approved" | "rejected" | "submitted" | "responded" | "won" | "completed" | "paid";
```

- [ ] **Step 2: Write the failing tests**

Create `packages/gigfinder/test/win-detection.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { scoreWinConfidence, matchGigForEmail, WIN_CONFIDENCE_THRESHOLD } from "../src/win-detection";
import type { Gig } from "../src/types";

describe("scoreWinConfidence", () => {
  it("scores a clear win notification at or above the threshold", () => {
    expect(scoreWinConfidence("Congratulations! You've been hired for this project.")).toBeGreaterThanOrEqual(WIN_CONFIDENCE_THRESHOLD);
  });

  it("scores a rejection well below the threshold", () => {
    expect(scoreWinConfidence("Unfortunately we went with another candidate for this one.")).toBeLessThan(WIN_CONFIDENCE_THRESHOLD);
  });

  it("scores a plain question below the threshold", () => {
    expect(scoreWinConfidence("Can you tell me more about your availability?")).toBeLessThan(WIN_CONFIDENCE_THRESHOLD);
  });

  it("clamps to 0-100", () => {
    expect(scoreWinConfidence("")).toBeGreaterThanOrEqual(0);
    expect(scoreWinConfidence("you've been hired congratulations job awarded")).toBeLessThanOrEqual(100);
  });
});

function gig(overrides: Partial<Gig> = {}): Gig {
  return {
    id: "g1",
    source: "web",
    title: "Python scraper for product pages",
    url: "http://x",
    snippet: "scrape data",
    foundAt: "2026-07-01T00:00:00Z",
    status: "submitted",
    dedupeKey: "k1",
    ...overrides,
  };
}

describe("matchGigForEmail", () => {
  it("matches an email that overlaps a pending gig's title", () => {
    const pending = [gig()];
    const match = matchGigForEmail("Congrats, you've been hired for the python scraper project!", pending);
    expect(match?.id).toBe("g1");
  });

  it("returns undefined when nothing overlaps", () => {
    const pending = [gig()];
    const match = matchGigForEmail("Your Amazon order has shipped.", pending);
    expect(match).toBeUndefined();
  });

  it("picks the best-overlapping gig when multiple are pending", () => {
    const pending = [
      gig({ id: "g1", title: "Python scraper for product pages" }),
      gig({ id: "g2", title: "Excel spreadsheet cleanup" }),
    ];
    const match = matchGigForEmail("You're hired! Ready to start the spreadsheet cleanup project.", pending);
    expect(match?.id).toBe("g2");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/gigfinder/test/win-detection.test.ts`
Expected: FAIL — cannot find module `../src/win-detection`.

- [ ] **Step 4: Implement `win-detection.ts`**

Create `packages/gigfinder/src/win-detection.ts`:

```typescript
import type { Gig } from "./types";

/**
 * Win detection — reads a plain-text email and decides (a) does it look like
 * a "you got the job" notification, and (b) which pending gig is it about.
 * Both are pure, dependency-free heuristics (no brain call), same tradeoff
 * @atlas/social's scoreConfidence already accepts: a starting heuristic, not
 * a trained model — refine once real data exists.
 */

/** Same bar @atlas/social already uses for auto-sending a reply — a
 * classification at or above this is confident enough to act on unattended;
 * anything below defers to Mat via the Brief instead of guessing. */
export const WIN_CONFIDENCE_THRESHOLD = 90;

const WIN_PHRASES = [
  "you've been hired", "you have been hired", "job awarded", "you won the job", "you've won",
  "congratulations", "order confirmed", "accepted your proposal", "accepted your bid",
  "you got the job", "selected you", "hired you", "new order", "project awarded",
];

const NOT_WIN_PHRASES = [
  "unfortunately", "not selected", "other candidate", "went with someone else", "declined",
  "no longer available", "position filled", "we chose another",
];

/** 0-100 — most inbox email isn't a win notification, so this starts low and
 * only rises on a clear positive signal. A bare question reads as "needs
 * more info," not a done deal, so it pulls the score down slightly too. */
export function scoreWinConfidence(text: string): number {
  const lower = text.toLowerCase();
  let score = 20;
  if (WIN_PHRASES.some((p) => lower.includes(p))) score += 70;
  if (NOT_WIN_PHRASES.some((p) => lower.includes(p))) score -= 60;
  if (lower.includes("?")) score -= 10;
  return Math.max(0, Math.min(100, score));
}

/** Best-overlap match against a gig's title (words longer than 3 chars,
 * case-insensitive). Requires at least 40% of a gig's significant title
 * words to appear in the email text; returns the best-scoring gig among the
 * pending ones, or undefined if nothing clears that bar. */
export function matchGigForEmail(text: string, pendingGigs: Gig[]): Gig | undefined {
  const lower = text.toLowerCase();
  let best: Gig | undefined;
  let bestScore = 0;
  for (const gig of pendingGigs) {
    const titleWords = gig.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    if (titleWords.length === 0) continue;
    const matches = titleWords.filter((w) => lower.includes(w)).length;
    const score = matches / titleWords.length;
    if (score > bestScore && score >= 0.4) {
      bestScore = score;
      best = gig;
    }
  }
  return best;
}
```

- [ ] **Step 5: Run the tests again to verify they pass**

Run: `pnpm exec vitest run packages/gigfinder/test/win-detection.test.ts`
Expected: All 7 tests pass.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add packages/gigfinder/src/types.ts packages/gigfinder/src/win-detection.ts packages/gigfinder/test/win-detection.test.ts
git commit -m "feat(gigfinder): add won status and pure win-detection heuristics

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `checkWins` op on the gigfinder plugin

**Files:**
- Modify: `packages/gigfinder/src/plugin.ts`
- Test: `packages/gigfinder/test/gigfinder.test.ts`

- [ ] **Step 1: Read the current file to confirm exact content**

Read `packages/gigfinder/src/plugin.ts` yourself before editing — this plan was written against its current state, but confirm nothing has drifted.

- [ ] **Step 2: Write the failing tests**

Add these imports near the top of `packages/gigfinder/test/gigfinder.test.ts` (it currently imports from `../src/matching` and `../src/registry` — add these alongside, don't remove the existing ones):

```typescript
import { Atlas, ConfigVault } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createGigFinderPlugin } from "../src/plugin";
```

Add this `describe` block at the end of `packages/gigfinder/test/gigfinder.test.ts`:

```typescript
describe("gigfinder plugin checkWins", () => {
  function fakeEmail(messages: Array<{ from: string; subject: string; date: string; text: string; links: string[] }>) {
    return {
      manifest: { name: "email", version: "1", capabilities: ["email"], permissions: [], role: "executor" as const },
      register(ctx: { provide: (name: string, fn: (payload: unknown) => Promise<unknown>) => void }) {
        ctx.provide("email", async (payload: unknown) => {
          const cmd = payload as { op: string };
          if (cmd.op === "check") return { messages };
          throw new Error("unexpected email op in test: " + cmd.op);
        });
      },
    };
  }

  async function seedSubmittedGig(gigFile: string, title: string): Promise<string> {
    const reg = new GigRegistry(gigFile);
    const [added] = await reg.addCandidates([{ source: "web", title, url: "http://x", snippet: "desc" }]);
    await reg.update(added!.id, { status: "submitted" });
    return added!.id;
  }

  it("marks a gig won on a confident match and does nothing else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-gigfinder-wins-"));
    const gigFile = join(dir, "gigs.json");
    try {
      const gigId = await seedSubmittedGig(gigFile, "Python scraper for product pages");
      const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
      await atlas.use(
        fakeEmail([{ from: "client@example.com", subject: "You're hired!", date: "2026-07-30T00:00:00Z", text: "Congratulations, you've been hired for the python scraper project.", links: [] }]),
      );
      await atlas.use(createGigFinderPlugin({ gigFile }));
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:gigfinder"], role: "executor" },
        async register(ctx) {
          const r = (await ctx.call("gigfinder", { op: "checkWins" })) as { checked: number; won: number; flagged: number };
          expect(r.won).toBe(1);
          expect(r.flagged).toBe(0);
          const gig = await ctx.call("gigfinder", { op: "list", status: "won" });
          expect((gig as Array<{ id: string }>).map((g) => g.id)).toContain(gigId);
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("flags an ambiguous reply as responded instead of guessing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-gigfinder-wins-"));
    const gigFile = join(dir, "gigs.json");
    try {
      await seedSubmittedGig(gigFile, "Python scraper for product pages");
      const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
      await atlas.use(
        fakeEmail([{ from: "client@example.com", subject: "Quick question", date: "2026-07-30T00:00:00Z", text: "Can you tell me more about the python scraper timeline?", links: [] }]),
      );
      await atlas.use(createGigFinderPlugin({ gigFile }));
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:gigfinder"], role: "executor" },
        async register(ctx) {
          const r = (await ctx.call("gigfinder", { op: "checkWins" })) as { checked: number; won: number; flagged: number };
          expect(r.won).toBe(0);
          expect(r.flagged).toBe(1);
          const responded = (await ctx.call("gigfinder", { op: "list", status: "responded" })) as Array<{ notes?: string }>;
          expect(responded).toHaveLength(1);
          expect(responded[0]!.notes).toContain("python scraper timeline");
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips calling email.check when there are no submitted gigs to match against", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-gigfinder-wins-"));
    const gigFile = join(dir, "gigs.json");
    try {
      const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
      let emailChecked = false;
      await atlas.use({
        manifest: { name: "email", version: "1", capabilities: ["email"], permissions: [], role: "executor" },
        register(ctx) {
          ctx.provide("email", async () => { emailChecked = true; return { messages: [] }; });
        },
      });
      await atlas.use(createGigFinderPlugin({ gigFile }));
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:gigfinder"], role: "executor" },
        async register(ctx) {
          const r = (await ctx.call("gigfinder", { op: "checkWins" })) as { checked: number; won: number; flagged: number };
          expect(r).toEqual({ checked: 0, won: 0, flagged: 0 });
        },
      });
      expect(emailChecked).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

Add these two imports at the very top of `packages/gigfinder/test/gigfinder.test.ts` too (needed by the new tests above):

```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/gigfinder/test/gigfinder.test.ts`
Expected: FAIL — `gigfinder: unknown op "checkWins"`.

- [ ] **Step 4: Add the `call:email` permission and implement `checkWins`**

In `packages/gigfinder/src/plugin.ts`, change the manifest's `permissions` line from:

```typescript
      permissions: ["call:brain", "call:memory", "call:search"],
```

to:

```typescript
      permissions: ["call:brain", "call:memory", "call:search", "call:email"],
```

Add `"checkWins"` to the `GigFinderCommand` union — change:

```typescript
export type GigFinderCommand =
  | { op: "search"; sources?: GigSource[] }
  | { op: "list"; status?: GigStatus }
  | { op: "approve"; id: string }
  | { op: "reject"; id: string }
  | { op: "markSubmitted"; id: string }
  | { op: "updateStatus"; id: string; status: GigStatus; paidAmount?: number }
  | { op: "stats" };
```

to:

```typescript
export type GigFinderCommand =
  | { op: "search"; sources?: GigSource[] }
  | { op: "list"; status?: GigStatus }
  | { op: "approve"; id: string }
  | { op: "reject"; id: string }
  | { op: "markSubmitted"; id: string }
  | { op: "updateStatus"; id: string; status: GigStatus; paidAmount?: number }
  | { op: "checkWins" }
  | { op: "stats" };
```

Add this import near the top of the file, alongside the existing imports:

```typescript
import { scoreWinConfidence, matchGigForEmail, WIN_CONFIDENCE_THRESHOLD } from "./win-detection";
```

Add the `checkWins` branch inside `ctx.provide("gigfinder", async (payload) => { ... })`, right after the existing `if (cmd.op === "search") { ... }` block and before `if (cmd.op === "list") { ... }`:

```typescript
        if (cmd.op === "checkWins") {
          const pending = await registry.list("submitted");
          let checked = 0;
          let won = 0;
          let flagged = 0;
          if (pending.length > 0) {
            const { messages } = (await ctx.call("email", { op: "check", limit: 20 })) as {
              messages: Array<{ from: string; subject: string; date: string; text: string; links: string[] }>;
            };
            for (const msg of messages) {
              checked++;
              try {
                const emailText = `${msg.subject} ${msg.text}`;
                const gig = matchGigForEmail(emailText, pending);
                if (!gig) continue;
                const confidence = scoreWinConfidence(emailText);
                if (confidence >= WIN_CONFIDENCE_THRESHOLD) {
                  await registry.update(gig.id, { status: "won" });
                  await ctx.emit("gigfinder.won", { id: gig.id });
                  won++;
                } else {
                  await registry.update(gig.id, { status: "responded", notes: emailText.slice(0, 500) });
                  flagged++;
                }
              } catch {
                /* one email failing to classify shouldn't kill the whole batch */
              }
            }
          }
          return { checked, won, flagged };
        }

```

- [ ] **Step 5: Run the tests again to verify they pass**

Run: `pnpm exec vitest run packages/gigfinder/test/gigfinder.test.ts`
Expected: All tests pass (existing ones + 3 new `checkWins` tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add packages/gigfinder/src/plugin.ts packages/gigfinder/test/gigfinder.test.ts
git commit -m "feat(gigfinder): add checkWins op — matches recent email against pending bids

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `approve` recognizes a confirmed win

**Files:**
- Modify: `packages/gigfinder/src/plugin.ts`
- Test: `packages/gigfinder/test/gigfinder.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test inside the `describe("gigfinder plugin checkWins", ...)` block from Task 2 (or as its own `describe("gigfinder plugin approve on a responded gig", ...)` block right after it — either is fine, put it after the 3 existing `checkWins` tests):

```typescript
describe("gigfinder plugin approve on a responded gig", () => {
  it("marks a responded gig won instead of drafting a new bid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-gigfinder-approve-won-"));
    const gigFile = join(dir, "gigs.json");
    try {
      const reg = new GigRegistry(gigFile);
      const [added] = await reg.addCandidates([{ source: "web", title: "Excel cleanup job", url: "http://x", snippet: "desc" }]);
      await reg.update(added!.id, { status: "responded", notes: "Congrats, you're hired!" });

      const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
      await atlas.use(createGigFinderPlugin({ gigFile }));
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:gigfinder"], role: "executor" },
        async register(ctx) {
          const r = (await ctx.call("gigfinder", { op: "approve", id: added!.id })) as { status: string };
          expect(r.status).toBe("won");
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/gigfinder/test/gigfinder.test.ts`
Expected: FAIL — the test asserts `status` is `"won"`, but the current `approve` op always sets `"approved"`.

- [ ] **Step 3: Add the early-return branch to `approve`**

In `packages/gigfinder/src/plugin.ts`, find the existing `approve` branch:

```typescript
        if (cmd.op === "approve") {
          const gig = await registry.get(cmd.id);
          if (!gig) throw new Error(`no gig "${cmd.id}"`);
          const bid = gig.draftBid ?? (await draftBid(gig)); // pre-drafted at search time; fall back for older gigs
          const updated = await registry.update(cmd.id, { status: "approved", draftBid: bid });
          await ctx.emit("gigfinder.approved", { id: cmd.id });
          return updated;
        }
```

Replace it with:

```typescript
        if (cmd.op === "approve") {
          const gig = await registry.get(cmd.id);
          if (!gig) throw new Error(`no gig "${cmd.id}"`);
          if (gig.status === "responded") {
            const updated = await registry.update(cmd.id, { status: "won" });
            await ctx.emit("gigfinder.won", { id: cmd.id });
            return updated;
          }
          const bid = gig.draftBid ?? (await draftBid(gig)); // pre-drafted at search time; fall back for older gigs
          const updated = await registry.update(cmd.id, { status: "approved", draftBid: bid });
          await ctx.emit("gigfinder.approved", { id: cmd.id });
          return updated;
        }
```

(The existing `reject` op needs NO changes — it already just sets `status: "rejected"` unconditionally, which is already the correct behavior for dismissing a `"responded"` gig too.)

- [ ] **Step 4: Run the test again to verify it passes**

Run: `pnpm exec vitest run packages/gigfinder/test/gigfinder.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add packages/gigfinder/src/plugin.ts packages/gigfinder/test/gigfinder.test.ts
git commit -m "feat(gigfinder): approving a responded gig confirms the win instead of drafting a new bid

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Brief surfaces possible wins

**Files:**
- Modify: `packages/brief/src/plugin.ts`
- Test: `packages/brief/test/brief.test.ts`

- [ ] **Step 1: Read the current file to confirm exact content**

Read `packages/brief/src/plugin.ts` yourself before editing.

- [ ] **Step 2: Write the failing test**

Add this test inside `packages/brief/test/brief.test.ts`'s existing top-level `describe("brief plugin — the Unified Morning Brief", ...)` block — put it right after the existing `"skips a source that errors instead of failing the whole brief"` test (before the `describe("surplus source", ...)` block):

```typescript
  it("surfaces a responded gig as an individual ask-tier 'possible win' item, and approving it confirms the win", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-brief-gig-win-"));
    const gigFile = join(dir, "gigs.json");
    const approvalsFile = join(dir, "approvals.json");
    try {
      const atlas = await buildTestAtlas(gigFile, approvalsFile);
      await atlas.use({
        manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:gigfinder", "call:brief"], role: "executor" },
        async register(ctx) {
          await ctx.call("gigfinder", { op: "search" });
          const seeded = (await ctx.call("gigfinder", { op: "list", status: "new" })) as Array<{ id: string }>;
          await ctx.call("gigfinder", { op: "updateStatus", id: seeded[0]!.id, status: "responded" });

          const r = (await ctx.call("brief", { op: "today" })) as { items: BriefItem[] };
          const possibleWin = r.items.find((i) => i.source === "gigfinder" && i.title.startsWith("Possible win:"));
          expect(possibleWin).toBeTruthy();
          expect(possibleWin!.tier).toBe("ask");

          const acted = (await ctx.call("brief", { op: "act", source: "gigfinder", id: possibleWin!.id, action: "approve" })) as { status: string };
          expect(acted.status).toBe("won");
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
```

(This test relies on `GigFinderCommand`'s existing `updateStatus` op, already present in `packages/gigfinder/src/plugin.ts` — no gigfinder changes needed for this test to work, since `"won"` and `"responded"` were already added to `GigStatus`/`GigFinderCommand` in Task 1.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/brief/test/brief.test.ts`
Expected: FAIL — no item with a title starting `"Possible win:"` exists yet (`fromGigFinder` only lists `"new"` gigs today).

- [ ] **Step 4: Extend `fromGigFinder`**

In `packages/brief/src/plugin.ts`, find the existing `fromGigFinder` function:

```typescript
      async function fromGigFinder(): Promise<BriefItem[]> {
        const gigs = (await ctx.call("gigfinder", { op: "list", status: "new" })) as Array<{ id: string; title: string; snippet: string; foundAt: string; budget?: number; draftBid?: string }>;
        return gigs.map((g) => ({
          id: g.id,
          source: "gigfinder" as const,
          title: g.title,
          detail: `${g.budget ? `${g.snippet} (budget: $${g.budget})` : g.snippet}${g.draftBid ? " — pitch already drafted, ready to copy" : ""}`,
          risk: 0 as const,
          // Approving only marks it approved + surfaces the already-drafted
          // pitch — it never auto-submits a bid (that boundary is permanent).
          // So batching "yes, these are worth pursuing" is safe.
          tier: "bulk" as const,
          createdAt: g.foundAt,
        }));
      }
```

Replace it with:

```typescript
      async function fromGigFinder(): Promise<BriefItem[]> {
        const [newGigs, respondedGigs] = await Promise.all([
          ctx.call("gigfinder", { op: "list", status: "new" }) as Promise<Array<{ id: string; title: string; snippet: string; foundAt: string; budget?: number; draftBid?: string }>>,
          ctx.call("gigfinder", { op: "list", status: "responded" }) as Promise<Array<{ id: string; title: string; foundAt: string; notes?: string }>>,
        ]);
        const bidItems = newGigs.map((g) => ({
          id: g.id,
          source: "gigfinder" as const,
          title: g.title,
          detail: `${g.budget ? `${g.snippet} (budget: $${g.budget})` : g.snippet}${g.draftBid ? " — pitch already drafted, ready to copy" : ""}`,
          risk: 0 as const,
          // Approving only marks it approved + surfaces the already-drafted
          // pitch — it never auto-submits a bid (that boundary is permanent).
          // So batching "yes, these are worth pursuing" is safe.
          tier: "bulk" as const,
          createdAt: g.foundAt,
        }));
        const possibleWinItems = respondedGigs.map((g) => ({
          id: g.id,
          source: "gigfinder" as const,
          title: `Possible win: ${g.title}`,
          detail: g.notes ? `Client replied — review before ATLAS starts the work: "${g.notes}"` : "Client replied — review before ATLAS starts the work.",
          risk: 1 as const,
          // Is this actually a win? A specific judgment call, same bar as a
          // reply to a specific person — never batched.
          tier: "ask" as const,
          createdAt: g.foundAt,
        }));
        return [...bidItems, ...possibleWinItems];
      }
```

`actOne`'s existing `gigfinder` branch needs no changes — it already calls `ctx.call("gigfinder", { op: action === "approve" ? "approve" : "reject", id })`, and Task 3 already taught `approve` to recognize a `"responded"` gig.

- [ ] **Step 5: Run the test again to verify it passes**

Run: `pnpm exec vitest run packages/brief/test/brief.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add packages/brief/src/plugin.ts packages/brief/test/brief.test.ts
git commit -m "feat(brief): surface a possible gig win as an individual ask-tier item

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire `checkWins` into the hourly cycle

**Files:**
- Modify: `packages/orchestrator/src/plugin.ts`

- [ ] **Step 1: Read the current file to confirm exact content**

Read `packages/orchestrator/src/plugin.ts` yourself before editing — find the existing `gigfinder.search` line to confirm it's still in the same place.

- [ ] **Step 2: Add the `checkWins` step**

Find this line (it should still be there, with the same comment above it):

```typescript
          // Gig Finder — sanctioned-search-only (web/Tavily) every cycle so
          // opportunities queue up for review without Mat manually clicking
          // search each time. The riskier scrape sources (craigslist/fiverr/
          // guru) stay manual-trigger-only from the UI, never automatic.
          optional<unknown>(ctx.call, "gigfinder", { op: "search", sources: ["web"] }, health),
```

Add immediately after it:

```typescript
          // Gig Finder win detection — reads recent email for a confident
          // "you got the job" match against pending bids and marks it won;
          // anything less certain queues in the Brief instead of guessing.
          // No-ops gracefully if EMAIL_USER/EMAIL_PASS aren't configured yet.
          optional<unknown>(ctx.call, "gigfinder", { op: "checkWins" }, health),
```

- [ ] **Step 3: Run the orchestrator and app test suites to confirm nothing broke**

Run: `pnpm exec vitest run packages/orchestrator`
Expected: All existing tests still pass (this repo's orchestrator tests only exercise the pure `optional`/`deriveTopic`/`reelToPublishInput` helpers directly — there's no existing per-step "was gigfinder.search called" test to extend, so a new one isn't added here either; that's consistent with how `pollInbox`'s own cycle-wiring has no such test).

Run: `pnpm exec vitest run packages/app`
Expected: All existing tests still pass (this change is additive — one more `optional()` call in a list of many, wrapped in the same failure-isolation every other step already has).

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/plugin.ts
git commit -m "feat(orchestrator): run gigfinder.checkWins every cycle, next to gigfinder.search

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Full suite, push, deploy

**Files:** none (verification + deploy only)

- [ ] **Step 1: Run the entire test suite**

Run: `pnpm test`
Expected: All tests pass (the full existing suite + the ~11 new tests added across Tasks 1–4 in this plan).

- [ ] **Step 2: Typecheck the whole repo**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 3: Push**

```bash
git push origin main
```

- [ ] **Step 4: Deploy to the VPS**

Unlike KDP's upload automation, this feature needs no display and touches no new real-world account — it only reads an already-configured inbox (`EMAIL_USER`/`EMAIL_PASS`, if Mat has set them) and updates ATLAS's own gig registry. Safe to run unattended on the VPS exactly like every other hourly-cycle step.

```bash
scp -i ~/.ssh/atlas_deploy packages/gigfinder/src/*.ts root@72.62.168.207:/opt/atlas/app/packages/gigfinder/src/
scp -i ~/.ssh/atlas_deploy packages/brief/src/plugin.ts root@72.62.168.207:/opt/atlas/app/packages/brief/src/
scp -i ~/.ssh/atlas_deploy packages/orchestrator/src/plugin.ts root@72.62.168.207:/opt/atlas/app/packages/orchestrator/src/
ssh -i ~/.ssh/atlas_deploy root@72.62.168.207 "docker restart atlas && sleep 8 && curl -s -o /dev/null -w '%{http_code}\n' localhost:4317/api/health"
```

Expected: the final `curl` prints `200`.

- [ ] **Step 5: Spot-check the deploy logs**

```bash
ssh -i ~/.ssh/atlas_deploy root@72.62.168.207 "docker logs atlas --tail 50"
```

Expected: no new errors related to `gigfinder`, `brief`, or `orchestrator`. If `EMAIL_USER`/`EMAIL_PASS` aren't configured on the VPS yet, the next hourly cycle's `checkWins` step will show up as a recorded (non-fatal) failure in that cycle's `cycleHealth.failures` — same as any other not-yet-configured optional step (KDP without `KDP_CRON_SECRET`, etc.) — not a deploy problem.

---
