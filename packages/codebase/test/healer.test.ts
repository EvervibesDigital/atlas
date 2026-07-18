import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
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

  it("rolls back file content and unstages when commitFix fails after a successful write+typecheck", async () => {
    dir = await initRepo();
    await writeFile(join(dir, "broken.ts"), "export const x: number = 'oops';\n");
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", ["-C", dir, "commit", "-m", "init"]);

    // Force `git commit` (but NOT `git add`) to fail, via a pre-commit hook
    // that always exits 1. This is deliberately different from failing
    // `git add` itself (e.g. via a stale index.lock): a hook runs AFTER
    // staging has already succeeded, so this exercises the actual scenario
    // the rollback fix targets — content genuinely staged, then the commit
    // is rejected, and the fix must unstage what's already staged. Before
    // failing, the hook records what's currently staged into a marker file
    // so the test can prove staging really happened (not that `git add`
    // silently no-op'd) — an intermediate check, not just "commit didn't throw".
    await mkdir(join(dir, ".git", "hooks"), { recursive: true });
    const stagedMarkerPath = join(dir, ".git", "hooks", "staged-at-commit-time.txt");
    const hookScript =
      ["#!/bin/sh", `git diff --cached --name-only > "${stagedMarkerPath.replace(/\\/g, "/")}"`, "exit 1"].join(
        "\n",
      ) + "\n";
    await writeFile(join(dir, ".git", "hooks", "pre-commit"), hookScript);

    const error: CodeError = { type: "typecheck", file: "broken.ts", message: "Type error." };
    const brainCall = async () => "export const x: number = 42;\n";

    const attempt = await generateAndApplyFix(dir, error, brainCall, OK_CMD);

    // Intermediate check: prove `git add` genuinely staged broken.ts before
    // the hook (running inside `git commit`) rejected it — this is what
    // distinguishes this test from one where `git add` fails outright and
    // nothing is ever staged.
    const stagedAtCommitTime = await readFile(stagedMarkerPath, "utf8");
    expect(stagedAtCommitTime).toContain("broken.ts");

    expect(attempt.outcome).toBe("verify_failed");
    expect(attempt.commit).toBeFalsy();
    // The written fix must be rolled back — commit failure is not "healed".
    expect(await readFile(join(dir, "broken.ts"), "utf8")).toBe("export const x: number = 'oops';\n");

    // The actual unstage verification: nothing should remain staged (or
    // even show as modified, since content was restored too) for broken.ts.
    const status = await run("git", ["-C", dir, "status", "--short"]);
    expect(status.stdout).not.toContain("broken.ts");

    const log = await run("git", ["-C", dir, "log", "-1", "--format=%s"]);
    expect(log.stdout).toContain("init"); // no auto-heal commit was made
  });

  it("rejects a file path that resolves outside repoRoot, before touching disk", async () => {
    dir = await initRepo();
    await writeFile(join(dir, "broken.ts"), "export const x: number = 'oops';\n");
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", ["-C", dir, "commit", "-m", "init"]);

    const outsideDir = await mkdtemp(join(tmpdir(), "atlas-heal-outside-"));
    const outsideFile = join(outsideDir, "secret.ts");
    await writeFile(outsideFile, "export const secret = 1;\n");

    let called = false;
    const brainCall = async () => { called = true; return "should not be used"; };
    // Absolute path pointing at a real, readable file OUTSIDE repoRoot.
    const error: CodeError = { type: "typecheck", file: outsideFile, message: "some error" };

    const attempt = await generateAndApplyFix(dir, error, brainCall, OK_CMD);

    expect(attempt.outcome).toBe("skipped");
    expect(called).toBe(false);
    expect(await readFile(outsideFile, "utf8")).toBe("export const secret = 1;\n");

    await rm(outsideDir, { recursive: true, force: true });
  });

  it("rejects a path matching an excluded pattern (node_modules), before touching disk", async () => {
    dir = await initRepo();
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(dir, "node_modules", "pkg", "index.ts"), "export const z = 1;\n");
    await run("git", ["-C", dir, "add", "-A"]);
    await run("git", ["-C", dir, "commit", "-m", "init"]);

    let called = false;
    const brainCall = async () => { called = true; return "should not be used"; };
    const error: CodeError = { type: "typecheck", file: "node_modules/pkg/index.ts", message: "some error" };

    const attempt = await generateAndApplyFix(dir, error, brainCall, OK_CMD);

    expect(attempt.outcome).toBe("skipped");
    expect(called).toBe(false);
    expect(await readFile(join(dir, "node_modules", "pkg", "index.ts"), "utf8")).toBe("export const z = 1;\n");
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
