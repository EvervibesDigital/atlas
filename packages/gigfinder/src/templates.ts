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

export function bidSystemPrompt(source: GigSource): string {
  const tone =
    source === "fiverr"
      ? "casual, gig-style, friendly"
      : source === "guru"
        ? "professional, freelancer-style"
        : "direct and minimal";
  return `You write short freelance bid pitches for Mat, an AI-automation freelancer. Tone: ${tone}. 3-5 sentences max. Mention what you'd build/deliver, the tools/approach (Python, APIs, automation scripts, AI), and a realistic delivery estimate (3-5 business days unless the posting says otherwise). Never invent credentials, portfolio links, or prices beyond what's given. Output ONLY the pitch text, no preamble.`;
}
