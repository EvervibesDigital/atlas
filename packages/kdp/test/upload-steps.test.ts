import { describe, it, expect } from "vitest";
import { buildUploadSteps, buildCategorySteps, buildFinalConfirmationStep, DEFAULT_KDP_PRICE_POLICY, PUBLISH_BUTTON_SELECTOR } from "../src/upload-steps";
import type { KdpBook } from "../src/types";

function book(overrides: Partial<KdpBook> = {}): KdpBook {
  return {
    id: "b1",
    niche: "gratitude",
    product_type: "journal",
    trim_size: "6x9",
    page_count: 120,
    title: "Gratitude Journal",
    subtitle: "90 Days",
    description: "A daily gratitude journal.",
    keywords: ["gratitude", "journal", "mindfulness"],
    categories: ["Crafts & Hobbies > Journals"],
    status: "downloaded",
    created_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

const files = { interiorPath: "/tmp/interior.pdf", coverPath: "/tmp/cover.pdf" };

describe("buildUploadSteps", () => {
  it("fills title, subtitle, fixed author, description, and keywords", () => {
    const steps = buildUploadSteps(book(), files, DEFAULT_KDP_PRICE_POLICY);
    expect(steps).toContainEqual(expect.objectContaining({ action: "fill", selector: "#data-print-book-title", value: "Gratitude Journal" }));
    expect(steps).toContainEqual(expect.objectContaining({ action: "fill", selector: "#data-print-book-subtitle", value: "90 Days" }));
    expect(steps).toContainEqual(expect.objectContaining({ action: "fill", selector: "#data-print-book-author-firstname", value: "Matthew" }));
    expect(steps).toContainEqual(expect.objectContaining({ action: "fill", selector: "#data-print-book-author-lastname", value: "Brittingham" }));
    expect(steps).toContainEqual(expect.objectContaining({ action: "fill", selector: "#data-print-book-keyword-0", value: "gratitude" }));
  });

  it("skips the subtitle step when the book has none", () => {
    const steps = buildUploadSteps(book({ subtitle: null }), files, DEFAULT_KDP_PRICE_POLICY);
    expect(steps.some((s) => s.selector === "#data-print-book-subtitle")).toBe(false);
  });

  it("uploads the interior and cover PDFs and waits for each to finish processing", () => {
    const steps = buildUploadSteps(book(), files, DEFAULT_KDP_PRICE_POLICY);
    const interiorIndex = steps.findIndex((s) => s.action === "upload" && s.value === "/tmp/interior.pdf");
    const coverIndex = steps.findIndex((s) => s.action === "upload" && s.value === "/tmp/cover.pdf");
    expect(interiorIndex).toBeGreaterThanOrEqual(0);
    expect(coverIndex).toBeGreaterThanOrEqual(0);
    expect(steps[interiorIndex + 1]?.action).toBe("waitFor");
    expect(steps[coverIndex + 1]?.action).toBe("waitFor");
  });

  it("fills the flat $7.49 list price for the book's product type", () => {
    const steps = buildUploadSteps(book({ product_type: "planner" }), files, DEFAULT_KDP_PRICE_POLICY);
    expect(steps).toContainEqual(expect.objectContaining({ action: "fill", selector: "[data-testid='list-price-input']", value: "7.49" }));
  });

  it("throws a clear error when the price policy has no entry for the book's product type", () => {
    expect(() => buildUploadSteps(book({ product_type: "cookbook" }), files, DEFAULT_KDP_PRICE_POLICY)).toThrow(/no price configured/);
  });

  it("throws a clear error when the book has no title", () => {
    expect(() => buildUploadSteps(book({ title: null }), files, DEFAULT_KDP_PRICE_POLICY)).toThrow(/no title/);
  });

  it("never includes a click on the Publish button", () => {
    const steps = buildUploadSteps(book(), files, DEFAULT_KDP_PRICE_POLICY);
    expect(steps.some((s) => s.selector === PUBLISH_BUTTON_SELECTOR)).toBe(false);
  });
});

describe("buildCategorySteps", () => {
  it("searches the category text, then waits for and clicks the first result", () => {
    const steps = buildCategorySteps("Crafts & Hobbies > Journals");
    expect(steps[0]).toEqual(expect.objectContaining({ action: "fill", value: "Crafts & Hobbies > Journals" }));
    expect(steps[1]?.action).toBe("waitFor");
    expect(steps[2]?.action).toBe("click");
  });
});

describe("buildFinalConfirmationStep", () => {
  it("only waits for the Publish button, never clicks it", () => {
    const steps = buildFinalConfirmationStep();
    expect(steps).toEqual([expect.objectContaining({ action: "waitFor", selector: PUBLISH_BUTTON_SELECTOR })]);
  });
});
