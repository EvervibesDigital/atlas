/**
 * The checks that run before ATLAS is allowed to put an email on the wire.
 *
 * Every business in ATLAS stops at a draft today. This module is what makes
 * actually sending safe, and its posture is deliberate: it **refuses** rather
 * than warns. A warning on a send path is a warning nobody reads — the
 * `send-intro` API has been returning "no postal address configured" for weeks
 * and it changed nothing, because a warning still sends the email.
 *
 * These rules exist because the downside is not a bug report. It's Mat's
 * personal domain getting a spam reputation, or a CAN-SPAM complaint against a
 * real business he owns. "It is my name on it, not ATLAS's."
 */

export interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
}

export interface ComplianceContext {
  /** Physical postal address. CAN-SPAM requires one in every commercial email. */
  postalAddress?: string;
  /** How a recipient opts out. Required alongside the address. */
  unsubscribeNote?: string;
}

/** A single reason an email must not go out. */
export interface Violation {
  rule: string;
  detail: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Addresses that are never a person. Sending to these earns spam complaints
// and teaches the receiving domain that mail from us is junk.
const ROLE_PREFIXES = ["no-reply", "noreply", "do-not-reply", "donotreply", "postmaster", "abuse", "mailer-daemon", "bounce", "bounces"];

/**
 * Everything wrong with an email, all at once.
 *
 * Returns every violation rather than the first, so a caller fixing a batch
 * learns all the problems in one pass instead of rediscovering them one send
 * at a time.
 */
export function checkOutgoing(email: OutgoingEmail, ctx: ComplianceContext): Violation[] {
  const problems: Violation[] = [];
  const to = (email.to ?? "").trim();

  if (!EMAIL_RE.test(to)) {
    problems.push({ rule: "valid-recipient", detail: `"${to}" is not a valid email address` });
  } else {
    const local = to.split("@")[0]!.toLowerCase();
    if (ROLE_PREFIXES.some((p) => local === p || local.startsWith(`${p}+`))) {
      problems.push({ rule: "no-role-address", detail: `${to} is an unattended role address, never a person` });
    }
  }

  if (!email.subject?.trim()) problems.push({ rule: "subject-required", detail: "empty subject lines read as spam" });
  if (!email.body?.trim()) problems.push({ rule: "body-required", detail: "refusing to send an empty email" });

  // The two CAN-SPAM requirements that are checkable from the message itself.
  // Checked against the RENDERED BODY, not against config: a configured address
  // that never made it into the text is exactly as illegal as no address, and
  // that is the failure mode worth catching.
  const address = ctx.postalAddress?.trim();
  if (!address) {
    problems.push({
      rule: "postal-address-required",
      detail: "no COMPANY_POSTAL_ADDRESS configured — US commercial email legally requires a physical mailing address (CAN-SPAM, 15 U.S.C. §7704)",
    });
  } else if (!email.body.includes(address)) {
    problems.push({
      rule: "postal-address-in-body",
      detail: "a postal address is configured but does not appear in this email's text",
    });
  }

  if (!hasOptOut(email.body, ctx.unsubscribeNote)) {
    problems.push({
      rule: "opt-out-required",
      detail: "no opt-out instruction found — the recipient must be told how to stop hearing from you",
    });
  }

  return problems;
}

/**
 * Does the body tell the reader how to stop receiving mail?
 *
 * Accepts a plain-English sentence, not just the word "unsubscribe" — the
 * outreach copy across every business already ends with a line like "if this
 * isn't useful, just say so and I won't follow up", which satisfies CAN-SPAM
 * and reads far better than a footer nobody wrote on purpose.
 */
export function hasOptOut(body: string, configuredNote?: string): boolean {
  const text = (body ?? "").toLowerCase();
  if (configuredNote?.trim() && body.includes(configuredNote.trim())) return true;
  return [
    "unsubscribe",
    "opt out",
    "opt-out",
    "won't follow up",
    "wont follow up",
    "no longer wish",
    "stop hearing from",
    "reply stop",
  ].some((phrase) => text.includes(phrase));
}
