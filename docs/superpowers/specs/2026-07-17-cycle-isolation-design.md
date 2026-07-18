# Isolated, Timed, Failure-Visible Cycle Steps

## Context

Mat wants two things: stop the daily/hourly cycle from silently swallowing
failures, and move toward each business/service running independently rather
than one giant sequential function. Investigation found both are narrower
than they first appeared:

- ATLAS already has an **hourly in-process loop** (`packages/server/src/server.ts`,
  `startAutomationLoop()` / `runAutomationCycleOnce()`, `setInterval(..., 60 *
  60 * 1000)`) calling the same `orchestrator.runDailyCycle` op the 3x/day
  GitHub Actions cron also calls. No new scheduler is needed.
- Since this morning's Run Ledger work, `ctx.call()` already records every
  service call's success/failure (with `error`/`durationMs`) to the audit
  ledger — including the calls made from inside `runDailyCycle`. The failure
  data already exists; it's just invisible to Mat, and the cycle itself has
  two real structural problems independent of logging:
  1. **Sequential blocking, not isolation.** The "intel" block in
     `packages/orchestrator/src/plugin.ts` (`curiosity`, `repoScout`,
     `freeTools`, `github`, `tidy`, `newsletters`, `gigs`, `kdpScan`,
     `kdpGenerate`, `mediaFactory` — 10 independent `await optional(...)`
     calls in a row) means one slow or hung call delays or blocks every
     step after it in the list, every single hour.
  2. **No timeout on any of these ten calls** (only the video-render step
     has one, via an existing `Promise.race`). A hang in any of them stalls
     the whole cycle. Worse: `runAutomationCycleOnce()`'s `isAutomationRunning`
     guard (`if (isAutomationRunning) return;`) means a cycle that never
     resolves **permanently kills the hourly loop** — every subsequent tick
     no-ops forever, silently, with no error surfaced anywhere.

Mat's chosen scope (confirmed): keep the same hourly clock for everything —
don't build per-business cadence configuration — just make the steps run
independently, bounded, and visibly report their own success/failure.

## Design

### 1. A shared step-runner replaces the bare `optional()` helper

`packages/orchestrator/src/plugin.ts` currently has:

```typescript
async function optional<T>(ctx: AtlasContext, service: string, payload: unknown): Promise<T | undefined> {
  try {
    return (await ctx.call(service, payload)) as T;
  } catch {
    return undefined;
  }
}
```

Replace it with a version that (a) enforces a timeout so one hung call can
never stall the cycle, and (b) records the failure (service + error) into a
collector the caller supplies, instead of discarding it:

