export type FetchLike = typeof fetch;

/** Twin's REST base. NOT api.twin.so — that host doesn't resolve. */
const TWIN_BASE = "https://build.twin.so";

export interface TwinRunEvent {
  [k: string]: unknown;
}

/**
 * Thin REST client for triggering a Twin agent and reading back its run
 * events. Deliberately minimal — ATLAS orchestrates Twin's existing Batch
 * Skip Tracer rather than reimplementing skip tracing, since that agent runs
 * off a Twin *platform* tool (`enrich_property`) that can't be replicated
 * here anyway.
 */
export class TwinEnrichmentClient {
  constructor(
    private apiKey: string,
    private f: FetchLike = fetch,
  ) {}

  private headers(): Record<string, string> {
    return { "x-api-key": this.apiKey, "Content-Type": "application/json" };
  }

  private async json(res: Response, what: string): Promise<unknown> {
    const text = await res.text();
    if (!res.ok) throw new Error(`twin ${what} HTTP ${res.status}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`twin ${what}: response was not JSON: ${text.slice(0, 120)}`);
    }
  }

  /** Kick off a run. Returns the new run's id. */
  async startRun(agentId: string, userMessage: string): Promise<string> {
    const res = await this.f(`${TWIN_BASE}/v1/agents/${agentId}/runs`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ run_mode: "run", user_message: userMessage }),
    });
    const d = (await this.json(res, "startRun")) as { run_id?: string; id?: string; data?: { run_id?: string } };
    const id = d.run_id ?? d.id ?? d.data?.run_id;
    if (!id) throw new Error(`twin startRun: no run id in response: ${JSON.stringify(d).slice(0, 200)}`);
    return id;
  }

  async getRunEvents(agentId: string, runId: string): Promise<TwinRunEvent[]> {
    const res = await this.f(`${TWIN_BASE}/v1/agents/${agentId}/runs/${runId}/events?limit=200`, { headers: this.headers() });
    const d = (await this.json(res, "getRunEvents")) as { data?: TwinRunEvent[]; events?: TwinRunEvent[] };
    return d.data ?? d.events ?? (Array.isArray(d) ? (d as TwinRunEvent[]) : []);
  }

  async isFinished(agentId: string, runId: string): Promise<boolean> {
    const res = await this.f(`${TWIN_BASE}/v1/agents/${agentId}/runs/${runId}`, { headers: this.headers() });
    const d = (await this.json(res, "getRun")) as { status?: string; is_finished?: boolean; data?: { status?: string } };
    const status = d.status ?? d.data?.status;
    return d.is_finished === true || status === "completed" || status === "failed";
  }

  /** Polls until the run finishes or the bound is hit. A skip-trace batch is
   * slow (Twin runs a real browser agent), so the default bound is generous —
   * but it must never hang forever. */
  async waitForRun(agentId: string, runId: string, opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<TwinRunEvent[]> {
    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    const intervalMs = opts.intervalMs ?? 10_000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.isFinished(agentId, runId)) return this.getRunEvents(agentId, runId);
      if (Date.now() >= deadline) throw new Error(`twin run ${runId} did not finish within ${Math.round(timeoutMs / 1000)}s`);
      await sleep(intervalMs);
    }
  }
}
