# Self-Healing Wiring (ATLAS autonomy punch list, item 1 of N)

## Context

Task #3 ("Add self-healing code capability") has been open since ATLAS's Phase 0
audit. Task #9 ("wire healer.ts + agent/skill factory") was marked complete on
2026-07-11, and it's half-true: `packages/codebase/src/healer.ts` is reachable
via the codebase plugin's `heal` op, but two things make it non-functional:

1. `suggestFix()` asks the Brain for fix text but nothing ever writes that
   text to a file. `verifyFix()` then re-runs typecheck on the *unchanged*
   code, so it fails again except by coincidence — `commitFix()` almost never
   fires.
2. `verifyFix()` runs `pnpm run typecheck` with a 30-second timeout.
   `packages/server/src/self-improve.ts`'s `applySelfImprovementPatch()` runs
   the identical command on the identical 42-package monorepo with a
   **180-second** timeout. The 30s cap is almost certainly failing before a
   real fix ever gets the chance to verify.
3. Even if both of the above were fixed, nothing in
   `packages/orchestrator/src/plugin.ts`'s automated cycle calls `codebase.heal`
   — it only runs on a manual `ctx.call`/chat trigger today.

This is the first item in Mat's prioritized "make ATLAS run without me, bring
me approval tasks" punch list. Confirmed with Mat (2026-07-18): self-healing
should be **fully autonomous** — detect, fix, verify, and commit every cycle
with no approval gate, using the same backup→write→typecheck→rollback safety
pattern already proven in `self-improve.ts`. All fixes land as their own git
commits (trivially revertible), and every attempt — success or failure — is
visible after the fact via the existing Run Ledger / `cycleHealth` summary
line (built in the 2026-07-17 Cycle Isolation project), not gated before.

## Design

### 1. Rewrite `packages/codebase/src/healer.ts`

Keep the existing exported function names/shapes where reasonable
(`detectErrors`, `commitFix`) but fix their bodies, and replace
`suggestFix`/`verifyFix` with a single `generateAndApplyFix` that mirrors
`self-improve.ts`'s safe-apply contract:

```typescript
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";

const run = promisify(exec);

export interface CodeError {
  type: "typecheck" | "test";
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

export async function detectErrors(repoRoot: string): Promise<CodeError[]> {
  const errors: CodeError[] = [];

  try {
    await run("pnpm run typecheck", { cwd: repoRoot, timeout: 180_000 });
  } catch (e) {
    const output = String((e as { stdout?: string }).stdout ?? (e as Error).message);
    const lines = output.split("\n");
    for (const line of lines) {
      const match = line.match(/^(.+?)\((\d+),(\d+)\):\s*error\s+TS\d+:\s*(.+)$/);
      if (match) {
        errors.push({ type: "typecheck", file: match[1] as string, message: (match[4] as string).trim() });
      }
    }
  }

  return errors.filter((e) => !EXCLUDED_PATH_PATTERNS.some((p) => p.test(e.file)));
}

/**
 * Generate a full-file fix via the Brain, sanity-check it, write it, verify
 * with a whole-workspace typecheck, and roll back automatically on failure.
 * Mirrors self-improve.ts's safe-apply contract — see that file for why
 * full-file (not diff) replacement is the safety boundary here.
 */
export async function generateAndApplyFix(
  repoRoot: string,
  error: CodeError,
  brainCall: (prompt: string) => Promise<string>,
): Promise<HealAttempt> {
  let original: string;
  try {
    original = await readFile(error.file, "utf8");
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

  const changedRatio = diffLineRatio(original, fixed);
  if (changedRatio > MAX_CHANGED_LINE_RATIO) {
    return { error, outcome: "skipped", detail: `fix changes ${Math.round(changedRatio * 100)}% of the file — rejected as too broad` };
  }

  try {
    await writeFile(error.file, fixed, "utf8");
    await run("pnpm run typecheck", { cwd: repoRoot, timeout: 180_000 });
  } catch (e) {
    await writeFile(error.file, original, "utf8");
    const detail = String((e as { stdout?: string; message?: string }).stdout ?? (e as Error).message).slice(0, 300);
    return { error, outcome: "verify_failed", detail };
  }

  const commit = await commitFix(repoRoot, error);
  return commit
    ? { error, outcome: "healed", detail: "typecheck passed", commit }
    : { error, outcome: "verify_failed", detail: "typecheck passed but commit failed" };
}

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

export async function commitFix(repoRoot: string, error: CodeError): Promise<string | null> {
  try {
    await run(`git add "${error.file}" && git commit -m "auto-heal: fix ${error.type} error in ${error.file}"`, { cwd: repoRoot });
    const result = await run("git rev-parse HEAD", { cwd: repoRoot });
    return ((result.stdout as string) || "").trim();
  } catch {
    return null;
  }
}
```

Notes:
- `detectErrors` drops the earlier test-suite detection — `pnpm run test`
  across the full monorepo is multiple minutes even when everything passes,
  which doesn't fit the per-cycle time budget below. Typecheck errors are the
  autonomous target; test failures more often indicate a genuine logic bug
  worth a human look, not a mechanical fix — leaving those for you to handle
  manually (or a future, separate, approval-gated project) is intentional,
  not an oversight.
