/**
 * SMTP transport — the path that works with a mailbox you already own.
 *
 * Resend is the better long-term choice for cold outreach (provider-side bounce
 * handling and suppression), but it will not send a single email until the
 * sending domain is verified by DNS. A Hostinger/Google Workspace mailbox needs
 * none of that: the domain is already configured, the mailbox already
 * authenticates, and mail can go out the same day.
 *
 * So both exist, and the choice is explicit rather than implied.
 *
 * `nodemailer` is imported through an indirect specifier for the same reason
 * @atlas/email does it: it keeps the dependency out of the module graph for
 * every consumer that never sends, and turns a missing install into a sentence
 * that says what to run.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export interface SmtpMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}

export interface SmtpTransport {
  sendMail(opts: Record<string, unknown>): Promise<{ messageId?: string }>;
}

export type TransportFactory = (config: SmtpConfig) => Promise<SmtpTransport>;

/** Real nodemailer transport. Replaced wholesale in tests. */
export const nodemailerTransport: TransportFactory = async (config) => {
  const spec = "nodemailer";
  let nodemailer: { createTransport(o: unknown): SmtpTransport };
  try {
    nodemailer = (await import(spec)) as typeof nodemailer;
  } catch {
    throw new Error("smtp: nodemailer is not installed — run once: pnpm add nodemailer");
  }
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    // 465 is implicit TLS; 587 upgrades via STARTTLS. Getting this backwards
    // fails with a timeout rather than a useful error, so it is derived from
    // the port rather than left to the caller.
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
  });
};

export async function sendViaSmtp(
  msg: SmtpMessage,
  config: SmtpConfig,
  makeTransport: TransportFactory = nodemailerTransport,
): Promise<{ id: string; provider: "smtp" }> {
  const transport = await makeTransport(config);
  const info = await transport.sendMail({
    from: msg.from,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
  });
  // A message-id is informational here; SMTP acceptance is the actual success
  // signal, so a server that omits one is not a failure.
  return { id: info?.messageId ?? "smtp-accepted", provider: "smtp" };
}

/** Known SMTP hosts, so a mailbox address alone is enough to configure sending. */
const KNOWN_HOSTS: Array<{ match: RegExp; host: string }> = [
  { match: /@hostinger\./i, host: "smtp.hostinger.com" },
  { match: /@gmail\.com$/i, host: "smtp.gmail.com" },
  { match: /@googlemail\.com$/i, host: "smtp.gmail.com" },
  { match: /@outlook\.com$|@hotmail\.com$/i, host: "smtp-mail.outlook.com" },
  { match: /@yahoo\.com$/i, host: "smtp.mail.yahoo.com" },
];

/**
 * Guess the SMTP host from the mailbox address.
 *
 * Only used when no host is configured, and only for providers where the
 * mapping is unambiguous. A custom domain (team@evervibesdigital.com) cannot be
 * guessed — its MX could be anyone — so it returns null and the caller asks for
 * the host explicitly rather than silently trying the wrong server.
 */
export function guessSmtpHost(user: string): string | null {
  return KNOWN_HOSTS.find((k) => k.match.test(user))?.host ?? null;
}
