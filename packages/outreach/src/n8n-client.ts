// Thin, injectable client for n8n's REST API + its webhook trigger URLs.
// Verified against n8n.evervibes.org (2026-07-21/22): the management API
// (list/activate/deactivate workflows) uses `X-N8N-API-KEY`; a workflow's
// own webhook trigger is a plain HTTP call to /webhook/<path> and needs no
// API key — n8n resolves it by path, same as an external caller (Stripe,
// Twilio) would hit it.

export type FetchLike = typeof fetch;

const BASE = "https://n8n.evervibes.org";

export class N8nClient {
  constructor(
    private apiKey: string,
    private f: FetchLike = fetch,
    private base: string = BASE,
  ) {}

  private async api(path: string, init?: RequestInit): Promise<unknown> {
    const r = await this.f(`${this.base}/api/v1${path}`, { ...init, headers: { ...(init?.headers ?? {}), "X-N8N-API-KEY": this.apiKey } });
    if (!r.ok) throw new Error(`n8n API ${path} -> HTTP ${r.status}`);
    return r.json().catch(() => ({}));
  }

  /** GET /api/v1/workflows */
  async listWorkflows(): Promise<Array<{ id: string; name: string; active: boolean }>> {
    const raw = (await this.api("/workflows?limit=100")) as { data?: unknown[] };
    const arr = Array.isArray(raw) ? raw : (raw.data ?? []);
    return (arr as Array<Record<string, unknown>>).map((w) => ({
      id: String(w.id ?? ""),
      name: String(w.name ?? "(unnamed)"),
      active: Boolean(w.active),
    }));
  }

  /** POST /api/v1/workflows/{id}/activate or /deactivate. */
  async setActive(id: string, active: boolean): Promise<void> {
    await this.api(`/workflows/${id}/${active ? "activate" : "deactivate"}`, { method: "POST" });
  }

  /** POST to the workflow's own /webhook/<path> — invokes it directly, no management API key needed. */
  async triggerWebhook(path: string, payload: Record<string, unknown>): Promise<unknown> {
    const r = await this.f(`${this.base}/webhook/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`n8n webhook /${path} -> HTTP ${r.status}`);
    return r.json().catch(() => ({}));
  }
}
