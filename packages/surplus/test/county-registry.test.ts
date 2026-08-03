import { describe, it, expect } from "vitest";
import {
  looksLikeUrl, detectColumnShift, extractUrl, extractCounty, auditRegistry, checkUrls,
  type RegistryRow, type FetchLike,
} from "../src/county-registry";

/**
 * VERBATIM from the live County Registry sheet on 2026-08-02. Note what is
 * wrong with it: every value sits one column LEFT of its header. `state` holds
 * a county name, `source url` holds "Both", and the actual URL is filed under
 * `last scraped date`. A scraper reading by header name gets garbage.
 */
const REAL_ROW: RegistryRow = {
  "county name": "az-maricopa",
  state: "Maricopa",
  "surplus type": "AZ",
  "source url": "Both",
  "last scraped date": "https://www.maricopa.gov/surplus-funds",
  "scrape status": "2026-03-04",
  "page format": "Broken",
  notes: "Table",
};

describe("looksLikeUrl", () => {
  it("accepts a real http(s) url and rejects the words sitting in the url column", () => {
    expect(looksLikeUrl("https://www.maricopa.gov/surplus-funds")).toBe(true);
    expect(looksLikeUrl("Both")).toBe(false);
    expect(looksLikeUrl("Excess Proceeds / Tax Lien")).toBe(false);
    expect(looksLikeUrl("")).toBe(false);
  });
});

describe("detectColumnShift", () => {
  it("detects the one-column shift in the real sheet", () => {
    // "source url" is index 3; the URL actually lives at index 4.
    expect(detectColumnShift(REAL_ROW)).toBe(1);
  });

  it("reports 0 for a correctly aligned row", () => {
    expect(detectColumnShift({ county: "AZ-Maricopa", "source url": "https://example.gov/x", status: "Active" })).toBe(0);
  });

  it("returns null rather than guessing when there is no URL to calibrate on", () => {
    expect(detectColumnShift({ county: "X", "source url": "Pending", status: "" })).toBeNull();
  });
});

describe("extractUrl / extractCounty", () => {
  it("finds the URL positionally, ignoring the untrustworthy headers", () => {
    expect(extractUrl(REAL_ROW)).toBe("https://www.maricopa.gov/surplus-funds");
  });

  it("returns null when a row genuinely has no URL", () => {
    expect(extractUrl({ a: "Pending", b: "", c: "Table" })).toBeNull();
  });

  it("names the county from its first real cell", () => {
    expect(extractCounty(REAL_ROW)).toBe("az-maricopa");
  });
});

describe("auditRegistry", () => {
  it("flags the sheet as misaligned and separates rows with and without URLs", () => {
    const rows = [REAL_ROW, { "county name": "AZ-Maricopa", state: "Maricopa", "source url": "Excess Proceeds / Tax Lien", "page format": "Pending" }];
    const a = auditRegistry(rows);
    expect(a.totalRows).toBe(2);
    expect(a.misaligned).toBe(true);
    expect(a.shift).toBe(1);
    expect(a.withUrl).toBe(1);
    expect(a.withoutUrl).toBe(1);
    expect(a.issues[0]!.problem).toMatch(/no URL/);
  });
});

describe("checkUrls", () => {
  it("marks a 404 dead and a 200 alive — the real result for these counties", async () => {
    // Measured live: maricopa.gov/surplus-funds and lacounty.gov/surplus-funds
    // both 404. The URLs in this sheet were invented.
    const fetcher = (async (url: string) => ({
      status: String(url).includes("maricopa") ? 404 : 200,
    }) as Response) as unknown as FetchLike;

    const out = await checkUrls(
      [
        { county: "az-maricopa", url: "https://www.maricopa.gov/surplus-funds" },
        { county: "ca-sb", url: "https://www.sbcounty.gov/surplus" },
      ],
      fetcher,
    );
    expect(out[0]).toMatchObject({ status: 404, alive: false });
    expect(out[1]).toMatchObject({ status: 200, alive: true });
  });

  it("records a network failure as dead with the reason, not a crash", async () => {
    const fetcher = (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as unknown as FetchLike;
    const out = await checkUrls([{ county: "x", url: "https://nope.invalid/a" }], fetcher);
    expect(out[0]!.alive).toBe(false);
    expect(out[0]!.note).toMatch(/ENOTFOUND/);
  });
});
