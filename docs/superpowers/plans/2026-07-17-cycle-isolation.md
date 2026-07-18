# Isolated, Timed, Failure-Visible Cycle Steps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop ATLAS's hourly/daily cycle from silently swallowing failures and blocking on hung services — parallelize the ten independent "intel" steps with a per-step timeout, track pass/fail counts, and surface a summary where Mat already reads cycle results.

**Architecture:** Move the `optional()` step-runner out of `packages/orchestrator/src/plugin.ts` into the framework-agnostic `packages/orchestrator/src/core.ts` (pure, directly unit-testable — no `Atlas`/`AtlasContext` dependency, just a bare async callback), give it a timeout race and a shared `CycleHealthTracker`, thread that tracker through every existing call site in `plugin.ts`, convert the ten-call "intel" sequence to `Promise.all`, add `cycleHealth` to `DailyReport`, and add one summary line to `packages/server/src/server.ts`'s `formatIntentResult("cycle", ...)`.

**Tech Stack:** TypeScript, Vitest, existing `@atlas/orchestrator`/`@atlas/core`/`@atlas/server` packages.

---

### Task 1: `optional()` step-runner + `cycleHealth` data model in `core.ts`

**Files:**
- Modify: `packages/orchestrator/src/core.ts`
- Test: `packages/orchestrator/test/orchestrator.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/orchestrator/test/orchestrator.test.ts` (new `describe` block, alongside the existing `deriveTopic`/`reelToPublishInput` ones):

```typescript
import { optional, type CycleHealthTracker } from "../src/index";

describe("optional() step runner", () => {
  function tracker(): CycleHealthTracker {
    return { succeeded: 0, failures: [] };
  }

  it("returns the result and counts a success when the call resolves", async () => {
    const t = tracker();
    const call = async () => ({ ok: true });
    const result = await optional(call, "svc", {}, t);
    expect(result).toEqual({ ok: true });
    expect(t.succeeded).toBe(1);
    expect(t.failures).toHaveLength(0);
  });

  it("records a failure and returns undefined when the call throws", async () => {
    const t = tracker();
    const call = async () => { throw new Error("boom"); };
    const result = await optional(call, "svc", {}, t);
    expect(result).toBeUndefined();
    expect(t.succeeded).toBe(0);
    expect(t.failures).toEqual([{ step: "svc", error: "boom" }]);
  });

  it("times out a hanging call instead of waiting forever, and records it as a failure", async () => {
    const t = tracker();
    const call = () => new Promise(() => { /* never resolves */ });
    const result = await optional(call, "svc", {}, t, 30);
    expect(result).toBeUndefined();
    expect(t.succeeded).toBe(0);
    expect(t.failures).toHaveLength(1);
    expect(t.failures[0]!.step).toBe("svc");
    expect(t.failures[0]!.error).toMatch(/timed out/);
  });

  it("runs several steps in parallel, taking roughly the slowest single step, not their sum", async () => {
    const t = tracker();
    const slowCall = (ms: number) => () => new Promise((resolve) => setTimeout(() => resolve("done"), ms));
    const started = Date.now();
    await Promise.all([
      optional(slowCall(40), "a", {}, t),
      optional(slowCall(40), "b", {}, t),
      optional(slowCall(40), "c", {}, t),
    ]);
    const elapsed = Date.now() - started;
    // Sequential would take ~120ms; parallel should take ~40ms. 90ms is a
    // generous ceiling that would fail if these ran sequentially but easily
    // passes if they ran in parallel, without being a flaky tight bound.
    expect(elapsed).toBeLessThan(90);
    expect(t.succeeded).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/orchestrator/test/orchestrator.test.ts`
Expected: FAIL — `optional` and `CycleHealthTracker` don't exist yet in `../src/index`.

- [ ] **Step 3: Implement in `core.ts`**

