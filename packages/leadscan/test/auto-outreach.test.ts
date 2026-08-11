import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, ConfigVault, type GuardianLike } from "@atlas/core";
import { createLeadScanPlugin } from "../src/plugin";
import { createSenderPlugin } from "@atlas/sender";
import type { Lead } from "../src/types";

function permissiveGuardian(): GuardianLike {
  return { grant: () => {}, check: () => ({ decision: "allow", reason: "test" }) };
}

function lead(over: Partial<Lead> & { id: string }): Lead {
  return {
    businessName: `Biz ${over.id}`, website: "https://test.example/", email: `${over.id}@test.example`,
    phone: "555-0100", niche: "lawyers", city: "Phoenix, AZ", foundAt: "2026-08-01T00:00:00.000Z",
    status: "new", dedupeKey: over.id,
    scan: { url: "https://test.example/", overallScore: 40, issues: [{ category: "accessibility", issue: "12 image(s) missing alt text" }] },
    ...over,
  } as Lead;
}

const ADDRESS = "EverVibes, 100 Main St, Tampa, FL 33601";

function acceptingFetch() {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ id: `msg_${calls.length}` }) } as Response;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("leadscan.autoOutreach — the daily-digest path, no per-email review", () => {
  let dir: string, leadsFile: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atlas-auto-"));
    leadsFile = join(dir, "leads.json");
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function atlasWith(leads: Lead[], fetcher: typeof fetch) {
    await writeFile(leadsFile, JSON.stringify(leads), "utf8");
    const a = new Atlas({
      guardian: permissiveGuardian(),
      config: new ConfigVault({ COMPANY_POSTAL_ADDRESS: ADDRESS, RESEND_API_KEY: "re_k", SENDER_FROM: "EverVibes <team@evervibesdigital.com>" }),
    });
    await a.use(createLeadScanPlugin({ leadFile: leadsFile, fetcher }));
    await a.use(createSenderPlugin({ suppressionFile: join(dir, "sup.json"), digestFile: join(dir, "dig.json"), fetcher }));
    return a;
  }

  it("sends every eligible lead and marks ONLY the delivered ones contacted", async () => {
    const { fetcher } = acceptingFetch();
    const a = await atlasWith([lead({ id: "a" }), lead({ id: "b" })], fetcher);

    const r = (await a.invoke("leadscan", { op: "autoOutreach" })) as { drafted: number; sent: number; markedContacted: number };
    expect(r.drafted).toBe(2);
    expect(r.sent).toBe(2);
    expect(r.markedContacted).toBe(2);

    const onDisk = JSON.parse(await readFile(leadsFile, "utf8")) as Lead[];
    expect(onDisk.every((l) => l.status === "contacted")).toBe(true);
  });

  it("a clean site (no findings) is skipped at DRAFT time and left as 'new', not marked contacted", async () => {
    const { fetcher } = acceptingFetch();
    const clean = lead({ id: "clean" });
    clean.scan = { url: "https://clean.example/", overallScore: 100, issues: [] };
    const a = await atlasWith([lead({ id: "good" }), clean], fetcher);

    const r = (await a.invoke("leadscan", { op: "autoOutreach" })) as { drafted: number; draftSkipped: number; markedContacted: number };
    expect(r.drafted).toBe(1);
    expect(r.draftSkipped).toBe(1);
    expect(r.markedContacted).toBe(1);

    const onDisk = JSON.parse(await readFile(leadsFile, "utf8")) as Lead[];
    expect(onDisk.find((l) => l.id === "clean")!.status).toBe("new");
  });

  it("a suppressed address is skipped at SEND time and not marked contacted, others still go", async () => {
    // Proves autoOutreach uses sendAutonomous, not the all-or-nothing `send` —
    // one bad recipient must not block the good ones behind it.
    const { fetcher } = acceptingFetch();
    const a = await atlasWith([lead({ id: "a" }), lead({ id: "b" })], fetcher);
    await a.invoke("sender", { op: "suppress", email: "a@test.example" });

    const r = (await a.invoke("leadscan", { op: "autoOutreach" })) as { sent: number; sendSkipped: number; markedContacted: number };
    expect(r.sent).toBe(1);
    expect(r.sendSkipped).toBe(1);
    expect(r.markedContacted).toBe(1);

    const onDisk = JSON.parse(await readFile(leadsFile, "utf8")) as Lead[];
    expect(onDisk.find((l) => l.id === "a")!.status).toBe("new");
    expect(onDisk.find((l) => l.id === "b")!.status).toBe("contacted");
  });

  it("passes maxPerRun through to cap a single run", async () => {
    const { fetcher, calls } = acceptingFetch();
    const a = await atlasWith(["a", "b", "c"].map((id) => lead({ id })), fetcher);
    const r = (await a.invoke("leadscan", { op: "autoOutreach", maxPerRun: 1 })) as { sent: number };
    expect(r.sent).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("does nothing and reports zero when there is nothing eligible", async () => {
    const { fetcher, calls } = acceptingFetch();
    const a = await atlasWith([], fetcher);
    const r = (await a.invoke("leadscan", { op: "autoOutreach" })) as { drafted: number; sent: number };
    expect(r).toMatchObject({ drafted: 0, sent: 0 });
    expect(calls).toHaveLength(0);
  });
});
