/**
 * Strategy Council — a multi-perspective debate. Each council member evaluates
 * a proposed decision from its own lens and votes, raising concerns. ATLAS then
 * synthesizes a verdict: consensus, the collected risks, and a recommendation.
 *
 * The member logic is deterministic (keyword-driven) so it runs offline and is
 * fully testable; the Brain can enrich each member's rationale later.
 */
export type Perspective = "engineering" | "security" | "marketing" | "finance" | "operations" | "legal" | "customer";

export interface CouncilOpinion {
  perspective: Perspective;
  vote: "for" | "against" | "neutral";
  concern?: string;
}

export interface CouncilVerdict {
  decision: string;
  consensus: "for" | "against" | "split";
  opinions: CouncilOpinion[];
  risks: string[];
  recommendation: string;
}

interface Member {
  perspective: Perspective;
  evaluate(decision: string): CouncilOpinion;
}

function rule(perspective: Perspective, againstRe: RegExp, concern: string, forRe?: RegExp): Member {
  return {
    perspective,
    evaluate(decision) {
      if (againstRe.test(decision)) return { perspective, vote: "against", concern };
      if (forRe && forRe.test(decision)) return { perspective, vote: "for" };
      return { perspective, vote: "neutral" };
    },
  };
}

const COUNCIL: Member[] = [
  rule("finance", /\b(spend|buy|pay|cost|budget|\$|invest)\b/i, "spends money", /\b(revenue|profit|save|free)\b/i),
  rule("security", /\b(delete|credential|password|api key|expose|public|scrape)\b/i, "security/privacy risk", /\b(audit|encrypt|approval)\b/i),
  rule("engineering", /\b(rewrite|refactor everything|rush|hack|overnight)\b/i, "maintainability risk", /\b(test|modular|incremental)\b/i),
  rule("marketing", /\b(spam|misleading|fake)\b/i, "brand risk", /\b(post|content|audience|brand|launch|grow|reel)\b/i),
  rule("operations", /\b(manual|one-off|untracked)\b/i, "operational drag", /\b(automate|schedule|workflow|pipeline)\b/i),
  rule("legal", /\b(scrape|copyright|guarantee|medical|personal data|gdpr|terms|impersonat)\b/i, "legal/compliance risk"),
  rule("customer", /\b(spam|pushy|manipulat|dark pattern|misleading)\b/i, "hurts customer trust", /\b(help|value|save|easier|support|free)\b/i),
];

export function convene(decision: string): CouncilVerdict {
  const opinions = COUNCIL.map((m) => m.evaluate(decision));
  const forVotes = opinions.filter((o) => o.vote === "for").length;
  const againstVotes = opinions.filter((o) => o.vote === "against").length;
  const consensus: CouncilVerdict["consensus"] = forVotes > againstVotes ? "for" : againstVotes > forVotes ? "against" : "split";
  const risks = opinions.filter((o) => o.concern).map((o) => `${o.perspective}: ${o.concern}`);

  const recommendation =
    consensus === "for"
      ? "Proceed."
      : consensus === "against"
        ? "Hold — the concerns outweigh the upside."
        : risks.length
          ? `Proceed only with mitigations for: ${risks.join("; ")}.`
          : "Proceed with caution.";

  return { decision, consensus, opinions, risks, recommendation };
}
