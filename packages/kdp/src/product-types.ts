/**
 * KDP product types, with the printing specs Amazon actually enforces.
 *
 * The bottleneck in this business is not generation — 30 books are already
 * built. It is that publishing is manual (no KDP API exists), so every book
 * costs Mat a wizard run. A book that gets REJECTED at upload costs him that
 * time twice and teaches him nothing, because KDP's errors arrive after the
 * files are uploaded.
 *
 * So these specs exist to make an invalid book impossible to queue: page
 * counts inside Amazon's real limits, trim sizes Amazon actually prints, and
 * bleed handled correctly per interior type.
 *
 * ⚠️ Amazon changes these. They are DATA, in one file, so a change is one edit
 * and the tests say what moved — rather than being scattered through
 * generation code where a stale limit fails silently at upload.
 * Verified against KDP's published paperback specs, 2026-08.
 */

export type InteriorType = "bw_white" | "bw_cream" | "color_standard" | "color_premium";

export interface TrimSize {
  /** Inches, width x height. */
  w: number;
  h: number;
  label: string;
}

/** The trim sizes worth using — Amazon prints many more, but these cover
 * every product type below and all are available in every marketplace. */
export const TRIM_SIZES: Record<string, TrimSize> = {
  "5x8": { w: 5, h: 8, label: '5" x 8"' },
  "5.5x8.5": { w: 5.5, h: 8.5, label: '5.5" x 8.5"' },
  "6x9": { w: 6, h: 9, label: '6" x 9"' },
  "7x10": { w: 7, h: 10, label: '7" x 10"' },
  "8x10": { w: 8, h: 10, label: '8" x 10"' },
  "8.5x11": { w: 8.5, h: 11, label: '8.5" x 11"' },
};

export interface ProductType {
  id: string;
  label: string;
  /** What the buyer is actually purchasing — drives cover and description copy. */
  premise: string;
  defaultTrim: keyof typeof TRIM_SIZES;
  allowedTrims: Array<keyof typeof TRIM_SIZES>;
  minPages: number;
  maxPages: number;
  /** A sensible starting length, inside the range. */
  defaultPages: number;
  interior: InteriorType;
  /** Full-bleed art runs to the page edge and needs Amazon's 0.125" bleed. */
  fullBleed: boolean;
  /** Whether the interior is mostly blank/repeating (low-content) or written. */
  lowContent: boolean;
}

/**
 * Amazon's hard paperback limits, applied to every type below.
 * A book outside these is rejected at upload, not at review.
 */
export const KDP_MIN_PAGES = 24;
export const KDP_MAX_PAGES_BW = 828;
export const KDP_MAX_PAGES_COLOR = 600;
/** Amazon's required bleed allowance on each outer edge, in inches. */
export const KDP_BLEED_INCHES = 0.125;

export const PRODUCT_TYPES: Record<string, ProductType> = {
  coloring_book: {
    id: "coloring_book",
    label: "Coloring book",
    premise: "Line art to colour in. Sells on theme and page count, not on words.",
    defaultTrim: "8.5x11",
    allowedTrims: ["8.5x11", "8x10"],
    // Under ~30 pages reads as thin for the price; over ~120 the spine and
    // print cost stop making sense at typical coloring-book pricing.
    minPages: 30,
    maxPages: 120,
    defaultPages: 50,
    interior: "bw_white",
    fullBleed: true,
    lowContent: true,
  },
  journal: {
    id: "journal",
    label: "Guided journal",
    premise: "Prompts plus space to write. The prompts are the product.",
    defaultTrim: "6x9",
    allowedTrims: ["6x9", "5.5x8.5", "5x8"],
    minPages: 100,
    maxPages: 200,
    defaultPages: 120,
    interior: "bw_cream",
    fullBleed: false,
    lowContent: true,
  },
  notebook: {
    id: "notebook",
    label: "Notebook",
    premise: "Lined or dotted pages. Competes almost entirely on cover.",
    defaultTrim: "6x9",
    allowedTrims: ["6x9", "5.5x8.5", "8.5x11"],
    minPages: 100,
    maxPages: 200,
    defaultPages: 120,
    interior: "bw_cream",
    fullBleed: false,
    lowContent: true,
  },
  planner: {
    id: "planner",
    label: "Planner",
    premise: "Dated or undated structure a buyer works inside for months.",
    defaultTrim: "8.5x11",
    allowedTrims: ["8.5x11", "7x10", "6x9"],
    minPages: 120,
    maxPages: 250,
    defaultPages: 150,
    interior: "bw_white",
    fullBleed: false,
    lowContent: true,
  },
  short_guide: {
    id: "short_guide",
    label: "Short-form guide",
    premise: "A tight, useful book on one specific problem. Read in an hour.",
    defaultTrim: "6x9",
    allowedTrims: ["6x9", "5x8", "5.5x8.5"],
    // Under 60 pages reads as a padded blog post; over 150 stops being "short".
    minPages: 60,
    maxPages: 150,
    defaultPages: 90,
    interior: "bw_cream",
    fullBleed: false,
    lowContent: false,
  },
  workbook: {
    id: "workbook",
    label: "Workbook",
    premise: "Exercises the reader completes. Teaching plus space to do it.",
    defaultTrim: "8.5x11",
    allowedTrims: ["8.5x11", "7x10"],
    minPages: 60,
    maxPages: 200,
    defaultPages: 100,
    interior: "bw_white",
    fullBleed: false,
    lowContent: false,
  },
};

