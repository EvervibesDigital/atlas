import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProposalRegistry } from "../src/registry";

describe("ProposalRegistry", () => {
  it("starts with no handled categories", async () => {
    const r = new ProposalRegistry();
    expect((await r.handledCategories()).size).toBe(0);
  });

  it("marks a category handled and reports it back", async () => {
    const r = new ProposalRegistry();
    await r.markHandled("outreach", "accepted");
    expect((await r.handledCategories()).has("outreach")).toBe(true);
  });

  it("persists across a fresh instance reading the same file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atlas-proposals-"));
    const file = join(dir, "proposals-handled.json");
    try {
      const first = new ProposalRegistry(file);
      await first.markHandled("outreach", "dismissed");

      const second = new ProposalRegistry(file);
      expect((await second.handledCategories()).has("outreach")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
