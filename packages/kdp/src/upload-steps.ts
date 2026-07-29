import type { BrowserStep } from "@atlas/browser";
import type { KdpBook } from "./types";

/** List price per product type. Flat $7.49 across all 4 current KDP product
 * types per Mat's explicit call (2026-07-29 design spec) — easy to change
 * later without touching step-building logic. */
export type PricePolicy = Record<string, number>;

export const DEFAULT_KDP_PRICE_POLICY: PricePolicy = {
  journal: 7.49,
  planner: 7.49,
  workbook: 7.49,
  coloring_book: 7.49,
};

/** Best-effort guesses at KDP's current wizard selectors and dashboard URL —
 * not confirmed against the live DOM (Known Limitation #2 in the design
 * spec). Expect one-line patches here after the first real run. */
const KDP_NEW_TITLE_URL = "https://kdp.amazon.com/en_US/title-setup/paperback/new";
const DASHBOARD_READY_SELECTOR = "[data-testid='bookshelf-create-title-button']";
export const PUBLISH_BUTTON_SELECTOR = "[data-testid='submit-for-publishing-button']";
const CATEGORY_SEARCH_INPUT_SELECTOR = "[data-testid='category-search-input']";
const CATEGORY_FIRST_RESULT_SELECTOR = "[data-testid='category-search-results'] li:first-child";

const AUTHOR_FIRST_NAME = "Matthew";
const AUTHOR_LAST_NAME = "Brittingham";

/** Builds the Details -> Content -> Rights & Pricing steps for one book, up
 * through entering the list price. Stops there — categories run separately
 * (see buildCategorySteps, best-effort per category) and the final
 * Publish-page confirmation runs separately too (see
 * buildFinalConfirmationStep), so a single missed category can't abort the
 * whole upload. */
export function buildUploadSteps(
  book: KdpBook,
  files: { interiorPath: string; coverPath: string },
  policy: PricePolicy,
): BrowserStep[] {
  if (!book.title) throw new Error("kdp upload: book has no title");
  const price = policy[book.product_type];
  if (price === undefined) throw new Error(`kdp upload: no price configured for product_type "${book.product_type}"`);

  const steps: BrowserStep[] = [
    { action: "goto", url: KDP_NEW_TITLE_URL, note: "opens KDP's paperback title-setup wizard" },
    {
      action: "waitFor",
      selector: DASHBOARD_READY_SELECTOR,
      timeoutMs: 5 * 60 * 1000,
      note: "waits up to 5 min — if this is the first run, log into KDP in this window now",
    },
    { action: "fill", selector: "#data-print-book-title", value: book.title },
  ];
  if (book.subtitle) steps.push({ action: "fill", selector: "#data-print-book-subtitle", value: book.subtitle });
  steps.push(
    { action: "fill", selector: "#data-print-book-author-firstname", value: AUTHOR_FIRST_NAME },
    { action: "fill", selector: "#data-print-book-author-lastname", value: AUTHOR_LAST_NAME },
  );
  if (book.description) steps.push({ action: "fill", selector: "#data-print-book-description", value: book.description });
  for (const [i, keyword] of (book.keywords ?? []).slice(0, 7).entries()) {
    steps.push({ action: "fill", selector: `#data-print-book-keyword-${i}`, value: keyword });
  }
  steps.push(
    { action: "click", selector: "#data-print-book-not-public-domain", note: "confirms this is not a public domain work" },
    { action: "click", selector: "[data-testid='details-save-and-continue']", note: "advances to the Content step" },
    { action: "upload", selector: "[data-testid='manuscript-upload-input']", value: files.interiorPath },
    {
      action: "waitFor",
      selector: "[data-testid='manuscript-upload-success']",
      timeoutMs: 5 * 60 * 1000,
      note: "manuscript processing can take minutes",
    },
    { action: "upload", selector: "[data-testid='cover-upload-input']", value: files.coverPath },
    { action: "waitFor", selector: "[data-testid='cover-upload-success']", timeoutMs: 5 * 60 * 1000, note: "cover processing" },
    { action: "click", selector: "[data-testid='content-save-and-continue']", note: "advances to the Rights & Pricing step" },
    { action: "click", selector: "[data-testid='territory-worldwide']", note: "worldwide distribution rights" },
    { action: "fill", selector: "[data-testid='list-price-input']", value: price.toFixed(2) },
  );
  return steps;
}

/** One category: types the AI-generated BISAC guess into KDP's search-then-
 * select category picker and clicks the first result if one appears. This
 * function never knows whether it "worked" — the caller (uploadToAmazon)
 * wraps each category's run in its own try/catch and treats a timeout as
 * skipped, not a failure of the whole upload. */
export function buildCategorySteps(category: string): BrowserStep[] {
  return [
    { action: "fill", selector: CATEGORY_SEARCH_INPUT_SELECTOR, value: category },
    { action: "waitFor", selector: CATEGORY_FIRST_RESULT_SELECTOR, timeoutMs: 5000, note: `looking for a match on "${category}"` },
    { action: "click", selector: CATEGORY_FIRST_RESULT_SELECTOR },
  ];
}

/** The last step of any run: confirms the wizard reached the final page.
 * Never clicks Publish — Mat does that himself. */
export function buildFinalConfirmationStep(): BrowserStep[] {
  return [{ action: "waitFor", selector: PUBLISH_BUTTON_SELECTOR, note: "confirms the wizard reached the final page — this never clicks it" }];
}
