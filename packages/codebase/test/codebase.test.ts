import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanCodebase, scanBriefing } from "../src/index";

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("scanCodebase", () => {
  it("captures structure, key files, workflows and skips node_modules", async () => {
    dir = await mkdtemp(join(tmpdir(), "atlas-cb-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "evervibes", scripts: { dev: "next dev" }, dependencies: { next: "14" } }));
    await writeFile(join(dir, "README.md"), "# EverVibes\nDigital + wholesale platform.");
    await mkdir(join(dir, "app", "api", "agents"), { recursive: true });
    await writeFile(join(dir, "app", "api", "agents", "route.ts"), "export {}");
    await mkdir(join(dir, "n8n-workflows"), { recursive: true });
    await writeFile(join(dir, "n8n-workflows", "nightly.workflow.json"), "{}");
    await mkdir(join(dir, "node_modules", "junk"), { recursive: true });
    await writeFile(join(dir, "node_modules", "junk", "index.js"), "// ignore me");

    const scan = await scanCodebase(dir, "evervibes");
    expect(scan.topFolders).toContain("app");
    expect(scan.topFolders).not.toContain("node_modules");
    expect(scan.keyFiles.some((k) => k.path === "package.json")).toBe(true);
    expect(scan.workflows.some((w) => w.includes("nightly"))).toBe(true);
    expect(scan.routeGroups).toContain("agents");

    const briefing = scanBriefing(scan);
    expect(briefing).toContain("evervibes");
    expect(briefing).toContain("package.json");
  });
});
