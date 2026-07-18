# Self-Healing Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ATLAS's self-healing (`codebase.heal`) actually detect, fix, verify, and commit its own typecheck errors — and run automatically every orchestrator cycle instead of only on manual trigger.

**Architecture:** Generalize the existing safe-apply pattern from `packages/server/src/self-improve.ts` (backup → write → whole-workspace typecheck → auto-rollback) into `packages/codebase/src/healer.ts`, keyed off real error file paths from `detectErrors()` instead of a fixed target whitelist, with extra guardrails (file-size cap, diff-size cap, excluded paths) since healing runs unattended. Wire it into `packages/orchestrator/src/plugin.ts`'s existing `optional()`-wrapped parallel cycle-step block (built in the 2026-07-17 Cycle Isolation project) so it participates in `cycleHealth` automatically, and surface a one-line summary in the chat cycle report.

**Tech Stack:** TypeScript, Node.js (`node:child_process`, `node:fs/promises`), Vitest, existing ATLAS plugin/kernel architecture (`@atlas/core`).

---

### Task 1: Rewrite `healer.ts` with a working, safe fix-apply flow

**Files:**
- Modify: `packages/codebase/src/healer.ts` (full rewrite)
- Test: `packages/codebase/test/healer.test.ts` (new)

**Context:** The current `healer.ts` has two bugs that make it non-functional: `suggestFix()`'s LLM output is never written to disk, and `verifyFix()`'s 30-second typecheck timeout doesn't match the 180-second timeout `self-improve.ts` needs for the same command on this monorepo. This task replaces `suggestFix`/`verifyFix`/the old `commitFix` with a single safe `generateAndApplyFix()`, and fixes `detectErrors()`'s error parsing and `commitFix()`'s git scoping. The typecheck command is injectable (`typecheckCmd` parameter, default `"pnpm run typecheck"`) specifically so tests can substitute a fast fake command instead of running a real TypeScript compile.

- [ ] **Step 1: Write the failing tests**

