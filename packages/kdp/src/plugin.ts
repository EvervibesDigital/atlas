import type { Plugin } from "@atlas/core";
import type { KdpBook, KdpBookStatus, KdpOpportunity } from "./types";

/**
 * KDP plugin (service "kdp") — bridges ATLAS to the REAL, already-built KDP
 * pipeline living in the separate `evervibes` Next.js app (trend scan → AI
 * scoring → metadata generation → PDF ZIP → manual Amazon upload). This does
 * NOT reimplement that pipeline — it calls the existing, deployed endpoints
 * over HTTP, same auth (CRON_SECRET bearer) the app's own cron jobs use.
 *
 * Honest scope: this wires ATLAS to what's ACTUALLY BUILT. Cover Engine v2
 * (real finished covers, currently spec-only — see evervibes'
 * docs/superpowers/specs/2026-07-13-kdp-cover-engine-design.md) is NOT
 * implemented yet; books ship with a placeholder cover template until that
 * gets built. Amazon auto-upload and sales tracking (roadmap sub-projects
 * 3-4) are also not built — status marking here is manual (Mat tells ATLAS,
 * or uses the evervibes hub directly).
 */
export type KdpCommand =
  | { op: "scan" }
  | { op: "generate"; limit?: number }
  | { op: "status" }
  | { op: "markStatus"; id: string; status: KdpBookStatus; amazonUrl?: string; amazonAsin?: string }
  | { op: "downloadZip"; id: string };

export function createKdpPlugin(opts: { fetcher?: typeof fetch } = {}): Plugin {
  const f = opts.fetcher ?? fetch;

  return {
    manifest: {
      name: "kdp",
      version: "0.1.0",
      capabilities: ["kdp"],
      permissions: ["secret:*", "call:memory"],
      role: "executor",
    },

    register(ctx) {
      async function base(): Promise<{ url: string; secret: string }> {
        const url = (await ctx.secret("EVERVIBES_APP_URL")) || "https://evervibesdigital.com";
        const secret = await ctx.secret("KDP_CRON_SECRET");
        if (!secret) throw new Error("kdp: no KDP_CRON_SECRET set — add it in API Keys (same value as evervibes' CRON_SECRET env var)");
        return { url, secret };
      }

      ctx.provide("kdp", async (payload) => {
        const cmd = payload as KdpCommand;

        if (cmd.op === "scan") {
          const { url, secret } = await base();
          const r = await f(`${url}/api/cron/kdp-trends-scan`, { headers: { Authorization: `Bearer ${secret}` } });
          const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
          if (!r.ok) throw new Error(`kdp scan HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
          await ctx.emit("kdp.scanned", data);
          return data;
        }

        if (cmd.op === "generate") {
          const { url, secret } = await base();
          const r = await f(`${url}/api/cron/kdp-auto-generate`, {
            method: "POST",
            headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
            body: JSON.stringify({ limit: cmd.limit ?? 3 }),
          });
          const data = (await r.json().catch(() => ({}))) as { generated?: number; built?: Array<{ title?: string }> };
          if (!r.ok) throw new Error(`kdp generate HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
          try {
            if (data.generated) {
              await ctx.call("memory", {
                op: "remember",
                input: { kind: "task", content: `KDP generated ${data.generated} new book(s): ${(data.built ?? []).map((b) => b.title).filter(Boolean).join("; ")}`.slice(0, 1500) },
              });
            }
          } catch {
            /* memory optional */
          }
          await ctx.emit("kdp.generated", data);
          return data;
        }

        if (cmd.op === "status") {
          const { url, secret } = await base();
          const r = await f(`${url}/api/kdp/status`, { headers: { Authorization: `Bearer ${secret}` } });
          const data = (await r.json().catch(() => ({}))) as { opportunities?: KdpOpportunity[]; books?: KdpBook[] };
          if (!r.ok) throw new Error(`kdp status HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
          return { opportunities: data.opportunities ?? [], books: data.books ?? [] };
        }

        if (cmd.op === "markStatus") {
          const { url, secret } = await base();
          const r = await f(`${url}/api/kdp/book/${cmd.id}`, {
            method: "PATCH",
            headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
            body: JSON.stringify({ status: cmd.status, amazon_url: cmd.amazonUrl, amazon_asin: cmd.amazonAsin }),
          });
          const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
          if (!r.ok) throw new Error(`kdp markStatus HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
          return data;
        }

        if (cmd.op === "downloadZip") {
          const { url, secret } = await base();
          const statusR = await f(`${url}/api/kdp/status`, { headers: { Authorization: `Bearer ${secret}` } });
          const statusData = (await statusR.json().catch(() => ({}))) as { books?: KdpBook[] };
          const book = (statusData.books ?? []).find((b) => b.id === cmd.id);
          if (!book) throw new Error(`kdp: book "${cmd.id}" not found`);

          const zipR = await f(`${url}/api/kdp/pdf`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: book.title,
              subtitle: book.subtitle,
              description: book.description,
              keywords: book.keywords,
              coverHook: book.cover_hook,
              backCoverText: book.back_cover_text,
              trimSize: book.trim_size,
              pageCount: book.page_count,
              interiorType: book.interior_type,
              primaryColor: book.primary_color,
            }),
          });
          if (!zipR.ok) throw new Error(`kdp pdf HTTP ${zipR.status}`);
          const buf = Buffer.from(await zipR.arrayBuffer());
          return { filename: `${(book.title ?? "book").replace(/[^a-z0-9]+/gi, "_")}.zip`, base64: buf.toString("base64") };
        }

        throw new Error(`kdp: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
