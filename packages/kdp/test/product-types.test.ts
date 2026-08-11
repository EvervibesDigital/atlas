import { describe, it, expect } from "vitest";
import {
  PRODUCT_TYPES, TRIM_SIZES, validateSpec, pageDimensions, defaultSpec,
  KDP_MIN_PAGES, KDP_MAX_PAGES_BW, KDP_BLEED_INCHES,
} from "../src/product-types";

/**
 * These guard the one thing that actually costs Mat time: publishing is
 * MANUAL (no KDP API exists), so a book Amazon rejects at upload burns a whole
 * wizard run and tells him nothing until the files are already there.
 */
describe("validateSpec — catch it here, not at upload", () => {
  it("accepts every product type's own default", () => {
    // A default that fails its own validation would be a trap.
    for (const id of Object.keys(PRODUCT_TYPES)) {
      const spec = defaultSpec(id, "AI for solopreneurs")!;
      expect(validateSpec(spec), `${id} default is invalid`).toEqual([]);
    }
  });

  it("rejects a page count below Amazon's hard floor", () => {
    const spec = { productType: "short_guide", trim: "6x9", pages: 12, niche: "AI" };
    expect(validateSpec(spec).join(" ")).toMatch(new RegExp(`${KDP_MIN_PAGES}-page minimum`));
  });

  it("rejects a page count above Amazon's hard ceiling", () => {
    const spec = { productType: "short_guide", trim: "6x9", pages: 900, niche: "AI" };
    expect(validateSpec(spec).join(" ")).toMatch(new RegExp(`${KDP_MAX_PAGES_BW}-page maximum`));
  });

  it("flags a length that is legal for Amazon but wrong for the product", () => {
    // 40 pages passes Amazon and still reads as a padded blog post.
    const spec = { productType: "short_guide", trim: "6x9", pages: 40, niche: "AI" };
    const problems = validateSpec(spec);
    expect(problems.join(" ")).toMatch(/thin for a short-form guide/);
    expect(problems.join(" ")).not.toMatch(/minimum/);
  });

  it("rejects a trim that makes no sense for the product", () => {
    // A 5x8 coloring book is legal to print and nobody wants it.
    const spec = { productType: "coloring_book", trim: "5x8", pages: 50, niche: "mandalas" };
    expect(validateSpec(spec).join(" ")).toMatch(/not a sensible trim/);
  });

  it("reports every problem at once, not just the first", () => {
    // Each retry costs a manual wizard run, so one pass has to surface all.
    const spec = { productType: "coloring_book", trim: "5x8", pages: 5, niche: "" };
    expect(validateSpec(spec).length).toBeGreaterThanOrEqual(3);
  });

  it("requires a niche", () => {
    const spec = { productType: "journal", trim: "6x9", pages: 120, niche: "  " };
    expect(validateSpec(spec).join(" ")).toMatch(/niche is required/);
  });

  it("names an unknown product type instead of guessing", () => {
    expect(validateSpec({ productType: "cookbook", trim: "6x9", pages: 100, niche: "x" })).toEqual([
      'unknown product type "cookbook"',
    ]);
  });
});

describe("pageDimensions", () => {
  it("adds Amazon's bleed only where the interior runs to the edge", () => {
    // Coloring pages are full-bleed; a journal's lined pages are not.
    const colouring = pageDimensions("coloring_book", "8.5x11")!;
    expect(colouring.bleed).toBe(KDP_BLEED_INCHES);
    expect(colouring.w).toBeCloseTo(8.625, 3);
    expect(colouring.h).toBeCloseTo(11.25, 3);

    const journal = pageDimensions("journal", "6x9")!;
    expect(journal.bleed).toBe(0);
    expect(journal.w).toBe(6);
    expect(journal.h).toBe(9);
  });

  it("returns null rather than a wrong size for an unknown combination", () => {
    expect(pageDimensions("cookbook", "6x9")).toBeNull();
    expect(pageDimensions("journal", "99x99")).toBeNull();
  });
});

describe("the catalog itself", () => {
  it("covers the product lines Mat asked for", () => {
    for (const id of ["coloring_book", "journal", "short_guide"]) {
      expect(PRODUCT_TYPES[id], `missing ${id}`).toBeTruthy();
    }
  });

  it("every product type's allowed trims actually exist", () => {
    for (const [id, t] of Object.entries(PRODUCT_TYPES)) {
      expect(t.allowedTrims.includes(t.defaultTrim), `${id} default trim not in allowed list`).toBe(true);
      for (const trim of t.allowedTrims) expect(TRIM_SIZES[trim], `${id} references unknown trim ${trim}`).toBeTruthy();
    }
  });

  it("every default page count sits inside its own range and Amazon's", () => {
    for (const [id, t] of Object.entries(PRODUCT_TYPES)) {
      expect(t.defaultPages, `${id}`).toBeGreaterThanOrEqual(Math.max(t.minPages, KDP_MIN_PAGES));
      expect(t.defaultPages, `${id}`).toBeLessThanOrEqual(t.maxPages);
    }
  });
});
