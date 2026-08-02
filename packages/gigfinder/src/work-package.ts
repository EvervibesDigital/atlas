import type { Gig } from "./types";

/**
 * Turning a won gig into work that can actually be executed.
 *
 * The design choice worth understanding: Mat already HAS a work-execution
 * engine — Claude Code, the thing that builds ATLAS itself. ATLAS should not
 * attempt a weaker copy of it. So this produces the *input* that makes that
 * engine fast: a scoped package plus a ready-to-paste handoff prompt. One
 * paste, and the work gets built by the best tool available.
 */
export interface WorkPackage {
  gigId: string;
  /** What the client actually wants, in plain terms. */
  summary: string;
  /** The concrete list Mat is on the hook for. */
  deliverables: string[];
  /** Genuine ambiguities, to ask BEFORE starting. Unclear scope is the single
   * most common way freelance work goes wrong, and a Reddit gig post rarely
   * contains enough detail — this field makes that thinness explicit rather
   * than hiding it behind confident-sounding scope. */
  questionsForClient: string[];
  /** What we proceed on if the client doesn't answer. */
  assumptions: string[];
  techApproach: string;
  estimateDays: number;
  /** Paste-into-Claude-Code prompt. The payoff of the whole module. */
  handoffPrompt: string;
  /** Provenance, so a generic template package is never mistaken for real
   * extracted requirements. */
  generatedBy: "brain" | "template";
}

/**
 * Quality gate, applied before a package is stored.
 *
 * Same discipline as the bid quality gate: validate the OUTPUT rather than
 * trust the model. A package with no deliverables, or whose summary is a
 * truncated fragment (the exact failure shape seen in production with
 * `"Delivery Estimate):* Depending on your clients'"`), is worse than the
 * deterministic template — it looks like real scope while being useless.
 */
