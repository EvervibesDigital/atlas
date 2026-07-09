import type { Plugin } from "@atlas/core";

/**
 * Inbox — how Mat messages ATLAS from anywhere. He opens a GitHub Issue on the
 * atlas repo (from the GitHub mobile app or any browser); ATLAS reads open
 * issues, files each as an instruction in memory, and surfaces them so it adds
 * them to what it's working on. READ-ONLY: it ingests messages; replying or
 * closing an issue would be a gated write action.
 */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface InboxMessage {
  number: number;
  title: string;
  body: string;
}

export async function fetchIssues(repo: string, token: string, fetcher: FetchLike): Promise<InboxMessage[]> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("repo must be 'owner/name'");
  const res = await fetcher(`https://api.github.com/repos/${repo}/issues?state=open&per_page=50`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "ATLAS", Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`);
  const issues = (await res.json()) as Array<{ number: number; title: string; body?: string | null; pull_request?: unknown }>;
  return issues.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, body: i.body ?? "" }));
}

export type InboxCommand = { op: "check"; repo: string; token: string };

/** Inbox plugin (service "inbox"). Dedupes by issue number within a run. */
export function createInboxPlugin(opts: { fetcher?: FetchLike } = {}): Plugin {
  const fetcher = opts.fetcher ?? (globalThis.fetch as unknown as FetchLike);
  const seen = new Set<number>();

  return {
    manifest: { name: "inbox", version: "0.1.0", capabilities: ["inbox"], permissions: ["call:memory"], role: "executor" },
    register(ctx) {
      ctx.provide("inbox", async (payload) => {
        const cmd = payload as InboxCommand;
        if (cmd.op !== "check") throw new Error(`inbox: unknown op "${(cmd as { op: string }).op}"`);

        const messages = await fetchIssues(cmd.repo, cmd.token, fetcher);
        const fresh = messages.filter((m) => !seen.has(m.number));
        for (const m of fresh) {
          seen.add(m.number);
          try {
            await ctx.call("memory", {
              op: "remember",
              input: { kind: "project", content: `📨 Instruction from Mat (issue #${m.number}): ${m.title}${m.body ? ` — ${m.body}` : ""}`.slice(0, 2000), metadata: { issue: m.number, source: "inbox" } },
            });
          } catch {
            /* memory optional */
          }
          await ctx.emit("inbox.message", { number: m.number, title: m.title });
        }
        return { total: messages.length, new: fresh };
      });
    },
  };
}
