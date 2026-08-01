import type { Lead, ScanIssue } from "./types";

/**
 * Cold-outreach copy for the website-compliance business.
 *
 * The whole pitch rests on one advantage: we already audited their site, so
 * we can name real, checkable problems instead of sending the generic "I
 * noticed your website could use some work" that every agency sends. The
 * findings come from `scanWebsite`, a real HTML audit — not an AI guess.
 *
 * ⚠️ This deliberately does NOT reuse the n8n `new-lead` workflow. That one
 * (`ARCHIVED-W3 - New Lead Intake`, inspected live 2026-08-01) ends in "Send
 * Lead Confirmation" — a thanks-for-contacting-us reply. Firing that at a
 * business who has never heard of Mat reads as spam at best and nonsense at
 * worst. Cold outreach needs its own copy, which is this.
 *
 * Written to the same standard as the wholesale intro prompt and the surplus
 * letter: no fake urgency, no scarcity, no flattery, no "I hope this finds
 * you well". One standard across every business.
 */

export interface ComplianceOutreachInput {
  lead: Lead;
  senderName: string;
  companyName: string;
  /** Physical postal address — CAN-SPAM requires one in commercial email. */
  companyAddress: string;
  /** Optional: what a fix typically costs, so the email answers the obvious
   * next question instead of forcing a reply to find out. */
  startingPrice?: string;
}

export interface RenderedOutreach {
  to: string;
  subject: string;
  body: string;
}

/** Issues a non-technical owner will actually recognise, worst first. */
// Keys match ScanIssue["category"] exactly. Values are what a non-technical
// business owner would recognise — "search visibility" lands where "seo"
// doesn't.
const CATEGORY_LABEL: Record<string, string> = {
  accessibility: "accessibility",
  privacy: "privacy/legal",
  seo: "search visibility",
  security: "security",
  mobile: "mobile",
};

function plainIssue(i: ScanIssue): string {
  const label = CATEGORY_LABEL[i.category] ?? i.category;
  return `${i.issue} (${label})`;
}

export function missingOutreachFields(input: ComplianceOutreachInput): string[] {
  const missing: string[] = [];
  if (!(input.lead?.email ?? "").includes("@")) missing.push("lead.email");
  if (!input.lead?.businessName?.trim()) missing.push("lead.businessName");
  if (!input.lead?.scan) missing.push("lead.scan");
  else if (!input.lead.scan.issues?.length) missing.push("lead.scan.issues (nothing to point at)");
  if (!input.senderName?.trim()) missing.push("senderName");
  if (!input.companyName?.trim()) missing.push("companyName");
  if (!input.companyAddress?.trim()) missing.push("companyAddress");
  return missing;
}

/**
 * Renders the email. Refuses rather than degrades: an outreach email whose
 * whole credibility rests on naming real findings must not go out saying
 * "I found some issues" with nothing behind it — that is indistinguishable
 * from the generic agency spam this is meant to beat.
 */
export function renderComplianceOutreach(input: ComplianceOutreachInput): RenderedOutreach {
  const missing = missingOutreachFields(input);
  if (missing.length) {
    throw new Error(`leadscan outreach: refusing to render — missing ${missing.join(", ")}`);
  }

  const { lead } = input;
  const scan = lead.scan!;
  const top = scan.issues.slice(0, 3).map(plainIssue);
  const more = scan.issues.length - top.length;

  const priceLine = input.startingPrice
    ? `Fixing this kind of thing usually starts around ${input.startingPrice}.`
    : `Happy to quote it once you know what you want done.`;

  // Build the bullet block first, then join whole paragraphs with blank
  // lines. Composing paragraphs directly (rather than filtering empties and
  // regex-restoring the breaks) keeps the output predictable — mangled copy
  // reaching a real business is exactly the failure this module exists to
  // avoid.
  const bullets = [...top.map((t) => `• ${t}`), ...(more > 0 ? [`• plus ${more} more`] : [])].join("\n");

  const paragraphs = [
    `Hi${lead.businessName ? ` — ${lead.businessName}` : ""},`,
    `I ran an automated check on ${lead.website} and found a few things worth fixing:`,
    bullets,
    `These matter for a couple of practical reasons: accessibility issues are the ones that draw demand letters, and the rest quietly cost you customers who bounce before the page loads properly.`,
    `I fix exactly this for local businesses. ${priceLine} If you'd like the full list of what I found, reply and I'll send it over — no charge either way, and no obligation.`,
    `If this isn't useful, just say so and I won't follow up.`,
    `— ${input.senderName.trim()}, ${input.companyName.trim()}\n${input.companyAddress.trim()}`,
  ];

  const body = paragraphs.join("\n\n");

  return {
    to: lead.email!,
    // Specific and checkable, so it doesn't read as a template blast.
    subject: `${scan.issues.length} issue${scan.issues.length === 1 ? "" : "s"} on ${lead.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}`,
    body,
  };
}