```typescript
export interface StepFailure {
  step: string;
  error: string;
}

// Generous on purpose: this box runs local LLM inference on CPU only (no
// GPU), where a single brain call can legitimately take 15-40s, and steps
// like kdpGenerate/mediaFactory's autoCycle may call the brain more than
// once. A tight timeout would produce FALSE-POSITIVE failures for slow-but-
// working steps, which undermines the entire point of a trustworthy health
// signal. Parallelizing (below) already bounds the worst case to the
// slowest single step, not their sum, so a generous per-step timeout doesn't
// meaningfully hurt total cycle time.
const STEP_TIMEOUT_MS = 90_000;

/**
 * Run one optional cycle step: bounded by a timeout (a hung call must never
 * stall the whole hourly cycle — see the "isAutomationRunning never resets"
 * failure mode this closes), and its failure recorded into `failures` instead
 * of silently discarded. `ctx.call()` already logs the raw success/failure to
 * the audit ledger (Run Ledger, shipped earlier) — this collector is for
 * Mat's human-readable cycle report, a different audience than the ledger.
 */
async function optional<T>(ctx: AtlasContext, service: string, payload: unknown, failures: StepFailure[]): Promise<T | undefined> {
  try {
    const result = await Promise.race([
      ctx.call(service, payload),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${STEP_TIMEOUT_MS}ms`)), STEP_TIMEOUT_MS)),
    ]);
    return result as T;
  } catch (err) {
    failures.push({ step: service, error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}
```

Every existing call site adds one argument (the shared `failures` array
declared once at the top of `runDailyCycle`). This is a mechanical,
find-and-replace-shaped change across the existing ~15 `optional(ctx, ...)`
call sites in `plugin.ts`.

### 2. The "intel" block runs in parallel, not sequentially

Today:

```typescript
const intel = {
  curiosity: (await optional<unknown>(ctx, "curiosity", { op: "ideas" })) ?? null,
  repoScout: (await optional<unknown>(ctx, "search", { op: "scout", ... })) ?? null,
  // ...8 more, each awaited in turn
};
```

Becomes: build an array of `[key, promise]` pairs (each already wrapped by
the timeout-bounded `optional()` above), run them with `Promise.all` (safe —
each promise already resolves to `T | undefined`, never rejects, since
`optional()` catches internally), then reassemble into the same `intel`
object shape:

```typescript
const intelEntries = await Promise.all([
  ["curiosity", optional<unknown>(ctx, "curiosity", { op: "ideas" }, failures)] as const,
  ["repoScout", optional<unknown>(ctx, "search", { op: "scout", query: "autonomous AI agent framework OR MCP server OR open-source LLM tools", max: 6 }, failures)] as const,
  ["freeTools", optional<unknown>(ctx, "search", { op: "freeApis", topic: "content automation, AI agents, and social posting" }, failures)] as const,
  ["github", optional<unknown>(ctx, "connectors", { op: "sync", which: "github" }, failures)] as const,
  ["tidy", optional<unknown>(ctx, "janitor", { op: "tidy" }, failures)] as const,
  ["newsletters", optional<unknown>(ctx, "newsletter", { op: "readDaily" }, failures)] as const,
  ["gigs", optional<unknown>(ctx, "gigfinder", { op: "search", sources: ["web"] }, failures)] as const,
  ["kdpScan", optional<unknown>(ctx, "kdp", { op: "scan" }, failures)] as const,
  ["kdpGenerate", optional<unknown>(ctx, "kdp", { op: "generate", limit: 3 }, failures)] as const,
  ["mediaFactory", optional<unknown>(ctx, "mediaFactory", { op: "autoCycle" }, failures)] as const,
].map(async ([key, p]) => [key, (await p) ?? null] as const));
const intel = Object.fromEntries(intelEntries);
```

Each entry's promise starts immediately (not gated on the previous one), so
all ten run concurrently, each independently bounded by the 45s timeout. A
hang in `kdpGenerate` no longer delays `mediaFactory` or `gigs`, and can no
longer make the entire cycle (and therefore the hourly loop) hang forever.

The other sequential `optional()` calls outside the intel block (persona
lookup, memory recall, business brief, business research, inbox check) stay
sequential — they're each fast, singular, and some genuinely depend on
earlier results (e.g. `topic` depends on `persona`). Only the intel block's
ten mutually-independent calls get parallelized; this isn't a blanket
`Promise.all`-everything rewrite.

### 3. `DailyReport` gets a `cycleHealth` field

`packages/orchestrator/src/core.ts`:

```typescript
export interface DailyReport {
  // ...existing fields...
  /** Pass/fail summary for this cycle's optional steps — the one thing Mat
   * should be able to see at a glance without querying /api/runs. */
  cycleHealth: { succeeded: number; failed: number; failures: StepFailure[] };
}
```

`runDailyCycle` builds this from the same `failures` array threaded through
every `optional()` call, counting total optional-step attempts vs. `failures.length`.

### 4. Surfaced in the one place Mat already reads cycle results

`packages/server/src/server.ts`'s `formatIntentResult()` (used by the "run
today's cycle" chat command) gets one more line in its `"cycle"` case:

```typescript
  if (kind === "cycle") {
    const rep = r as { topic?: string; reel?: { hook?: string }; pendingApprovals?: unknown[]; cycleHealth?: { succeeded: number; failed: number; failures: Array<{ step: string; error: string }> } };
    const health = rep.cycleHealth;
    const healthLine = health && health.failed > 0
      ? `\n⚠️ ${health.failed} of ${health.succeeded + health.failed} steps failed: ${health.failures.map((f) => f.step).join(", ")}.`
      : health ? `\n✅ All ${health.succeeded} steps succeeded.` : "";
    return `Done. Topic: ${rep.topic}. Drafted hook: "${rep.reel?.hook ?? ""}". ${rep.pendingApprovals?.length ?? 0} item(s) awaiting your approval.${healthLine}`;
  }
```

No other UI change in this phase — the `/api/runs` endpoint (already shipped)
remains the place to dig into specifics; this just adds the at-a-glance
summary line to what Mat already sees when he asks ATLAS to run a cycle.

### Error handling

- `optional()`'s timeout race means a hung service call always resolves
  (as a recorded failure) within `STEP_TIMEOUT_MS`, never blocking forever.
- `Promise.all` over the intel entries is safe from a "one rejection kills
  the batch" failure mode because every wrapped promise already resolves
  (never rejects) — `optional()`'s own try/catch guarantees that.
- This does not change what happens when `ctx.call()` itself already logs to
  the ledger (Tasks 1-7, unchanged) — `cycleHealth` is a second, independent,
  human-readable summary layer on top, not a replacement.

### Testing

- `packages/orchestrator/test/orchestrator.test.ts`: a new test constructing
  a fake `AtlasContext` (or reusing `packages/app/test/cycle.test.ts`'s real
  `Atlas` instance) where one intel-block service is wired to hang past the
  timeout and another throws immediately — assert `cycleHealth.failed`
  reflects both, `cycleHealth.succeeded` reflects the rest, and the overall
  `runDailyCycle` call still resolves within a bounded time (not proportional
  to the number of independent steps run sequentially).
- `packages/app/test/cycle.test.ts`: existing tests must keep passing
  unchanged — `cycleHealth` is additive to `DailyReport`, not a breaking
  change to its existing fields.
- A new server-level test (or extending `packages/server/test/server.test.ts`)
  confirming `formatIntentResult("cycle", {...})` includes the failure-count
  line when `cycleHealth.failed > 0`, and the all-succeeded line otherwise.

## Explicitly out of scope for this spec

- Per-business scheduling cadence (Mat confirmed: same hourly clock for
  everything, not per-business intervals).
- Any change to the external GitHub Actions cron (`atlas-daily.yml`) — it
  calls the same `runDailyCycle` op, which now behaves better underneath it,
  with no changes needed to the workflow file itself.
- Any UI beyond the one `formatIntentResult` line — no new dashboard, no
  changes to the Living Map (already explicitly deprioritized).
- Persisting `cycleHealth` history over time / trending failure rates — the
  Run Ledger (`/api/runs`) already gives raw historical data if that's ever
  wanted; this spec only adds the point-in-time summary for the CURRENT cycle.
