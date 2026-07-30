import type { AtlasContext, Plugin } from "@atlas/core";

/**
 * Email agent — gives ATLAS its own inbox so it can read confirmation links
 * (for approval-gated signups), read real message bodies (for things like Gig
 * Finder's win detection), and send mail. READING is safe (L0). SENDING is
 * approval-gated (email.send). The real IMAP/SMTP/MIME-parsing libraries are
 * lazy-loaded so the module never pays their load cost unless email is
 * actually used: enable with `pnpm add imapflow nodemailer mailparser` and by
 * adding EMAIL_USER + EMAIL_PASS (Gmail: an App Password) to the vault.
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

/** Decodes a raw RFC822/MIME message (headers + body) into a clean body
 * `text` and the `links` found in it. Exported so it's independently
 * testable against real raw-message fixtures, without a live IMAP server.
 * Prefers the plain-text part; falls back to the HTML part (for both the
 * returned text and link extraction) when a message has no text/plain part —
 * common for marketing-styled "you got the job" notification emails. */
export async function parseMessage(source: Buffer): Promise<{ text: string; links: string[] }> {
  const spec = "mailparser";
  let simpleParser: (source: Buffer) => Promise<{ text?: string; html?: string | false }>;
  try {
    ({ simpleParser } = (await import(spec)) as { simpleParser: typeof simpleParser });
  } catch {
    throw new Error("Email libraries not installed — run once: pnpm add imapflow nodemailer mailparser");
  }
  const parsed = await simpleParser(source);
  const bodyText = (parsed.text ?? "").trim() || (parsed.html ? parsed.html.replace(/<[^>]+>/g, " ") : "");
  const linkSource = parsed.html || parsed.text || "";
  return { text: bodyText.replace(/\s+/g, " ").trim().slice(0, 1500), links: extractLinks(linkSource) };
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
    throw new Error("Email libraries not installed — run once: pnpm add imapflow nodemailer mailparser");
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
          const { text, links } = msg.source ? await parseMessage(msg.source) : { text: "", links: [] as string[] };
          out.push({
            from: msg.envelope?.from?.[0]?.address ?? "",
            subject: msg.envelope?.subject ?? "",
            date: msg.envelope?.date?.toISOString?.() ?? "",
            text,
            links,
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
    throw new Error("Email libraries not installed — run once: pnpm add imapflow nodemailer mailparser");
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
export type EmailCommand =
  | { op: "check"; limit?: number }
  | { op: "send"; to: string; subject: string; body: string }
  // Direct send to the OWNER's own address only (no approval gate) — for system
  // notifications like the morning brief. Not an outbound-spam vector the way
  // `send` is, because it can never reach a third party.
  | { op: "ownerNotify"; subject: string; body: string };

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
        if (cmd.op === "ownerNotify") {
          const owner = (await ctx.secret("OWNER_EMAIL")) || (await ctx.secret("EMAIL_USER"));
          if (!owner) throw new Error("email: no owner address — set EMAIL_USER (or OWNER_EMAIL)");
          const sender = opts.sender ?? (await realSender(ctx));
          await sender.send(owner, cmd.subject, cmd.body);
          await ctx.emit("email.sent", { to: owner });
          return { sent: true, to: owner };
        }
        throw new Error(`email: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
