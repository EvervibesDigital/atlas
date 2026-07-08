import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanForDebt, summarize } from "../src/index";

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("scanForDebt", () => {
  it("finds TODO/FIXME markers and skips node_modules", async () => {
    dir = await mkdtemp(join(tmpdir(), "atlas-debt-"));
    await writeFile(join(dir, "clean.ts"), "export const ok = 1;\n");
    await writeFile(join(dir, "messy.ts"), "// TODO wire this up\nfunction x(){} // FIXME broken\n");
    await mkdir(join(dir, "node_modules"), { recursive: true });
    await writeFile(join(dir, "node_modules", "junk.ts"), "// TODO should be ignored\n");

    const findings = await scanForDebt(dir);
    const kinds = findings.map((f) => f.kind);
    expect(kinds).toContain("todo");
    expect(kinds).toContain("fixme");
    // node_modules is skipped → exactly two findings (one TODO, one FIXME).
    expect(findings.filter((f) => f.kind === "todo" || f.kind === "fixme")).toHaveLength(2);
  });

  it("flags oversized files and summarizes by severity", async () => {
    dir = await mkdtemp(join(tmpdir(), "atlas-debt-"));
    await writeFile(join(dir, "big.ts"), Array(50).fill("const a = 1;").join("\n"));
    const findings = await scanForDebt(dir, { maxLines: 10 });
    expect(findings.some((f) => f.kind === "large-file")).toBe(true);
    expect(summarize(findings).total).toBeGreaterThan(0);
  });
});
