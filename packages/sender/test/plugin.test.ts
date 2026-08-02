import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Atlas, ConfigVault, type GuardianLike } from "@atlas/core";
import { createSenderPlugin } from "../src/plugin";
import type { FetchLike } from "../src/resend";

function permissiveGuardian(): GuardianLike {
  return { grant: () => {}, check: () => ({ decision: "allow", reason: "test" }) };
}

/** A fetch that fails the test if anything calls it. Proves "no send happened"
 * as a fact rather than an absence of evidence. */
const forbiddenFetch: FetchLike = (() => {
  throw new Error("NETWORK CALLED — this path must never reach the wire");
}) as unknown as FetchLike;

function acceptingFetch(): { fetcher: FetchLike; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const fetcher = (async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ id: `msg_${calls.length}` }) } as Response;
  }) as unknown as FetchLike;
  return { fetcher, calls };
}

const ADDRESS = "EverVibes, 100 Main St, Tampa, FL 33601";

/** A compliant email: names the address in the text and offers an opt-out. */
function goodEmail(to = "owner@smilesupdentistry.com") {
  return {
    to,
    subject: "4 issues on smilesupdentistry.com",
    body: `Hi,\n\nI ran a check on your site and found a few things.\n\nIf this isn't useful, just say so and I won't follow up.\n\n— Mat, EverVibes\n${ADDRESS}`,
  };
}

function makeAtlas(dir: string, fetcher: FetchLike, secrets: Record<string, string>) {
  const config = new ConfigVault({ ...secrets });
  const atlas = new Atlas({ guardian: permissiveGuardian(), config });
  return atlas.use(createSenderPlugin({ suppressionFile: join(dir, "suppressions.json"), fetcher })).then(() => atlas);
}

const FULL_SECRETS = {
  RESEND_API_KEY: "re_test_key",
  SENDER_FROM: "Mat <mat@evervibesdigital.com>",
  COMPANY_POSTAL_ADDRESS: ADDRESS,
};

describe("sender — the send gate", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "atlas-sender-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("refuses to send without confirmSend:true, and never touches the network", async () => {
    // The whole safety model: a required literal, checked before anything
    // else. An autonomous cycle cannot mail anyone by forgetting a flag.
    const atlas = await makeAtlas(dir, forbiddenFetch, FULL_SECRETS);
    await expect(atlas.invoke("sender", { op: "send", emails: [goodEmail()] })).rejects.toThrow(/confirmSend:true/);
  });

  it("treats a truthy-but-not-true confirmSend as a refusal", async () => {
    const atlas = await makeAtlas(dir, forbiddenFetch, FULL_SECRETS);
    for (const value of ["true", 1, {}]) {
      await expect(atlas.invoke("sender", { op: "send", emails: [goodEmail()], confirmSend: value })).rejects.toThrow(/confirmSend:true/);
    }
  });

  it("sends when everything checks out", async () => {
    const { fetcher, calls } = acceptingFetch();
    const atlas = await makeAtlas(dir, fetcher, FULL_SECRETS);
    const r = (await atlas.invoke("sender", { op: "send", emails: [goodEmail()], confirmSend: true })) as { sentCount: number; sent: Array<{ id: string }> };
    expect(r.sentCount).toBe(1);
    expect(r.sent[0]!.id).toBe("msg_1");
    expect(calls[0]).toMatchObject({ from: FULL_SECRETS.SENDER_FROM, to: ["owner@smilesupdentistry.com"] });
  });
});

