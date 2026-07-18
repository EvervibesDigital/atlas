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
