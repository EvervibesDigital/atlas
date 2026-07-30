import type { Plugin } from "@atlas/core";
import { SimulatedDriver, type BrowserDriver } from "@atlas/browser";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import type { KdpBook, KdpBookStatus, KdpOpportunity } from "./types";
import { buildUploadSteps, buildCategorySteps, buildFinalConfirmationStep, DEFAULT_KDP_PRICE_POLICY, type PricePolicy } from "./upload-steps";

/**
 * KDP plugin (service "kdp") — bridges ATLAS to the REAL, already-built KDP
 * pipeline living in the separate `evervibes` Next.js app (trend scan → AI
 * scoring → metadata generation → PDF ZIP), plus a Playwright-driven
 * `uploadToAmazon` op that fills Amazon KDP's own book-creation wizard and
 * stops immediately before the Publish click — Mat reviews and clicks
 * Publish himself in the same browser window. `uploadToAmazon` uses
 * SimulatedDriver (safe, no real browser) unless a real `driver` is passed in
 * or `ATLAS_REAL_KDP_UPLOAD=true` is set (see packages/app/src/build.ts).
 *
 * Honest scope: Cover Engine v2 (real finished covers, currently spec-only —
 * see evervibes' docs/superpowers/specs/2026-07-13-kdp-cover-engine-design.md)
 * is NOT implemented yet; books ship with a placeholder cover template until
 * that gets built. Sales tracking (roadmap sub-project 4) is also not built.
 * Category selection during upload is best-effort (see upload-steps.ts) —
 * KDP's real category tree isn't validated against.
 */
export type KdpCommand =
  | { op: "scan" }
  | { op: "generate"; limit?: number }
  | { op: "status" }
  | { op: "markStatus"; id: string; status: KdpBookStatus; amazonUrl?: string; amazonAsin?: string }
  | { op: "downloadZip"; id: string }
  | { op: "uploadToAmazon"; id: string };

export function createKdpPlugin(opts: { fetcher?: typeof fetch; driver?: BrowserDriver; pricePolicy?: PricePolicy } = {}): Plugin {
  const f = opts.fetcher ?? fetch;
  const driver = opts.driver ?? new SimulatedDriver();
  const pricePolicy = opts.pricePolicy ?? DEFAULT_KDP_PRICE_POLICY;
  /** Guards against two overlapping uploadToAmazon calls fighting over the
   * same live browser page. Known residual gap: this flag lives in this
   * plugin instance's closure, so it does NOT survive server.ts's
   * rebuildAtlas() (which runs on /api/setup, /api/unlock, and whenever a
   * pasted API key is auto-detected in chat) — a rebuild mid-upload starts a
   * fresh plugin with the flag reset, so a second real upload could still
   * begin while an orphaned first one keeps running in the background.
   * Accepted for now; closing it fully needs a guard that outlives a single
   * Atlas rebuild, not just a single plugin instance. */
  let uploadInFlight = false;

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

      /** Shared by downloadZip and uploadToAmazon: looks up the book, then
       * fetches its upload-ready ZIP (interior.pdf + cover.pdf + extras). */
      async function fetchBookAndZip(id: string): Promise<{ book: KdpBook; zipBuffer: Buffer }> {
        const { url, secret } = await base();
        const statusR = await f(`${url}/api/kdp/status`, { headers: { Authorization: `Bearer ${secret}` } });
        const statusData = (await statusR.json().catch(() => ({}))) as { books?: KdpBook[] };
        const book = (statusData.books ?? []).find((b) => b.id === id);
        if (!book) throw new Error(`kdp: book "${id}" not found`);

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
        const zipBuffer = Buffer.from(await zipR.arrayBuffer());
        return { book, zipBuffer };
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
          const { book, zipBuffer } = await fetchBookAndZip(cmd.id);
          return { filename: `${(book.title ?? "book").replace(/[^a-z0-9]+/gi, "_")}.zip`, base64: zipBuffer.toString("base64") };
        }

        if (cmd.op === "uploadToAmazon") {
          if (uploadInFlight) throw new Error("kdp upload: another upload is already in progress on this driver — wait for it to finish before starting another");
          uploadInFlight = true;
          try {
            const { book, zipBuffer } = await fetchBookAndZip(cmd.id);
            const price = pricePolicy[book.product_type];
            if (price === undefined) {
              throw new Error(`kdp upload: no price configured for product_type "${book.product_type}"`);
            }
            const zip = new AdmZip(zipBuffer);
            const interiorEntry = zip.getEntry("interior.pdf");
            const coverEntry = zip.getEntry("cover.pdf");
            if (!interiorEntry || !coverEntry) throw new Error(`kdp upload: zip for "${cmd.id}" is missing interior.pdf or cover.pdf`);

            const tmpDir = await mkdtemp(join(tmpdir(), "atlas-kdp-upload-"));
            try {
              const interiorPath = join(tmpDir, "interior.pdf");
              const coverPath = join(tmpDir, "cover.pdf");
              await writeFile(interiorPath, interiorEntry.getData());
              await writeFile(coverPath, coverEntry.getData());

              const log: string[] = [];
              let stepsRun = 0;

              const coreResult = await driver.run(buildUploadSteps(book, { interiorPath, coverPath }, pricePolicy));
              stepsRun += coreResult.stepsRun;
              log.push(...coreResult.log);

              const categoriesMatched: string[] = [];
              const categoriesSkipped: Array<{ category: string; reason: string }> = [];
              for (const category of book.categories ?? []) {
                try {
                  const categoryResult = await driver.run(buildCategorySteps(category));
                  stepsRun += categoryResult.stepsRun;
                  log.push(...categoryResult.log);
                  categoriesMatched.push(category);
                } catch (err) {
                  categoriesSkipped.push({ category, reason: err instanceof Error ? err.message : String(err) });
                }
              }

              const confirmResult = await driver.run(buildFinalConfirmationStep());
              stepsRun += confirmResult.stepsRun;
              log.push(...confirmResult.log);

              const result = {
                ok: true,
                bookId: cmd.id,
                driver: driver.name,
                stepsRun,
                filled: { title: book.title, price },
                categoriesMatched,
                categoriesSkipped,
                log,
              };
              await ctx.emit("kdp.uploadedToAmazon", result);
              return result;
            } finally {
              await rm(tmpDir, { recursive: true, force: true });
            }
          } finally {
            uploadInFlight = false;
          }
        }

        throw new Error(`kdp: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
