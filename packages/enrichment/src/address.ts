/**
 * US address parsing for skip tracing.
 *
 * This exists as a first-class, tested unit because the real data demanded it.
 * Measured across the 59 owner mailing addresses in the surplus leads sheet
 * (2026-08-01): only 8 split cleanly on commas, 31 had NO commas at all, 13
 * had one, and 7 had no state/zip. Comma-splitting alone would have mangled
 * 86% of the data.
 *
 * The reliable anchor is the trailing `STATE ZIP` — present in 52 of 59 (88%).
 * Parse strips that first, then splits what's left.
 */

/** Common US street-suffix tokens, used to find the street/city boundary when
 * there are no commas to split on (the single most common real shape). */
const STREET_SUFFIXES = new Set([
  "ST", "STREET", "AVE", "AVENUE", "RD", "ROAD", "BLVD", "BOULEVARD", "DR", "DRIVE",
  "LN", "LANE", "CT", "COURT", "WAY", "PL", "PLACE", "TER", "TERRACE", "CIR", "CIRCLE",
  "HWY", "HIGHWAY", "PKWY", "PARKWAY", "TRL", "TRAIL", "LOOP", "RUN", "PATH", "PIKE",
]);

export interface ParsedAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
  /** "high" = state+zip anchored AND a street suffix found, so the street/city
   * split is trustworthy. "low" = anchored but the split is a guess (e.g. a PO
   * box with no suffix token). Low-confidence rows are still worth sending —
   * Twin's agent re-parses unstructured text itself — but `preview` reports
   * them so data quality is visible before any money is spent. */
  confidence: "high" | "low";
}

/** Trailing `STATE ZIP` (optionally ZIP+4) — the anchor everything hangs off. */
const STATE_ZIP = /\b([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/;

/**
 * Parses a raw one-line US address. Returns null when there's no trailing
 * STATE ZIP to anchor on — deliberately null rather than throwing, so one bad
 * row can never abort a whole batch.
 */
export function parseUsAddress(raw: string): ParsedAddress | null {
  const norm = (raw ?? "").toUpperCase().replace(/\s+/g, " ").trim();
  if (!norm) return null;

  const anchor = norm.match(STATE_ZIP);
  if (!anchor) return null;
  const state = anchor[1]!;
  const zip = anchor[2]!;

  // Everything before the state/zip, with any dangling comma cleaned up.
  const head = norm.slice(0, anchor.index).replace(/[,\s]+$/, "").trim();
  if (!head) return null;

  // Commas, where present, are the author's own explicit separator — trust
  // them over the suffix heuristic.
  if (head.includes(",")) {
    const parts = head.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return { street: parts[0]!, city: parts.slice(1).join(" ").trim(), state, zip, confidence: "high" };
    }
  }

  // No commas: find the LAST street-suffix token. Everything through it is the
  // street; everything after is the city (handles multi-word cities like
  // "ST PETERSBURG" without needing a city gazetteer).
  const tokens = head.split(" ").filter(Boolean);
  const suffixIdx: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (STREET_SUFFIXES.has(tokens[i]!.replace(/\./g, ""))) suffixIdx.push(i);
  }
  let suffixAt = suffixIdx.length ? suffixIdx[suffixIdx.length - 1]! : -1;

  // "ST" is ambiguous — it's both "Street" AND the "Saint" in city names like
  // ST PETERSBURG, ST LOUIS, ST CLOUD. Florida (where every current lead is)
  // has several. If the last suffix is an "ST" that still has a word after it
  // and an earlier suffix exists, that earlier one is the real street suffix
  // and this "ST" belongs to the city. Caught by test: "55 OAK AVE ST
  // PETERSBURG FL 33701" was parsing as street "55 OAK AVE ST" / city
  // "PETERSBURG".
  if (suffixAt >= 0 && tokens[suffixAt] === "ST" && suffixAt < tokens.length - 1 && suffixIdx.length > 1) {
    suffixAt = suffixIdx[suffixIdx.length - 2]!;
  }

  if (suffixAt >= 0 && suffixAt < tokens.length - 1) {
    return {
      street: tokens.slice(0, suffixAt + 1).join(" "),
      city: tokens.slice(suffixAt + 1).join(" "),
      state,
      zip,
      confidence: "high",
    };
  }

  // No usable suffix (PO boxes, rural routes). Best guess: last token is the
  // city. Flagged low so it's visible rather than silently wrong.
  if (tokens.length >= 2) {
    return {
      street: tokens.slice(0, -1).join(" "),
      city: tokens[tokens.length - 1]!,
      state,
      zip,
      confidence: "low",
    };
  }

  return { street: tokens.join(" "), city: "", state, zip, confidence: "low" };
}
