import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { renderPluginCode, loadActivePlugins } from "../src/index";

let dir = "";
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("renderPluginCode", () => {
  it("produces a valid plugin with the prompt safely embedded", () => {
    const code = renderPluginCode("Cold Email Writer", "cold.email", 'You write cold emails. Use "hooks".');
    expect(code).toContain('name: "cold-email-writer"');
    expect(code).toContain('capabilities: ["cold.email"]');
    // The quote inside the prompt must be JSON-escaped, not break the file.
    expect(code).toContain('\\"hooks\\"');
    expect(code).toContain("export default plugin");
  });
});

describe("loadActivePlugins", () => {
  it("dynamically loads an approved forged plugin and registers it", async () => {
    dir = await mkdtemp(join(tmpdir(), "atlas-forge-"));
    const active = join(dir, "active");
    await mkdir(active, { recursive: true });
    // A minimal valid forged plugin (no @atlas/core import needed for the test).
    await writeFile(
      join(active, "echo.plugin.ts"),
      `export const plugin = { manifest: { name: "echo", version: "0.1.0", capabilities: ["echo"], permissions: ["*"], role: "executor" }, register(ctx) { ctx.provide("echo", (p) => p); } };\nexport default plugin;\n`,
      "utf8",
    );

    const atlas = new Atlas({ guardian: new Guardian() });
    const loaded = await loadActivePlugins(atlas, active);
    expect(loaded).toContain("echo");
    expect(atlas.loaded()).toContain("echo");
  });

  it("returns empty for a missing directory (never crashes boot)", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    expect(await loadActivePlugins(atlas, "/no/such/dir")).toEqual([]);
  });
});
