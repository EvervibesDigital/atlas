import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, ConfigVault, type GuardianLike } from "@atlas/core";
import { storeDrafts, removeDraft, findDraft, introDraftId, type IntroDraft } from "../src/intro-drafts";
import { createWholesalePlugin } from "../src/plugin";

function permissiveGuardian(): GuardianLike {
  return { grant: () => {}, check: () => ({ decision: "allow", reason: "test" }) };
}

describe("storeDrafts", () => {
  it("keys drafts by buyer and replaces rather than duplicating on re-preview", () => {
    // Re-previewing the same buyer must not queue two emails to that person.
    const first = storeDrafts([], [{ id: "b1", name: "A", email: "a@x.com", subject: "s1", body: "body one" }]);
    const second = storeDrafts(first, [{ id: "b1", name: "A", email: "a@x.com", subject: "s2", body: "body two" }]);
    expect(second).toHaveLength(1);
    expect(second[0]!.subject).toBe("s2");
    expect(second[0]!.id).toBe(introDraftId("b1"));
  });

  it("skips malformed drafts instead of storing empty emails", () => {
    const out = storeDrafts([], [
      { id: "b1", subject: "", body: "x" } as never,
      { id: "", subject: "s", body: "b" } as never,
      { id: "b2", subject: "ok", body: "fine" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.buyerId).toBe("b2");
  });

  it("finds and removes by either the prefixed id or the raw buyer id", () => {
    const d = storeDrafts([], [{ id: "b1", subject: "s", body: "b" }]);
    expect(findDraft(d, "intro:b1")?.buyerId).toBe("b1");
    expect(findDraft(d, "b1")?.buyerId).toBe("b1");
    expect(removeDraft(d, "intro:b1")).toHaveLength(0);
  });
});

describe("intro draft approval flow", () => {
  let dir = "";
  let file = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atlas-intro-"));
    file = join(dir, "intro-drafts.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sends the STORED copy verbatim, not freshly generated text", async () => {
    // The whole point: copy is AI-written per buyer, so regenerating at send
    // time would send different words than the ones that were approved.
    const stored: IntroDraft[] = [
      { id: "intro:b1", buyerId: "b1", name: "A", email: "a@x.com", subject: "approved subject", body: "approved body", createdAt: "t" },
    ];
    await writeFile(file, JSON.stringify(stored), "utf8");

    let sentBody: Record<string, unknown> = {};
    const fake = (async (_u: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ ok: true, sent: 1 }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s" }) });
    await atlas.use(createWholesalePlugin({ fetcher: fake, introDraftsFile: file }));

    await atlas.invoke("wholesale", { op: "approveIntroDraft", id: "intro:b1" });

    expect(sentBody.drafts).toEqual([{ id: "b1", subject: "approved subject", body: "approved body" }]);
    // And it must be consumed, so the same email can't be sent twice.
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([]);
  });

  it("refuses to send a draft that no longer exists", async () => {
    await writeFile(file, "[]", "utf8");
    const forbidden = (() => {
      throw new Error("must not send");
    }) as unknown as typeof fetch;
    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s" }) });
    await atlas.use(createWholesalePlugin({ fetcher: forbidden, introDraftsFile: file }));

    await expect(atlas.invoke("wholesale", { op: "approveIntroDraft", id: "intro:gone" })).rejects.toThrow(/no stored intro draft/);
  });

  it("discarding removes the draft without sending anything", async () => {
    const stored: IntroDraft[] = [
      { id: "intro:b1", buyerId: "b1", name: "A", email: "a@x.com", subject: "s", body: "b", createdAt: "t" },
    ];
    await writeFile(file, JSON.stringify(stored), "utf8");
    const forbidden = (() => {
      throw new Error("discard must never send");
    }) as unknown as typeof fetch;

    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s" }) });
    await atlas.use(createWholesalePlugin({ fetcher: forbidden, introDraftsFile: file }));

    await atlas.invoke("wholesale", { op: "discardIntroDraft", id: "intro:b1" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([]);
  });
});
