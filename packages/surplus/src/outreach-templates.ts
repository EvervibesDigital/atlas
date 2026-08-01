/**
 * Outreach copy for surplus-funds recovery.
 *
 * WHO THIS REACHES: people whose home was just sold at a foreclosure or
 * tax sale. They are often distressed, frequently targeted by predatory
 * "recovery" outfits, and in many cases do not know the money exists. The
 * copy below is written accordingly, and three choices in it are deliberate:
 *
 *  1. **It tells them they can file the claim themselves, for free.** Hiding
 *     that is the single clearest marker of a predatory recovery operation.
 *     Saying it plainly is both the right thing and the durable thing — it is
 *     what survives a complaint, a regulator, or the recipient's lawyer
 *     reading the letter.
 *  2. **It invites independent verification** with the clerk of court, and
 *     gives the case number so they can. Anyone can check the claim is real.
 *  3. **No urgency, no scarcity, no "act now".** Those tactics are what make
 *     this industry's mail look like a scam, and they are explicitly banned
 *     from the wholesale email prompt in this same codebase — one standard,
 *     applied everywhere.
 *
 * ⚠️ LEGAL — NOT LEGAL ADVICE, AND NOT OPTIONAL TO RESOLVE:
 * Florida (where every current lead sits) regulates surplus-funds recovery,
 * including rules touching assignments of a claim and what may be charged
 * (see F.S. 45.033 and related). Several states restrict solicitation timing
 * after a sale, cap fees, or require specific disclosure language. The fee
 * percentage and the wording of the fee sentence MUST be reviewed by the
 * attorney the business partners with before the first letter goes out. This
 * module deliberately takes the fee as an input rather than hardcoding one,
 * so that review has something concrete to sign off on.
 */

export interface SurplusOutreachInput {
  ownerName?: string;
  propertyAddress?: string;
  caseNumber?: string;
  county?: string;
  state?: string;
  estimatedSurplus?: number;
  auctionDate?: string;
  /** Contingency fee as a percentage, e.g. 25 for 25%. Attorney-approved. */
  feePercent: number;
  senderName: string;
  companyName: string;
  /** Physical postal address — required on the letter, and required by
   * CAN-SPAM on the email version. */
  companyAddress: string;
  contactPhone?: string;
  contactEmail?: string;
}

/**
 * Fields without which the letter would be untrustworthy or nonsense. A
 * letter reading "you may be owed $undefined" or missing the case number is
 * worse than sending nothing: it is unverifiable, it looks exactly like a
 * scam, and it goes to someone who just lost their home. Rendering is refused
 * rather than degraded.
 */