Create `packages/codebase/test/healer.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectErrors, generateAndApplyFix, type CodeError } from "../src/healer";

const run = promisify(execFile);
let dir = "";

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function initRepo(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "atlas-heal-"));
  await run("git", ["-C", d, "init"]);
  await run("git", ["-C", d, "config", "user.email", "t@t"]);
  await run("git", ["-C", d, "config", "user.name", "t"]);
  return d;
}

const OK_CMD = process.platform === "win32" ? "node -e \"process.exit(0)\"" : "node -e 'process.exit(0)'";
const FAIL_CMD = process.platform === "win32" ? "node -e \"process.exit(1)\"" : "node -e 'process.exit(1)'";

describe("generateAndApplyFix", () => {
  it("writes the fix, verifies it, and commits scoped to just the healed file", async () => {
    dir = await initRepo();
    await writeFile(join(dir, "broken.ts"), "export const x: number = 'oops';\n");
    await writeFile(join(dir, "untouched.ts"), "export const y = 1;\n");
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", ["-C", dir, "commit", "-m", "init"]);

    // Simulate Mat having an unrelated dirty edit in progress — must survive untouched.
    await writeFile(join(dir, "untouched.ts"), "export const y = 2; // WIP, not committed\n");

    const error: CodeError = { type: "typecheck", file: "broken.ts", message: "Type 'string' is not assignable to type 'number'." };
    const brainCall = async () => "export const x: number = 42;\n";

    const attempt = await generateAndApplyFix(dir, error, brainCall, OK_CMD);

    expect(attempt.outcome).toBe("healed");
    expect(attempt.commit).toBeTruthy();
    expect(await readFile(join(dir, "broken.ts"), "utf8")).toBe("export const x: number = 42;\n");

    const status = await run("git", ["-C", dir, "status", "--short"]);
    // Only the WIP edit to untouched.ts should remain uncommitted — broken.ts must not appear.
    expect(status.stdout).not.toContain("broken.ts");
    expect(status.stdout).toContain("untouched.ts");

    const log = await run("git", ["-C", dir, "log", "-1", "--format=%s"]);
    expect(log.stdout).toContain("auto-heal");
  });

  it("rolls back and reports verify_failed when the written fix still fails verification", async () => {
    dir = await initRepo();
    await writeFile(join(dir, "broken.ts"), "export const x: number = 'oops';\n");
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", ["-C", dir, "commit", "-m", "init"]);

    const error: CodeError = { type: "typecheck", file: "broken.ts", message: "Type error." };
    const brainCall = async () => "export const x: number = 'still wrong';\n";

    const attempt = await generateAndApplyFix(dir, error, brainCall, FAIL_CMD);

    expect(attempt.outcome).toBe("verify_failed");
    // File must be rolled back to the ORIGINAL content, not left with the bad fix.
    expect(await readFile(join(dir, "broken.ts"), "utf8")).toBe("export const x: number = 'oops';\n");
    const log = await run("git", ["-C", dir, "log", "-1", "--format=%s"]);
    expect(log.stdout).toContain("init"); // no auto-heal commit was made
  });

  it("skips files over the size cap without calling the brain", async () => {
    dir = await initRepo();
    const bigFile = Array.from({ length: 401 }, (_, i) => `// line ${i}`).join("\n") + "\n";
    await writeFile(join(dir, "big.ts"), bigFile);
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", ["-C", dir, "commit", "-m", "init"]);

    let called = false;
    const brainCall = async () => { called = true; return "should not be used"; };
    const error: CodeError = { type: "typecheck", file: "big.ts", message: "some error" };

    const attempt = await generateAndApplyFix(dir, error, brainCall, OK_CMD);

    expect(attempt.outcome).toBe("skipped");
    expect(called).toBe(false);
    expect(await readFile(join(dir, "big.ts"), "utf8")).toBe(bigFile);
  });

  it("rejects a fix that rewrites too much of the file", async () => {
    dir = await initRepo();
    const original = Array.from({ length: 20 }, (_, i) => `const line${i} = ${i};`).join("\n") + "\n";
    await writeFile(join(dir, "broken.ts"), original);
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", ["-C", dir, "commit", "-m", "init"]);

    const brainCall = async () => "import x from 'y';\nexport default function totally() { return 'different'; }\n";
    const error: CodeError = { type: "typecheck", file: "broken.ts", message: "some error" };

    const attempt = await generateAndApplyFix(dir, error, brainCall, OK_CMD);

    expect(attempt.outcome).toBe("skipped");
    expect(await readFile(join(dir, "broken.ts"), "utf8")).toBe(original);
  });
});

