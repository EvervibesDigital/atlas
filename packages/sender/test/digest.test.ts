import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDigest, loadDigest, isSameDay, summarizeDigest, type DigestEntry } from "../src/digest";

describe("digest log", () => {
  let dir: string, file: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "atlas-digest-")); file = join(dir, "digest.json"); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("starts empty and accumulates across calls", async () => {
    expect(await loadDigest(file)).toEqual([]);
    await appendDigest(file, [{ at: "2026-08-02T10:00:00Z", to: "a@x.com", subject: "s", outcome: "sent" }]);
    await appendDigest(file, [{ at: "2026-08-02T11:00:00Z", to: "b@x.com", subject: "s", outcome: "sent" }]);
    expect(await loadDigest(file)).toHaveLength(2);
  });

  it("does nothing on an empty entry list rather than writing an empty file", async () => {
    await appendDigest(file, []);
    expect(await loadDigest(file)).toEqual([]);
  });
});

describe("isSameDay", () => {
  it("treats two timestamps on the same UTC calendar day as the same day", () => {
    expect(isSameDay("2026-08-02T00:05:00Z", "2026-08-02T23:55:00Z")).toBe(true);
  });

  it("treats midnight-adjacent timestamps on different days as different", () => {
    expect(isSameDay("2026-08-02T23:59:00Z", "2026-08-03T00:01:00Z")).toBe(false);
  });
});

describe("summarizeDigest", () => {
  const entries: DigestEntry[] = [
    { at: "2026-08-02T09:00:00Z", to: "a@x.com", subject: "s", outcome: "sent", source: "leadscan" },
    { at: "2026-08-02T09:05:00Z", to: "b@x.com", subject: "s", outcome: "sent", source: "leadscan" },
    { at: "2026-08-02T09:10:00Z", to: "c@x.com", subject: "s", outcome: "sent", source: "wholesale" },
    { at: "2026-08-02T09:15:00Z", to: "d@x.com", subject: "s", outcome: "skipped", reason: "no findings" },
    { at: "2026-08-02T09:20:00Z", to: "e@x.com", subject: "s", outcome: "failed", reason: "smtp timeout" },
    { at: "2026-08-01T09:00:00Z", to: "old@x.com", subject: "s", outcome: "sent", source: "leadscan" },
  ];

  it("counts only today's activity by default, split by source", () => {
    const s = summarizeDigest(entries, "2026-08-02T12:00:00Z");
    expect(s.sent).toBe(3);
    expect(s.skipped).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.bySource).toEqual({ leadscan: 2, wholesale: 1 });
    expect(s.entries).toHaveLength(5);
  });

  it("excludes yesterday's entries even though they are in the same file", () => {
    const s = summarizeDigest(entries, "2026-08-02T12:00:00Z");
    expect(s.entries.some((e) => e.to === "old@x.com")).toBe(false);
  });

  it("labels a sourceless send as manual rather than dropping it", () => {
    const s = summarizeDigest([{ at: "2026-08-02T09:00:00Z", to: "x@x.com", subject: "s", outcome: "sent" }], "2026-08-02T12:00:00Z");
    expect(s.bySource).toEqual({ manual: 1 });
  });
});