export interface BookSpec {
  productType: string;
  trim: string;
  pages: number;
  niche: string;
}

/**
 * Everything Amazon would reject, reported at once.
 *
 * Returns every problem rather than the first, so a bad spec is fixed in one
 * pass instead of one rejection at a time — which matters when each retry
 * costs a manual wizard run.
 */
export function validateSpec(spec: BookSpec): string[] {
  const problems: string[] = [];
  const type = PRODUCT_TYPES[spec.productType];
  if (!type) return [`unknown product type "${spec.productType}"`];

  if (!TRIM_SIZES[spec.trim]) {
    problems.push(`unknown trim size "${spec.trim}"`);
  } else if (!type.allowedTrims.includes(spec.trim as keyof typeof TRIM_SIZES)) {
    problems.push(`${TRIM_SIZES[spec.trim]!.label} is not a sensible trim for a ${type.label.toLowerCase()} — use ${type.allowedTrims.map((t) => TRIM_SIZES[t]!.label).join(" or ")}`);
  }

  if (!Number.isInteger(spec.pages)) {
    problems.push(`page count must be a whole number, got ${spec.pages}`);
  } else {
    // Amazon's floor beats the product type's, and is a hard rejection.
    if (spec.pages < KDP_MIN_PAGES) problems.push(`${spec.pages} pages is below Amazon's ${KDP_MIN_PAGES}-page minimum`);
    const amazonMax = type.interior.startsWith("color") ? KDP_MAX_PAGES_COLOR : KDP_MAX_PAGES_BW;
    if (spec.pages > amazonMax) problems.push(`${spec.pages} pages is over Amazon's ${amazonMax}-page maximum for this interior`);
    if (spec.pages >= KDP_MIN_PAGES && spec.pages < type.minPages) {
      problems.push(`${spec.pages} pages is thin for a ${type.label.toLowerCase()} (aim for ${type.minPages}-${type.maxPages})`);
    }
    if (spec.pages <= amazonMax && spec.pages > type.maxPages) {
      problems.push(`${spec.pages} pages is long for a ${type.label.toLowerCase()} (aim for ${type.minPages}-${type.maxPages})`);
    }
  }

  if (!spec.niche?.trim()) problems.push("niche is required — an untargeted book competes with everything");

  return problems;
}

/** The interior page size to generate at, including bleed where the type needs it. */
export function pageDimensions(productType: string, trim: string): { w: number; h: number; bleed: number } | null {
  const type = PRODUCT_TYPES[productType];
  const size = TRIM_SIZES[trim];
  if (!type || !size) return null;
  const bleed = type.fullBleed ? KDP_BLEED_INCHES : 0;
  // Bleed is added to the outer edges: full width gain, and top+bottom.
  return { w: size.w + bleed, h: size.h + bleed * 2, bleed };
}

/** A valid starting spec for a product type — never needs validating. */
export function defaultSpec(productType: string, niche: string): BookSpec | null {
  const type = PRODUCT_TYPES[productType];
  if (!type) return null;
  return { productType, trim: type.defaultTrim, pages: type.defaultPages, niche };
}
