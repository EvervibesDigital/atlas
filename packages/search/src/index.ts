import type { Plugin } from "@atlas/core";

/**
 * Search agent — ATLAS's ability to go FIND things on the open internet, using
 * Mat's free search keys (Tavily / Serper) and the GitHub API. It powers:
 *   • findSite — resolve a fuzzy/approximate site name to a real URL
 *   • freeApis — discover free APIs/tools for a topic
 *   • repos / scout — find GitHub repos that could make ATLAS better, and file
 *     the findings to memory
 * READ-ONLY: it searches and reports; using/acting on results is gated.
 */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function tavilySearch(apiKey: string, query: string, max: number, f: FetchLike): Promise<SearchResult[]> {
  const r = await f("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: max, search_depth: "basic" }),
  });
  if (!r.ok) throw new Error(`Tavily HTTP ${r.status}`);
  const d = (await r.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
  return (d.results ?? []).map((x) => ({ title: x.title, url: x.url, snippet: (x.content ?? "").slice(0, 300) }));
}

export async function serperSearch(apiKey: string, query: string, max: number, f: FetchLike): Promise<SearchResult[]> {
  const r = await f("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: max }),
  });
  if (!r.ok) throw new Error(`Serper HTTP ${r.status}`);
  const d = (await r.json()) as { organic?: Array<{ title: string; link: string; snippet?: string }> };
  return (d.organic ?? []).slice(0, max).map((x) => ({ title: x.title, url: x.link, snippet: x.snippet ?? "" }));
}

export async function githubRepoSearch(token: string | undefined, query: string, max: number, f: FetchLike): Promise<SearchResult[]> {
  const r = await f(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=${max}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "ATLAS", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!r.ok) throw new Error(`GitHub search HTTP ${r.status}`);
  const d = (await r.json()) as { items?: Array<{ full_name: string; html_url: string; description?: string | null; stargazers_count: number }> };
  return (d.items ?? []).map((x) => ({ title: x.full_name, url: x.html_url, snippet: `${x.description ?? ""} ⭐${x.stargazers_count}` }));
}

export type SearchCommand =
  | { op: "web"; query: string; max?: number }
  | { op: "findSite"; name: string }
  | { op: "freeApis"; topic: string }
  | { op: "repos"; query: string; max?: number }
  | { op: "scout"; query: string; max?: number };

/** Search plugin (service "search"). Reads Tavily/Serper/GitHub keys from the vault. */
export function createSearchPlugin(opts: { fetcher?: FetchLike } = {}): Plugin {
  const f = opts.fetcher ?? (globalThis.fetch as unknown as FetchLike);
  return {
    manifest: { name: "search", version: "0.1.0", capabilities: ["search"], permissions: ["secret:*", "call:memory"], role: "executor" },
    register(ctx) {
      async function web(query: string, max = 6): Promise<SearchResult[]> {
        const tavily = await ctx.secret("TAVILY_API_KEY");
        if (tavily) return tavilySearch(tavily, query, max, f);
        const serper = await ctx.secret("SERPER_API_KEY");
        if (serper) return serperSearch(serper, query, max, f);
        throw new Error("No search key — add a Tavily or Serper key (free) in Connect/Keys.");
      }

      ctx.provide("search", async (payload) => {
        const cmd = payload as SearchCommand;

        if (cmd.op === "web") return web(cmd.query, cmd.max);

        if (cmd.op === "findSite") {
          const results = await web(`${cmd.name} official website`, 5);
          return { query: cmd.name, best: results[0] ?? null, candidates: results };
        }

        if (cmd.op === "freeApis") {
          const results = await web(`best free API for ${cmd.topic} no credit card`, 8);
          try {
            await ctx.call("memory", { op: "remember", input: { kind: "reference", content: `Free-API options for ${cmd.topic}: ${results.map((r) => r.title + " " + r.url).join("; ")}`.slice(0, 2000) } });
          } catch {
            /* optional */
          }
          return { topic: cmd.topic, results };
        }

        if (cmd.op === "repos" || cmd.op === "scout") {
          const token = await ctx.secret("GITHUB_TOKEN");
          const results = await githubRepoSearch(token, cmd.query, cmd.max ?? 8, f);
          if (cmd.op === "scout") {
            for (const r of results) {
              try {
                await ctx.call("memory", { op: "remember", input: { kind: "project", content: `Repo to consider for ATLAS: ${r.title} — ${r.snippet} (${r.url})`.slice(0, 800), metadata: { url: r.url } } });
              } catch {
                /* optional */
              }
            }
            await ctx.emit("search.scouted", { query: cmd.query, count: results.length });
          }
          return { query: cmd.query, results };
        }

        throw new Error(`search: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
