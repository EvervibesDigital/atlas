import type { Plugin } from "@atlas/core";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { PendingAction, WholesaleCommand } from "./types";
import { toBuyerRows, buyerStats } from "./buyers";
import { storeDrafts, findDraft, removeDraft, withComplianceFooter, type IntroDraft } from "./intro-drafts";

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
      permissions: ["secret:*", "call:sender"],
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

        /**
         * Stored intro drafts in the exact shape `sender` takes.
         *
         * Mirrors leadscan.draftBatch deliberately: one review-then-send
         * pattern across both businesses, and one place email leaves ATLAS.
         * Identity comes from secrets, never the request — a per-call postal
         * address is a per-call chance to send a non-compliant email.
         */
        /** Shared by draftBatchForSender and autoOutreach — one rendering
         * path so the email a human previews is identical to what goes out
         * unattended. */
        async function draftIntrosEligible(ids?: string[]) {
          const postalAddress = await ctx.secret("COMPANY_POSTAL_ADDRESS");
          if (!postalAddress) {
            throw new Error("wholesale: COMPANY_POSTAL_ADDRESS is not set — commercial email legally requires a physical address in the body.");
          }
          const optOut = (await ctx.secret("UNSUBSCRIBE_NOTE")) ?? undefined;
          const drafts = await loadDrafts();
          const chosen = ids?.length ? drafts.filter((d) => ids.includes(d.id)) : drafts;

          const emails: Array<{ draftId: string; to: string; subject: string; body: string }> = [];
          const skipped: Array<{ draftId: string; name: string; reason: string }> = [];
          for (const d of chosen) {
            if (!(d.email ?? "").includes("@")) {
              skipped.push({ draftId: d.id, name: d.name, reason: "no email address on this buyer" });
              continue;
            }
            emails.push({ draftId: d.id, to: d.email, subject: d.subject, body: withComplianceFooter(d.body, postalAddress, optOut) });
          }
          return { emails, skipped, considered: chosen.length };
        }

        if (cmd.op === "draftBatchForSender") {
          const { emails, skipped, considered } = await draftIntrosEligible(cmd.ids);
          return { emails, skipped, drafted: emails.length, considered };
        }

        /**
         * Unattended intro sending — the daily-digest path. Routed through
         * `sender.sendAutonomous`, not `send`: with nobody choosing which
         * drafts to approve, one buyer with a stale email must not block the
         * rest of the batch, which is what the human-reviewed all-or-nothing
         * `send` path would do.
         */
        if (cmd.op === "autoOutreach") {
          const { emails, skipped: draftSkipped } = await draftIntrosEligible(cmd.ids);
          if (!emails.length) return { drafted: 0, sent: 0, sendSkipped: 0, draftSkipped: draftSkipped.length };

          const result = (await ctx.call("sender", {
            op: "sendAutonomous",
            emails: emails.map((e) => ({ to: e.to, subject: e.subject, body: e.body })),
            confirmSend: true,
            source: "wholesale",
            maxPerRun: cmd.maxPerRun,
          })) as { sentCount: number; skippedCount: number; sent: Array<{ to: string }> };

          // Discard only the drafts that actually went out — the copy for a
          // skipped one is still worth keeping to fix and retry.
          const byEmail = new Map(emails.map((e) => [e.to, e.draftId]));
          const deliveredIds = result.sent.map((s) => byEmail.get(s.to)).filter((id): id is string => Boolean(id));
          if (deliveredIds.length) {
            let drafts = await loadDrafts();
            for (const id of deliveredIds) drafts = removeDraft(drafts, id);
            await saveDrafts(drafts);
          }

          return { drafted: emails.length, sent: result.sentCount, sendSkipped: result.skippedCount, draftSkipped: draftSkipped.length, discarded: deliveredIds.length };
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
