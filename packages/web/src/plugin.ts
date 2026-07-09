import type { AtlasContext, Plugin } from "@atlas/core";
import type { FetchLike } from "./read";
import { fetchReadable } from "./read";

export type WebCommand =
  | { op: "read"; url: string }
  | { op: "learn"; url: string }
  | { op: "repo"; repo: string };

const ANALYST_SYSTEM =
  "You are ATLAS's research analyst. Read the content and produce concise, useful notes as bullet points: what it is, who it's for, the core offer/features, pricing if shown, and specifically how it could help Mat's online businesses. Be factual; if something isn't stated, don't invent it.";

async function summarize(ctx: AtlasContext, header: string, text: string): Promise<string> {
  try {
    const r = (await ctx.call("brain", {
      system: ANALYST_SYSTEM,
      prompt: `${header}\n\nContent:\n${text}`,
      needs: { research: 0.8, cost: 1 },
      maxTokens: 1024,
      task: "web.analyze",
    })) as { text: string };
    return r.text;
  } catch {
    return text.slice(0, 600);
  }
}

/**
 * Web plugin (service "web") — ATLAS's eyes on the internet. READ-ONLY:
 *   read  → fetch a page, return its readable text
 *   learn → fetch + analyze into notes + save to memory
 *   repo  → read a public GitHub repo's README + analyze into notes
 * It cannot sign up, submit forms, install, or post — those are gated actions
 * handled elsewhere behind approval.
 */
export function createWebPlugin(opts: { fetcher?: FetchLike } = {}): Plugin {
  const fetcher = opts.fetcher;
  return {
    manifest: { name: "web", version: "0.1.0", capabilities: ["web"], permissions: ["call:brain", "call:memory"], role: "executor" },
    register(ctx) {
      ctx.provide("web", async (payload) => {
        const cmd = payload as WebCommand;

        if (cmd.op === "read") {
          return fetchReadable(cmd.url, { fetcher });
        }

        if (cmd.op === "learn") {
          const page = await fetchReadable(cmd.url, { fetcher });
          const notes = await summarize(ctx, `URL: ${page.url}\nTitle: ${page.title}`, page.text);
          try {
            await ctx.call("memory", {
              op: "remember",
              input: { kind: "semantic", content: `Learned from ${page.url} (${page.title}): ${notes}`.slice(0, 2000), metadata: { url: page.url } },
            });
          } catch {
            /* memory optional */
          }
          await ctx.emit("web.learned", { url: page.url, title: page.title });
          return { url: page.url, title: page.title, notes };
        }

        if (cmd.op === "repo") {
          if (!/^[\w.-]+\/[\w.-]+$/.test(cmd.repo)) throw new Error("repo must be 'owner/name'");
          const f = fetcher ?? (globalThis.fetch as unknown as FetchLike);
          const res = await f(`https://api.github.com/repos/${cmd.repo}/readme`);
          if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
          const data = JSON.parse(await res.text()) as { content?: string; encoding?: string };
          const readme = data.content ? Buffer.from(data.content, (data.encoding as BufferEncoding) ?? "base64").toString("utf8") : "";
          const notes = await summarize(ctx, `GitHub repo: ${cmd.repo}`, readme.slice(0, 8000));
          try {
            await ctx.call("memory", {
              op: "remember",
              input: { kind: "project", content: `Analyzed GitHub repo ${cmd.repo}: ${notes}`.slice(0, 2000), metadata: { repo: cmd.repo } },
            });
          } catch {
            /* memory optional */
          }
          await ctx.emit("web.repo", { repo: cmd.repo });
          return { repo: cmd.repo, notes };
        }

        throw new Error(`web: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
