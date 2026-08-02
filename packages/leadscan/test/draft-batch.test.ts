import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, ConfigVault, type GuardianLike } from "@atlas/core";
import { createLeadScanPlugin } from "../src/plugin";
import type { Lead } from "../src/types";

function permissiveGuardian(): GuardianLike {
  return { grant: () => {}, check: () => ({ decision: "allow", reason: "test" }) };
}

/** A fetcher that fails the test if used — draftBatch and markSent must not
 * touch the network, and markSent especially must not reach n8n. */
const forbiddenFetch = (() => {
  throw new Error("NETWORK CALLED — draftBatch/markSent must not reach n8n or any API");
}) as unknown as typeof fetch;

function lead(over: Partial<Lead> & { id: string }): Lead {
  return {
    businessName: "Test Co", website: "https://test.example/", email: "owner@test.example",
    phone: "555-0100", niche: "lawyers", city: "Phoenix, AZ", foundAt: "2026-08-01T00:00:00.000Z",
    status: "new", dedupeKey: over.id,
    scan: { url: "https://test.example/", overallScore: 40, issues: [{ category: "accessibility", issue: "12 image(s) missing alt text" }] },
    ...over,
  } as Lead;
}

const ADDRESS = "EverVibes, 100 Main St, Tampa, FL 33601";

describe("leadscan.draftBatch", () => {
  let dir: string, leadsFile: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atlas-draftbatch-"));
    leadsFile = join(dir, "leads.json");
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function atlasWith(leads: Lead[], secrets: Record<string, string>) {
    await writeFile(leadsFile, JSON.stringify(leads), "utf8");
    const a = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({ ...secrets }) });
    await a.use(createLeadScanPlugin({ leadFile: leadsFile, fetcher: forbiddenFetch }));
    return a;
  }

  it("skips a lead with a clean site instead of pitching it nothing", async () => {
    // A score of 100 means no findings. The whole advantage is naming real,
    // checkable problems; without them this is the agency spam it should beat.
    const clean = lead({ id: "clean", email: "a@clean.example" });
    clean.scan = { url: "https://clean.example/", overallScore: 100, issues: [] };
    const a = await atlasWith([lead({ id: "good" }), clean], { COMPANY_POSTAL_ADDRESS: ADDRESS });

    const r = (await a.invoke("leadscan", { op: "draftBatch" })) as {
      emails: Array<{ leadId: string }>; skipped: Array<{ leadId: string; reason: string }>; drafted: number; considered: number;
    };
    expect(r.drafted).toBe(1);
    expect(r.considered).toBe(2);
    expect(r.emails[0]!.leadId).toBe("good");
    // Reported, not silently dropped — 1 of 2 with a reason is actionable.
    expect(r.skipped[0]!.leadId).toBe("clean");
    expect(r.skipped[0]!.reason).toMatch(/nothing to point at/);
  });

  it("puts the configured postal address in every body", async () => {
    const a = await atlasWith([lead({ id: "x" })], { COMPANY_POSTAL_ADDRESS: ADDRESS });
    const r = (await a.invoke("leadscan", { op: "draftBatch" })) as { emails: Array<{ body: string }> };
    expect(r.emails[0]!.body).toContain(ADDRESS);
  });

  it("refuses entirely when no postal address is configured", async () => {
    const a = await atlasWith([lead({ id: "x" })], {});
    await expect(a.invoke("leadscan", { op: "draftBatch" })).rejects.toThrow(/COMPANY_POSTAL_ADDRESS/);
  });

  it("drafts only the ids asked for", async () => {
    const a = await atlasWith([lead({ id: "a" }), lead({ id: "b" })], { COMPANY_POSTAL_ADDRESS: ADDRESS });
    const r = (await a.invoke("leadscan", { op: "draftBatch", ids: ["b"] })) as { emails: Array<{ leadId: string }> };
    expect(r.emails.map((e) => e.leadId)).toEqual(["b"]);
  });

  it("never drafts a lead that is not 'new'", async () => {
    const a = await atlasWith([lead({ id: "done", status: "contacted" })], { COMPANY_POSTAL_ADDRESS: ADDRESS });
    const r = (await a.invoke("leadscan", { op: "draftBatch" })) as { drafted: number };
    expect(r.drafted).toBe(0);
  });
});

describe("leadscan.markSent", () => {
  let dir: string, leadsFile: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atlas-marksent-"));
    leadsFile = join(dir, "leads.json");
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("marks contacted WITHOUT firing the n8n new-lead workflow", async () => {
    // `approve` calls outreach -> n8n "new-lead", which ends in a
    // thanks-for-contacting-us confirmation. Firing that on top of a cold
    // email already delivered is two wrong emails instead of one right one.
    // The forbidden fetcher proves nothing left the process.
    await writeFile(leadsFile, JSON.stringify([lead({ id: "x" })]), "utf8");
    const a = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({}) });
    await a.use(createLeadScanPlugin({ leadFile: leadsFile, fetcher: forbiddenFetch }));

    const updated = (await a.invoke("leadscan", { op: "markSent", id: "x" })) as { status: string };
    expect(updated.status).toBe("contacted");
  });

  it("errors on an unknown lead rather than silently doing nothing", async () => {
    await writeFile(leadsFile, JSON.stringify([]), "utf8");
    const a = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({}) });
    await a.use(createLeadScanPlugin({ leadFile: leadsFile, fetcher: forbiddenFetch }));
    await expect(a.invoke("leadscan", { op: "markSent", id: "nope" })).rejects.toThrow(/no lead/);
  });
});
