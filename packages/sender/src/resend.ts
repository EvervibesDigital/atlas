export type FetchLike = typeof fetch;

/**
 * Minimal Resend client.
 *
 * Resend over raw SMTP because cold outreach lives or dies on deliverability:
 * SPF/DKIM signing, bounce handling, and a hard suppression list at the
 * provider are things a Gmail SMTP transport simply does not give. Sending
 * business mail through a personal Gmail is also the fastest way to get that
 * personal account rate-limited.
 *
 * Written against `fetch` rather than the `resend` SDK — one less dependency,
 * and the fetch is injectable so every test proves it never touches the
 * network.
 */

export interface SendResult {
  id: string;
  provider: "resend";
}

export interface ResendMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}

export async function sendViaResend(msg: ResendMessage, apiKey: string, fetcher: FetchLike = fetch): Promise<SendResult> {
  const r = await fetcher("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: msg.from,
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
    }),
  });

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    // Surface Resend's own words. Its 403s are usually "domain not verified",
    // which is a specific, fixable thing — a generic "send failed" would send
    // Mat hunting through code instead of into his DNS records.
    throw new Error(`resend: HTTP ${r.status}: ${body.slice(0, 300)}`);
  }

  const data = (await r.json().catch(() => ({}))) as { id?: string };
  if (!data.id) throw new Error("resend: accepted the request but returned no message id");
  return { id: data.id, provider: "resend" };
}

/**
 * Is this `from` address plausibly sendable?
 *
 * Resend only sends from a domain you have verified. Catching a gmail.com /
 * outlook.com sender here turns an opaque provider 403 into a sentence that
 * says what to do about it.
 */
export function unsendableFromReason(from: string): string | null {
  const at = from.lastIndexOf("@");
  if (at < 1) return `"${from}" is not a valid From address`;
  const domain = from.slice(at + 1).toLowerCase();
  const freeMail = ["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "aol.com"];
  if (freeMail.includes(domain)) {
    return `Resend cannot send from ${domain} — it only sends from a domain you have verified. Use an address on a domain you own (e.g. mat@evervibesdigital.com) and verify it at resend.com/domains.`;
  }
  return null;
}
