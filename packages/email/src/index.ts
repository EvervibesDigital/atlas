import type { AtlasContext, Plugin } from "@atlas/core";

/**
 * Email agent — gives ATLAS its own inbox so it can read confirmation links
 * (for approval-gated signups) and send mail. READING is safe (L0). SENDING is
 * approval-gated (email.send). The real IMAP/SMTP transports are lazy-loaded so
 * they're optional: enable with `pnpm add imapflow nodemailer` and by adding
 * EMAIL_USER + EMAIL_PASS (Gmail: an App Password) to the vault.
 */
export interface MailMessage {
  from: string;
  subject: string;
  date: string;
  text: string;
  links: string[];
}

export interface MailReader {
  recent(limit: number): Promise<MailMessage[]>;
}
export interface MailSender {
  send(to: string, subject: string, body: string): Promise<void>;
}

export function extractLinks(text: string): string[] {
  const m = text.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
  return [...new Set(m)].slice(0, 25);
}

async function getCreds(ctx: AtlasContext): Promise<{ user: string; pass: string; imapHost: string; smtpHost: string }> {
  const user = await ctx.secret("EMAIL_USER");
  const pass = await ctx.secret("EMAIL_PASS");
  if (!user || !pass) throw new Error("Email not configured — add EMAIL_USER + EMAIL_PASS (Gmail: an App Password) in the Keys/Connect tab.");
  const gmail = /@gmail\.com$/i.test(user);
  const imapHost = (await ctx.secret("EMAIL_IMAP_HOST")) ?? (gmail ? "imap.gmail.com" : "");
  const smtpHost = (await ctx.secret("EMAIL_SMTP_HOST")) ?? (gmail ? "smtp.gmail.com" : "");
  return { user, pass, imapHost, smtpHost };
}

async function realReader(ctx: AtlasContext): Promise<MailReader> {
  const { user, pass, imapHost } = await getCreds(ctx);
  if (!imapHost) throw new Error("Set EMAIL_IMAP_HOST for a non-Gmail provider.");
  const spec = "imapflow";
  let ImapFlow: new (o: unknown) => { connect(): Promise<void>; getMailboxLock(m: string): Promise<{ release(): void }>; status(m: string, o: unknown): Promise<{ messages?: number }>; fetch(range: string, o: unknown): AsyncIterable<{ envelope?: { from?: Array<{ address?: string }>; subject?: string; date?: Date }; source?: Buffer }>; logout(): Promise<void> };
  try {
    ({ ImapFlow } = (await import(spec)) as { ImapFlow: typeof ImapFlow });
  } catch {
    throw new Error("Email libraries not installed — run once: pnpm add imapflow nodemailer");
  }
  return {
    async recent(limit) {
      const client = new ImapFlow({ host: imapHost, port: 993, secure: true, auth: { user, pass }, logger: false });
      await client.connect();
      const out: MailMessage[] = [];
      const lock = await client.getMailboxLock("INBOX");
      try {
        const status = await client.status("INBOX", { messages: true });
        const total = status.messages ?? 0;
        const start = Math.max(1, total - limit + 1);
        for await (const msg of client.fetch(`${start}:*`, { envelope: true, source: true })) {
          const src = msg.source?.toString("utf8") ?? "";
          out.push({
            from: msg.envelope?.from?.[0]?.address ?? "",
            subject: msg.envelope?.subject ?? "",
            date: msg.envelope?.date?.toISOString?.() ?? "",
            text: src.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 1500),
            links: extractLinks(src),
          });
        }
      } finally {
        lock.release();
        await client.logout();
      }
      return out.reverse();
    },
  };
}

async function realSender(ctx: AtlasContext): Promise<MailSender> {
  const { user, pass, smtpHost } = await getCreds(ctx);
  if (!smtpHost) throw new Error("Set EMAIL_SMTP_HOST for a non-Gmail provider.");
  const spec = "nodemailer";
  let nodemailer: { createTransport(o: unknown): { sendMail(o: unknown): Promise<unknown> } };
  try {
    nodemailer = (await import(spec)) as typeof nodemailer;
  } catch {
    throw new Error("Email libraries not installed — run once: pnpm add imapflow nodemailer");
  }
  const transport = nodemailer.createTransport({ host: smtpHost, port: 465, secure: true, auth: { user, pass } });
  return {
    async send(to, subject, body) {
      await transport.sendMail({ from: user, to, subject, text: body });
    },
  };
}

interface Approval {
  id: string;
}
export type EmailCommand = { op: "check"; limit?: number } | { op: "send"; to: string; subject: string; body: string };

/** Email plugin (service "email"). Inject reader/sender for tests. */
export function createEmailPlugin(opts: { reader?: MailReader; sender?: MailSender } = {}): Plugin {
  return {
    manifest: { name: "email", version: "0.1.0", capabilities: ["email"], permissions: ["secret:*", "call:approvals"], role: "executor" },
    register(ctx) {
      const jobs = new Map<string, { to: string; subject: string; body: string }>();

      ctx.on("approval.granted", async (payload) => {
        const job = jobs.get((payload as Approval).id);
        if (!job) return;
        jobs.delete((payload as Approval).id);
        try {
          const sender = opts.sender ?? (await realSender(ctx));
          await sender.send(job.to, job.subject, job.body);
          await ctx.emit("email.sent", { to: job.to });
        } catch (e) {
          await ctx.emit("email.error", { error: (e as Error).message });
        }
      });

      ctx.provide("email", async (payload) => {
        const cmd = payload as EmailCommand;
        if (cmd.op === "check") {
          const reader = opts.reader ?? (await realReader(ctx));
          return { messages: await reader.recent(cmd.limit ?? 10) };
        }
        if (cmd.op === "send") {
          const approval = (await ctx.call("approvals", { op: "request", action: `Send email to ${cmd.to}`, detail: cmd.subject, risk: 2 })) as Approval;
          jobs.set(approval.id, { to: cmd.to, subject: cmd.subject, body: cmd.body });
          return { status: "pending-approval", approvalId: approval.id };
        }
        throw new Error(`email: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
