import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";

const run = promisify(exec);

/**
 * Self-healing layer — ATLAS detects code errors, generates fixes via brain,
 * verifies they compile, and commits changes. Keeps ATLAS running even when code breaks.
 */

export interface CodeError {
  type: "typecheck" | "import" | "test" | "runtime";
  file: string;
  line?: number;
  message: string;
}

export interface HealingResult {
  error: CodeError;
  fixed: boolean;
  fix?: string;
  verified: boolean;
  commit?: string;
}

export async function detectErrors(repoRoot: string): Promise<CodeError[]> {
  const errors: CodeError[] = [];

  // Run typecheck
  try {
    await run("pnpm run typecheck", { cwd: repoRoot });
  } catch (e) {
    const output = String((e as { stdout?: string }).stdout ?? (e as Error).message);
    // Parse error message to extract file:line:message
    const lines = output.split("\n");
    for (const line of lines.slice(0, 20)) {
      // limit to first 20 errors
      if (/error\s+TS\d+/.test(line)) {
        errors.push({
          type: "typecheck",
          file: line.split(":")[0] || "unknown",
          message: line.split("error")[1]?.trim() || "type error",
        });
      }
    }
  }

  // Run tests
  try {
    await run("pnpm run test 2>&1 | head -20", { cwd: repoRoot, shell: "/bin/bash" });
  } catch (e) {
    const output = String((e as { stdout?: string }).stdout ?? "");
    if (/fail|error/i.test(output)) {
      errors.push({
        type: "test",
        file: "test suite",
        message: output.split("\n")[0]?.slice(0, 100) || "test failed",
      });
    }
  }

  return errors;
}

export async function suggestFix(error: CodeError, brainCall: (prompt: string) => Promise<string>): Promise<string> {
  const prompt = `A TypeScript/Node.js error occurred:
File: ${error.file}
Type: ${error.type}
Message: ${error.message}

Suggest a ONE-LINE fix (not an explanation, just the fix code or command).`;

  return await brainCall(prompt);
}

export async function verifyFix(repoRoot: string): Promise<boolean> {
  try {
    await run("pnpm run typecheck", { cwd: repoRoot, timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

export async function commitFix(repoRoot: string, error: CodeError, fixDescription: string): Promise<string | null> {
  try {
    await run(`git add -A && git commit -m "auto-fix: ${error.type} in ${error.file} — ${fixDescription.slice(0, 40)}"`, {
      cwd: repoRoot,
    });
    const result = await run("git rev-parse HEAD", { cwd: repoRoot });
    return ((result.stdout as string) || "").trim();
  } catch {
    return null;
  }
}
