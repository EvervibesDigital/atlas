import type { Plugin } from "@atlas/core";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { PendingAction, WholesaleCommand } from "./types";
import { toBuyerRows, buyerStats } from "./buyers";
import { storeDrafts, findDraft, removeDraft, type IntroDraft } from "./intro-drafts";

/**
 * Wholesale plugin (service "wholesale") — bridges ATLAS to evervibes' REAL,
 * already-built approval-gate queue for wholesale sends (deal blasts, SMS
 * deal alerts, Bland verification calls, investor outreach emails). That
 * system (lib/wholesale/queue-pending-action.ts) already ranks every
 * candidate action by dollars-at-stake and refuses to fire ANYTHING until
 * approved — this does not reimplement any of that, it calls the existing
 * list/approve/veto endpoints over HTTP, same CRON_SECRET-bearer pattern
 * the kdp bridge already uses.
 *
 * Reuses KDP_CRON_SECRET as the credential on purpose: it's the same
 * evervibes CRON_SECRET value either way, and there's no reason to make Mat
 * paste the identical secret into the vault under a second name.
 */
export function createWholesalePlugin(opts: { fetcher?: typeof fetch; introDraftsFile?: string } = {}): Plugin {
  const f = opts.fetcher ?? fetch;
  const draftsPath = opts.introDraftsFile ?? "data/intro-drafts.json";

  async function loadDrafts(): Promise<IntroDraft[]> {
    const raw = await readFile(draftsPath, "utf8").catch(() => "[]");
    try {
      const parsed = JSON.parse(raw) as IntroDraft[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async function saveDrafts(drafts: IntroDraft[]): Promise<void> {
    await mkdir(dirname(draftsPath), { recursive: true }).catch(() => {});
    await writeFile(draftsPath, JSON.stringify(drafts, null, 2), "utf8");
  }

  return {
    manifest: {
      name: "wholesale",
      version: "0.1.0",
      capabilities: ["wholesale"],
      permissions: ["secret:*"],
      role: "executor",
    },

    register(ctx) {
      async function base(): Promise<{ url: string; secret: string }> {
        // @atlas-optional-secret EVERVIBES_APP_URL — defaults to the live production URL.
        const url = (await ctx.secret("EVERVIBES_APP_URL")) || "https://evervibesdigital.com";
        const secret = await ctx.secret("KDP_CRON_SECRET");
        if (!secret) throw new Error("wholesale: no KDP_CRON_SECRET set — add it in API Keys (same value as evervibes' CRON_SECRET env var)");
        return { url, secret };
      }

      ctx.provide("wholesale", async (payload) => {
        const cmd = payload as WholesaleCommand;

        if (cmd.op === "list") {
          const { url, secret } = await base();
          const r = await f(`${url}/api/wholesale/pending-actions/list`, { headers: { Authorization: `Bearer ${secret}` } });
          const data = (await r.json().catch(() => ({}))) as { actions?: PendingAction[] };
          if (!r.ok) throw new Error(`wholesale list HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
          return { actions: data.actions ?? [] };
        }

        if (cmd.op === "approve") {
          const { url, secret } = await base();
          const r = await f(`${url}/api/wholesale/pending-actions/${cmd.id}/approve`, {
            method: "POST",
            headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
          });
          const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
          if (!r.ok) throw new Error(`wholesale approve HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
          await ctx.emit("wholesale.approved", { id: cmd.id });
          return data;
        }

        if (cmd.op === "veto") {
          const { url, secret } = await base();
          const r = await f(`${url}/api/wholesale/pending-actions/${cmd.id}/veto`, {
            method: "POST",
            headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
            body: JSON.stringify({ reason: cmd.reason ?? "atlas_brief_reject" }),
          });
          const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
          if (!r.ok) throw new Error(`wholesale veto HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
          return data;
        }

        // ── Buyer pipeline ──────────────────────────────────────────────
        // These call endpoints that already existed in evervibes but were
        // owner-SESSION-only until 2026-08-01, so they could only ever be
        // triggered by a human clicking in a browser. Token auth was added
        // (mirroring buyers/send-intro's existing pattern) specifically so
        // ATLAS could orchestrate them.

        if (cmd.op === "buyerStats") {
          const { url, secret } = await base();
          const r = await f(`${url}/api/wholesale/buyers/export`, { headers: { Authorization: `Bearer ${secret}` } });
          const text = await r.text();
          if (!r.ok) throw new Error(`wholesale buyerStats HTTP ${r.status}: ${text.slice(0, 200)}`);
          return buyerStats(toBuyerRows(text));
        }

        if (cmd.op === "listBuyers") {
          const { url, secret } = await base();
          const qs = cmd.mailableOnly ? "?mailable=1" : "";
          const r = await f(`${url}/api/wholesale/buyers/export${qs}`, { headers: { Authorization: `Bearer ${secret}` } });
          const text = await r.text();
          if (!r.ok) throw new Error(`wholesale listBuyers HTTP ${r.status}: ${text.slice(0, 200)}`);
          const rows = toBuyerRows(text);
          return { buyers: cmd.limit ? rows.slice(0, cmd.limit) : rows, stats: buyerStats(rows) };
        }

        if (cmd.op === "traceTopBuyers") {
          // Spends real trace credits unless dryRun. Defaults to dryRun TRUE:
          // the caller must opt IN to spending, never out of it.
          const dryRun = cmd.dryRun !== false;
          if (!dryRun && cmd.confirmSpend !== true) {
            throw new Error(
              `wholesale: refusing to spend trace credits without confirmSpend:true — call with {dryRun:true} first to preview, then pass confirmSpend:true deliberately.`,
            );
          }
          const { url, secret } = await base();
          const r = await f(`${url}/api/wholesale/buyers/find-and-trace-top`, {
            method: "POST",
            headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
            body: JSON.stringify({ count: cmd.count ?? 25, dry_run: dryRun }),
          });
          const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
          if (!r.ok) throw new Error(`wholesale traceTopBuyers HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
          return { dryRun, ...data };
        }

        if (cmd.op === "previewIntros") {
          // FREE and sends nothing: returns the REAL copy that would go out, so
          // the wording itself can be approved rather than just the act of
          // sending. Previously the copy was generated at send time, so there
          // was never a draft to review.
          const { url, secret } = await base();
          const r = await f(`${url}/api/wholesale/buyers/send-intro`, {
            method: "POST",
            headers: { "x-n8n-secret": secret, "Content-Type": "application/json" },
            body: JSON.stringify({ preview: true, ...(cmd.max !== undefined ? { max: cmd.max } : {}) }),
          });
          const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
          if (!r.ok) throw new Error(`wholesale previewIntros HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);

          // Persist the generated copy. The email is AI-written per buyer, so
          // regenerating at send time would send DIFFERENT text than what was
          // approved. Storing it here is what makes approval mean the wording.
          const incoming = (data.drafts ?? []) as Array<{ id: string; name?: string; email?: string; subject: string; body: string }>;
          const stored = storeDrafts(await loadDrafts(), incoming);
          await saveDrafts(stored);
          return { ...data, stored: stored.length };
        }

        if (cmd.op === "listIntroDrafts") {
          return { drafts: await loadDrafts() };
        }

        if (cmd.op === "discardIntroDraft") {
          const next = removeDraft(await loadDrafts(), cmd.id);
          await saveDrafts(next);
          return { discarded: cmd.id, remaining: next.length };
        }

        if (cmd.op === "approveIntroDraft") {
          // Sends the STORED copy verbatim — the exact text that was reviewed.
          // No confirmSend flag here because approving a specific draft by id
          // IS the explicit confirmation; the ambiguity that gate protects
          // against ("send 10 emails I haven't read") can't arise.
          const drafts = await loadDrafts();
          const draft = findDraft(drafts, cmd.id);
          if (!draft) throw new Error(`wholesale: no stored intro draft "${cmd.id}" (it may already have been sent or discarded)`);

          const { url, secret } = await base();
          const r = await f(`${url}/api/wholesale/buyers/send-intro`, {
            method: "POST",
            headers: { "x-n8n-secret": secret, "Content-Type": "application/json" },
            body: JSON.stringify({ max: 1, drafts: [{ id: draft.buyerId, subject: draft.subject, body: draft.body }] }),
          });
          const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
          if (!r.ok) throw new Error(`wholesale approveIntroDraft HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);

          await saveDrafts(removeDraft(drafts, draft.id));
          await ctx.emit("wholesale.introsSent", { id: draft.id, email: draft.email });
          return { sent: draft.id, ...data };
        }

        if (cmd.op === "sendIntros") {
          // REAL EMAILS TO REAL PEOPLE. Structurally gated the same way the
          // enrichment cost gate is: an absent-minded cycle wiring cannot
          // satisfy a required literal `confirmSend: true`. The endpoint has
          // its own guardrails too (10/day cap, skips unsubscribed and
          // already-introduced buyers) — this gate is in addition to those,
          // not instead of them.
          if (cmd.confirmSend !== true) {
            throw new Error(
              `wholesale: refusing to send intro emails without confirmSend:true — these are real emails to real buyers. Check {op:"buyerStats"} first (free), then pass confirmSend:true deliberately.`,
            );
          }
          const { url, secret } = await base();
          const r = await f(`${url}/api/wholesale/buyers/send-intro`, {
            method: "POST",
            headers: { "x-n8n-secret": secret, "Content-Type": "application/json" },
            body: JSON.stringify({
              ...(cmd.max !== undefined ? { max: cmd.max } : {}),
              // When approved drafts are supplied, evervibes sends them
              // verbatim instead of regenerating — so what was approved is
              // exactly what goes out.
              ...(cmd.drafts ? { drafts: cmd.drafts } : {}),
            }),
          });
          const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
          if (!r.ok) throw new Error(`wholesale sendIntros HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
          await ctx.emit("wholesale.introsSent", data);
          return data;
        }

        throw new Error(`wholesale: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
