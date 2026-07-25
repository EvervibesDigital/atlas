import { describe, it, expect } from "vitest";
import { scanWebsite } from "../src/scanner";

function fakeFetch(html: string, url = "https://example.com"): typeof fetch {
  return (async () => ({ ok: true, status: 200, text: async () => html }) as unknown as Response) as typeof fetch;
}

describe("scanWebsite", () => {
  it("scores a clean, compliant page near 100", async () => {
    const html = `<html><head><title>Acme</title><meta name="description" content="A shop"><meta name="viewport" content="width=device-width"></head>
      <body><h1>Welcome</h1><img src="x.png" alt="a widget"><p>See our privacy policy.</p></body></html>`;
    const result = await scanWebsite("https://example.com", fakeFetch(html));
    expect(result.overallScore).toBe(100);
    expect(result.issues).toHaveLength(0);
  });

  it("flags missing alt text, missing privacy policy, missing viewport, and non-HTTPS", async () => {
    const html = `<html><head><title>Acme</title></head><body><h1>Hi</h1><img src="x.png"><img src="y.png"></body></html>`;
    const result = await scanWebsite("http://example.com", fakeFetch(html));
    expect(result.overallScore).toBeLessThan(100);
    const categories = result.issues.map((i) => i.category);
    expect(categories).toContain("accessibility");
    expect(categories).toContain("privacy");
    expect(categories).toContain("security");
    expect(categories).toContain("mobile");
  });

  it("flags missing title, meta description, and H1", async () => {
    const html = `<html><head></head><body><p>No structure here.</p></body></html>`;
    const result = await scanWebsite("https://example.com", fakeFetch(html));
    const seoIssues = result.issues.filter((i) => i.category === "seo").map((i) => i.issue);
    expect(seoIssues.some((s) => /title/i.test(s))).toBe(true);
    expect(seoIssues.some((s) => /description/i.test(s))).toBe(true);
    expect(seoIssues.some((s) => /h1/i.test(s))).toBe(true);
  });

  it("throws a clear error when the site can't be fetched", async () => {
    const f = (async () => ({ ok: false, status: 404 }) as unknown as Response) as typeof fetch;
    await expect(scanWebsite("https://dead-site.example", f)).rejects.toThrow(/404/);
  });

  it("never scores below 0", async () => {
    const html = `<html><head></head><body>${"<img src='x.png'>".repeat(30)}</body></html>`;
    const result = await scanWebsite("http://example.com", fakeFetch(html));
    expect(result.overallScore).toBeGreaterThanOrEqual(0);
  });
});
