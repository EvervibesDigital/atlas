import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, ConfigVault, type GuardianLike } from "@atlas/core";
import { createGigFinderPlugin } from "../src/plugin";
import { isUsableBid } from "../src/templates";
import type { Gig } from "../src/types";

function permissiveGuardian(): GuardianLike {
  return { grant: () => {}, check: () => ({ decision: "allow", reason: "test" }) };
}


// Verbatim draftBid values from the 28 approved gigs in production 2026-08-02.
const REAL_BROKEN = [
  "Call to Action/Wrap up):* Let me know",
  "I can develop and optimize the AI/ML models",
  "I will build your Telegram bot and username store website using Python",
];
const REAL_GOOD =
  "I'll build a Python script that uses the Notion API to import a CSV file into your Notion database. " +
  "The script will handle various CSV formats and include error handling. I'll deliver within 3-5 business days.";

function gig(id: string, draftBid: string): Gig {
  return {
    id, source: "web", title: `Job ${id}`, url: `https://reddit.com/r/forhire/comments/${id}`,
    snippet: "…", foundAt: "2026-08-01T00:00:00.000Z", status: "approved", dedupeKey: id, draftBid,
  } as Gig;
}

describe("gigfinder.repairBids", () => {
  let dir: string, gigsFile: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atlas-repair-"));
    gigsFile = join(dir, "gigs.json");
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function atlasWith(gigs: Gig[]) {
    await writeFile(gigsFile, JSON.stringify(gigs), "utf8");
    const a = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({}) });
    await a.use(createGigFinderPlugin({ gigFile: gigsFile }));
    return a;
  }

  it("dry-runs by default — it overwrites stored text, so previewing must be the default", async () => {
    const a = await atlasWith([gig("a", REAL_BROKEN[0]!), gig("b", REAL_GOOD)]);
    const r = (await a.invoke("gigfinder", { op: "repairBids" })) as { dryRun: boolean; repaired: number };
    expect(r.dryRun).toBe(true);
    expect(r.repaired).toBe(1);

    const onDisk = JSON.parse(await readFile(gigsFile, "utf8")) as Gig[];
    expect(onDisk.find((g) => g.id === "a")!.draftBid).toBe(REAL_BROKEN[0]);
  });

  it("replaces every real broken bid with something actually sendable", async () => {
    const gigs = REAL_BROKEN.map((b, i) => gig(`b${i}`, b));
    const a = await atlasWith(gigs);
    const r = (await a.invoke("gigfinder", { op: "repairBids", dryRun: false })) as { repaired: number };
    expect(r.repaired).toBe(REAL_BROKEN.length);

    const onDisk = JSON.parse(await readFile(gigsFile, "utf8")) as Gig[];
    for (const g of onDisk) {
      expect(isUsableBid(g.draftBid ?? ""), `still unusable: ${g.draftBid}`).toBe(true);
    }
  });

  it("leaves a good bid completely untouched", async () => {
    const a = await atlasWith([gig("good", REAL_GOOD)]);
    await a.invoke("gigfinder", { op: "repairBids", dryRun: false });
    const onDisk = JSON.parse(await readFile(gigsFile, "utf8")) as Gig[];
    expect(onDisk[0]!.draftBid).toBe(REAL_GOOD);
  });

  it("reports before and after so the change is reviewable, not blind", async () => {
    const a = await atlasWith([gig("a", REAL_BROKEN[0]!)]);
    const r = (await a.invoke("gigfinder", { op: "repairBids" })) as {
      changes: Array<{ id: string; before: string; after: string }>;
    };
    expect(r.changes[0]!.before).toBe(REAL_BROKEN[0]);
    expect(r.changes[0]!.after).toContain("Job a");
  });

  it("does not invent a pitch for a gig that never had one", async () => {
    // No bid means it was never approved. Writing one would fabricate review
    // that never happened.
    const a = await atlasWith([gig("never", "")]);
    const r = (await a.invoke("gigfinder", { op: "repairBids", dryRun: false })) as { repaired: number };
    expect(r.repaired).toBe(0);
  });
});