describe("sender — compliance refuses rather than warns", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "atlas-sender-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("will not send at all when no postal address is configured", async () => {
    // The send-intro API has warned about this for weeks and it changed
    // nothing, because a warning still sends the email.
    const atlas = await makeAtlas(dir, forbiddenFetch, { RESEND_API_KEY: "re_k", SENDER_FROM: "Mat <mat@evervibesdigital.com>" });
    await expect(atlas.invoke("sender", { op: "send", emails: [goodEmail()], confirmSend: true })).rejects.toThrow(/COMPANY_POSTAL_ADDRESS/);
  });

  it("catches an address that is configured but missing from the body", async () => {
    // Configured-but-absent is exactly as illegal as never configured, and is
    // the failure a config-only check would wave through.
    const atlas = await makeAtlas(dir, forbiddenFetch, FULL_SECRETS);
    const noAddress = { ...goodEmail(), body: "Hi, some findings. If this isn't useful, just say so and I won't follow up." };
    await expect(atlas.invoke("sender", { op: "send", emails: [noAddress], confirmSend: true })).rejects.toThrow(/does not appear/);
  });

  it("requires an opt-out instruction", async () => {
    const atlas = await makeAtlas(dir, forbiddenFetch, FULL_SECRETS);
    const noOptOut = { ...goodEmail(), body: `Hi, some findings.\n\n— Mat\n${ADDRESS}` };
    await expect(atlas.invoke("sender", { op: "send", emails: [noOptOut], confirmSend: true })).rejects.toThrow(/opt-out/);
  });

  it("rejects unattended role addresses", async () => {
    const atlas = await makeAtlas(dir, forbiddenFetch, FULL_SECRETS);
    await expect(atlas.invoke("sender", { op: "send", emails: [goodEmail("no-reply@example.com")], confirmSend: true })).rejects.toThrow(/role address/);
  });

  it("sends NOTHING when one email in a batch fails checks", async () => {
    // All-or-nothing: partially sending a reviewed batch means Mat approved
    // one set of emails and a different set went out.
    const atlas = await makeAtlas(dir, forbiddenFetch, FULL_SECRETS);
    const emails = [goodEmail("a@example.com"), { ...goodEmail("b@example.com"), subject: "" }];
    await expect(atlas.invoke("sender", { op: "send", emails, confirmSend: true })).rejects.toThrow(/1 of 2/);
  });

  it("explains why a free-mail From address cannot work", async () => {
    // Resend only sends from a verified domain. Catching it here turns an
    // opaque provider 403 into a sentence naming the fix.
    const atlas = await makeAtlas(dir, forbiddenFetch, { ...FULL_SECRETS, SENDER_FROM: "mat@gmail.com" });
    await expect(atlas.invoke("sender", { op: "send", emails: [goodEmail()], confirmSend: true })).rejects.toThrow(/verified/);
  });
});

describe("sender — suppression is enforced here, not by callers", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "atlas-sender-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("blocks a suppressed address even in an otherwise perfect batch", async () => {
    const atlas = await makeAtlas(dir, forbiddenFetch, FULL_SECRETS);
    await atlas.invoke("sender", { op: "suppress", email: "owner@smilesupdentistry.com", reason: "asked to stop" });
    await expect(atlas.invoke("sender", { op: "send", emails: [goodEmail()], confirmSend: true })).rejects.toThrow(/opted out/);
  });

  it("honours an opt-out across capitalisation and plus-tags", async () => {
    // Someone who unsubscribed as Bob+news@Gmail.com has unsubscribed as
    // bob@gmail.com — it is the same inbox.
    const atlas = await makeAtlas(dir, forbiddenFetch, FULL_SECRETS);
    await atlas.invoke("sender", { op: "suppress", email: "Bob+news@Gmail.com" });
    await expect(atlas.invoke("sender", { op: "send", emails: [goodEmail("b.ob@gmail.com")], confirmSend: true })).rejects.toThrow(/opted out/);
  });

  it("persists suppressions to disk", async () => {
    const atlas = await makeAtlas(dir, forbiddenFetch, FULL_SECRETS);
    await atlas.invoke("sender", { op: "suppress", email: "x@example.com", reason: "replied stop" });
    const saved = JSON.parse(await readFile(join(dir, "suppressions.json"), "utf8")) as Array<{ email: string; reason: string }>;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ email: "x@example.com", reason: "replied stop" });
  });
});

describe("sender — preview and status", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "atlas-sender-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("preview reports every problem at once and sends nothing", async () => {
    const atlas = await makeAtlas(dir, forbiddenFetch, FULL_SECRETS);
    const bad = { to: "not-an-email", subject: "", body: "nothing here" };
    const r = (await atlas.invoke("sender", { op: "preview", emails: [goodEmail(), bad] })) as {
      total: number; sendable: number; rows: Array<{ sendable: boolean; problems: Array<{ rule: string }> }>;
    };
    expect(r.total).toBe(2);
    expect(r.sendable).toBe(1);
    // All problems, not just the first — so fixing a batch takes one pass.
    expect(r.rows[1]!.problems.map((p) => p.rule).sort()).toEqual(
      ["opt-out-required", "postal-address-in-body", "subject-required", "valid-recipient"],
    );
  });

  it("status names every blocker instead of just saying not ready", async () => {
    const atlas = await makeAtlas(dir, forbiddenFetch, {});
    const s = (await atlas.invoke("sender", { op: "status" })) as { readyToSend: boolean; blockers: string[] };
    expect(s.readyToSend).toBe(false);
    expect(s.blockers.join(" ")).toMatch(/RESEND_API_KEY/);
    expect(s.blockers.join(" ")).toMatch(/SENDER_FROM/);
    expect(s.blockers.join(" ")).toMatch(/COMPANY_POSTAL_ADDRESS/);
  });

  it("status reports ready once everything is configured", async () => {
    const atlas = await makeAtlas(dir, forbiddenFetch, FULL_SECRETS);
    const s = (await atlas.invoke("sender", { op: "status" })) as { readyToSend: boolean; provider: string };
    expect(s.readyToSend).toBe(true);
    expect(s.provider).toBe("resend");
  });
});
