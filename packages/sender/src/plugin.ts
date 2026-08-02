import type { Plugin } from "@atlas/core";
import { checkOutgoing, type OutgoingEmail, type Violation } from "./compliance";
import { loadSuppressions, saveSuppressions, addSuppression, partitionBySuppression, isSuppressed } from "./suppression";
import { sendViaResend, unsendableFromReason, type FetchLike } from "./resend";

/**
 * Sender — the one place ATLAS is allowed to put email on the wire.
 *
 * Until now every business ended at a draft: wholesale intros, compliance
 * outreach, and surplus letters all render perfectly and stop. This closes that
 * gap, and centralising it is the point — the compliance checks and the
 * suppression list only mean something if there is no second code path that
 * skips them.
 *
 * Three structural guarantees, in order of how much damage they prevent:
 *
 * 1. **`confirmSend: true` is a required literal.** Same shape as
 *    `wholesale.sendIntros` and `enrichment.enrich`. An autonomous cycle cannot
 *    mail anyone by forgetting a flag, because forgetting the flag throws.
 * 2. **Suppression is enforced here, not by callers.** Someone who asked to be
 *    left alone cannot be mailed by whichever call site forgot to check.
 * 3. **Compliance refuses, it does not warn.** A warning on a send path still
 *    sends the email.
 */

export interface SenderOptions {
  suppressionFile?: string;
  fetcher?: FetchLike;
}

export type SenderCommand =
  | { op: "status" }
  | { op: "preview"; emails: OutgoingEmail[] }
  | { op: "send"; emails: OutgoingEmail[]; confirmSend?: boolean; replyTo?: string }
  | { op: "suppress"; email: string; reason?: string }
  | { op: "listSuppressed" };

export interface PreviewRow {
  to: string;
  subject: string;
  bodyPreview: string;
  sendable: boolean;
  problems: Violation[];
}

export function createSenderPlugin(opts: SenderOptions = {}): Plugin {
  const suppressionFile = opts.suppressionFile ?? "./data/suppressions.json";
  const fetcher = opts.fetcher ?? fetch;

  return {
    manifest: { name: "sender", version: "0.1.0", capabilities: ["sender"], permissions: ["secret:*"], role: "executor" },
    register(ctx) {
      async function complianceContext(): Promise<{ postalAddress?: string; unsubscribeNote?: string }> {
        return {
          postalAddress: (await ctx.secret("COMPANY_POSTAL_ADDRESS")) ?? undefined,
          unsubscribeNote: (await ctx.secret("UNSUBSCRIBE_NOTE")) ?? undefined,
        };
      }

      async function review(emails: OutgoingEmail[]): Promise<PreviewRow[]> {
        const cc = await complianceContext();
        const suppressions = await loadSuppressions(suppressionFile);
        return emails.map((e) => {
          const problems = checkOutgoing(e, cc);
          if (isSuppressed(suppressions, e.to)) {
            problems.push({ rule: "suppressed", detail: `${e.to} has opted out and must not be contacted again` });
          }
          return {
            to: e.to,
            subject: e.subject,
            bodyPreview: (e.body ?? "").slice(0, 400),
            sendable: problems.length === 0,
            problems,
          };
        });
      }

      ctx.provide("sender", async (payload) => {
        const cmd = payload as SenderCommand;

        if (cmd.op === "status") {
          const resendKey = await ctx.secret("RESEND_API_KEY");
          const from = await ctx.secret("SENDER_FROM");
          const cc = await complianceContext();
          const suppressions = await loadSuppressions(suppressionFile);
          const blockers: string[] = [];
          if (!resendKey) blockers.push("RESEND_API_KEY is not set");
          if (!from) blockers.push("SENDER_FROM is not set (the address mail is sent from)");
          else {
            const why = unsendableFromReason(from);
            if (why) blockers.push(why);
          }
          if (!cc.postalAddress) blockers.push("COMPANY_POSTAL_ADDRESS is not set — legally required in the body of every commercial email");
          return {
            provider: resendKey ? "resend" : null,
            from: from ?? null,
            postalAddressConfigured: Boolean(cc.postalAddress),
            suppressedCount: suppressions.length,
            readyToSend: blockers.length === 0,
            blockers,
          };
        }

        if (cmd.op === "preview") {
          const rows = await review(cmd.emails ?? []);
          return { total: rows.length, sendable: rows.filter((r) => r.sendable).length, rows };
        }

        if (cmd.op === "listSuppressed") {
          return { entries: await loadSuppressions(suppressionFile) };
        }

        if (cmd.op === "suppress") {
          const entries = await loadSuppressions(suppressionFile);
          const next = addSuppression(entries, cmd.email, cmd.reason ?? "requested");
          await saveSuppressions(suppressionFile, next);
          return { suppressed: cmd.email, total: next.length };
        }

        if (cmd.op === "send") {
          // The gate. A required literal true, checked before anything else —
          // no default, no truthiness, no "unless dryRun". This is what makes
          // it structurally impossible to wire sending into an automated loop
          // by accident.
          if (cmd.confirmSend !== true) {
            throw new Error(
              `sender: refusing to send ${(cmd.emails ?? []).length} email(s) without confirmSend:true. ` +
                `Run op:"preview" first and read what would go out.`,
            );
          }

          const resendKey = await ctx.secret("RESEND_API_KEY");
          if (!resendKey) throw new Error("sender: RESEND_API_KEY is not set — add it in the Keys tab.");
          const from = await ctx.secret("SENDER_FROM");
          if (!from) throw new Error('sender: SENDER_FROM is not set — the address mail is sent from, e.g. "Mat <mat@evervibesdigital.com>".');
          const fromProblem = unsendableFromReason(from);
          if (fromProblem) throw new Error(`sender: ${fromProblem}`);

          const rows = await review(cmd.emails ?? []);
          const blocked = rows.filter((r) => !r.sendable);
          if (blocked.length) {
            // All-or-nothing on purpose. Partially sending a reviewed batch
            // means Mat approved a set of emails and a different set went out.
            throw new Error(
              `sender: refusing to send — ${blocked.length} of ${rows.length} email(s) failed checks:\n` +
                blocked.map((b) => `  ${b.to}: ${b.problems.map((p) => p.detail).join("; ")}`).join("\n"),
            );
          }

          const suppressions = await loadSuppressions(suppressionFile);
          const { allowed } = partitionBySuppression(suppressions, cmd.emails ?? []);

          const sent: Array<{ to: string; id: string }> = [];
          const failed: Array<{ to: string; error: string }> = [];
          for (const email of allowed) {
            try {
              const res = await sendViaResend(
                { from, to: email.to, subject: email.subject, text: email.body, replyTo: cmd.replyTo },
                resendKey,
                fetcher,
              );
              sent.push({ to: email.to, id: res.id });
            } catch (err) {
              // One bad address must not strand the rest of an approved batch,
              // but every failure is reported — never swallowed.
              failed.push({ to: email.to, error: (err as Error).message });
            }
          }

          if (sent.length) {
            try {
              await ctx.call("memory", {
                op: "remember",
                input: {
                  kind: "task",
                  content: `Sent ${sent.length} email(s) via Resend to: ${sent.map((s) => s.to).join(", ")}`.slice(0, 1500),
                },
              });
            } catch {
              /* memory is optional — a bookkeeping failure must not look like a send failure */
            }
          }

          return { sentCount: sent.length, failedCount: failed.length, sent, failed };
        }

        throw new Error(`sender: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
