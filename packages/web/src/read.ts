/**
 * Web reader — safely fetch a page and extract readable text. READ-ONLY: only
 * GET, only http(s), and private/loopback hosts are blocked (basic SSRF guard).
 * This is how ATLAS learns from the open web without any ability to act on it.
 */
export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface ReadablePage {
  url: string;
  title: string;
  text: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

export function stripHtml(html: string): { title: string; text: string } {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim());
  const text = decodeEntities(
    html
      .replace(/<head[\s\S]*?<\/head>/gi, " ")
      .replace(/<title[\s\S]*?<\/title>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return { title, text };
}

/** Block loopback / private-range hosts to avoid hitting internal services. */
export function isBlockedHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return (
      h === "localhost" ||
      h === "::1" ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^169\.254\./.test(h) ||
      /^0\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    );
  } catch {
    return true;
  }
}

export async function fetchReadable(url: string, opts: { fetcher?: FetchLike; maxChars?: number } = {}): Promise<ReadablePage> {
  if (!/^https?:\/\//i.test(url)) throw new Error("only http(s) URLs are allowed");
  if (isBlockedHost(url)) throw new Error("refusing to fetch a private/loopback address");
  const fetcher = opts.fetcher ?? (globalThis.fetch as unknown as FetchLike);
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  const { title, text } = stripHtml(await res.text());
  return { url, title, text: text.slice(0, opts.maxChars ?? 8000) };
}
