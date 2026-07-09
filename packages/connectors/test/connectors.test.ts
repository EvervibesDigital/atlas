import { describe, it, expect } from "vitest";
import { syncGithub, syncVercel, syncSupabase, type FetchLike } from "../src/index";

const fake =
  (payload: unknown, ok = true, status = 200): FetchLike =>
  async () => ({ ok, status, json: async () => payload });

describe("connectors (read-only)", () => {
  it("summarizes GitHub repos", async () => {
    const r = await syncGithub("tok", fake([
      { full_name: "EvervibesDigital/atlas", private: true, description: "AI OS" },
      { full_name: "EvervibesDigital/site", private: false, description: null },
    ]));
    expect(r.summary).toMatch(/2 GitHub repositories/);
    expect(r.items[0]).toContain("atlas (private)");
  });

  it("summarizes Vercel projects", async () => {
    const r = await syncVercel("tok", fake({ projects: [{ name: "evervibes", framework: "nextjs" }] }));
    expect(r.items[0]).toContain("evervibes (nextjs)");
  });

  it("summarizes Supabase projects", async () => {
    const r = await syncSupabase("tok", fake([{ name: "evervibes-db", region: "us-east-1" }]));
    expect(r.items[0]).toContain("evervibes-db");
  });

  it("throws a clear error on a bad token", async () => {
    await expect(syncGithub("bad", fake({}, false, 401))).rejects.toThrow(/HTTP 401/);
  });
});
