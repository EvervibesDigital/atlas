/**
 * Evaluation Layer core — pure, deterministic scoring so it works offline and
 * is trivially testable. Judges text; never edits or blocks it (callers decide
 * what to do with a low score, same division of labor as chat-safety.ts).
 */

export interface EvaluationInput {
  /** Free-text label for logging/audit, e.g. "gigfinder.bid-draft". */
  task?: string;
  text: string;
  /** Source notes/memory hits the text is supposed to be grounded in, if any. */
  context?: string[];
}

export interface EvaluationResult {
  /** 0..1 — how much a caller should trust this text at face value. */
  confidence: number;
  /** True when there's no source context to check, or the text overlaps it enough. */
  grounded: boolean;
  issues: string[];
}

/**
 * Claims a plugin output should never make about ITSELF having done something
 * in the real world unless a real tool call actually happened. Broader reuse
 * of the pattern family chat-safety.ts introduced for the /api/chat endpoint —
 * here so ANY plugin (gigfinder, kdp, business, …) can run the same check on
 * brain-generated text before treating it as fact.
 */
const OVERCLAIM_PATTERNS: RegExp[] = [
  /\b(guaranteed|100% certain|never fails|always works|zero risk|risk-free)\b/i,
  /\bi(?:'ve| have)?\s+(?:successfully\s+)?(?:registered|signed you up|signed up|created (?:your|an|the) account|verified (?:the|your)?\s*(?:account|email|registration))\b/i,
  /\b(?:your\s+)?(?:profile|account|storefront|gig|store)\s+(?:is|was|are)\s+(?:now\s+)?(?:live|active|published|verified)\b/i,
  /\bi(?:'ve| have)?\s+(?:bypass(?:ed)?|solved)\s+(?:the\s+)?captcha\b/i,
  /\bi(?:'ve| have)?\s+(?:submitted|sent|posted)\s+(?:the|your|a)\s+(?:bid|proposal|application|payment)\b/i,
];

const WORD = /\b[a-z]{4,}\b/g;

/**
 * Fraction of the text's significant words (4+ letters) that also appear
 * somewhere in the provided context. Crude word-overlap, not embeddings — kept
 * deterministic and dependency-free, matching this codebase's existing
 * heuristic style (see packages/knowledge/src/synth.ts).
 */
function groundednessRatio(text: string, context: string[]): number {
  const textWords = text.toLowerCase().match(WORD) ?? [];
  if (textWords.length === 0) return 1;
  if (context.length === 0) return 1;
  const contextWords = new Set(context.join(" ").toLowerCase().match(WORD) ?? []);
  const overlap = textWords.filter((w) => contextWords.has(w)).length;
  return overlap / textWords.length;
}

const GROUNDEDNESS_FLOOR = 0.15;

export function evaluate(input: EvaluationInput): EvaluationResult {
  const issues: string[] = [];
  let confidence = 1;

  for (const re of OVERCLAIM_PATTERNS) {
    const m = input.text.match(re);
    if (m) {
      issues.push(`unverifiable claim: "${m[0]}"`);
      confidence -= 0.35;
    }
  }

  const context = input.context ?? [];
  const ratio = groundednessRatio(input.text, context);
  const grounded = context.length === 0 || ratio >= GROUNDEDNESS_FLOOR;
  if (context.length > 0 && !grounded) {
    issues.push(`low overlap (${Math.round(ratio * 100)}%) with the ${context.length} provided source note(s)`);
    confidence -= 0.25;
  }

  confidence = Math.max(0, Math.min(1, confidence));
  return { confidence, grounded, issues };
}
