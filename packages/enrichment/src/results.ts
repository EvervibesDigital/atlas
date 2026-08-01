import type { TwinRunEvent } from "./twin-client";

export interface EnrichmentResult {
  /** Echoes the target id we sent, so callers can match results back to rows. */
  id: string;
  phones: string[];
  emails: string[];
  matched: boolean;
}

/**
 * ⚠️ WRITTEN AGAINST AN UNOBSERVED CONTRACT — READ BEFORE TRUSTING.
 *
 * Twin's Batch Skip Tracer has NEVER been run (verified 2026-08-01: its only
 * run record is the instruction build, not an execution). So the exact shape
 * of its run events is unknown. This function is deliberately isolated and
 * separately tested precisely so that, once billing is enabled and real
 * output is seen, there is exactly ONE small function to correct — rather
 * than a wrong assumption smeared across the codebase.
 *
 * It is written defensively against the agent's DOCUMENTED behaviour (it
 * reports matched phones/emails per property), and it deep-walks the nested
 * `event` payloads because Twin nests agent output several levels down.
 *
 * If results come back empty in production, suspect THIS FUNCTION FIRST —
 * not the tracing itself.
 */
export function parseEnrichmentResults(events: TwinRunEvent[]): EnrichmentResult[] {
  const byId = new Map<string, EnrichmentResult>();

  const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
  const PHONE_RE = /\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;

  /** Recursively walk any nested structure looking for objects that carry an
   * id alongside contact fields. */
  const walk = (node: unknown): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (typeof node !== "object") return;

    const o = node as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : typeof o.target_id === "string" ? o.target_id : typeof o.property_id === "string" ? o.property_id : undefined;

    if (id) {
      const emails = new Set<string>();
      const phones = new Set<string>();
      for (const key of ["email", "emails", "owner_email", "phone", "phones", "owner_phone"]) {
        const v = o[key];
        if (typeof v === "string") {
          for (const m of v.match(EMAIL_RE) ?? []) emails.add(m);
          for (const m of v.match(PHONE_RE) ?? []) phones.add(m.trim());
        } else if (Array.isArray(v)) {
          for (const item of v) {
            if (typeof item !== "string") continue;
            for (const m of item.match(EMAIL_RE) ?? []) emails.add(m);
            for (const m of item.match(PHONE_RE) ?? []) phones.add(m.trim());
          }
        }
      }
      if (emails.size || phones.size) {
        const prev = byId.get(id) ?? { id, phones: [], emails: [], matched: false };
        byId.set(id, {
          id,
          emails: [...new Set([...prev.emails, ...emails])],
          phones: [...new Set([...prev.phones, ...phones])],
          matched: true,
        });
      }
    }

    for (const v of Object.values(o)) walk(v);
  };

  walk(events);
  return [...byId.values()];
}
