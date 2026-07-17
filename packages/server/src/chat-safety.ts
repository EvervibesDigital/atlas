/**
 * Chat safety guard — catches the LLM claiming to have taken a real-world
 * action it never actually took.
 *
 * Root cause of the 2026-07-16 incident: normal chat replies are PURE TEXT
 * GENERATION with no tool execution behind them (only messages that match
 * routeChatIntent() ever call a real capability). A weak/local model, when
 * pushed hard enough by the user, confabulated an entire fake success story
 * — registered accounts, verified emails, submitted bids, bypassed
 * CAPTCHAs — none of which ATLAS's code can do or ever did. The old system
 * prompt made this worse: it taught the model that "[saved:NAME]" means
 * "a secret was stored", and the model then invented ITS OWN [saved:X]
 * reference to make the fabrication look legitimate.
 *
 * Prompting alone already failed once, so this is a MECHANICAL check that
 * doesn't depend on the model cooperating. It runs only on the free-text
 * fallback path (never on routeChatIntent results, which come from real
 * ctx.call()s and are legitimate).
 */

const FABRICATION_PATTERNS: RegExp[] = [
  /\bi(?:'ve| have)?\s+(?:successfully\s+)?(?:registered|signed you up|signed up|created (?:your|an|the) account|created your profile|set up your (?:profile|account|store|storefront))\b/i,
  /\b(?:your\s+)?(?:profile|account|storefront|gig|store)\s+(?:is|was|are)\s+(?:now\s+)?(?:live|active|published|verified)\b/i,
  /\bi(?:'ve| have)?\s+(?:submitted|sent|posted)\s+(?:the|your|a)\s+(?:bid|proposal|application|pitch|email)\b/i,
  /\bi(?:'ve| have)?\s+(?:verified|confirmed)\s+(?:the|your)\s+(?:account|email|registration)\b/i,
  /\bi(?:'ve| have)?\s+(?:bypass(?:ed)?|solved|completed)\s+(?:the\s+)?captcha\b/i,
  /\bi(?:'m| am)\s+(?:now\s+)?(?:logged in|logging in|navigating to|accessing your inbox|monitoring (?:your|the) inbox)\b/i,
  /\[saved:[a-z0-9_]+\]/i, // only the real detectSecrets() pipeline is allowed to produce this — see storedBanner
];

export interface FabricationCheck {
  flagged: boolean;
  matchedPatterns: string[];
}

export function checkFabricatedActionClaim(text: string): FabricationCheck {
  const matched: string[] = [];
  for (const re of FABRICATION_PATTERNS) {
    const m = text.match(re);
    if (m) matched.push(m[0]);
  }
  return { flagged: matched.length > 0, matchedPatterns: matched };
}

export const FABRICATION_CORRECTION = (originalReply: string): string =>
  "⚠️ I started to say something I can't actually back up, so I'm stopping myself here instead of sending it.\n\n" +
  "**The honest fact:** in this chat, I can only draft text and queue things for your approval — I have no working " +
  "connection that creates accounts, submits bids, sends emails, or verifies anything on any website. If I ever say " +
  "otherwise, it's wrong. Tell me what you actually want drafted or queued, or say \"run today's cycle\" / \"check " +
  "approvals\" for things I can really do.\n\n" +
  "(For reference, here's the reply I almost sent, which you should NOT treat as something that happened:)\n" +
  `> ${originalReply.slice(0, 300).replace(/\n/g, "\n> ")}${originalReply.length > 300 ? "…" : ""}`;
