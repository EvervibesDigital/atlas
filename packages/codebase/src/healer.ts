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
const MAX_CHANGED_RATIO = 0.3;
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
    fixed = await brainCall(prompt);
    // Only strip markdown code fences when actually present — do NOT
    // unconditionally trim() the raw output, since that would silently drop
    // a real trailing newline the model returned as part of the fix and
    // make the written file byte-for-byte different from what the model
    // (and diffRatio, below) intended.
    if (fixed.trimStart().startsWith("```")) {
      const lines = fixed.trim().split("\n");
      fixed = lines.slice(1, -1).join("\n") + "\n";
    }
  } catch (e) {
    return { error, outcome: "generate_failed", detail: (e as Error).message };
  }

  if (fixed.length < 20 || !/\b(import|export)\b/.test(fixed)) {
    return { error, outcome: "skipped", detail: "generated fix is not a complete module — rejected for safety" };
  }

  if (diffRatio(original, fixed) > MAX_CHANGED_RATIO) {
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

/**
 * Fraction of characters that differ between two file contents (0 = identical,
 * 1 = nothing in common). Uses a common-prefix/common-suffix trim rather than
 * a line-indexed comparison: a line-indexed ratio scores a single-character
 * edit inside a one-line file as 100% changed (1 of 1 lines differs), which
 * would wrongly reject the most common real fix (a small typo/type correction
 * in a small file). Prefix/suffix trimming isn't a full diff/LCS, but it's a
 * conservative approximation — the only failure mode from imprecision is an
 * unnecessary "skipped" (safe), never an unsafe write — and it's O(n) so it
 * stays cheap even at the 400-line file cap.
 */
function diffRatio(a: string, b: string): number {
  const minLen = Math.min(a.length, b.length);
  let start = 0;
  while (start < minLen && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const changed = Math.max(endA - start, endB - start);
  const total = Math.max(a.length, b.length, 1);
  return changed / total;
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