export function missingOutreachFields(input: SurplusOutreachInput): string[] {
  const missing: string[] = [];
  if (!input.ownerName?.trim()) missing.push("ownerName");
  if (!input.caseNumber?.trim()) missing.push("caseNumber");
  if (!input.propertyAddress?.trim()) missing.push("propertyAddress");
  if (!input.county?.trim()) missing.push("county");
  if (typeof input.estimatedSurplus !== "number" || !Number.isFinite(input.estimatedSurplus) || input.estimatedSurplus <= 0) {
    missing.push("estimatedSurplus");
  }
  if (typeof input.feePercent !== "number" || !Number.isFinite(input.feePercent) || input.feePercent <= 0) {
    missing.push("feePercent");
  }
  if (!input.senderName?.trim()) missing.push("senderName");
  if (!input.companyName?.trim()) missing.push("companyName");
  if (!input.companyAddress?.trim()) missing.push("companyAddress");
  if (!input.contactPhone?.trim() && !input.contactEmail?.trim()) missing.push("contactPhone or contactEmail");
  return missing;
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** Rounded DOWN and hedged, so the figure can never read as a promise of a
 * specific payout. The court decides the final amount, not us. */
function approxSurplus(n: number): string {
  const floored = Math.floor(n / 100) * 100;
  return money(floored > 0 ? floored : n);
}

export interface RenderedOutreach {
  subject: string;
  body: string;
}

/**
 * The primary channel. 59 of 68 current leads have a mailing address and
 * ZERO have an email, so physical mail is how these people are actually
 * reachable — not a fallback.
 */
export function renderSurplusLetter(input: SurplusOutreachInput): RenderedOutreach {
  const missing = missingOutreachFields(input);
  if (missing.length) {
    throw new Error(`surplus outreach: refusing to render — missing required field(s): ${missing.join(", ")}`);
  }

  const contactLine = [input.contactPhone && `call ${input.contactPhone}`, input.contactEmail && `email ${input.contactEmail}`]
    .filter(Boolean)
    .join(" or ");

  const soldOn = input.auctionDate?.trim() ? ` on ${input.auctionDate.trim()}` : "";
  const county = `${input.county!.trim()}${input.state?.trim() ? ` County, ${input.state.trim()}` : " County"}`;

  const body = [
    `${input.ownerName!.trim()},`,
    ``,
    `Public court records for ${county} show that the property at ${input.propertyAddress!.trim()} sold at a foreclosure sale${soldOn} for more than was owed on it. When that happens, the leftover money — the surplus — generally belongs to the former owner, not to the lender.`,
    ``,
    `Based on those records, the surplus in your case appears to be around ${approxSurplus(input.estimatedSurplus!)}. The case number is ${input.caseNumber!.trim()}.`,
    ``,
    `Please verify this yourself. The ${county} Clerk of Court can confirm the case, the surplus, and what the deadline is. I would rather you check than take my word for it.`,
    ``,
    `You can file this claim on your own, for free. The clerk's office can tell you how, and many people do exactly that. I am not with the court and I am not a lawyer.`,
    ``,
    `If you would rather not handle the filing yourself, we work with attorneys who do it for you. They are paid ${input.feePercent}% of whatever you actually recover, and nothing at all if you recover nothing. There is no upfront cost and no obligation.`,
    ``,
    `If you want help, ${contactLine}. If you would rather not hear from us again, tell us and we will stop contacting you.`,
    ``,
    `— ${input.senderName.trim()}, ${input.companyName.trim()}`,
    input.companyAddress.trim(),
  ].join("\n");

  return {
    subject: `Funds from the sale of ${input.propertyAddress!.trim()} (case ${input.caseNumber!.trim()})`,
    body,
  };
}

/**
 * Email version — usable only AFTER skip tracing produces an address, since
 * 0 of 68 current leads have one. Same substance as the letter, tightened for
 * a screen, and carrying the postal address CAN-SPAM requires.
 */
export function renderSurplusEmail(input: SurplusOutreachInput): RenderedOutreach {
  const missing = missingOutreachFields(input);
  if (missing.length) {
    throw new Error(`surplus outreach: refusing to render — missing required field(s): ${missing.join(", ")}`);
  }

  const contactLine = [input.contactPhone && `call ${input.contactPhone}`, input.contactEmail && `reply to this email`]
    .filter(Boolean)
    .join(" or ");
  const county = `${input.county!.trim()}${input.state?.trim() ? ` County, ${input.state.trim()}` : " County"}`;

  const body = [
    `${input.ownerName!.trim()},`,
    ``,
    `Court records for ${county} show the property at ${input.propertyAddress!.trim()} sold for more than was owed. That surplus generally belongs to the former owner. In your case it looks like roughly ${approxSurplus(input.estimatedSurplus!)}, under case number ${input.caseNumber!.trim()}.`,
    ``,
    `Please confirm it with the ${county} Clerk of Court rather than taking my word for it — they can also tell you the deadline.`,
    ``,
    `You can claim it yourself, for free. I am not with the court and not a lawyer. If you would rather someone else handle the filing, we work with attorneys who take ${input.feePercent}% of what you actually recover and nothing if you recover nothing.`,
    ``,
    `No obligation either way. To talk it through, ${contactLine}.`,
    ``,
    `— ${input.senderName.trim()}, ${input.companyName.trim()}`,
    input.companyAddress.trim(),
  ].join("\n");

  return {
    subject: `Surplus funds from ${input.propertyAddress!.trim()} — case ${input.caseNumber!.trim()}`,
    body,
  };
}