- `EXCLUDED_PATH_PATTERNS` is deliberately conservative (vault/env/secrets/git
  internals) — typecheck errors don't occur in `.env`/vault files anyway
  (they're not TypeScript), but the filter stays as defense-in-depth in case
  `detectErrors`' regex ever misparses a path.
- The 400-line cap and 30%-diff cap both exist to stop the local (CPU-only,
  context-limited) LLM from silently truncating or over-rewriting a file —
  same failure class as the Ollama 2048-token gibberish bug fixed earlier
  this project.

### 2. Update `packages/codebase/src/plugin.ts`'s `heal` op

Replace the current per-error `suggestFix`/`verifyFix`/`commitFix` loop with
calls to the new `generateAndApplyFix`, capped at 2 attempts per invocation:

```typescript
if (cmd.op === "heal") {
  const errors = await detectErrors(cmd.dir);
  if (!errors.length) return { healed: 0, attempted: 0, errors: [] };

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
  return { healed, attempted: attempts.length, errors: attempts };
}
```

`maxTokens` raised from 800 to 3000 to fit a full (up to 400-line) file in the
response — the previous 800-token cap couldn't have returned a whole file
even if `suggestFix` had tried to.

### 3. Wire into the orchestrator cycle

`packages/orchestrator/src/plugin.ts` already runs its ~10 intel steps via
`optional()` (from `packages/orchestrator/src/core.ts`, built in Cycle
Isolation) inside a `Promise.all`, each recording into the shared
`CycleHealthTracker`. Add one more step to that same `Promise.all` block:

```typescript
optional(ctx.call, "codebase", { op: "heal", dir: process.cwd() }, health, 400_000),
```

400s (vs the 90s default) because this step can run up to two full
180-second typechecks back to back. `process.cwd()` is correct here: confirmed
no existing repo-root convention in `orchestrator/plugin.ts` (this is the
first call into `codebase.heal` from there), and `self-improve.ts` already
relies on the running ATLAS server process having its cwd at the repo root
(it uses bare relative paths like `"packages/memory/src/plugin.ts"`), so
`process.cwd()` is consistent with that existing assumption.

No changes needed to `cycleHealth`'s shape — `optional()` already records
success/failure into `tracker.succeeded`/`tracker.failures` generically, and
a "healed 1/2, 1 unhealed" detail only needs to reach the *chat* cycle-report
line, not the health tracker itself. To surface that detail (not just
pass/fail), the heal step's *result* (not just its success/failure) needs a
home: extend `DailyReport` (in `packages/orchestrator/src/core.ts`) with an
optional `healReport?: { healed: number; attempted: number; total: number }`
field, populated in `plugin.ts` from the heal step's return value (guarded —
`optional()` returns `undefined` on failure/timeout, in which case
`healReport` stays unset). Extend the existing cycle-report formatter in
`packages/server/src/server.ts`'s `formatIntentResult` (the same `"cycle"`
branch that already prints the `cycleHealth` pass/fail line) with one more
line when `healReport` is present and `attempted > 0`:

```typescript
const healLine = rep.healReport && rep.healReport.attempted > 0
  ? `\n🩹 Self-heal: fixed ${rep.healReport.healed}/${rep.healReport.attempted} code errors found this cycle.`
  : "";
```

### Error handling

- Every `generateAndApplyFix` outcome (`healed`/`verify_failed`/`skipped`/
  `generate_failed`) is captured in the return value — nothing is silently
  swallowed. Only `healed` writes to memory; the others are visible via the
  `healReport` counts (`attempted` vs `healed`) in the cycle report, which is
  enough signal without spamming memory with every non-fix.
- If `detectErrors` itself throws (e.g., `pnpm run typecheck` errors in a way
  that isn't a normal non-zero exit with parseable output), the whole heal
  step fails and `optional()` already handles that — logged into
  `tracker.failures`, cycle continues.
- A file that fails to heal this cycle simply gets picked up again next
  cycle (nothing marks it "already tried and failed" — acceptable since the
  400-line/30%-diff/2-attempt caps bound the cost of repeated failed
  attempts, and a persistently-broken file will surface via
  `tracker.failures`/`healReport` every time, which is visible, not hidden).

### Testing

- `packages/codebase/src/healer.test.ts` (new): unit tests for
  `generateAndApplyFix` against a real temp git repo fixture — verify (a) a
  good fix gets written, typechecks, and commits with a scoped `git add`
  (only the target file staged, confirmed via `git status`); (b) a fix that
  fails typecheck gets rolled back to the original content and returns
  `verify_failed`; (c) a file over 400 lines returns `skipped` without
  calling `brainCall`; (d) a fix changing >30% of lines returns `skipped`
  without writing; (e) `detectErrors` correctly parses a real `tsc` error
  output fixture into `CodeError[]` and filters out `node_modules`/`vault`
  paths.
- `packages/orchestrator/src/plugin.test.ts` (existing file, extend): verify
  the heal step is included in the cycle's `Promise.all`, and that a
  successful heal result populates `DailyReport.healReport` while a
  failed/timed-out one leaves it `undefined` without breaking the rest of
  the cycle.
- Manual verification after implementation: trigger a cycle run via chat
  ("run today's cycle") against a repo with a deliberately introduced trivial
  typecheck error, confirm the 🩹 self-heal line appears and the error is
  actually gone afterward (`git log` shows the auto-heal commit).

## Explicitly out of scope

- Auto-fixing test failures (only typecheck errors are targeted — see notes
  above).
- The `generate` op (agent/skill self-authoring) in the same plugin —
  untouched.
- Any new UI — reuses the existing cycle-report chat line and Run Ledger.
- Retrying a failed heal attempt within the same cycle, or backing off a
  file that fails repeatedly across cycles — not needed at this scope; revisit
  if it turns out to matter in practice.
