import * as cheerio from "cheerio";
import type { ScanIssue, ScanResult } from "./types";

// The real, working "vibe check" logic from Mat's EverVibes Digital
// compliance-bot repo (server.ts's performVibeCheck) — a genuine HTML audit,
// not an AI guess. Ported directly rather than standing up the whole
// separate app: this is the one piece worth keeping from it.
export async function scanWebsite(url: string, fetcher: typeof fetch = fetch): Promise<ScanResult> {
  const issues: ScanIssue[] = [];
  let score = 100;

  const r = await fetcher(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`scan: could not fetch ${url} (HTTP ${r.status})`);
  const html = await r.text();
  const $ = cheerio.load(html);

  // Accessibility
  let missingAlt = 0;
  $("img").each((_, img) => {
    if (!$(img).attr("alt")) missingAlt++;
  });
  if (missingAlt > 0) {
    score -= Math.min(15, missingAlt * 2);
    issues.push({ category: "accessibility", issue: `${missingAlt} image(s) missing alt text` });
  }
  if ($("form").length > 0 && $("label").length === 0) {
    score -= 10;
    issues.push({ category: "accessibility", issue: "Forms missing labels" });
  }

  // Privacy
  if (!/privacy/i.test(html)) {
    score -= 20;
    issues.push({ category: "privacy", issue: "No privacy policy found" });
  }

  // Security
  if (!url.startsWith("https")) {
    score -= 25;
    issues.push({ category: "security", issue: "Site not using HTTPS" });
  }

  // SEO
  if (!$("title").text()) {
    score -= 10;
    issues.push({ category: "seo", issue: "Missing meta title" });
  }
  if (!$('meta[name="description"]').attr("content")) {
    score -= 10;
    issues.push({ category: "seo", issue: "Missing meta description" });
  }
  if ($("h1").length === 0) {
    score -= 5;
    issues.push({ category: "seo", issue: "Missing H1 tag" });
  }

  // Mobile
  if (!$('meta[name="viewport"]').attr("content")) {
    score -= 15;
    issues.push({ category: "mobile", issue: "Missing mobile viewport meta tag" });
  }

  return { url, overallScore: Math.max(0, score), issues };
}
