# Run Ledger + Live Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn ATLAS's existing in-memory-only, pre-call-only `AuditLog` into a persistent run ledger that records what actually happened (not just what was attempted), then make the existing Living Map show live agent status pulled from it.

**Architecture:** Extend `AuditEntry` with `id`/`status`/`endedAt`/`durationMs`/`error`; add a `JsonFileAuditSink` (same pattern as `packages/memory/src/stores.ts`'s `JsonFileStore`); change `Atlas.invoke()`, `ctx.call()`, and `ctx.act()` to record a start entry and a completion entry (success or failure) instead of one static "allow" log; expose `GET /api/runs` and extend `GET /api/map` with `runningAgents`; wire the map's SVG nodes (already has an unused `nodeEls` lookup object) to a polling function that toggles running/failed CSS classes.

**Tech Stack:** TypeScript, Vitest, Node `fs/promises`, existing ATLAS plugin/kernel architecture (`@atlas/core`), vanilla DOM/SVG in `packages/server/src/html.ts`.

---

### Task 1: Extend `AuditEntry` with run-tracking fields + add `AuditLog.query()`

**Files:**
- Modify: `packages/core/src/audit.ts`
- Test: `packages/core/test/audit.test.ts` (new file)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/test/audit.test.ts
import { describe, it, expect } from "vitest";
import { AuditLog } from "../src/audit";

describe("AuditLog.query", () => {
  it("filters entries by actor, status, and time range", async () => {
    const log = new AuditLog();
    await log.record({ id: "1", actor: "cfo", action: "invoke:cfo", decision: "allow", status: "done" });
    await log.record({ id: "2", actor: "gigfinder", action: "invoke:gigfinder", decision: "allow", status: "failed" });
    await log.record({ id: "3", actor: "cfo", action: "invoke:cfo", decision: "allow", status: "running" });

    expect(await log.query({ actor: "cfo" })).toHaveLength(2);
    expect(await log.query({ status: "failed" })).toHaveLength(1);
    expect(await log.query({ actor: "cfo", status: "running" })).toHaveLength(1);
    expect(await log.query({})).toHaveLength(3);
  });

  it("filters by since/until against the entry timestamp", async () => {
    const log = new AuditLog();
    await log.record({ id: "1", actor: "cfo", action: "x", decision: "allow" });
    await new Promise((r) => setTimeout(r, 2));
    const midpoint = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 2));
    await log.record({ id: "2", actor: "cfo", action: "y", decision: "allow" });

    expect(await log.query({ since: midpoint })).toHaveLength(1);
    expect(await log.query({ until: midpoint })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/audit.test.ts`
Expected: FAIL — `log.record` type error (no `id`/`status` fields on `AuditEntry` yet) and `log.query` doesn't exist.

- [ ] **Step 3: Implement the fields and query method**

Replace the full contents of `packages/core/src/audit.ts` with:

```typescript
/**
 * Audit Log — "every decision is logged" (core principle #3).
 *
 * Every action a plugin attempts, every event it emits, every secret it
 * requests, and every Guardian decision flows through here. The sink is
 * pluggable: today it's in-memory or a JSON file — later it can become
 * Postgres — callers never change.
 *
 * Beyond audit trail duty, this doubles as ATLAS's run ledger: a "run" is a
 * matched pair of entries sharing the same `id` — one with `status: "running"`
 * written before a handler executes, one with `status: "done"` or `"failed"`
 * written after. Not every entry is part of a run (e.g. `secret:` and
 * `provide:` entries are single, unpaired log lines) — `status` is only set
 * on entries that represent a trackable run.
 */
export interface AuditEntry {
  /** Present when this entry is (half of) a trackable run; absent for one-off log lines. */
  id?: string;
  timestamp: string;
  /** Who acted: a plugin name, or "kernel"/"owner-console". */
  actor: string;
  /** What was attempted, e.g. "emit:video.rendered" or "invoke:cfo". */
  action: string;
  /** The Guardian's verdict. */
  decision: "allow" | "deny" | "pending";
  /** Result summary or the reason for a deny/pending. */
  outcome?: string;
  metadata?: Record<string, unknown>;
  /** Run lifecycle state — only set on entries that are half of a run pair. */
  status?: "running" | "done" | "failed";
  /** Set on the completion entry of a run. */
  endedAt?: string;
  /** Set on the completion entry of a run. */
  durationMs?: number;
  /** Set on the completion entry of a run that failed. */
  error?: string;
}

export interface AuditSink {
  write(entry: AuditEntry): void | Promise<void>;
  /** Read back everything written so far, in insertion order. */
  readAll(): AuditEntry[] | Promise<AuditEntry[]>;
}

/** Default sink. Swap for a Postgres sink later without touching callers. */
export class MemoryAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];
  write(entry: AuditEntry): void {
    this.entries.push(entry);
  }
  readAll(): AuditEntry[] {
    return this.entries;
  }
}

export interface AuditQuery {
  actor?: string;
  status?: AuditEntry["status"];
  since?: string;
  until?: string;
}

export class AuditLog {
  constructor(private sink: AuditSink = new MemoryAuditSink()) {}

  async record(entry: Omit<AuditEntry, "timestamp"> & { timestamp?: string }): Promise<AuditEntry> {
    const full: AuditEntry = { ...entry, timestamp: entry.timestamp ?? new Date().toISOString() };
    await this.sink.write(full);
    return full;
  }

  /** Introspection helper — only meaningful with the in-memory sink. */
  get entries(): readonly AuditEntry[] {
    return this.sink instanceof MemoryAuditSink ? this.sink.entries : [];
  }

  /**
   * Filter recorded entries. Always reads through `sink.readAll()` — every
   * `AuditSink` (in-memory or file-backed) must honestly implement that
   * method, so `query()` never needs to special-case or guess at a sink's
   * internal shape.
   */
  async query(filter: AuditQuery): Promise<AuditEntry[]> {
    const all = await this.sink.readAll();
    return all.filter((e) => {
      if (filter.actor && e.actor !== filter.actor) return false;
      if (filter.status && e.status !== filter.status) return false;
      if (filter.since && e.timestamp < filter.since) return false;
      if (filter.until && e.timestamp > filter.until) return false;
      return true;
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/audit.test.ts`
Expected: PASS (2 tests — remember every `log.query(...)` call in the test is now `await log.query(...)`, since `query()` is `async`)

- [ ] **Step 5: Run the full core package test suite to check for regressions**

Run: `npx vitest run packages/core/test/`
Expected: PASS — `kernel.test.ts`'s `"stamps a timestamp and stores entries"` test still passes since `record()` still accepts entries without `id`/`status` (both optional).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/audit.ts packages/core/test/audit.test.ts
git commit -m "Add run-tracking fields to AuditEntry and AuditLog.query()"
```

---

### Task 2: Add `JsonFileAuditSink` for persistence

**Files:**
- Modify: `packages/core/src/audit.ts`
- Test: `packages/core/test/audit.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/audit.test.ts`:

```typescript
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileAuditSink } from "../src/audit";

describe("JsonFileAuditSink persistence", () => {
  const file = join(tmpdir(), `atlas-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  afterEach(async () => {
    await rm(file, { force: true });
  });

  it("survives across sink instances (persists to disk)", async () => {
    const log1 = new AuditLog(new JsonFileAuditSink(file));
    await log1.record({ id: "1", actor: "cfo", action: "invoke:cfo", decision: "allow", status: "done" });

    const log2 = new AuditLog(new JsonFileAuditSink(file));
    // Force the second sink to load from disk before querying.
    await log2.record({ id: "2", actor: "gigfinder", action: "invoke:gigfinder", decision: "allow", status: "done" });
    const all = await log2.query({});
    expect(all.map((e) => e.id).sort()).toEqual(["1", "2"]);
  });
});
```

Add the `afterEach` import to the top of the file: `import { describe, it, expect, afterEach } from "vitest";`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/audit.test.ts`
Expected: FAIL — `JsonFileAuditSink` doesn't exist yet.

- [ ] **Step 3: Implement `JsonFileAuditSink`**

Add to `packages/core/src/audit.ts` (after `MemoryAuditSink`):

```typescript
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * JSON-file sink — real persistence with no database, same philosophy as
 * `JsonFileStore` in `@atlas/memory` (that file is the reference pattern this
 * mirrors). Cache loads lazily on first access; every write re-persists the
 * whole array. Fine for ATLAS's single-owner, low-volume run counts — a
 * Postgres sink can replace this later without touching any caller.
 */
export class JsonFileAuditSink implements AuditSink {
  private cache: AuditEntry[] | null = null;

  constructor(private file: string) {}

  private load(): AuditEntry[] {
    if (this.cache) return this.cache;
    try {
      const raw = readFileSync(this.file, "utf8");
      this.cache = JSON.parse(raw) as AuditEntry[];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.cache ?? [], null, 2), "utf8");
  }

  write(entry: AuditEntry): void {
    const all = this.load();
    all.push(entry);
    this.persist();
  }

  readAll(): AuditEntry[] {
    return [...this.load()];
  }
}
```

Note: `AuditLog.query()` (Task 1) always reads through `sink.readAll()` — `JsonFileAuditSink.readAll()` here satisfies that contract directly, no special-casing needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/audit.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Typecheck the whole workspace**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/audit.ts packages/core/test/audit.test.ts
git commit -m "Add JsonFileAuditSink for persistent run tracking"
```

---

### Task 3: `Atlas.invoke()` records a run (start + completion pair)

**Files:**
- Modify: `packages/core/src/atlas.ts:118-123`
- Test: `packages/core/test/services.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/services.test.ts` (uses the existing `provider` plugin and `realishGuardian()` already defined in that file):

```typescript
  it("records a running->done run pair with matching id and a duration on success", async () => {
    const atlas = new Atlas({ guardian: realishGuardian() });
    await atlas.use(provider);
    await atlas.invoke("math", { a: 1, b: 2 });

    const runs = atlas.audit.entries.filter((e) => e.action === "invoke:math");
    expect(runs).toHaveLength(2);
    expect(runs[0]!.status).toBe("running");
    expect(runs[1]!.status).toBe("done");
    expect(runs[0]!.id).toBe(runs[1]!.id);
    expect(typeof runs[1]!.durationMs).toBe("number");
  });

  it("records a running->failed run pair with the error when the service throws", async () => {
    const atlas = new Atlas({ guardian: realishGuardian() });
    await atlas.use({
      manifest: { name: "boom", version: "1", capabilities: ["boom"], permissions: ["*"], role: "executor" },
      register(ctx) {
        ctx.provide("boom", () => {
          throw new Error("kaboom");
        });
      },
    });

    await expect(atlas.invoke("boom", {})).rejects.toThrow("kaboom");
    const runs = atlas.audit.entries.filter((e) => e.action === "invoke:boom");
    expect(runs).toHaveLength(2);
    expect(runs[0]!.status).toBe("running");
    expect(runs[1]!.status).toBe("failed");
    expect(runs[1]!.error).toMatch(/kaboom/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/services.test.ts`
Expected: FAIL — only one entry per invoke exists today (no completion entry), so `runs` has length 1, not 2.

- [ ] **Step 3: Implement start/completion tracking in `Atlas.invoke()`**

Replace `packages/core/src/atlas.ts:112-123` (the `invoke` method) with:

```typescript
  /**
   * OWNER-ONLY: invoke a service directly, bypassing the plugin permission
   * gate. This is the human owner console (core principle #5 — human approval
   * overrides AI: the human is the ultimate authority). Not available to
   * plugins, which must use the guarded `ctx.call`.
   *
   * Records a run: a "running" entry before the handler executes, then a
   * "done" or "failed" completion entry sharing the same `id`, so the audit
   * log doubles as a queryable run history (see `AuditLog.query`).
   */
  async invoke(service: string, payload?: unknown): Promise<unknown> {
    const svc = this.services.get(service);
    if (!svc) throw new Error(`no such service "${service}"`);
    const id = crypto.randomUUID();
    const startedAt = Date.now();
    await this.audit.record({ id, actor: "owner-console", action: `invoke:${service}`, decision: "allow", status: "running" });
    try {
      const result = await svc.handler(payload);
      await this.audit.record({
        id,
        actor: "owner-console",
        action: `invoke:${service}`,
        decision: "allow",
        status: "done",
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        outcome: summarize(result),
      });
      return result;
    } catch (err) {
      await this.audit.record({
        id,
        actor: "owner-console",
        action: `invoke:${service}`,
        decision: "allow",
        status: "failed",
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        error: String(err instanceof Error ? err.message : err),
      });
      throw err;
    }
  }
```

Add this helper near the top of `packages/core/src/atlas.ts`, right after the imports (used by `invoke`, and reused by `call`/`act` in Tasks 4–5):

```typescript
/** Short, safe stringification of a run's result for the audit trail — never the full payload (could be large/sensitive), just enough to recognize what happened at a glance. */
function summarize(value: unknown): string {
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return String(value);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/services.test.ts`
Expected: PASS (existing 4 tests + 2 new = 6 tests)

- [ ] **Step 5: Run the full core suite**

Run: `npx vitest run packages/core/test/`
Expected: PASS — the existing `"lets the owner console invoke a service directly"` test in `services.test.ts` still passes: it only asserts `atlas.audit.entries.some(e => e.actor === "owner-console" && e.action === "invoke:math")`, which is still true (now true of 2 entries instead of 1, `.some` still matches).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/atlas.ts packages/core/test/services.test.ts
git commit -m "Atlas.invoke() records a running->done/failed run pair"
```

---

### Task 4: `ctx.call()` records a run the same way

**Files:**
- Modify: `packages/core/src/atlas.ts` (the `call` handler inside `makeContext`)
- Test: `packages/core/test/services.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/services.test.ts`:

```typescript
  it("records a running->done run pair when one plugin calls another's service", async () => {
    const atlas = new Atlas({ guardian: realishGuardian() });
    await atlas.use(provider);
    await atlas.use({
      manifest: { name: "consumer", version: "1", capabilities: [], permissions: ["call:math"], role: "executor" },
      async register(ctx) {
        await ctx.call("math", { a: 2, b: 3 });
      },
    });

    const runs = atlas.audit.entries.filter((e) => e.action === "call:math" && e.actor === "consumer");
    expect(runs).toHaveLength(2);
    expect(runs[0]!.status).toBe("running");
    expect(runs[1]!.status).toBe("done");
    expect(runs[0]!.id).toBe(runs[1]!.id);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/services.test.ts`
Expected: FAIL — `call` only writes one "allow" entry today, before invoking the handler, with no completion entry.

- [ ] **Step 3: Implement start/completion tracking in `ctx.call()`**

Replace the `call` handler inside `makeContext` in `packages/core/src/atlas.ts` (currently lines 176-189) with:

```typescript
      call: async (service, payload) => {
        const verdict = this.guardian.check(manifest, `call:${service}`);
        if (verdict.decision !== "allow") {
          await this.audit.record({ actor: manifest.name, action: `call:${service}`, decision: verdict.decision, outcome: verdict.reason });
          throw new Error(`Guardian ${verdict.decision}: call:${service} — ${verdict.reason}`);
        }
        const svc = this.services.get(service);
        if (!svc) {
          await this.audit.record({ actor: manifest.name, action: `call:${service}`, decision: "deny", outcome: "no such service" });
          throw new Error(`no such service "${service}"`);
        }
        const id = crypto.randomUUID();
        const startedAt = Date.now();
        await this.audit.record({ id, actor: manifest.name, action: `call:${service}`, decision: "allow", status: "running" });
        try {
          const result = await svc.handler(payload);
          await this.audit.record({
            id,
            actor: manifest.name,
            action: `call:${service}`,
            decision: "allow",
            status: "done",
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            outcome: summarize(result),
          });
          return result;
        } catch (err) {
          await this.audit.record({
            id,
            actor: manifest.name,
            action: `call:${service}`,
            decision: "allow",
            status: "failed",
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            error: String(err instanceof Error ? err.message : err),
          });
          throw err;
        }
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/services.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Run the full core suite**

Run: `npx vitest run packages/core/test/`
Expected: PASS — the existing `"lets one plugin call a service another provides"` test only checks the returned `sum`, unaffected by extra audit entries.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/atlas.ts packages/core/test/services.test.ts
git commit -m "ctx.call() records a running->done/failed run pair"
```

---

### Task 5: Fix `ctx.act()`'s silent-on-failure audit gap

**Files:**
- Modify: `packages/core/src/atlas.ts` (the `act` handler inside `makeContext`)
- Test: `packages/core/test/kernel.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/core/test/kernel.test.ts` (inside the existing `describe("Atlas kernel", ...)` block):

```typescript
  it("still logs a failed completion entry when act()'s run callback throws", async () => {
    const atlas = new Atlas({ guardian: allowAll });
    await atlas.use({
      manifest: { name: "thrower", version: "1", capabilities: [], permissions: [], role: "executor" },
      async register(ctx) {
        await expect(ctx.act("risky-thing", async () => {
          throw new Error("boom");
        })).rejects.toThrow("boom");
      },
    });
    const entries = atlas.audit.entries.filter((e) => e.action === "risky-thing");
    // Before this fix: 0 entries (the throw skipped the only completion log).
    expect(entries.some((e) => e.status === "failed" && e.error?.includes("boom"))).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/test/kernel.test.ts`
Expected: FAIL — today, if `run()` throws inside `ctx.act()`, the exception propagates straight out of `act()` with no audit entry at all (the `audit.record` call after `run()` is never reached), so `ctx.act` itself doesn't even reject with a catchable structure the way this test expects — the throw is unhandled inside the async handler.

- [ ] **Step 3: Implement failure tracking in `ctx.act()`**

Replace the `act` handler inside `makeContext` in `packages/core/src/atlas.ts` (currently lines 149-163) with:

```typescript
      act: async (action, run) => {
        const verdict = this.guardian.check(manifest, action);
        if (verdict.decision !== "allow") {
          await this.audit.record({ actor: manifest.name, action, decision: verdict.decision, outcome: verdict.reason });
          return { decision: verdict.decision, reason: verdict.reason };
        }
        try {
          const result = await run();
          await this.audit.record({ actor: manifest.name, action, decision: "allow", status: "done", outcome: "ok" });
          return { decision: "allow", result };
        } catch (err) {
          await this.audit.record({
            actor: manifest.name,
            action,
            decision: "allow",
            status: "failed",
            error: String(err instanceof Error ? err.message : err),
          });
          throw err;
        }
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/test/kernel.test.ts`
Expected: PASS (existing 3 tests + 1 new = 4 tests)

- [ ] **Step 5: Run the full core suite**

Run: `npx vitest run packages/core/test/`
Expected: PASS — the existing `"does NOT run an action's callback when the Guardian denies it"` test is unaffected (that path doesn't touch the new try/catch).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/atlas.ts packages/core/test/kernel.test.ts
git commit -m "Fix ctx.act() silently dropping the audit trail when run() throws"
```

---

### Task 6: Wire persistent audit storage into the real running server

**Files:**
- Modify: `packages/app/src/build.ts`
- Modify: `packages/server/src/server.ts:328-339`
- Test: `packages/app/test/skeleton.test.ts` (verify no regression, no new test needed — this task is wiring, covered by Tasks 1-5's unit tests plus the manual verification in Task 9)

- [ ] **Step 1: Add `auditFile` to `AtlasOptions` and wire it in `buildAtlas`**

In `packages/app/src/build.ts`, add the import:

```typescript
import { Atlas, AuditLog, JsonFileAuditSink } from "@atlas/core";
```

(This replaces the existing `import { Atlas } from "@atlas/core";` line — `AuditLog` and `JsonFileAuditSink` are added to the same import.)

Add to the `AtlasOptions` interface (after `memoryFile?: string;`):

```typescript
  /** Where the run ledger persists to disk. Defaults to in-memory-only (safe for tests) when omitted. */
  auditFile?: string;
```

Replace the line `const atlas = new Atlas({ guardian: new Guardian() });` with:

```typescript
  const atlas = new Atlas({
    guardian: new Guardian(),
    audit: opts.auditFile ? new AuditLog(new JsonFileAuditSink(opts.auditFile)) : undefined,
  });
```

- [ ] **Step 2: Point the real server at a real file**

In `packages/server/src/server.ts`, inside the `buildAtlas({...})` call at line 328, add one line (matching the existing `memoryFile`/`approvalsFile` style):

```typescript
    atlas = await buildAtlas({
      brainAdapters: opts.brainAdapters,
      memoryFile: `${dataDir}/memory.json`,
      approvalsFile: `${dataDir}/approvals.json`,
      metricsFile: `${dataDir}/metrics.json`,
      businessFile: `${dataDir}/businesses.json`,
      gigFile: `${dataDir}/gigs.json`,
      toolVaultFile: `${dataDir}/toolvault.json`,
      skillsFile: `${dataDir}/skills.json`,
      auditFile: `${dataDir}/audit-log.json`,
      forgeDir: "./forge",
      publisher: livePublisher,
    });
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors

- [ ] **Step 4: Run the full app + server test suites to confirm no regression**

Run: `npx vitest run packages/app/test/ packages/server/test/`
Expected: PASS — every existing `buildAtlas({...})` call in tests omits `auditFile`, so `opts.auditFile` is `undefined` and `audit` stays `undefined` → `Atlas`'s own default (`new AuditLog()`, in-memory) applies exactly as before. No test starts writing real files to disk.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/build.ts packages/server/src/server.ts
git commit -m "Wire persistent JsonFileAuditSink into the real running server"
```

---

### Task 7: `GET /api/runs` endpoint

**Files:**
- Modify: `packages/server/src/server.ts`
- Test: `packages/server/test/server.test.ts`

`packages/server/test/server.test.ts` already establishes the exact pattern to follow: `start()` boots a real `createControlPanel(...)` instance on an ephemeral port into module-level `panel`/`base`, and top-level `get(path, token)` / `post(path, body, token)` helpers (lines 12-27) wrap `fetch` against it. Every test calls `await start()` first, then `POST /api/setup` to obtain an unlock token, then passes that token to subsequent authed calls (see the `"sets up a vault..."` test at line 42 for the exact shape). This new test follows that identical shape.

- [ ] **Step 1: Write the failing test**

Add to `packages/server/test/server.test.ts`, inside the existing `describe("control panel", ...)` block:

```typescript
  it("GET /api/runs lists ledger entries, filterable by status", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    // The stub-brain chat call below goes through Atlas.invoke("brain", ...) and
    // Atlas.invoke("memory", ...) internally, which is enough to populate the ledger.
    await post("/api/chat", { message: "hello ATLAS", history: [] }, token);

    const res = await get("/api/runs?limit=50", token);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { runs: Array<{ status: string; actor: string }> };
    expect(Array.isArray(data.runs)).toBe(true);
    expect(data.runs.some((r) => r.actor === "owner-console" && r.status === "done")).toBe(true);

    const failedOnly = await get("/api/runs?status=failed", token);
    const failedData = (await failedOnly.json()) as { runs: unknown[] };
    expect(failedData.runs).toHaveLength(0); // nothing failed in this test run
  });

  it("blocks GET /api/runs when locked", async () => {
    await start();
    expect((await get("/api/runs")).status).toBe(401);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/test/server.test.ts`
Expected: FAIL — both new tests fail with a 404 (route doesn't exist yet).

- [ ] **Step 3: Implement the endpoint**

Add to `packages/server/src/server.ts`, right after the existing `/api/map` handler (around line 1291):

```typescript
    if (method === "GET" && path === "/api/runs") {
      if (!authed(req)) return send(res, 401, { error: "locked — unlock first" });
      const a = await ensureAtlas();
      const params = new URL(req.url ?? "", "http://x").searchParams;
      const filter = {
        actor: params.get("agent") ?? undefined,
        status: (params.get("status") as "running" | "done" | "failed" | null) ?? undefined,
        since: params.get("since") ?? undefined,
        until: params.get("until") ?? undefined,
      };
      const limit = Number(params.get("limit") ?? 50);
      const runs = (await a.audit.query(filter))
        .filter((e) => e.status) // only entries that represent a trackable run, not one-off log lines
        .slice(-limit)
        .reverse(); // most recent first, matching /api/chats' existing convention
      return send(res, 200, { runs });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/test/server.test.ts`
Expected: PASS (existing 9 tests + 2 new = 11 tests)

- [ ] **Step 5: Run the full server suite**

Run: `npx vitest run packages/server/test/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/server.ts packages/server/test/server.test.ts
git commit -m "Add GET /api/runs endpoint over the run ledger"
```

---

### Task 8: Extend `GET /api/map` with `runningAgents`

**Files:**
- Modify: `packages/server/src/server.ts:1287-1291`
- Test: `packages/server/test/server.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/server/test/server.test.ts`, inside `describe("control panel", ...)`:

```typescript
  it("GET /api/map includes runningAgents from the ledger", async () => {
    await start();
    const { token } = (await (await post("/api/setup", { masterPassword: "master-passphrase" })).json()) as { token: string };
    const res = await get("/api/map", token);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { runningAgents: string[] };
    expect(Array.isArray(data.runningAgents)).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/test/server.test.ts`
Expected: FAIL — `data.runningAgents` is `undefined`.

- [ ] **Step 3: Implement**

Replace the `/api/map` handler (`packages/server/src/server.ts:1287-1291`) with:

```typescript
    if (method === "GET" && path === "/api/map") {
      const a = await ensureAtlas();
      const businesses = (await a.invoke("business", { op: "listBusinesses" })) as Array<{ name: string }>;
      const runningAgents = [...new Set((await a.audit.query({ status: "running" })).map((e) => e.actor))];
      return send(res, 200, { agents: a.loaded(), businesses: businesses.map((b) => b.name), runningAgents });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/server/test/server.test.ts`
Expected: PASS (existing 11 tests + 1 new = 12 tests)

- [ ] **Step 5: Run the full server suite**

Run: `npx vitest run packages/server/test/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/server.ts packages/server/test/server.test.ts
git commit -m "Extend GET /api/map with live runningAgents from the ledger"
```

---

### Task 9: Live map — wire node lookup, pulse/fail CSS, and polling

**Files:**
- Modify: `packages/server/src/html.ts`

This task is UI/DOM code embedded in a template literal — not unit-testable the way Tasks 1–8 are (no DOM test harness in this codebase; verification is the served-page parse check plus a manual browser check, per existing project convention documented in `packages/server/test/page-script.test.ts` and the project's own html.ts escaping notes). Follow the exact escaping rule already established for this file: every backslash that needs to survive as a literal backslash-escape in the served script must be DOUBLE-backslashed in this .ts source (regex shorthand, `\n`, `\"`, etc.) — only a literal backtick uses a single backslash. Verify empirically after editing (Step 5), never by eye.

- [ ] **Step 1: Add CSS for pulse/fail states**

In `packages/server/src/html.ts`, find the existing map CSS block (around line 86-89, the `#mapSvg` rules) and add directly after it:

```css
  #mapSvg .node.running circle { animation: nodePulse 1.4s ease-in-out infinite; }
  #mapSvg .node.failed circle { animation: nodeFail 1.8s ease-out 1; }
  @keyframes nodePulse { 0%,100% { filter: drop-shadow(0 0 5px currentColor); } 50% { filter: drop-shadow(0 0 14px currentColor); transform: scale(1.15); transform-origin: center; } }
  @keyframes nodeFail { 0% { filter: drop-shadow(0 0 5px #ef4444); } 50% { filter: drop-shadow(0 0 18px #ef4444); } 100% { filter: drop-shadow(0 0 5px currentColor); } }
```

- [ ] **Step 2: Populate the existing (currently unused) `nodeEls` lookup**

In the `renderMap()` function, the line `const links=[]; const nodeEls={};` (around line 712) already declares `nodeEls` but nothing ever writes to it. Find the `addNode` function definition (around line 731) and the two lines that call it for agents (around line 739):

Current:
```javascript
  A.forEach(a=>addNode(a, 7, MAP_COLORS[a.group], a.name, "agent"));
```

Replace with:
```javascript
  A.forEach(a=>{ const g=addNode(a, 7, MAP_COLORS[a.group], a.name, "agent"); nodeEls[a.name]=g.closest("g"); });
```

(`addNode` returns the `<circle>` element `c`; `.closest("g")` gets the wrapping `<g class="node">` group, since the CSS in Step 1 targets `.node.running circle` / `.node.failed circle` — the running/failed class toggles on the outer `<g>`.)

- [ ] **Step 3: Add the polling function**

Add this new function directly after `renderMap()` (after its closing `}` around line 745):

```javascript
let mapPollTimer = null;
let lastFailedAgents = new Set();
async function pollMapStatus(){
  if (!mapDone) return; // structural render hasn't happened yet (or failed) — nothing to update
  let data; try { data = await api("/api/map"); } catch(e){ return; }
  const running = new Set(data.runningAgents||[]);
  for (const name in nodeEls){
    const g = nodeEls[name];
    if (!g) continue;
    g.classList.toggle("running", running.has(name));
  }
}
function startMapPolling(){
  if (mapPollTimer) return;
  mapPollTimer = setInterval(pollMapStatus, 5000);
  pollMapStatus();
}
function stopMapPolling(){
  if (mapPollTimer){ clearInterval(mapPollTimer); mapPollTimer=null; }
}
```

- [ ] **Step 4: Start/stop polling with the map tab's visibility**

The nav tab switcher (`packages/server/src/html.ts`, inside `document.querySelectorAll("nav button[data-tab]").forEach(b => b.onclick = () => {...})`) has one line per tab:

```javascript
  if (b.dataset.tab==="map") renderMap();
```

Replace that exact line with:

```javascript
  if (b.dataset.tab==="map") { renderMap(); startMapPolling(); } else { stopMapPolling(); }
```

This starts polling every time the map tab is opened (idempotent — `startMapPolling` no-ops if already running) and stops it the instant any other tab is clicked, so the map doesn't keep polling in the background while Mat is looking at a different tab.

- [ ] **Step 5: Verify the served page still parses**

Run:
```bash
npx tsc -p tsconfig.json --noEmit
```
Expected: no errors.

Then, with the local ATLAS server running (`npx tsx packages/server/src/main.ts` in the background), run:
```bash
curl -s http://localhost:4317/ | awk '/<script>/{f=1;next}/<\/script>/{f=0}f' > /tmp/p.js && node --check /tmp/p.js && echo "SCRIPT OK"
```
Expected: `SCRIPT OK` — if this fails, re-check every new line added in Steps 1–4 against the file's established double-backslash escaping rule before proceeding.

- [ ] **Step 6: Manual browser verification**

Using the Browser pane tool:
1. Navigate to the running local ATLAS instance, click the "map" nav tab.
2. Confirm no console errors (`read_console_messages`).
3. Trigger a real run (e.g. send a chat message that hits `routeChatIntent`, or POST `/api/cycle`) and, within 5 seconds, confirm via `read_page` or a screenshot that the corresponding node picked up the `running` class (or, more simply, call `GET /api/map` directly and confirm `runningAgents` reflects the in-flight run).
4. Hover a node and confirm the existing hover behavior (nerve highlight, `mapInfo` text) still works unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/html.ts
git commit -m "Living Map shows live running/failed agent status from the run ledger"
```

---

### Task 10: Full verification, deploy, and close out

**Files:** none (verification + deployment only)

- [ ] **Step 1: Full typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all test files pass (should be the prior full-suite count plus the ~9 new tests added across Tasks 1, 2, 3, 4, 5, 7, 8)

- [ ] **Step 3: Deploy to the VPS**

```bash
tar --exclude=node_modules -czf /tmp/atlas-runledger.tar.gz packages/core packages/app packages/server
scp -i ~/.ssh/atlas_deploy /tmp/atlas-runledger.tar.gz root@72.62.168.207:/tmp/
ssh -i ~/.ssh/atlas_deploy root@72.62.168.207 "cd /opt/atlas/app && tar -xzf /tmp/atlas-runledger.tar.gz && rm /tmp/atlas-runledger.tar.gz && docker restart atlas && sleep 6 && curl -s http://localhost:4317/api/health && echo"
```

Expected: `{"ok":true,"initialized":true,"unlocked":false}`

- [ ] **Step 4: Verify the cloud instance too**

```bash
curl -s https://atlas.evervibesdigital.com/api/health && echo
```

Expected: same healthy response.

- [ ] **Step 5: Update memory**

This phase (Run Ledger + Live Map) is the first of the "ATLAS closer to Paperclip" roadmap (ledger → live map → Tasks/Issues tracker → per-agent run history → budget view → org hierarchy/goals). Update `project_atlas_state.md` (or add a new `project_atlas_paperclip_direction.md` memory file) noting: phase 0+1 shipped, remaining phases 2-5 still ahead, and the roadmap shape, so a future session picks up the thread correctly.
