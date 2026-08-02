import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, ConfigVault, type GuardianLike } from "@atlas/core";
import { createWholesalePlugin } from "../src/plugin";
import { withComplianceFooter } from "../src/intro-drafts";

function permissiveGuardian(): GuardianLike {
  return { grant: () => {}, check: () => ({ decision: "allow", reason: "test" }) };
}

const ADDRESS = "EverVibes, 100 Main St, Tampa, FL 33601";

const draft = (id: string, email: string, body = "Hi Dana — I've got two off-market deals in Tampa this month.") => ({
  id: `intro:${id}`, buyerId: id, name: "Dana Reyes", email,
  subject: "Two off-market deals in Tampa", body, createdAt: "2026-08-01T00:00:00.000Z",
});

describe("withComplianceFooter", () => {
  it("adds the postal address and an opt-out line", () => {
    const out = withComplianceFooter("Hi there.", ADDRESS);
    expect(out).toContain(ADDRESS);
    expect(out).toMatch(/won't follow up/i);
  });

  it("is idempotent — re-drafting cannot stack footers", () => {
    const once = withComplianceFooter("Hi there.", ADDRESS);
    expect(withComplianceFooter(once, ADDRESS)).toBe(once);
  });

  it("does not duplicate an address the copy already carries", () => {
    const body = `Hi there.\n\nIf this isn't useful, just say so and I won't follow up.\n\n${ADDRESS}`;
    expect(withComplianceFooter(body, ADDRESS)).toBe(body);
  });
});

describe("wholesale.draftBatchForSender", () => {
  let dir: string, file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atlas-wholesale-"));
    file = join(dir, "intro-drafts.json");
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function atlasWith(drafts: unknown[], secrets: Record<string, string>) {
    await writeFile(file, JSON.stringify(drafts), "utf8");
    const a = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({ ...secrets }) });
    await a.use(createWholesalePlugin({ introDraftsFile: file }));
    return a;
  }

  it("returns drafts in sender's shape, footer included", async () => {
    const a = await atlasWith([draft("b1", "dana@example.com")], { COMPANY_POSTAL_ADDRESS: ADDRESS });
    const r = (await a.invoke("wholesale", { op: "draftBatchForSender" })) as {
      emails: Array<{ draftId: string; to: string; subject: string; body: string }>; drafted: number;
    };
    expect(r.drafted).toBe(1);
    expect(r.emails[0]).toMatchObject({ draftId: "intro:b1", to: "dana@example.com" });
    // sender REFUSES without both of these, so their absence would mean
    // wholesale could never send at all.
    expect(r.emails[0]!.body).toContain(ADDRESS);
    expect(r.emails[0]!.body).toMatch(/won't follow up/i);
  });

  it("refuses entirely when no postal address is configured", async () => {
    const a = await atlasWith([draft("b1", "dana@example.com")], {});
    await expect(a.invoke("wholesale", { op: "draftBatchForSender" })).rejects.toThrow(/COMPANY_POSTAL_ADDRESS/);
  });

  it("reports a buyer with no email instead of silently dropping them", async () => {
    const a = await atlasWith([draft("b1", "dana@example.com"), draft("b2", "")], { COMPANY_POSTAL_ADDRESS: ADDRESS });
    const r = (await a.invoke("wholesale", { op: "draftBatchForSender" })) as {
      drafted: number; considered: number; skipped: Array<{ draftId: string; reason: string }>;
    };
    expect(r.drafted).toBe(1);
    expect(r.considered).toBe(2);
    expect(r.skipped[0]!.reason).toMatch(/no email/);
  });

  it("drafts only the ids asked for", async () => {
    const a = await atlasWith([draft("b1", "a@x.com"), draft("b2", "b@x.com")], { COMPANY_POSTAL_ADDRESS: ADDRESS });
    const r = (await a.invoke("wholesale", { op: "draftBatchForSender", ids: ["intro:b2"] })) as {
      emails: Array<{ draftId: string }>;
    };
    expect(r.emails.map((e) => e.draftId)).toEqual(["intro:b2"]);
  });
});
