import type { GigSource } from "./types";

/** Fallback templates used if the brain call for a tailored pitch fails or is unavailable. */
export function renderFallbackBid(source: GigSource, title: string, budget?: number): string {
  const budgetStr = budget ? `$${budget}` : "your budget";
  if (source === "fiverr") {
    return `Hi! I'm an AI automation specialist. I can help you with "${title}". I'll deliver within 3-5 business days. Rate: ${budgetStr} as posted. Let's get started!`;
  }
  if (source === "guru") {
    return `I have extensive experience relevant to "${title}". I'm confident I can complete this efficiently and to spec. My rate: ${budgetStr}. Available to start immediately.`;
  }
  return `Interested in your "${title}" project. I specialize in automation and can deliver on time. Budget: ${budgetStr}. Let's discuss further.`;
}

/**
 * Quality gate on a model-written bid, applied BEFORE it is stored.
 *
 * A real production bid read, in full: `"Delivery Estimate):* Depending on
 * your clients'"` — a mid-sentence fragment carrying template artifacts. It
 * was stored and shown as if it were a real pitch. Since the exact model
 * failure isn't reproducible on demand, this validates the OUTPUT rather than
 * trying to predict the failure: anything that doesn't look like a genuine
 * pitch falls back to the deterministic template, which is always coherent.
 *
 * Being slightly over-strict is the right trade here — a false rejection
 * costs a generic-but-correct template bid, while a false acceptance sends a
 * broken fragment to a real prospective client under Mat's name.
 */
export function isUsableBid(text: string): boolean {
  const t = (text ?? "").trim();
  // 3-5 sentences can't fit in under ~80 chars; the broken one was 47.
  if (t.length < 80) return false;
  // Must begin a sentence, not land mid-thought or on punctuation.
  if (!/^["'A-Z]/.test(t)) return false;
  // Markdown or leaked template scaffolding ("**", "[...]", "Estimate):").
  if (/[*_#[\]]/.test(t) || /\)\s*:/.test(t)) return false;
  // Truncated mid-sentence (a common maxTokens cutoff) — real pitches end.
  if (!/[.!?]["')]?$/.test(t)) return false;
  return true;
}

export function bidSystemPrompt(source: GigSource): string {
  const tone =
    source === "fiverr"
      ? "casual, gig-style, friendly"
      : source === "guru"
        ? "professional, freelancer-style"
        : "direct and minimal";
  return `You write short freelance bid pitches for Mat, an AI-automation freelancer. Tone: ${tone}. 3-5 sentences max. Mention what you'd build/deliver, the tools/approach (Python, APIs, automation scripts, AI), and a realistic delivery estimate (3-5 business days unless the posting says otherwise). Never invent credentials, portfolio links, or prices beyond what's given. Output ONLY the pitch text, no preamble.`;
}
