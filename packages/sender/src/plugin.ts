import type { Plugin } from "@atlas/core";
import { checkOutgoing, type OutgoingEmail, type Violation } from "./compliance";
import { loadSuppressions, saveSuppressions, addSuppression, partitionBySuppression, isSuppressed } from "./suppression";
import { sendViaResend, unsendableFromReason, type FetchLike } from "./resend";
import { sendViaSmtp, guessSmtpHost, nodemailerTransport, type SmtpConfig, type TransportFactory } from "./smtp";
import { appendDigest, loadDigest, summarizeDigest, type DigestEntry } from "./digest";

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
  digestFile?: string;
  fetcher?: FetchLike;
  makeTransport?: TransportFactory;
}

export type SenderCommand =
  | { op: "status" }
  | { op: "preview"; emails: OutgoingEmail[] }
  | { op: "send"; emails: OutgoingEmail[]; confirmSend?: boolean; replyTo?: string; source?: string }
  /**
   * Unattended sending: each email is judged on ITS OWN merits, not as an
   * all-or-nothing batch. `send` refuses the whole batch if one email fails a
   * check, which is correct when a human reviewed the batch and expects
   * exactly what they saw to go out — but with no human in the loop, that rule
   * just means one bad lead blocks every good one behind it. Here, a failing
   * email is skipped and reported; the rest still go. `maxPerRun` bounds a
   * single call so a bug can't blast an entire list in one shot.
   */
  | { op: "sendAutonomous"; emails: OutgoingEmail[]; confirmSend?: boolean; source?: string; maxPerRun?: number; replyTo?: string }
  /** Today's (default) or a given day's send activity, for the morning brief. */
  | { op: "digest"; date?: string }
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
  const digestFile = opts.digestFile ?? "./data/send-digest.json";
  const fetcher = opts.fetcher ?? fetch;
  const makeTransport = opts.makeTransport ?? nodemailerTransport;

  return {
    manifest: { name: "sender", version: "0.1.0", capabilities: ["sender"], permissions: ["secret:*"], role: "executor" },
    register(ctx) {
      /**
       * Which transport will actually carry the mail.
       *
       * SMTP is preferred when configured, because a working mailbox sends
       * today whereas Resend sends nothing until its domain is DNS-verified —
       * and silently preferring the key that cannot send yet is precisely the
       * "configured but doesn't work" failure this codebase keeps hitting.
       * `SENDER_PROVIDER` overrides when both are available.
       */
      async function resolveTransport(): Promise<
        | { kind: "smtp"; config: SmtpConfig; blockers: string[] }
        | { kind: "resend"; apiKey: string; blockers: string[] }
        | { kind: "none"; blockers: string[] }
      > {
        // @atlas-optional-secret SENDER_PROVIDER — defaults to SMTP when configured, else Resend.
        // @atlas-optional-secret SENDER_SMTP_PORT — defaults to 465 (implicit TLS).
        // @atlas-optional-secret EMAIL_SMTP_HOST — only a fallback for SENDER_SMTP_HOST.
        // @atlas-optional-secret EMAIL_USER — only a fallback for SENDER_SMTP_USER.
        // @atlas-optional-secret EMAIL_PASS — only a fallback for SENDER_SMTP_PASS.
        // @atlas-optional-secret RESEND_API_KEY — an alternative transport, not required when SMTP works.
        const preference = (await ctx.secret("SENDER_PROVIDER"))?.trim().toLowerCase();
        const resendKey = await ctx.secret("RESEND_API_KEY");
        const user = (await ctx.secret("SENDER_SMTP_USER")) ?? (await ctx.secret("EMAIL_USER"));
        const pass = (await ctx.secret("SENDER_SMTP_PASS")) ?? (await ctx.secret("EMAIL_PASS"));
        const host = (await ctx.secret("SENDER_SMTP_HOST")) ?? (await ctx.secret("EMAIL_SMTP_HOST")) ?? (user ? guessSmtpHost(user) : null);
        const port = Number((await ctx.secret("SENDER_SMTP_PORT")) ?? 465);

        const smtpReady = Boolean(user && pass && host);
        const wantsSmtp = preference === "smtp" || (preference !== "resend" && smtpReady);

        if (wantsSmtp && smtpReady) return { kind: "smtp", config: { host: host!, port, user: user!, pass: pass! }, blockers: [] };
        if (resendKey && preference !== "smtp") return { kind: "resend", apiKey: resendKey, blockers: [] };

        const blockers: string[] = [];
        if (preference === "smtp" || (!resendKey && (user || pass || host))) {
          if (!user) blockers.push("SENDER_SMTP_USER is not set (the mailbox to send from)");
          if (!pass) blockers.push("SENDER_SMTP_PASS is not set (that mailbox's password)");
          if (!host) blockers.push("SENDER_SMTP_HOST is not set — a custom domain's mail server cannot be guessed (Hostinger: smtp.hostinger.com)");
        } else {
          blockers.push("no sending transport configured — set SENDER_SMTP_USER/PASS/HOST for a mailbox you own, or RESEND_API_KEY");
        }
        return { kind: "none", blockers };
      }

      async function complianceContext(): Promise<{ postalAddress?: string; unsubscribeNote?: string }> {
        return {
          postalAddress: (await ctx.secret("COMPANY_POSTAL_ADDRESS")) ?? undefined,
          // @atlas-optional-secret UNSUBSCRIBE_NOTE — the existing copy already carries a plain-English opt-out line.
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
          const transport = await resolveTransport();
          const from = await ctx.secret("SENDER_FROM");
          const cc = await complianceContext();
          const suppressions = await loadSuppressions(suppressionFile);
          const blockers: string[] = [...transport.blockers];
          if (!from) blockers.push("SENDER_FROM is not set (the address mail is sent from)");
          // The verified-domain rule is Resend's, not SMTP's — a mailbox sends
          // as itself, so applying it to SMTP would reject a valid setup.
          else if (transport.kind === "resend") {
            const why = unsendableFromReason(from);
            if (why) blockers.push(why);
          }
          if (!cc.postalAddress) blockers.push("COMPANY_POSTAL_ADDRESS is not set — legally required in the body of every commercial email");
          return {
            provider: transport.kind === "none" ? null : transport.kind,
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

        /** A resolved transport that is actually usable — "none" excluded,
         * so `deliverOne`'s smtp/resend branch is exhaustive without TS
         * needing to guard against a case `prepareToSend` already ruled out. */
        type ReadyTransport = Exclude<Awaited<ReturnType<typeof resolveTransport>>, { kind: "none" }>;

        /** Resolves the transport + From address, or throws with a reason a
         * human (or the morning brief) can act on. Shared by both send paths
         * so "why can't this send" is answered identically either way. */
        async function prepareToSend(): Promise<{ transport: ReadyTransport; from: string }> {
          const transport = await resolveTransport();
          if (transport.kind === "none") throw new Error(`sender: ${transport.blockers.join("; ")}`);
          const from = await ctx.secret("SENDER_FROM");
          if (!from) throw new Error('sender: SENDER_FROM is not set — the address mail is sent from, e.g. "EverVibes <team@evervibesdigital.com>".');
          if (transport.kind === "resend") {
            const fromProblem = unsendableFromReason(from);
            if (fromProblem) throw new Error(`sender: ${fromProblem}`);
          }
          return { transport, from };
        }

        /** Delivers one already-cleared email over whichever transport resolved. */
        async function deliverOne(
          transport: ReadyTransport,
          from: string,
          email: OutgoingEmail,
          replyTo: string | undefined,
        ): Promise<{ id: string }> {
          const message = { from, to: email.to, subject: email.subject, text: email.body, replyTo };
          return transport.kind === "smtp"
            ? sendViaSmtp(message, transport.config, makeTransport)
            : sendViaResend(message, transport.apiKey, fetcher);
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

          const { transport, from } = await prepareToSend();

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
          const digestEntries: DigestEntry[] = [];
          const now = new Date().toISOString();
          for (const email of allowed) {
            try {
              const res = await deliverOne(transport, from, email, cmd.replyTo);
              sent.push({ to: email.to, id: res.id });
              digestEntries.push({ at: now, source: cmd.source, to: email.to, subject: email.subject, outcome: "sent" });
            } catch (err) {
              // One bad address must not strand the rest of an approved batch,
              // but every failure is reported — never swallowed.
              const reason = (err as Error).message;
              failed.push({ to: email.to, error: reason });
              digestEntries.push({ at: now, source: cmd.source, to: email.to, subject: email.subject, outcome: "failed", reason });
            }
          }
          await appendDigest(digestFile, digestEntries).catch(() => { /* digest is a log, not a gate */ });

          if (sent.length) {
            try {
              await ctx.call("memory", {
                op: "remember",
                input: {
                  kind: "task",
                  content: `Sent ${sent.length} email(s) via ${transport.kind} to: ${sent.map((s) => s.to).join(", ")}`.slice(0, 1500),
                },
              });
            } catch {
              /* memory is optional — a bookkeeping failure must not look like a send failure */
            }
          }

          return { sentCount: sent.length, failedCount: failed.length, sent, failed };
        }

        if (cmd.op === "sendAutonomous") {
          if (cmd.confirmSend !== true) {
            throw new Error(
              `sender: refusing to send ${(cmd.emails ?? []).length} email(s) without confirmSend:true. ` +
                `This is the unattended path — confirmSend is what an automated cycle must set deliberately, not by default.`,
            );
          }

          const { transport, from } = await prepareToSend();
          const suppressions = await loadSuppressions(suppressionFile);
          const cc = await complianceContext();
          const cap = cmd.maxPerRun ?? 25;
          const now = new Date().toISOString();

          const sent: Array<{ to: string; id: string }> = [];
          const skipped: Array<{ to: string; reason: string }> = [];
          const failed: Array<{ to: string; error: string }> = [];
          const digestEntries: DigestEntry[] = [];

          for (const email of cmd.emails ?? []) {
            if (sent.length >= cap) {
              skipped.push({ to: email.to, reason: `daily cap of ${cap} reached — will be picked up on a future run` });
              digestEntries.push({ at: now, source: cmd.source, to: email.to, subject: email.subject, outcome: "skipped", reason: "daily cap reached" });
              continue;
            }
            // Judged individually — a bad email here must not block the good
            // ones behind it, unlike the human-reviewed `send` path.
            const problems = checkOutgoing(email, cc);
            if (isSuppressed(suppressions, email.to)) problems.push({ rule: "suppressed", detail: `${email.to} has opted out` });
            if (problems.length) {
              const reason = problems.map((p) => p.detail).join("; ");
              skipped.push({ to: email.to, reason });
              digestEntries.push({ at: now, source: cmd.source, to: email.to, subject: email.subject, outcome: "skipped", reason });
              continue;
            }
            try {
              const res = await deliverOne(transport, from, email, cmd.replyTo);
              sent.push({ to: email.to, id: res.id });
              digestEntries.push({ at: now, source: cmd.source, to: email.to, subject: email.subject, outcome: "sent" });
            } catch (err) {
              const reason = (err as Error).message;
              failed.push({ to: email.to, error: reason });
              digestEntries.push({ at: now, source: cmd.source, to: email.to, subject: email.subject, outcome: "failed", reason });
            }
          }
          await appendDigest(digestFile, digestEntries).catch(() => { /* digest is a log, not a gate */ });

          return { sentCount: sent.length, skippedCount: skipped.length, failedCount: failed.length, sent, skipped, failed };
        }

        if (cmd.op === "digest") {
          const entries = await loadDigest(digestFile);
          return summarizeDigest(entries, cmd.date);
        }

        throw new Error(`sender: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
