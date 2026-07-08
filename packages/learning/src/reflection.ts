import type { Outcome, Reflection } from "./types";

/**
 * Turn an outcome into a Reflection (the lesson). Deterministic so it works
 * offline; the lesson text can be enriched by the Brain later without changing
 * callers.
 */
export function reflect(input: { event: string; outcome: Outcome; category: string; detail?: string }): Reflection {
  const { event, outcome, category, detail } = input;
  const lesson =
    outcome === "success"
      ? `${event} worked for ${category}${detail ? ` — ${detail}` : ""}`
      : `${event} failed for ${category}${detail ? `: ${detail}` : ""}`;
  return { event, outcome, category, lesson, detail, at: new Date().toISOString() };
}
