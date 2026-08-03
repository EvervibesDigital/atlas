import { describe, it, expect } from "vitest";
import { TwinClient, type FetchLike } from "../src/twin-client";

/** Responds with a captured-shape body for any path. */
function fakeFetch(body: unknown): FetchLike {
  return (async () => ({ ok: true, status: 200, json: async () => body }) as Response) as unknown as FetchLike;
}

describe("TwinClient response shape", () => {
  /**
   * Captured VERBATIM from build.twin.so on 2026-08-02. The client previously
   * read `raw.data`, which is not what Twin returns — so every call resolved
   * to [] while reporting HTTP 200, and surplus.listAgents reported "no
   * agents" against a workspace full of them. A silent empty is worse than an
   * error: nothing surfaces to investigate.
   */
  const REAL_AGENTS = {
    agents: [
      {
        agent_id: "019f9b69-0d36-77c7-b74f-21f0e7fee615",
        latest_run_id: "019f9b69-0d7e-7e2c-9d9b-ff146c65c11b",
        agent_name: { name: "Influencer Persona Generator" },
        last_activity_at: "2026-07-25T23:09:08Z",
        has_runs: true,
      },
    ],
  };
  const REAL_SCHEDULES = {
    schedules: [
      { agent_id: "019cbebb-e091-7dc1-beee-0e9e9a8477ec", cron: "0 15 17 * * 5 *", next_run: 1786036500, paused: true, consecutive_failures: 0 },
    ],
  };

  it("reads agents from the key Twin actually returns", async () => {
    const agents = await new TwinClient("k", fakeFetch(REAL_AGENTS)).listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("Influencer Persona Generator");
    expect(agents[0]!.has_runs).toBe(true);
  });

  it("reads schedules from the key Twin actually returns", async () => {
    const s = await new TwinClient("k", fakeFetch(REAL_SCHEDULES)).listSchedules();
    expect(s).toHaveLength(1);
    expect(s[0]!.paused).toBe(true);
    expect(s[0]!.cron).toBe("0 15 17 * * 5 *");
  });

  it("still accepts a bare array, in case the shape changes again", async () => {
    const agents = await new TwinClient("k", fakeFetch(REAL_AGENTS.agents)).listAgents();
    expect(agents).toHaveLength(1);
  });

  it("returns empty for a genuinely empty workspace, not a crash", async () => {
    expect(await new TwinClient("k", fakeFetch({ agents: [] })).listAgents()).toEqual([]);
  });
});