describe("detectErrors", () => {
  it("parses tsc-style error output and filters out excluded paths", async () => {
    dir = await initRepo();
    const fakeTsc = [
      "node -e \"console.log(String.raw`src/foo.ts(3,5): error TS2322: Type mismatch.`);",
      "console.log(String.raw`node_modules/bar/x.ts(1,1): error TS1000: ignore me.`);",
      "process.exit(1)\"",
    ].join(" ");

    const errors = await detectErrors(dir, fakeTsc);

    expect(errors).toHaveLength(1);
    expect(errors[0]!.file).toBe("src/foo.ts");
    expect(errors[0]!.message).toBe("Type mismatch.");
  });

  it("returns no errors when the typecheck command succeeds", async () => {
    dir = await initRepo();
    const errors = await detectErrors(dir, OK_CMD);
    expect(errors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/codebase && npx vitest run test/healer.test.ts`
Expected: FAIL — `../src/healer` doesn't export `generateAndApplyFix`, `CodeError` shape doesn't match.

- [ ] **Step 3: Rewrite `packages/codebase/src/healer.ts`**

```typescript
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";

const run = promisify(exec);
const runFile = promisify(execFile);

/**
 * Self-healing layer — ATLAS detects TypeScript compile errors, generates a
 * fix via the Brain, verifies the fix by re-running the whole-workspace
 * typecheck, and commits it. Mirrors the safe-apply contract in
 * packages/server/src/self-improve.ts (backup -> write -> typecheck ->
 * auto-rollback), generalized to any file (keyed off real detected errors)
 * instead of a fixed target whitelist, with extra guardrails since this runs
 * unattended every cycle rather than behind a human approval click.
 */

export interface CodeError {
  type: "typecheck";
  file: string;
  message: string;
}

export interface HealAttempt {
  error: CodeError;
  outcome: "healed" | "verify_failed" | "skipped" | "generate_failed";
  detail: string;
  commit?: string;
}

const EXCLUDED_PATH_PATTERNS = [/node_modules/, /\.git[\\/]/, /vault/i, /\.env/, /secrets/i];
const MAX_FILE_LINES = 400;
const MAX_CHANGED_LINE_RATIO = 0.3;
const DEFAULT_TYPECHECK_CMD = "pnpm run typecheck";
const TYPECHECK_TIMEOUT_MS = 180_000;

/**
 * Run the workspace typecheck and parse any `error TSxxxx` lines into
 * structured errors. `typecheckCmd` is injectable so tests can substitute a
 * fast fake command instead of a real multi-package TypeScript compile.
 */
export async function detectErrors(repoRoot: string, typecheckCmd: string = DEFAULT_TYPECHECK_CMD): Promise<CodeError[]> {
  const errors: CodeError[] = [];

  try {
    await run(typecheckCmd, { cwd: repoRoot, timeout: TYPECHECK_TIMEOUT_MS });
  } catch (e) {
    const output = String((e as { stdout?: string }).stdout ?? (e as Error).message);
    for (const line of output.split("\n")) {
      const match = line.match(/^(.+?)\((\d+),(\d+)\):\s*error\s+TS\d+:\s*(.+)$/);
      if (match) {
        errors.push({ type: "typecheck", file: (match[1] as string).trim(), message: (match[4] as string).trim() });
      }
    }
  }

  return errors.filter((e) => !EXCLUDED_PATH_PATTERNS.some((p) => p.test(e.file)));
}

/**
 * Generate a full-file fix via the Brain, sanity-check it, write it, verify
 * with a whole-workspace typecheck, and roll back automatically on failure.
 * Never diffs/patches — a complete file is the safety boundary, same as
 * self-improve.ts.
 */
export async function generateAndApplyFix(
  repoRoot: string,
  error: CodeError,
  brainCall: (prompt: string) => Promise<string>,
  typecheckCmd: string = DEFAULT_TYPECHECK_CMD,
): Promise<HealAttempt> {
  const filePath = isAbsolute(error.file) ? error.file : join(repoRoot, error.file);

  let original: string;
  try {
    original = await readFile(filePath, "utf8");
  } catch {
    return { error, outcome: "skipped", detail: "could not read file" };
  }

  const lineCount = original.split("\n").length;
  if (lineCount > MAX_FILE_LINES) {
    return { error, outcome: "skipped", detail: `file too large to safely auto-rewrite (${lineCount} lines)` };
  }

  const prompt = `This TypeScript file has a compile error.
File: ${error.file}
Error: ${error.message}

Full current file contents:
\`\`\`typescript
${original}
\`\`\`

Return the COMPLETE corrected file contents. No markdown fences, no explanation — just the fixed file, in full, ready to write to disk.`;

  let fixed: string;
  try {
    fixed = (await brainCall(prompt)).trim();
    if (fixed.startsWith("```")) fixed = fixed.split("\n").slice(1, -1).join("\n");
  } catch (e) {
    return { error, outcome: "generate_failed", detail: (e as Error).message };
  }

  if (fixed.length < 20 || !/\b(import|export)\b/.test(fixed)) {
    return { error, outcome: "skipped", detail: "generated fix is not a complete module — rejected for safety" };
  }

  if (diffLineRatio(original, fixed) > MAX_CHANGED_LINE_RATIO) {
    return { error, outcome: "skipped", detail: "fix changes too much of the file — rejected as too broad" };
  }

  try {
    await writeFile(filePath, fixed, "utf8");
    await run(typecheckCmd, { cwd: repoRoot, timeout: TYPECHECK_TIMEOUT_MS });
  } catch (e) {
    await writeFile(filePath, original, "utf8");
    const detail = String((e as { stdout?: string; message?: string }).stdout ?? (e as Error).message).slice(0, 300);
    return { error, outcome: "verify_failed", detail };
  }

  const commit = await commitFix(repoRoot, error);
  return commit
    ? { error, outcome: "healed", detail: "typecheck passed", commit }
    : { error, outcome: "verify_failed", detail: "typecheck passed but commit failed" };
}

/** Fraction of lines that differ between two file contents (0 = identical). Index-aligned, not a real diff — a conservative approximation that's fine here since the only consequence of over-estimating is an unnecessary "skipped" (safe), never an unsafe write. */
function diffLineRatio(a: string, b: string): number {
  const linesA = a.split("\n");
  const linesB = b.split("\n");
  const max = Math.max(linesA.length, linesB.length, 1);
  let same = 0;
  for (let i = 0; i < Math.min(linesA.length, linesB.length); i++) {
    if (linesA[i] === linesB[i]) same++;
  }
  return 1 - same / max;
}

/** Commit only the healed file — never `git add -A`, which would sweep up any unrelated work in progress. Uses execFile (no shell) so error/file text can never be interpreted as shell syntax. */
export async function commitFix(repoRoot: string, error: CodeError): Promise<string | null> {
  try {
    await runFile("git", ["-C", repoRoot, "add", error.file]);
    await runFile("git", ["-C", repoRoot, "commit", "-m", `auto-heal: fix ${error.type} error in ${error.file}`]);
    const result = await runFile("git", ["-C", repoRoot, "rev-parse", "HEAD"]);
    return (result.stdout || "").trim();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/codebase && npx vitest run test/healer.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/codebase/src/healer.ts packages/codebase/test/healer.test.ts
git commit -m "fix: make self-healing actually apply and verify fixes"
```

---

### Task 2: Update the codebase plugin's `heal` op to use the fixed healer

**Files:**
- Modify: `packages/codebase/src/plugin.ts:14-61`

**Context:** The plugin's `heal` op currently calls the old `suggestFix`/`verifyFix`/`commitFix` loop. Replace it with `generateAndApplyFix`, capped at 2 attempts per invocation (bounds worst-case wall-clock time once this runs automatically every cycle — see Task 3).

- [ ] **Step 1: Replace the `heal` branch**

In `packages/codebase/src/plugin.ts`, replace line 2's import and the entire `if (cmd.op === "heal") { ... }` block (lines 17-61):

```typescript
import { detectErrors, generateAndApplyFix, type HealAttempt } from "./healer";
```

```typescript
        if (cmd.op === "heal") {
          const errors = await detectErrors(cmd.dir);
          if (!errors.length) return { healed: 0, attempted: 0, total: 0, errors: [] };

          const attempts: HealAttempt[] = [];
          for (const err of errors.slice(0, 2)) {
            const brainCall = async (prompt: string): Promise<string> => {
              const r = (await ctx.call("brain", {
                prompt,
                system: "You are ATLAS's code fixer. Return only the complete corrected file.",
                needs: { coding: 0.9, reasoning: 0.7 },
                maxTokens: 3000,
                task: "codebase.heal",
              })) as { text: string };
              return r.text;
            };
            const attempt = await generateAndApplyFix(cmd.dir, err, brainCall);
            attempts.push(attempt);
            if (attempt.outcome === "healed") {
              try {
                await ctx.call("memory", {
                  op: "remember",
                  input: {
                    kind: "event",
                    content: `ATLAS auto-healed a typecheck error in ${err.file}: ${err.message.slice(0, 100)}`,
                    metadata: { type: "self-heal", file: err.file, commit: attempt.commit },
                  },
                });
              } catch {
                /* memory optional */
              }
            }
          }

          const healed = attempts.filter((a) => a.outcome === "healed").length;
          await ctx.emit("codebase.healed", { healed, attempted: attempts.length, total: errors.length });
          return { healed, attempted: attempts.length, total: errors.length, errors: attempts };
        }
```

- [ ] **Step 2: Typecheck**

`packages/codebase` has no dedicated `tsconfig.json` — the whole workspace typechecks through the root `tsconfig.json` via one command. Run from the repo root: `pnpm run typecheck`
Expected: no errors

- [ ] **Step 3: Run the codebase package's existing + new tests**

Run: `cd packages/codebase && npx vitest run`
Expected: PASS (codebase.test.ts + healer.test.ts, no regressions)

- [ ] **Step 4: Commit**

```bash
git add packages/codebase/src/plugin.ts
git commit -m "fix: wire codebase.heal op to the corrected healer, capped at 2 attempts"
```

---

### Task 3: Wire healing into the orchestrator cycle

**Files:**
- Modify: `packages/orchestrator/src/core.ts` (add `healReport` to `DailyReport`)
- Modify: `packages/orchestrator/src/plugin.ts` (add `healEnabled` option + heal step)
- Modify: `packages/app/test/cycle.test.ts` (existing 3 tests opt out for speed; 1 new test verifies wiring)

**Context:** `optional()` and `CycleHealthTracker` already exist (Cycle Isolation project). This task adds one more step to the existing parallel intel block. Because `codebase.heal` shells out to a real (up to 180s) typecheck, and the existing offline test suite must stay fast/deterministic (same reasoning as the `renderer`/`brainAdapters` test overrides already documented in `packages/app/src/build.ts`), the step needs an opt-out: `healEnabled` (default `true` in production, explicitly set `false` in the 3 pre-existing fast tests).

- [ ] **Step 1: Add `healReport` to `DailyReport`**

In `packages/orchestrator/src/core.ts`, add this field to the `DailyReport` interface (after the existing `cycleHealth?` field, around line 70):

```typescript
  /** Self-healing outcome for this cycle, if the heal step ran and didn't
   * time out/fail (in which case it's simply absent — `cycleHealth.failures`
   * already records that). Optional for the same reason `cycleHealth` is. */
  healReport?: { healed: number; attempted: number; total: number };
```

- [ ] **Step 2: Add `healEnabled` option and the heal step to the orchestrator plugin**

In `packages/orchestrator/src/plugin.ts`, change the function signature (line 23):

```typescript
export function createOrchestratorPlugin(opts: { defaultPersona?: string; healEnabled?: boolean } = {}): Plugin {
  const defaultPersona = opts.defaultPersona ?? "@everspark.ai";
  const healEnabled = opts.healEnabled ?? true;
```

Add `"call:codebase"` to the `permissions` array (alongside the existing `"call:mediaFactory"` entry).

In the `Promise.all` block (lines 137-164), add the heal call and destructure it:

```typescript
        const [curiosity, repoScout, freeTools, github, tidy, newsletters, gigs, kdpScan, kdpGenerate, mediaFactory, healResult] = await Promise.all([
          optional<unknown>(ctx.call, "curiosity", { op: "ideas" }, health),
          optional<unknown>(ctx.call, "search", { op: "scout", query: "autonomous AI agent framework OR MCP server OR open-source LLM tools", max: 6 }, health),
          optional<unknown>(ctx.call, "search", { op: "freeApis", topic: "content automation, AI agents, and social posting" }, health),
          optional<unknown>(ctx.call, "connectors", { op: "sync", which: "github" }, health),
          optional<unknown>(ctx.call, "janitor", { op: "tidy" }, health),
          optional<unknown>(ctx.call, "newsletter", { op: "readDaily" }, health),
          optional<unknown>(ctx.call, "gigfinder", { op: "search", sources: ["web"] }, health),
          optional<unknown>(ctx.call, "kdp", { op: "scan" }, health),
          optional<unknown>(ctx.call, "kdp", { op: "generate", limit: 3 }, health),
          optional<unknown>(ctx.call, "mediaFactory", { op: "autoCycle" }, health),
          // Self-healing — detect and auto-fix typecheck errors in ATLAS's own
          // code. 400s (vs the 90s default) because this can run up to two
          // full 180s workspace typechecks back to back. Disabled in tests
          // (healEnabled: false) so the offline suite stays fast — see
          // packages/app/test/cycle.test.ts.
          healEnabled
            ? optional<{ healed: number; attempted: number; total: number }>(ctx.call, "codebase", { op: "heal", dir: process.cwd() }, health, 400_000)
            : Promise.resolve(undefined),
        ]);
```

Update the `intel` object (lines 165-176) — no change needed there (`healResult` is reported separately, not part of `intel`).

In the `report` construction (lines 182-199), add `healReport`:

```typescript
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
          healReport: healResult,
        };
```

- [ ] **Step 3: Update the 3 existing `cycle.test.ts` tests to opt out of healing**

In `packages/app/test/cycle.test.ts`, add `healEnabled: false` to all three existing `runDailyCycle({...})` calls (the ones at lines 15-21, 33-39, and 46-52):

```typescript
    const report = await runDailyCycle({
      memoryStore: new InMemoryStore(),
      approvalsGateway: new ApprovalGateway(),
      metricsTracker: new MetricsTracker(),
      brainAdapters: [new StubAdapter()],
      renderer: new NoOpRenderer(),
      healEnabled: false,
    });
```

(apply the same `healEnabled: false` addition to all three calls — the second one has no `renderer` line, add `healEnabled: false` as its own new line there too)

- [ ] **Step 4: Add a new test proving the heal step wires into `healReport`**

Append to `packages/app/test/cycle.test.ts`, inside the existing `describe("autonomous daily cycle", ...)` block:

```typescript
  it(
    "runs self-healing when enabled and reports the outcome",
    async () => {
      const report = await runDailyCycle({
        memoryStore: new InMemoryStore(),
        approvalsGateway: new ApprovalGateway(),
        metricsTracker: new MetricsTracker(),
        brainAdapters: [new StubAdapter()],
        renderer: new NoOpRenderer(),
        healEnabled: true,
      });

      // This repo should typecheck cleanly, so healing finds nothing to fix —
      // this test proves the WIRING (the step ran and its result reached the
      // report), not the fix-generation logic itself (covered by
      // packages/codebase/test/healer.test.ts with fast fake commands).
      if (report.healReport) {
        expect(typeof report.healReport.healed).toBe("number");
        expect(typeof report.healReport.attempted).toBe("number");
        expect(typeof report.healReport.total).toBe("number");
      }
      // Either it ran (healReport present) or it failed/timed out and shows
      // up in cycleHealth.failures instead — never both silent.
      const healFailed = report.cycleHealth?.failures.some((f) => f.step === "codebase");
      expect(report.healReport !== undefined || healFailed).toBe(true);
    },
    { timeout: 200_000 },
  );
```

- [ ] **Step 5: Typecheck**

Run: `pnpm run typecheck` (from repo root)
Expected: no errors

- [ ] **Step 6: Run the affected test suites**

Run: `cd packages/orchestrator && npx vitest run` then `cd ../app && npx vitest run test/cycle.test.ts`
Expected: orchestrator suite PASS unchanged (4 describe blocks, unaffected by this task); cycle.test.ts PASS, 4 tests (3 fast + 1 real ~10-180s heal-enabled test — if this single test exceeds 200s, check whether the actual repo typecheck is unusually slow on this machine and raise the `{ timeout }` override accordingly, matching the pattern already used for the Cycle Isolation real-cycle test)

- [ ] **Step 7: Commit**

```bash
git add packages/orchestrator/src/core.ts packages/orchestrator/src/plugin.ts packages/app/test/cycle.test.ts
git commit -m "feat: run self-healing automatically every orchestrator cycle"
```

---

### Task 4: Thread `healEnabled` through the real server, surface the chat report line, full verification

**Files:**
- Modify: `packages/app/src/build.ts` (add `healEnabled` to `AtlasOptions`, pass to orchestrator plugin)
- Modify: `packages/server/src/server.ts` (add `healEnabled` to `ControlPanelOptions`, thread into `rebuildAtlas()`, extend `formatIntentResult`'s `"cycle"` branch)
- Modify: `packages/server/test/server.test.ts` (opt the test server out of healing for speed)

**Context:** `buildAtlas()` builds `createOrchestratorPlugin()` with no options today — needs `healEnabled` threaded from `AtlasOptions` (used directly by `cycle.test.ts`, Task 3) through to `ControlPanelOptions` (used by the real server and `server.test.ts`), matching the existing `brainAdapters` test-override pattern.

- [ ] **Step 1: Thread `healEnabled` through `AtlasOptions`/`buildAtlas`**

In `packages/app/src/build.ts`, add to the `AtlasOptions` interface (after `renderer?: Renderer;`):

```typescript
  /** Enable the orchestrator's automatic self-healing step (default true).
   * Tests set this false to stay fast/offline — see packages/app/test/cycle.test.ts. */
  healEnabled?: boolean;
```

Change line 169 from:

```typescript
  await atlas.use(createOrchestratorPlugin());
```

to:

```typescript
  await atlas.use(createOrchestratorPlugin({ healEnabled: opts.healEnabled }));
```

- [ ] **Step 2: Thread `healEnabled` through `ControlPanelOptions`/`rebuildAtlas`**

In `packages/server/src/server.ts`, add to `ControlPanelOptions` (after `brainAdapters?: ProviderAdapter[];`, around line 241):

```typescript
  /** Enable the orchestrator's automatic self-healing step (default true). Tests set this false. */
  healEnabled?: boolean;
```

In `rebuildAtlas()`'s `buildAtlas({...})` call (around line 356), add:

```typescript
    atlas = await buildAtlas({
      brainAdapters: opts.brainAdapters,
      healEnabled: opts.healEnabled,
      memoryFile: `${dataDir}/memory.json`,
```

(insert `healEnabled: opts.healEnabled,` right after the existing `brainAdapters` line, rest of the call unchanged)

- [ ] **Step 3: Extend the chat cycle report with the heal line**

In `packages/server/src/server.ts`'s `formatIntentResult` (the `if (kind === "cycle")` branch, around line 195-209), add `healReport` to the destructured type and build the extra line:

```typescript
  if (kind === "cycle") {
    const rep = r as {
      topic?: string;
      reel?: { hook?: string };
      pendingApprovals?: unknown[];
      cycleHealth?: { succeeded: number; failed: number; failures: Array<{ step: string; error: string }> };
      healReport?: { healed: number; attempted: number; total: number };
    };
    const health = rep.cycleHealth;
    const healthLine = health
      ? health.failed > 0
        ? `\n⚠️ ${health.failed} of ${health.succeeded + health.failed} steps failed: ${health.failures.map((f) => f.step).join(", ")}.`
        : `\n✅ All ${health.succeeded} steps succeeded.`
      : "";
    const heal = rep.healReport;
    const healLine = heal && heal.attempted > 0 ? `\n🩹 Self-heal: fixed ${heal.healed}/${heal.attempted} code errors found this cycle.` : "";
    return `Done. Topic: ${rep.topic}. Drafted hook: "${rep.reel?.hook ?? ""}". ${rep.pendingApprovals?.length ?? 0} item(s) awaiting your approval.${healthLine}${healLine}`;
  }
```

- [ ] **Step 4: Opt `server.test.ts`'s test server out of healing**

In `packages/server/test/server.test.ts`'s `start()` function (line 14), add `healEnabled: false`:

```typescript
  panel = createControlPanel({ vaultFile: join(dir, "vault.enc.json"), dataDir: dir, envFile: join(dir, ".env"), brainAdapters: [new StubAdapter()], healEnabled: false });
```

- [ ] **Step 5: Full workspace typecheck**

Run: `pnpm run typecheck` (from repo root)
Expected: no errors

- [ ] **Step 6: Full test suite**

Run: `pnpm run test` (from repo root)
Expected: all tests pass, including the new `healer.test.ts` (6 tests), the extended `cycle.test.ts` (4 tests), and unchanged `server.test.ts`/`orchestrator.test.ts`

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/build.ts packages/server/src/server.ts packages/server/test/server.test.ts
git commit -m "feat: thread healEnabled through the real server, surface self-heal in chat cycle report"
```

- [ ] **Step 8: Manual verification**

1. Restart ATLAS locally (`Restart ATLAS (load updates).bat` or equivalent) so the new code loads.
2. In chat, deliberately introduce a trivial typecheck error in a low-risk file (e.g., a throwaway test package or a scratch file with a wrong type annotation), commit it as a normal change so it's on disk.
3. Ask ATLAS "run today's cycle" in chat.
4. Confirm the reply includes a line starting with `🩹 Self-heal:` (if a heal was attempted) alongside the existing `✅`/`⚠️` steps line.
5. Run `git log -3 --oneline` in the ATLAS repo — if healing succeeded, confirm an `auto-heal:` commit appears and the deliberately-introduced error is gone (`pnpm run typecheck` clean again).
6. Clean up: revert/remove the deliberately-introduced test error if the auto-heal didn't already fix it.
7. Deploy to the Hostinger VPS (same flow as prior sessions: push, `scp`/`tar` to `/opt/atlas/app`, `docker restart atlas`) once verified locally.

---

## Explicitly out of scope (carried over from the spec)

- Auto-fixing test failures — only typecheck errors are targeted.
- The `generate` op (agent/skill self-authoring) in `codebase/plugin.ts` — untouched.
- Any new UI — reuses the existing cycle-report chat line and Run Ledger.
- Cross-cycle backoff for a file that fails to heal repeatedly — not needed at this scope.
