// Thin, injectable client for Twin AI's public REST API (build.twin.so).
// Verified endpoints (2026-07-21): list agents, read/trigger runs, pull run
// events, list + pause schedules. Auth is `x-api-key: <twin_...>`.
//
// Kept dependency-free and fetcher-injectable so it's unit-testable without
// hitting the network — same pattern as @atlas/search's FetchLike seam.

import type { TwinAgent, TwinSchedule } from "./types";

export type FetchLike = typeof fetch;

const BASE = "https://build.twin.so";

export class TwinClient {
  constructor(
    private apiKey: string,
    private f: FetchLike = fetch,
    private base: string = BASE,
  ) {}

  private async get(path: string): Promise<unknown> {
    const r = await this.f(`${this.base}${path}`, { headers: { "x-api-key": this.apiKey } });
    if (!r.ok) throw new Error(`twin GET ${path} -> HTTP ${r.status}`);
    return r.json();
  }

  private async post(path: string, body?: unknown): Promise<unknown> {
    const r = await this.f(`${this.base}${path}`, {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`twin POST ${path} -> HTTP ${r.status}`);
    return r.json().catch(() => ({}));
  }

  /** GET /v1/agents — the API returns each name nested under agent_name.name; flatten it. */
  async listAgents(limit = 50): Promise<TwinAgent[]> {
    const raw = (await this.get(`/v1/agents?limit=${limit}`)) as { data?: unknown[] };
    const arr = Array.isArray(raw) ? raw : (raw.data ?? []);
    return (arr as Array<Record<string, unknown>>).map((a) => ({
      agent_id: String(a.agent_id ?? ""),
      name: String((a.agent_name as { name?: string } | undefined)?.name ?? "(unnamed)"),
      latest_run_id: a.latest_run_id ? String(a.latest_run_id) : undefined,
      latest_run_status: a.latest_run_status ? String(a.latest_run_status) : undefined,
      last_activity_at: a.last_activity_at ? String(a.last_activity_at) : undefined,
      has_runs: Boolean(a.has_runs),
    }));
  }

  /** GET /v1/schedules — the recurring (billable) surface; used to see/verify what's on autopilot. */
  async listSchedules(): Promise<TwinSchedule[]> {
    const raw = (await this.get(`/v1/schedules`)) as { data?: unknown[] };
    const arr = Array.isArray(raw) ? raw : (raw.data ?? []);
    return (arr as Array<Record<string, unknown>>).map((s) => ({
      agent_id: String(s.agent_id ?? ""),
      cron: String(s.cron ?? ""),
      next_run: typeof s.next_run === "number" ? s.next_run : undefined,
      paused: Boolean(s.paused),
      consecutive_failures: typeof s.consecutive_failures === "number" ? s.consecutive_failures : undefined,
      auto_paused: Boolean(s.auto_paused),
    }));
  }

  /** GET /v1/agents/{id}/instructions — the full natural-language spec; the migration blueprint. */
  async getInstructions(agentId: string): Promise<string> {
    const raw = (await this.get(`/v1/agents/${agentId}/instructions`)) as { instructions?: unknown };
    const v = raw.instructions;
    return typeof v === "string" ? v : JSON.stringify(v ?? "");
  }

  /** POST /v1/agents/{id}/runs — trigger a run. run_mode "run" executes the deployed agent. */
  async triggerRun(agentId: string, userMessage = "Execute workflow"): Promise<{ run_id?: string }> {
    const raw = (await this.post(`/v1/agents/${agentId}/runs`, { run_mode: "run", user_message: userMessage })) as Record<string, unknown>;
    return { run_id: raw.run_id ? String(raw.run_id) : undefined };
  }

  /** GET /v1/agents/{id}/runs/{run_id}/events — raw event stream from a run (where output lands). */
  async getRunEvents(agentId: string, runId: string, limit = 100): Promise<unknown[]> {
    const raw = (await this.get(`/v1/agents/${agentId}/runs/${runId}/events?limit=${limit}`)) as { data?: unknown[] };
    return Array.isArray(raw) ? raw : (raw.data ?? []);
  }

  /** POST /v1/agents/{id}/schedule/pause — stop an agent's recurring run (used when migrating off Twin). */
  async pauseSchedule(agentId: string): Promise<void> {
    await this.post(`/v1/agents/${agentId}/schedule/pause`);
  }
}
