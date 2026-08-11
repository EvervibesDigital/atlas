/**
 * Composes the morning brief email — the thing Mat actually reads instead of
 * logging in. Pure and separately tested from `sendBriefDigest`'s network
 * calls, because the wording is the part most likely to need tuning and a
 * pure function is what lets that happen without touching a live mailbox.
 *
 * The shape follows directly from "I want ATLAS acting as a second me": the
 * email has to say plainly what ATLAS ALREADY DID overnight (so Mat isn't
 * re-checking work that's finished) and separately what still needs his hands
 * — with concrete instructions, not just a bare item title.
 */

export interface BriefItem {
  source: string;
  title: string;
  detail?: string;
  tier: string;
}

export interface OutreachDigest {
  sent: number;
  skipped: number;
  failed: number;
  bySource: Record<string, number>;
}

export interface ManualQueueCounts {
  /** Approved gig bids still waiting on a submit click. */
  gigsToSubmit: number;
  /** KDP books built but not yet published (no API — every one needs a click). */
  kdpToPublish: number;
}

export interface MorningBriefInput {
  items: BriefItem[];
  digest: OutreachDigest;
  manual: ManualQueueCounts;
  /** Tap-to-review link, valid ~24h, for anything still needing a human call. */
  reviewLink: string;
}

export interface MorningBriefEmail {
  subject: string;
  body: string;
}

export function buildMorningBrief(input: MorningBriefInput): MorningBriefEmail {
  const { items, digest, manual, reviewLink } = input;
  const asks = items.filter((i) => i.tier === "ask");

  const didLines: string[] = [];
  if (digest.sent > 0) {
    const bySource = Object.entries(digest.bySource)
      .map(([src, n]) => `${n} ${src}`)
      .join(", ");
    didLines.push(`✅ Sent ${digest.sent} email(s) overnight, no review needed (${bySource}).`);
  }
  if (digest.skipped > 0) {
    didLines.push(`⏭️  Skipped ${digest.skipped} — didn't clear a quality or compliance check (see the Health tab digest for why).`);
  }
  if (digest.failed > 0) {
    didLines.push(`⚠️ ${digest.failed} failed to send — worth a look, something's likely misconfigured.`);
  }
  if (!didLines.length) didLines.push(`Nothing sent itself overnight — no eligible outreach was queued.`);

  const needLines: string[] = [];
  if (manual.gigsToSubmit > 0) {
    needLines.push(`• ${manual.gigsToSubmit} gig bid(s) ready to submit — Gig Finder tab, copy + open + submit each (no platform allows ATLAS to do this step).`);
  }
  if (manual.kdpToPublish > 0) {
    needLines.push(`• ${manual.kdpToPublish} KDP book(s) built and waiting on the Publish click — KDP tab (Amazon has no publish API, so this is always a click).`);
  }
  if (asks.length) {
    needLines.push(`• ${asks.length} item(s) need an actual decision from you — tap the link below.`);
  }
  if (!needLines.length) needLines.push(`Nothing needs you right now.`);

  const subject = asks.length
    ? `☀️ ATLAS brief — ${digest.sent} sent overnight, ${asks.length} need you`
    : `☀️ ATLAS brief — ${digest.sent} sent overnight, nothing urgent`;

  const lines = [
    `Good morning. Here's what ATLAS did, and what's on you today.`,
    ``,
    `WHAT I HANDLED`,
    ...didLines,
    ``,
    `WHAT NEEDS YOU`,
    ...needLines,
    ``,
    asks.length ? `👉 Review & decide from your phone (link good for 24h, no login):` : `👉 Full detail any time (link good for 24h, no login):`,
    reviewLink,
    ``,
    `— ATLAS`,
  ];

  return { subject, body: lines.join("\n") };
}
