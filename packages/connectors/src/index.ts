import type { Plugin } from "@atlas/core";

/**
 * Connectors — READ-ONLY windows into Mat's cloud accounts. Using tokens he
 * stores in the encrypted vault, ATLAS can SEE all his GitHub repos, Vercel
 * deployments, and Supabase projects and file a summary into memory. It never
 * writes, deploys, or deletes here — those are gated actions handled elsewhere.
 */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type ConnectorName = "github" | "vercel" | "supabase";

export interface SyncResult {
  service: ConnectorName;
  summary: string;
  items: string[];
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "User-Agent": "ATLAS", Accept: "application/json" };
}

async function getJson(fetcher: FetchLike, url: string, token: string): Promise<unknown> {
  const res = await fetcher(url, { headers: auth(token) });
  if (!res.ok) throw new Error(`${new URL(url).host} API returned HTTP ${res.status}`);
  return res.json();
}

export async function syncGithub(token: string, fetcher: FetchLike): Promise<SyncResult> {
  const repos = (await getJson(fetcher, "https://api.github.com/user/repos?per_page=100&sort=updated", token)) as Array<{
    full_name: string;
    private: boolean;
    description?: string | null;
  }>;
  const items = repos.map((r) => `${r.full_name}${r.private ? " (private)" : ""} — ${r.description ?? "no description"}`);
  return { service: "github", summary: `${repos.length} GitHub repositories`, items };
}

export async function syncVercel(token: string, fetcher: FetchLike): Promise<SyncResult> {
  const data = (await getJson(fetcher, "https://api.vercel.com/v9/projects?limit=100", token)) as { projects?: Array<{ name: string; framework?: string | null }> };
  const projects = data.projects ?? [];
  const items = projects.map((p) => `${p.name}${p.framework ? ` (${p.framework})` : ""}`);
  return { service: "vercel", summary: `${projects.length} Vercel projects`, items };
}

export async function syncSupabase(token: string, fetcher: FetchLike): Promise<SyncResult> {
  const projects = (await getJson(fetcher, "https://api.supabase.com/v1/projects", token)) as Array<{ name: string; region?: string; id?: string }>;
  const items = projects.map((p) => `${p.name}${p.region ? ` — ${p.region}` : ""}`);
  return { service: "supabase", summary: `${projects.length} Supabase projects`, items };
}

const SYNCS: Record<ConnectorName, (t: string, f: FetchLike) => Promise<SyncResult>> = {
  github: syncGithub,
  vercel: syncVercel,
  supabase: syncSupabase,
};

export type ConnectorCommand = { op: "sync"; which: ConnectorName; token: string };

/** Connectors plugin (service "connectors"). */
export function createConnectorsPlugin(opts: { fetcher?: FetchLike } = {}): Plugin {
  const fetcher = opts.fetcher ?? (globalThis.fetch as unknown as FetchLike);
  return {
    manifest: { name: "connectors", version: "0.1.0", capabilities: ["connectors"], permissions: ["call:memory"], role: "executor" },
    register(ctx) {
      ctx.provide("connectors", async (payload) => {
        const cmd = payload as ConnectorCommand;
        if (cmd.op !== "sync") throw new Error(`connectors: unknown op "${(cmd as { op: string }).op}"`);
        const fn = SYNCS[cmd.which];
        if (!fn) throw new Error(`unknown connector "${cmd.which}"`);
        const result = await fn(cmd.token, fetcher);
        try {
          await ctx.call("memory", {
            op: "remember",
            input: { kind: "project", content: `${cmd.which} account: ${result.summary}. ${result.items.slice(0, 40).join("; ")}`.slice(0, 3000), metadata: { service: cmd.which } },
          });
        } catch {
          /* memory optional */
        }
        await ctx.emit("connectors.synced", { service: cmd.which, count: result.items.length });
        return result;
      });
    },
  };
}