Add to `packages/orchestrator/src/core.ts` (after the existing imports/before `DailyReport`, or anywhere at module scope — exact position doesn't matter, but keep it above `DailyReport` since that interface references `StepFailure`):

```typescript
/** One optional cycle step's failure, recorded for Mat's human-readable report (see `optional`). */
export interface StepFailure {
  step: string;
  error: string;
}

/** Shared counter threaded through every `optional()` call in one cycle run. */
export interface CycleHealthTracker {
  succeeded: number;
  failures: StepFailure[];
}

const DEFAULT_STEP_TIMEOUT_MS = 90_000;

/**
 * Run one optional cycle step: bounded by a timeout (a hung call must never
 * stall the whole hourly cycle — an unresolved cycle permanently kills the
 * hourly automation loop via its own `isAutomationRunning` guard), and its
 * outcome (success or failure) recorded into `tracker` for Mat's cycle
 * report. `ctx.call()` already logs the raw success/failure to the audit
 * ledger — this tracker is a separate, human-readable summary layer for a
 * different audience (Mat reading "run today's cycle"), not a replacement.
 *
 * Generous default timeout on purpose: this runs on CPU-only local LLM
 * inference where a single brain call can legitimately take 15-40s, and
 * some steps (KDP generate, media factory) may call the brain more than
 * once. A tight timeout would produce FALSE-POSITIVE failures for
 * slow-but-working steps. Running steps in parallel (the caller's job, not
 * this function's) already bounds total wall-clock time to the slowest
 * single step, not their sum, so a generous per-step timeout doesn't
 * meaningfully hurt overall cycle time.
 */
export async function optional<T>(
  call: (service: string, payload: unknown) => Promise<unknown>,
  service: string,
  payload: unknown,
  tracker: CycleHealthTracker,
  timeoutMs: number = DEFAULT_STEP_TIMEOUT_MS,
): Promise<T | undefined> {
  try {
    const result = await Promise.race([
      call(service, payload),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    tracker.succeeded++;
    return result as T;
  } catch (err) {
    tracker.failures.push({ step: service, error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}
```

Then add `cycleHealth` to the existing `DailyReport` interface — find:

```typescript
export interface DailyReport {
  date: string;
  topic: string;
```

and change to:

```typescript
export interface DailyReport {
  date: string;
  topic: string;
  /** Pass/fail summary for this cycle's optional steps — the one thing Mat
   * should see at a glance without querying /api/runs. */
  cycleHealth: { succeeded: number; failed: number; failures: StepFailure[] };
```

(Insert it as a new field; don't reorder or remove any existing field.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/orchestrator/test/orchestrator.test.ts`
Expected: PASS (2 existing describe blocks + the new 4 tests = 8 tests total)

- [ ] **Step 5: Run the full orchestrator package suite + typecheck**

Run: `npx vitest run packages/orchestrator/test/`
Run: `npx tsc -p tsconfig.json --noEmit`
Expected: both clean. `plugin.ts` still has its OWN local `optional()` function at this point (untouched, Task 2's job) — that's fine, TypeScript allows two same-named functions in different files/modules; there's no conflict since `plugin.ts` doesn't import the new one yet.

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/core.ts packages/orchestrator/test/orchestrator.test.ts
git commit -m "Add timeout-bounded optional() step runner + cycleHealth data model"
```

---

### Task 2: Rewire `plugin.ts` to use the shared `optional()`, parallelize the intel block, return `cycleHealth`

**Files:**
- Modify: `packages/orchestrator/src/plugin.ts`
- Test: `packages/app/test/cycle.test.ts`

This is one atomic, whole-file change — `plugin.ts` can't be left half-migrated (every call site must agree on the same `optional()` signature) — so this task replaces the entire file in one step rather than many small diffs.

- [ ] **Step 1: Write the failing test**

Add to `packages/app/test/cycle.test.ts`, inside the existing `describe("autonomous daily cycle", ...)` block:

```typescript
  it("reports cycleHealth alongside the rest of the report", async () => {
    const report = await runDailyCycle({
      memoryStore: new InMemoryStore(),
      approvalsGateway: new ApprovalGateway(),
      metricsTracker: new MetricsTracker(),
      brainAdapters: [new StubAdapter()],
      renderer: new NoOpRenderer(),
    });

    expect(report.cycleHealth).toBeTruthy();
    expect(typeof report.cycleHealth.succeeded).toBe("number");
    expect(typeof report.cycleHealth.failed).toBe("number");
    expect(Array.isArray(report.cycleHealth.failures)).toBe(true);
    // succeeded/failed should account for every optional() call actually made.
    expect(report.cycleHealth.succeeded + report.cycleHealth.failed).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/app/test/cycle.test.ts`
Expected: FAIL — `report.cycleHealth` is `undefined` (property doesn't exist on the returned object yet, since `plugin.ts` doesn't set it).

- [ ] **Step 3: Replace the full contents of `packages/orchestrator/src/plugin.ts`**

```typescript
import type { AtlasContext, Plugin } from "@atlas/core";
import type { DailyReport, OrchestratorCommand, ReelLike, CycleHealthTracker } from "./core";
import { deriveTopic, reelToPublishInput, optional } from "./core";

/**
 * Orchestrator plugin (service "orchestrator") — the autonomous agent loop.
 *
 * `runDailyCycle` is one full day's work: assess the businesses (Business
 * brief), pick a topic, write a Reel (Creative), sanity-check it (Strategy
 * Council), queue it for approval (Publishing — which gates on Mat), gather
 * improvement proposals (Learning) and the pending approval list, then file a
 * timeline note. It returns a DailyReport — Mat's morning briefing.
 *
 * Role `planner`: it conducts and delegates; it never executes risky actions
 * itself (posting still goes through the Approval Gateway).
 *
 * Every non-critical step goes through `optional()` (from `./core`), which
 * bounds it with a generous timeout and records success/failure into a
 * shared `CycleHealthTracker` — this is what makes `cycleHealth` in the
 * returned report meaningful, and what stops one hung/failing service from
 * silently blocking or being invisible in every future cycle run.
 */
export function createOrchestratorPlugin(opts: { defaultPersona?: string } = {}): Plugin {
  const defaultPersona = opts.defaultPersona ?? "@everspark.ai";

  return {
    manifest: {
      name: "orchestrator",
      version: "0.1.0",
      capabilities: ["orchestrator"],
      permissions: [
        "call:personas",
        "call:business",
        "call:creative",
        "call:strategy",
        "call:publishing",
        "call:learning",
        "call:approvals",
        "call:memory",
        "call:compliance",
        "call:analytics",
        "call:inbox",
        "call:curiosity",
        "call:search",
        "call:connectors",
        "call:janitor",
        "call:newsletter",
        "call:gigfinder",
        "call:kdp",
        "call:mediaFactory",
      ],
      role: "planner",
    },

    register(ctx) {
      ctx.provide("orchestrator", async (payload) => {
        const cmd = payload as OrchestratorCommand;
        if (cmd.op !== "runDailyCycle") throw new Error(`orchestrator: unknown op "${(cmd as { op: string }).op}"`);

        const personaHandle = cmd.personaHandle ?? defaultPersona;
        const health: CycleHealthTracker = { succeeded: 0, failures: [] };

        // 1. Which persona, and what should it talk about today?
        const persona = await optional<{ contentPillars?: string[] }>(ctx.call, "personas", { op: "get", handle: personaHandle }, health);
        const daySeed = Math.floor(Date.now() / 86_400_000);
        const topic = cmd.topic ?? deriveTopic(persona?.contentPillars ?? [], daySeed);

        // 1b. RECALL — close the learning loop. Before deciding anything, pull
        // the most relevant lessons ATLAS has stored (past successes/failures,
        // newsletter findings, learnings) for today's topic. Without this the
        // cycle only ever WRITES to memory and never learns from it.
        const recalled = (await optional<Array<{ record: { content: string; kind: string } }>>(ctx.call, "memory", {
          op: "search",
          query: `${topic} lessons, what worked, what failed, opportunities`,
          options: { limit: 5, minScore: 0.12 },
        }, health)) ?? [];
        const lessons = recalled.map((r) => r.record.content);

        // 2. Assess the businesses.
        const brief = (await optional<{ summary: string; recommendations: unknown[] }>(ctx.call, "business", { op: "brief" }, health)) ?? {
          summary: "No business data yet.",
          recommendations: [],
        };

        // 3. Create today's Reel (required — creative + brain must be present).
        const reel = (await ctx.call("creative", { op: "writeReel", personaHandle, topic })) as ReelLike & { hook: string; caption: string; voice: string; scenes: Array<{ text: string; imageUrl: string }> };

        // 3b. Try to render a real MP4. Time-boxed: the renderer can involve
        // network image/voice generation with no timeouts of its own, and a
        // hang here must never stall the whole daily cycle. On failure or
        // timeout, publishing falls back to "pending-render" (still queues
        // everything else) rather than blocking.
        let videoRef = cmd.videoRef ?? null;
        if (!videoRef) {
          try {
            console.log(`[orchestrator] Rendering video for topic: ${topic}`);
            const renderResult = (await Promise.race([
              ctx.call("publishing", { op: "render", spec: reel }),
              new Promise((_, reject) => setTimeout(() => reject(new Error("render timed out after 30s")), 30_000)),
            ])) as { videoPath: string };
            videoRef = renderResult.videoPath || null;
          } catch (err) {
            console.error("[orchestrator] Video rendering failed or timed out, proceeding without videoRef:", err);
          }
        }

        // 4. Sanity-check the plan with the Strategy Council.
        const council = (await optional<{ consensus: string; recommendation: string }>(ctx.call, "strategy", { op: "convene", decision: `Post a Reel about ${topic}` }, health)) ?? null;

        // 5. Queue it — Publishing gates on Mat's approval.
        const publish = (await ctx.call("publishing", { op: "publish", input: reelToPublishInput(reel, videoRef) })) as {
          status: string;
          detail: string;
          approvalId?: string;
        };

        // 6. Compliance-check the caption + pull headline KPIs.
        const compliance = (await optional<unknown[]>(ctx.call, "compliance", { op: "check", text: reel.caption }, health)) ?? [];
        const kpis = (await optional<unknown>(ctx.call, "analytics", { op: "kpis" }, health)) ?? null;

        // 6b. Study one of Mat's businesses (rotates each cycle — how ATLAS
        // learns his businesses overnight). Read-only; safe to run autonomously.
        const learned = (await optional<unknown>(ctx.call, "business", { op: "research-next" }, health)) ?? null;

        // 6c. Check the GitHub inbox for instructions Mat sent from the road
        // (only if configured via env — works in the cloud cycle too).
        const inboxRepo = process.env.ATLAS_INBOX_REPO;
        const inboxToken = process.env.GITHUB_TOKEN;
        const inbox = inboxRepo && inboxToken ? ((await optional<unknown>(ctx.call, "inbox", { op: "check", repo: inboxRepo, token: inboxToken }, health)) ?? null) : null;

        // 6d. Daily intelligence sweep, run in PARALLEL (was sequential) —
        // each of these ten calls is independent of the others, so one
        // hung/slow service (e.g. KDP generate on a bad night) no longer
        // delays or blocks curiosity/gig-finder/media-factory/etc., and can
        // no longer stall the whole cycle (each is timeout-bounded inside
        // `optional()`).
        const [curiosity, repoScout, freeTools, github, tidy, newsletters, gigs, kdpScan, kdpGenerate, mediaFactory] = await Promise.all([
          optional<unknown>(ctx.call, "curiosity", { op: "ideas" }, health),
          optional<unknown>(ctx.call, "search", { op: "scout", query: "autonomous AI agent framework OR MCP server OR open-source LLM tools", max: 6 }, health),
          optional<unknown>(ctx.call, "search", { op: "freeApis", topic: "content automation, AI agents, and social posting" }, health),
          optional<unknown>(ctx.call, "connectors", { op: "sync", which: "github" }, health),
          optional<unknown>(ctx.call, "janitor", { op: "tidy" }, health),
          // Daily knowledge ingestion: read the tech newsletters and summarize
          // each into shared memory (via the web service's learn op). This is
          // what future cycles RECALL at step 1b — the ingestion→recall loop.
          optional<unknown>(ctx.call, "newsletter", { op: "readDaily" }, health),
          // Gig Finder — sanctioned-search-only (web/Tavily) every cycle so
          // opportunities queue up for review without Mat manually clicking
          // search each time. The riskier scrape sources (craigslist/fiverr/
          // guru) stay manual-trigger-only from the UI, never automatic.
          optional<unknown>(ctx.call, "gigfinder", { op: "search", sources: ["web"] }, health),
          // KDP — "constantly creating": scan for new book opportunities, then
          // build metadata+PDF for the top few unbuilt ones every cycle. Real
          // pipeline lives in evervibes; this just keeps it fed. Skipped
          // gracefully if KDP_CRON_SECRET isn't configured yet.
          optional<unknown>(ctx.call, "kdp", { op: "scan" }, health),
          optional<unknown>(ctx.call, "kdp", { op: "generate", limit: 3 }, health),
          // Media Factory — "constantly creating": one autoCycle step per
          // orchestrator run (plan a fresh calendar for a creator with an
          // empty queue, or produce the next planned post's script). Never
          // posts; everything lands in "review" for Mat to approve. No-ops
          // gracefully if DATABASE_URL isn't configured yet.
          optional<unknown>(ctx.call, "mediaFactory", { op: "autoCycle" }, health),
        ]);
        const intel = {
          curiosity: curiosity ?? null,
          repoScout: repoScout ?? null,
          freeTools: freeTools ?? null,
          github: github ?? null,
          tidy: tidy ?? null,
          newsletters: newsletters ?? null,
          gigs: gigs ?? null,
          kdpScan: kdpScan ?? null,
          kdpGenerate: kdpGenerate ?? null,
          mediaFactory: mediaFactory ?? null,
        };

        // 7. Gather advice + the approval list for the report.
        const proposals = (await optional<unknown[]>(ctx.call, "learning", { op: "proposals" }, health)) ?? [];
        const pendingApprovals = (await optional<unknown[]>(ctx.call, "approvals", { op: "list", status: "pending" }, health)) ?? [];

        const report: DailyReport = {
          date: new Date().toISOString(),
          topic,
          lessons,
          brief,
          topPriorities: brief.recommendations.slice(0, 3),
          reel: { hook: reel.hook, caption: reel.caption },
          council,
          publish,
          compliance,
          kpis,
          learned,
          inbox,
          intel,
          proposals,
          pendingApprovals,
          cycleHealth: { succeeded: health.succeeded, failed: health.failures.length, failures: health.failures },
        };

        // This one memory write is fire-and-forget informational (a timeline
        // note), not tracked in health — losing it isn't a "cycle step
        // failed" in the sense Mat cares about, and it happens after
        // cycleHealth is already computed above.
        try {
          await ctx.call("memory", {
            op: "remember",
            input: { kind: "timeline", content: `Daily cycle: drafted a Reel about "${topic}"; ${pendingApprovals.length} item(s) awaiting approval`, metadata: { topic } },
          });
        } catch {
          /* best-effort timeline note; not a cycle-health-tracked step */
        }
        await ctx.emit("orchestrator.cycle", { topic, pending: pendingApprovals.length, publish: publish.status });

        return report;
      });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/app/test/cycle.test.ts`
Expected: PASS (existing 2 tests + 1 new = 3 tests)

- [ ] **Step 5: Run the full orchestrator + app test suites**

Run: `npx vitest run packages/orchestrator/test/ packages/app/test/`
Expected: PASS — the existing 2 `cycle.test.ts` tests (checking `report.topic`, `report.reel.hook`, `report.council?.consensus`, `report.publish.status`, `report.pendingApprovals`) are unaffected, since `cycleHealth` is additive and every other field is computed identically to before (same calls, same fallback values, just parallel instead of sequential for the 10 intel calls and routed through the shared `optional()` instead of the old local one).

- [ ] **Step 6: Typecheck the whole workspace**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors — confirms no other file still imports a now-removed local `optional` from `plugin.ts` (nothing else did; it was module-private).

- [ ] **Step 7: Commit**

```bash
git add packages/orchestrator/src/plugin.ts packages/app/test/cycle.test.ts
git commit -m "Parallelize the daily cycle's intel steps and report cycleHealth"
```

---

### Task 3: Surface `cycleHealth` in the chat "run today's cycle" summary

**Files:**
- Modify: `packages/server/src/server.ts`
- Test: `packages/server/test/server.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/server/test/server.test.ts`, inside `describe("control panel", ...)`:

```typescript
  it("chat's cycle summary reports cycleHealth pass/fail counts", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const r = await post("/api/chat", { message: "run today's cycle", history: [] }, token);
    expect(r.status).toBe(200);
    const data = (await r.json()) as { reply: string };
    // Either all-succeeded or some-failed phrasing must appear — this proves
    // formatIntentResult's "cycle" branch reads cycleHealth, not that any
    // particular outcome happens in this offline stub test environment.
    expect(data.reply).toMatch(/steps (succeeded|failed)/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/test/server.test.ts`
Expected: FAIL — current `formatIntentResult`'s `"cycle"` branch doesn't mention "steps" at all.

- [ ] **Step 3: Update `formatIntentResult`'s `"cycle"` branch**

In `packages/server/src/server.ts`, find:

```typescript
  if (kind === "cycle") {
    const rep = r as { topic?: string; reel?: { hook?: string }; pendingApprovals?: unknown[] };
    return `Done. Topic: ${rep.topic}. Drafted hook: "${rep.reel?.hook ?? ""}". ${rep.pendingApprovals?.length ?? 0} item(s) awaiting your approval.`;
  }
```

Replace with:

```typescript
  if (kind === "cycle") {
    const rep = r as {
      topic?: string;
      reel?: { hook?: string };
      pendingApprovals?: unknown[];
      cycleHealth?: { succeeded: number; failed: number; failures: Array<{ step: string; error: string }> };
    };
    const health = rep.cycleHealth;
    const healthLine = health
      ? health.failed > 0
        ? `\n⚠️ ${health.failed} of ${health.succeeded + health.failed} steps failed: ${health.failures.map((f) => f.step).join(", ")}.`
        : `\n✅ All ${health.succeeded} steps succeeded.`
      : "";
    return `Done. Topic: ${rep.topic}. Drafted hook: "${rep.reel?.hook ?? ""}". ${rep.pendingApprovals?.length ?? 0} item(s) awaiting your approval.${healthLine}`;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/test/server.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full server suite**

Run: `npx vitest run packages/server/test/`
Expected: PASS — no other test asserts the exact old `formatIntentResult("cycle", ...)` string (confirm by checking test output; if any does, it needs updating to expect the new trailing health line, but none of the currently-passing tests check this specific string based on the existing suite).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/server.ts packages/server/test/server.test.ts
git commit -m "Surface cycleHealth pass/fail summary in the chat cycle-run reply"
```

---

### Task 4: Full verification, deploy, and memory update

**Files:** none (verification + deployment only)

- [ ] **Step 1: Full typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all test files pass (prior full-suite count, 240 tests as of the Run Ledger work, plus the ~8 new tests added across Tasks 1-3)

- [ ] **Step 3: Manual smoke check of the parallelization improvement**

This isn't unit-testable in a way that proves real-world timing (that depends on live network/CPU conditions), so confirm qualitatively: with the local ATLAS server running, trigger a real cycle (chat: "run today's cycle", or `POST /api/cycle`) and check the server console log — confirm no single intel step's failure/timeout prevents the others from completing (look for multiple `[orchestrator]`-prefixed or service-specific log lines appearing close together in time rather than strictly sequential gaps matching each service's typical latency).

- [ ] **Step 4: Deploy to the VPS**

```bash
git push origin main
tar --exclude=node_modules -czf /tmp/atlas-cycle-isolation.tar.gz packages/orchestrator packages/server
scp -i ~/.ssh/atlas_deploy /tmp/atlas-cycle-isolation.tar.gz root@72.62.168.207:/tmp/
ssh -i ~/.ssh/atlas_deploy root@72.62.168.207 "cd /opt/atlas/app && tar -xzf /tmp/atlas-cycle-isolation.tar.gz && rm /tmp/atlas-cycle-isolation.tar.gz && docker restart atlas && sleep 8 && curl -s http://localhost:4317/api/health && echo"
```

Expected: `{"ok":true,"initialized":true,"unlocked":false}`

- [ ] **Step 5: Verify the cloud instance**

```bash
curl -s https://atlas.evervibesdigital.com/api/health && echo
```

Expected: same healthy response.

- [ ] **Step 6: Update memory**

Add an entry to the ATLAS project memory noting: cycle steps are now parallelized + timeout-bounded + failure-tracked, `cycleHealth` is in `DailyReport` and surfaced in the chat cycle-run reply, and the remaining "continuous per-business" ambition (Mat confirmed same hourly clock, not per-business cadence, for this phase) is intentionally not a bigger rebuild — this phase closes the "silent failure" and "one hang blocks everything" gaps specifically.