export function isUsableWorkPackage(pkg: Partial<WorkPackage> | null | undefined): boolean {
  if (!pkg) return false;
  const summary = (pkg.summary ?? "").trim();
  if (summary.length < 25) return false;
  // Starts mid-sentence or on punctuation — a truncated model artifact.
  if (!/^["'A-Z0-9]/.test(summary)) return false;
  // Leaked markdown/template scaffolding. Deliberately narrow: an earlier
  // version banned any of [ ] * _ #, which rejected EVERY real gig — r/forhire
  // titles are tagged "[Hiring]", and the summary quotes the title. Brackets
  // are legitimate content; bold markers and headings are not.
  if (/\*\*/.test(summary) || /^#{1,6}\s/.test(summary) || /\)\s*:/.test(summary)) return false;
  if (!Array.isArray(pkg.deliverables) || pkg.deliverables.filter((d) => (d ?? "").trim().length > 3).length === 0) return false;
  if (typeof pkg.estimateDays !== "number" || !Number.isFinite(pkg.estimateDays) || pkg.estimateDays <= 0 || pkg.estimateDays > 90) return false;
  if (!(pkg.techApproach ?? "").trim()) return false;
  return true;
}

function bullets(items: string[]): string {
  return items.filter((i) => (i ?? "").trim()).map((i) => `- ${i.trim()}`).join("\n");
}

/**
 * Assembles the paste-ready Claude Code prompt. Pure and deterministic — the
 * same gig and package always produce byte-identical output, so what was
 * reviewed is what gets pasted.
 */
export function buildHandoffPrompt(gig: Gig, pkg: Omit<WorkPackage, "handoffPrompt" | "gigId" | "generatedBy">): string {
  const budget = gig.budget ? `$${gig.budget}` : "not stated";
  const sections = [
    `Build the deliverable for a paid freelance job. Work to the scope below — do not expand it.`,
    ``,
    `## The job`,
    `Title: ${gig.title}`,
    `Source: ${gig.url}`,
    `Budget: ${budget}`,
    `Client's own words: ${gig.snippet}`,
    ``,
    `## Scope`,
    pkg.summary,
    ``,
    `## Deliverables`,
    bullets(pkg.deliverables),
    ``,
    `## Approach`,
    pkg.techApproach,
  ];

  if (pkg.assumptions.filter((a) => (a ?? "").trim()).length) {
    sections.push(``, `## Assumptions being made`, bullets(pkg.assumptions));
  }
  if (pkg.questionsForClient.filter((q) => (q ?? "").trim()).length) {
    sections.push(
      ``,
      `## Open questions (NOT yet answered by the client)`,
      bullets(pkg.questionsForClient),
      ``,
      `Where an open question blocks a decision, pick the most conventional option, note it clearly in the README, and keep going — do not stall.`,
    );
  }

  sections.push(
    ``,
    `## Definition of done`,
    `- Every deliverable above exists and runs.`,
    `- A README explains how to run it, what was assumed, and any open question that was decided unilaterally.`,
    `- No placeholder or stub code presented as finished work.`,
    `- Target: roughly ${pkg.estimateDays} day(s) of work.`,
  );

  return sections.join("\n");
}

/** Lowercased haystack of everything the posting told us. */
function gigText(gig: Gig): string {
  return `${gig.title} ${gig.snippet}`.toLowerCase();
}

/** Best-effort stack guess from the posting's own words. Deterministic. */
function inferTechApproach(gig: Gig): string {
  const t = gigText(gig);
  const hits: string[] = [];
  if (/\bn8n\b/.test(t)) hits.push("n8n workflows");
  if (/zapier|make\.com/.test(t)) hits.push("Zapier/Make automation");
  if (/telegram|discord|slack bot|chatbot|\bbot\b/.test(t)) hits.push("a bot integration against the platform's official API");
  if (/playwright|selenium|scrape|scraping|crawler/.test(t)) hits.push("Playwright for browser automation/scraping");
  if (/react native|expo|\bios\b|android/.test(t)) hits.push("React Native");
  if (/\bapi\b|integration|webhook/.test(t)) hits.push("REST API integration");
  if (/website|landing page|web app|next\.?js|frontend/.test(t)) hits.push("a small web front end");
  if (/python|pandas|csv|excel|spreadsheet/.test(t)) hits.push("Python");
  if (!hits.length) hits.push("Python plus the relevant platform APIs");
  return `${hits.join(", ")}. Deliver runnable source with a README.`;
}

/**
 * A package built with NO AI CALL AT ALL, from the posting's own text.
 *
 * This is not merely a fallback. Every brain provider is quota-exhausted as of
 * 2026-08-01 (Gemini 429), so a design that only worked with AI would be a
 * design that does not work today. This makes the feature usable immediately,
 * and it degrades honestly: `generatedBy: "template"` records that the scope
 * was inferred, not extracted.
 */
export function templateWorkPackage(gig: Gig): WorkPackage {
  const techApproach = inferTechApproach(gig);
  const summary = `Deliver the work described in the posting "${gig.title}". Scope below is inferred from the posting text and must be confirmed with the client before substantial work begins.`;

  const deliverables = [
    "Working implementation of the functionality described in the posting",
    "Source code, runnable from a clean checkout",
    "README covering setup, how to run it, and any assumptions made",
  ];

  const questionsForClient = [
    "What exactly counts as done for you — is there a specific end result or output you need to see?",
    "Are there existing systems, accounts, or APIs this has to work with?",
    gig.budget ? `Is the ${`$${gig.budget}`} budget fixed, or does it depend on final scope?` : "What budget range are you working with for this?",
    "What's your deadline, and is any part of it more urgent than the rest?",
  ];

  const assumptions = [
    "The client provides any credentials or API access needed for systems we don't control",
    "Deliverable is source code plus documentation, not a hosted/managed service",
    "One round of revisions is included",
  ];

  const estimateDays = 4;
  const base = { summary, deliverables, questionsForClient, assumptions, techApproach, estimateDays };

  return {
    gigId: gig.id,
    ...base,
    handoffPrompt: buildHandoffPrompt(gig, base),
    generatedBy: "template",
  };
}

/** System prompt for extracting real requirements when the brain is available. */
export function workPackageSystemPrompt(): string {
  return [
    "You scope paid freelance jobs for Mat, an AI-automation freelancer.",
    "Read the job posting and return ONLY a JSON object, no markdown fence, no preamble, with exactly these keys:",
    '{"summary": string, "deliverables": string[], "questionsForClient": string[], "assumptions": string[], "techApproach": string, "estimateDays": number}',
    "Rules:",
    "- summary: what the client actually wants, plainly, 1-3 sentences. Start with a capital letter.",
    "- deliverables: 2-5 concrete items. No vague entries like 'do the work'.",
    "- questionsForClient: the genuine ambiguities that should be asked BEFORE starting. Postings are usually thin — surfacing what's missing is the most valuable part. 2-5 items.",
    "- assumptions: what to proceed on if the client doesn't answer. 2-4 items.",
    "- techApproach: concrete tools/stack, one or two sentences.",
    "- estimateDays: realistic working days, a number between 1 and 30.",
    "Never invent client details, credentials, prices, or requirements that are not in the posting.",
  ].join("\n");
}

/**
 * Is this drafted bid fit to send under Mat's own name?
 *
 * Measured against the 28 real approved bids sitting in production on
 * 2026-08-02, not invented. Seven of them were truncated mid-sentence by a
 * failed generation — the worst being the literal string
 * `"Call to Action/Wrap up):* Let me know"`, which is leaked prompt
 * scaffolding. Pasting that into a client's thread costs the gig and the
 * reputation.
 *
 * The three signals agreed perfectly on that real sample, which is why all
 * three are used rather than the shortest one:
 *   - length: every broken bid was <= 70 chars, every good one >= 243
 *   - terminal punctuation: 21/21 good ended in . ! or ?, 0/7 broken did
 *   - scaffolding: 0/21 good contained "*", 2/7 broken did
 *
 * The 150-char threshold sits in the empty gap between 70 and 243 rather than
 * being a round number picked by feel.
 */
export function isUsableBid(bid: string | undefined): boolean {
  const text = (bid ?? "").trim();
  if (text.length < 150) return false;
  // A bid that doesn't end a sentence was cut off mid-generation.
  if (!/[.!?]$/.test(text)) return false;
  // Markdown emphasis and template headings are prompt leakage — a human
  // writing a proposal in a plain-text box does not type "Approach.*".
  if (/\*/.test(text)) return false;
  if (/\b(call to action|wrap ?up|your name here|\[insert)\b/i.test(text)) return false;
  return true;
}

/** Why a bid was rejected, for showing next to it instead of a bare "unusable". */
export function bidProblem(bid: string | undefined): string | null {
  const text = (bid ?? "").trim();
  if (!text) return "no bid was drafted";
  if (text.length < 150) return `only ${text.length} characters — the generation was cut off`;
  if (!/[.!?]$/.test(text)) return "ends mid-sentence — the generation was cut off";
  if (/\*/.test(text)) return "contains leftover markdown/template scaffolding";
  if (/\b(call to action|wrap ?up|your name here|\[insert)\b/i.test(text)) return "contains leaked prompt scaffolding";
  return null;
}
