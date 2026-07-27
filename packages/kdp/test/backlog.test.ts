import { describe, it, expect } from "vitest";
import { backlogCount, shouldPauseGeneration } from "../src/backlog";
import type { KdpBook } from "../src/types";

function book(status: string): KdpBook {
  return { id: Math.random().toString(), niche: "n", product_type: "journal", trim_size: "6x9", page_count: 100, status, created_at: new Date().toISOString() };
}

describe("backlogCount", () => {
  it("counts only 'generated' (not-yet-downloaded) books", () => {
    const books = [book("generated"), book("generated"), book("downloaded"), book("uploaded_to_amazon"), book("live")];
    expect(backlogCount(books)).toBe(2);
  });

  it("is zero for an empty list", () => {
    expect(backlogCount([])).toBe(0);
  });
});

describe("shouldPauseGeneration", () => {
  it("does not pause when the backlog is below the cap", () => {
    const books = [book("generated"), book("generated")];
    expect(shouldPauseGeneration(books, 10)).toBe(false);
  });

  it("pauses once the backlog reaches the cap", () => {
    const books = Array.from({ length: 10 }, () => book("generated"));
    expect(shouldPauseGeneration(books, 10)).toBe(true);
  });

  it("pauses when the backlog exceeds the cap", () => {
    const books = Array.from({ length: 34 }, () => book("generated"));
    expect(shouldPauseGeneration(books, 10)).toBe(true);
  });

  it("ignores books that are already downloaded/uploaded/live when counting toward the cap", () => {
    const books = [
      ...Array.from({ length: 9 }, () => book("generated")),
      ...Array.from({ length: 20 }, () => book("downloaded")),
    ];
    expect(shouldPauseGeneration(books, 10)).toBe(false);
  });
});
