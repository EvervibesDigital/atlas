import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, ConfigVault, type GuardianLike } from "@atlas/core";
import { createWholesalePlugin } from "../src/plugin";
import { createSenderPlugin } from "@atlas/sender";

function permissiveGuardian(): GuardianLike {
  return { grant: () => {}, check: () => ({ decision: "allow", reason: "test" }) };
}

const ADDRESS = "EverVibes, 100 Main St, Tampa, FL 33601";
const draft = (id: string, email: string) => ({
  id: `intro:${id}`, buyerId: id, name: `Buyer ${id}`, email,
  subject: "Two off-market deals in Tampa", body: "Hi — I've got two off-market deals this month.", createdAt: "2026-08-01T00:00:00.000Z",
});

function acceptingFetch() {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ id: `msg_${calls.length}` }) } as Response;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("wholesale.autoOutreach — the daily-digest path, no per-email review", () => {
  let dir: string, draftsFile: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atlas-wauto-"));
    draftsFile = join(dir, "intro-drafts.json");
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function atlasWith(drafts: unknown[], fetcher: typeof fetch) {
    await writeFile(draftsFile, JSON.stringify(drafts), "utf8");
    const a = new Atlas({
      guardian: permissiveGuardian(),
      config: new ConfigVault({ COMPANY_POSTAL_ADDRESS: ADDRESS, RESEND_API_KEY: "re_k", SENDER_FROM: "EverVibes <team@evervibesdigital.com>" }),
    });
    await a.use(createWholesalePlugin({ introDraftsFile: draftsFile, fetcher }));
    await a.use(createSenderPlugin({ suppressionFile: join(dir, "sup.json"), digestFile: join(dir, "dig.json"), fetcher }));
    return a;
  }

  it("sends every eligible draft and discards ONLY the delivered ones", async () => {
    const { fetcher } = acceptingFetch();
    const a = await atlasWith([draft("b1", "a@example.com"), draft("b2", "b@example.com")], fetcher);

    const r = (await a.invoke("wholesale", { op: "autoOutreach" })) as { drafted: number; sent: number; discarded: number };
    expect(r.drafted).toBe(2);
    expect(r.sent).toBe(2);
    expect(r.discarded).toBe(2);

    const onDisk = JSON.parse(await readFile(draftsFile, "utf8")) as unknown[];
    expect(onDisk).toHaveLength(0);
  });

  it("a buyer with no email is skipped at draft time; a suppressed one is skipped at send time — neither blocks the other buyer", async () => {
    const { fetcher } = acceptingFetch();
    const a = await atlasWith([draft("noemail", ""), draft("suppressed", "s@example.com"), draft("good", "g@example.com")], fetcher);
    await a.invoke("sender", { op: "suppress", email: "s@example.com" });

    const r = (await a.invoke("wholesale", { op: "autoOutreach" })) as {
      drafted: number; draftSkipped: number; sent: number; sendSkipped: number; discarded: number;
    };
    expect(r.draftSkipped).toBe(1); // no email
    expect(r.drafted).toBe(2); // suppressed + good made it to draft stage
    expect(r.sent).toBe(1); // only good
    expect(r.sendSkipped).toBe(1); // suppressed
    expect(r.discarded).toBe(1);

    const onDisk = JSON.parse(await readFile(draftsFile, "utf8")) as Array<{ id: string }>;
    // noemail and suppressed drafts both survive — one never drafted, one
    // drafted but not sent, and BOTH are still worth keeping to fix/retry.
    expect(onDisk.map((d) => d.id).sort()).toEqual(["intro:noemail", "intro:suppressed"]);
  });

  it("passes maxPerRun through to cap a single run", async () => {
    const { fetcher, calls } = acceptingFetch();
    const a = await atlasWith(["a", "b", "c"].map((id) => draft(id, `${id}@example.com`)), fetcher);
    const r = (await a.invoke("wholesale", { op: "autoOutreach", maxPerRun: 1 })) as { sent: number };
    expect(r.sent).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("does nothing and reports zero when there are no drafts", async () => {
    const { fetcher, calls } = acceptingFetch();
    const a = await atlasWith([], fetcher);
    const r = (await a.invoke("wholesale", { op: "autoOutreach" })) as { drafted: number; sent: number };
    expect(r).toMatchObject({ drafted: 0, sent: 0 });
    expect(calls).toHaveLength(0);
  });
});
