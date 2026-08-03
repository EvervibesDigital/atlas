/**
 * County Registry auditing.
 *
 * The Twin scraper is driven by a Google Sheet of counties: each row carries a
 * `source url` and a `scrape status`, and the agent scrapes every Active row.
 * Rebuilding that scraper natively looked like the obvious next step until the
 * registry itself was checked, on 2026-08-02, and turned out to be unusable:
 *
 *   1. **Every value sits one column left of its header.** `state` holds
 *      "Maricopa" (a county), `source url` holds "Both", and the actual URL is
 *      under `last scraped date`. A scraper reading by header name gets
 *      garbage on every row.
 *   2. **The URLs are fabricated.** They follow a too-clean pattern —
 *      `maricopa.gov/surplus-funds`, `lacounty.gov/surplus-funds`,
 *      `sbcounty.gov/surplus`. Real county excess-proceeds pages are never
 *      that tidy. Two of the first three returned **404**.
 *
 * So no scraper can work until the registry holds real URLs. This module
 * doesn't guess at them — inventing county URLs is exactly what produced the
 * problem. It reports precisely which rows are broken and why, turning 63 rows
 * of unknown quality into a checkable list.
 */

export interface RegistryRow {
  [column: string]: string;
}

export interface RegistryIssue {
  row: number;
  county: string;
  problem: string;
}

/** A URL good enough to try fetching. */
export function looksLikeUrl(value: string): boolean {
  return /^https?:\/\/[^\s]+\.[^\s]{2,}/i.test((value ?? "").trim());
}

/**
 * Detect the column shift.
 *
 * Rather than trusting header names, this checks whether the value that IS a
 * URL sits under a header that mentions "url". When it doesn't, the sheet is
 * misaligned and reading by header name is unsafe.
 *
 * Returns the offset (0 = aligned, 1 = values are one column left of their
 * header) or null when no URL was found to calibrate against.
 */
export function detectColumnShift(row: RegistryRow): number | null {
  const keys = Object.keys(row);
  const urlKeyIndex = keys.findIndex((k) => looksLikeUrl(row[k] ?? ""));
  if (urlKeyIndex < 0) return null;
  const headerSaysUrl = keys.findIndex((k) => /url|link|source/i.test(k));
  if (headerSaysUrl < 0) return null;
  return urlKeyIndex - headerSaysUrl;
}

/**
 * Pull the URL out of a row regardless of misalignment.
 *
 * Deliberately positional rather than by header: the header names are exactly
 * what cannot be trusted here.
 */
export function extractUrl(row: RegistryRow): string | null {
  for (const v of Object.values(row)) {
    if (looksLikeUrl(v ?? "")) return v.trim();
  }
  return null;
}

/** The county's own label, taken from the first non-empty cell. */
export function extractCounty(row: RegistryRow): string {
  for (const v of Object.values(row)) {
    const t = (v ?? "").trim();
    if (t && !looksLikeUrl(t)) return t;
  }
  return "(unnamed)";
}

export interface RegistryAudit {
  totalRows: number;
  misaligned: boolean;
  shift: number | null;
  withUrl: number;
  withoutUrl: number;
  issues: RegistryIssue[];
  urls: Array<{ row: number; county: string; url: string }>;
}

/** Structural audit — no network. Fetch-checking is a separate, slower step. */
export function auditRegistry(rows: RegistryRow[]): RegistryAudit {
  const issues: RegistryIssue[] = [];
  const urls: Array<{ row: number; county: string; url: string }> = [];
  let shift: number | null = null;

  rows.forEach((row, i) => {
    const county = extractCounty(row);
    const url = extractUrl(row);
    if (shift === null) shift = detectColumnShift(row);
    if (!url) {
      issues.push({ row: i + 1, county, problem: "no URL in any column" });
    } else {
      urls.push({ row: i + 1, county, url });
    }
  });

  return {
    totalRows: rows.length,
    misaligned: shift !== null && shift !== 0,
    shift,
    withUrl: urls.length,
    withoutUrl: rows.length - urls.length,
    issues,
    urls,
  };
}

export type FetchLike = typeof fetch;

export interface UrlCheck {
  county: string;
  url: string;
  status: number | null;
  alive: boolean;
  note?: string;
}

/**
 * Fetch-check every registry URL.
 *
 * GET rather than HEAD: county sites frequently refuse HEAD with a 405 while
 * serving the page fine, and a false "dead" here would send Mat hunting for a
 * page that works.
 */
export async function checkUrls(
  urls: Array<{ county: string; url: string }>,
  fetcher: FetchLike = fetch,
  timeoutMs = 15000,
): Promise<UrlCheck[]> {
  const out: UrlCheck[] = [];
  for (const { county, url } of urls) {
    try {
      const r = await fetcher(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      out.push({ county, url, status: r.status, alive: r.status >= 200 && r.status < 400 });
    } catch (err) {
      out.push({ county, url, status: null, alive: false, note: (err as Error).message.slice(0, 120) });
    }
  }
  return out;
}
