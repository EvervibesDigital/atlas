# KDP Upload Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `uploadToAmazon` op to the `@atlas/kdp` plugin that drives Amazon KDP's paperback "Create new title" wizard end-to-end (Details → Content → Rights & Pricing) with Playwright, stopping immediately before the Publish click so Mat finishes it himself.

**Architecture:** Two new pure, unit-tested step-builder functions in `packages/kdp/src/upload-steps.ts` describe the wizard fields as a `BrowserStep[]` (reusing the existing `@atlas/browser` driver primitive — no new automation paradigm). The `uploadToAmazon` op in `packages/kdp/src/plugin.ts` downloads the book's real interior/cover PDFs (already-working `downloadZip` logic, refactored into a shared helper), unzips them to a temp dir, runs the core wizard steps, then attempts each AI-guessed category as its own small step-batch so one unmatched category can't abort the run. `packages/browser`'s `createPlaywrightDriver` gains a persistent session (`storageState`) and a `keepOpen` option so the real browser window stays open for Mat to review and finish manually — both are additive, off-by-default options that don't change the existing Actions-department usage.

**Tech Stack:** TypeScript, Vitest, `@atlas/browser` (existing), `@atlas/core` (Atlas/ConfigVault/Guardian test harness), new dependency `adm-zip` (ZIP extraction — Node has no built-in ZIP reader).

**Two deliberate refinements to the approved spec, made during planning (not scope changes — see rationale inline in each task):**
1. Categories run as separate per-category `driver.run()` calls (not embedded in one big step array), because the shared `BrowserDriver.run()` either fully succeeds or throws — there's no way to "skip one step and keep going" inside a single call. This is the only way to actually deliver the spec's "one bad category shouldn't fail the whole upload" behavior.
2. `createPlaywrightDriver` gains a `keepOpen` option so the browser does **not** auto-close after `run()` returns. The spec requires Mat to review/finish in "the same real browser window" on both success and failure — the driver's existing `finally { browser.close() }` (built for the Actions department's fire-and-forget steps) would close that window before Mat ever saw it.
3. The spec's Testing section suggested testing `storageState` via "a mocked import, same pattern `createPlaywrightDriver`'s existing tests likely already use" — but they don't: Playwright isn't installed in this repo, and the existing test only exercises the "not installed" error path. There's no precedent anywhere in this codebase for mocking a bare package specifier that isn't actually installed, and Vitest doesn't reliably support that without the module present. Task 1 instead extracts the storageState *decision* (reuse a session file vs. start fresh) into a small pure function (`resolveContextOptions`) that's fully unit-tested without touching Playwright at all — the actual `newContext`/`storageState`-save wiring stays real integration code with no unit coverage, same as every other line inside `createPlaywrightDriver`'s Playwright branch today.

**Operational note (tell Mat, don't just bury it in code):** this feature needs a real, visible browser window. ATLAS's VPS is headless — there's no display for Mat to see or finish the wizard in. This op is meant to be run wherever `ATLAS_REAL_KDP_UPLOAD=true` is set with a real display attached, i.e. Mat's own machine, not the always-on VPS. No VPS deploy step exists in this plan for that reason; Task 5 covers push + local run instructions instead.

---

### Task 1: `packages/browser` — persistent session + keep-open option

**Files:**
- Modify: `packages/browser/src/index.ts`
- Test: `packages/browser/test/browser.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/browser/test/browser.test.ts` (keep all existing content, add these at the end of the file):

```typescript
import { resolveContextOptions } from "../src/index";

describe("resolveContextOptions", () => {
  it("reuses a saved session when the file exists", () => {
    const result = resolveContextOptions("/tmp/kdp-session.json", () => true);
    expect(result).toEqual({ storageState: "/tmp/kdp-session.json" });
  });

  it("starts a fresh context when no path is configured, or the file doesn't exist yet", () => {
    expect(resolveContextOptions(undefined, () => true)).toEqual({});
    expect(resolveContextOptions("/tmp/kdp-session.json", () => false)).toEqual({});
  });
});

describe("createPlaywrightDriver with storageState/keepOpen options", () => {
  it("still fails with the install message even when storageState/keepOpen are set", async () => {
    await expect(createPlaywrightDriver({ storageState: "/tmp/x.json", keepOpen: true }).run(steps)).rejects.toThrow(
      /Playwright is not installed/,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/browser/test/browser.test.ts`
Expected: FAIL — `resolveContextOptions` is not exported from `../src/index` (import error).

- [ ] **Step 3: Add `timeoutMs` to `BrowserStep` and export `resolveContextOptions`**

In `packages/browser/src/index.ts`, replace the `BrowserStep` interface:

```typescript
export interface BrowserStep {
  action: "goto" | "click" | "fill" | "upload" | "waitFor" | "press";
  selector?: string;
  url?: string;
  value?: string;
  /** Pull the value from a named credential provided in the run context. */
  valueFromCred?: string;
  /** Override Playwright's default wait timeout (ms) for this step. Only
   * consulted by `waitFor`. Used for long, human-in-the-loop waits (e.g.
   * waiting for a manual login) where the default would time out too soon. */
  timeoutMs?: number;
  note?: string;
}
```

Add this new exported function right after the `SimulatedDriver` class (before `createPlaywrightDriver`):

```typescript
/** Pure — decides Playwright's `newContext()` options for a configured
 * storageState path. Exported so this decision is unit-testable without a
 * real browser: a session file only gets reused if it actually exists. */
export function resolveContextOptions(
  storageStatePath: string | undefined,
  exists: (path: string) => boolean,
): { storageState?: string } {
  if (storageStatePath && exists(storageStatePath)) return { storageState: storageStatePath };
  return {};
}
```

- [ ] **Step 4: Run the tests again — `resolveContextOptions` tests should pass, the `createPlaywrightDriver` options test should still pass too (options are accepted, just unused so far)**

Run: `pnpm exec vitest run packages/browser/test/browser.test.ts`
Expected: All pass (the two new `resolveContextOptions` tests, plus the new "still fails with install message" test, since `createPlaywrightDriver` already accepts an options object and ignores unknown-to-it fields until Step 5 wires them in).

- [ ] **Step 5: Wire `storageState`/`keepOpen` into `createPlaywrightDriver`**

Add this import at the top of `packages/browser/src/index.ts`:

```typescript
import { existsSync } from "node:fs";
```

Replace the entire `createPlaywrightDriver` function with:

```typescript
/** Real browser via Playwright, loaded lazily so it stays optional. */
export function createPlaywrightDriver(
  opts: { headless?: boolean; storageState?: string; keepOpen?: boolean } = {},
): BrowserDriver {
  return {
    name: "playwright",
    async run(steps: BrowserStep[], ctx: RunContext = {}): Promise<BrowserResult> {
      // Variable specifier defeats static resolution so tsc doesn't require the
      // package to be present at build time.
      const spec = "playwright";
      let chromium: { launch: (o: { headless: boolean }) => Promise<unknown> };
      try {
        ({ chromium } = (await import(spec)) as { chromium: typeof chromium });
      } catch {
        throw new Error("Playwright is not installed. Run: pnpm add playwright && npx playwright install chromium");
      }
      const browser = (await chromium.launch({ headless: opts.headless ?? false })) as {
        newContext: (o: { storageState?: string }) => Promise<Record<string, unknown>>;
        close: () => Promise<void>;
      };
      const log: string[] = [];
      try {
        const context = (await browser.newContext(resolveContextOptions(opts.storageState, existsSync))) as Record<
          string,
          (...a: unknown[]) => Promise<unknown>
        >;
        const page = (await context.newPage!()) as Record<string, (...a: unknown[]) => Promise<unknown>>;
        const saveSession = async () => {
          if (opts.storageState) await (context.storageState as (o: { path: string }) => Promise<unknown>)({ path: opts.storageState });
        };
        try {
          for (const s of steps) {
            const val = s.valueFromCred ? (ctx.secrets?.[s.valueFromCred] ?? "") : (s.value ?? "");
            if (s.action === "goto" && s.url) await page.goto!(s.url);
            else if (s.action === "click" && s.selector) await page.click!(s.selector);
            else if (s.action === "fill" && s.selector) await page.fill!(s.selector, val);
            else if (s.action === "waitFor" && s.selector) await page.waitForSelector!(s.selector, s.timeoutMs ? { timeout: s.timeoutMs } : undefined);
            else if (s.action === "press" && s.selector && s.value) await page.press!(s.selector, s.value);
            else if (s.action === "upload" && s.selector && val) await page.setInputFiles!(s.selector, val);
            log.push(`${s.action}${s.selector ? " @ " + s.selector : ""}${s.url ? " " + s.url : ""}`);
          }
          await saveSession();
          return { ok: true, stepsRun: steps.length, log };
        } catch (err) {
          await saveSession().catch(() => {});
          throw err;
        }
      } finally {
        if (!opts.keepOpen) await browser.close();
      }
    },
  };
}
```

- [ ] **Step 6: Run the full browser test file and typecheck**

Run: `pnpm exec vitest run packages/browser/test/browser.test.ts`
Expected: All 6 tests pass (3 original + 3 new).

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add packages/browser/src/index.ts packages/browser/test/browser.test.ts
git commit -m "feat(browser): add persistent session + keep-open options to the Playwright driver

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `packages/kdp/src/upload-steps.ts` — pure wizard step builders

**Files:**
- Create: `packages/kdp/src/upload-steps.ts`
- Test: `packages/kdp/test/upload-steps.test.ts`
- Modify: `packages/kdp/package.json` (add `@atlas/browser` dependency)
- Modify: `packages/kdp/src/index.ts` (export the new module)

- [ ] **Step 1: Add the `@atlas/browser` dependency**

In `packages/kdp/package.json`, change `"dependencies"` to:

```json
"dependencies": { "@atlas/core": "workspace:*", "@atlas/browser": "workspace:*" }
```

Run: `pnpm install`
Expected: Lockfile updates, no errors.

- [ ] **Step 2: Write the failing test**

Create `packages/kdp/test/upload-steps.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/kdp/test/upload-steps.test.ts`
Expected: FAIL — cannot find module `../src/upload-steps`.

- [ ] **Step 4: Implement `buildUploadSteps`, `buildCategorySteps`, `buildFinalConfirmationStep`**

Create `packages/kdp/src/upload-steps.ts`:

```typescript
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
```

- [ ] **Step 5: Run the test again to verify it passes**

Run: `pnpm exec vitest run packages/kdp/test/upload-steps.test.ts`
Expected: All 9 tests pass.

- [ ] **Step 6: Export the new module from the package index**

In `packages/kdp/src/index.ts`, add a line so the new module is part of the package's public surface, matching how `types`/`plugin`/`backlog` are already exported:

```typescript
export * from "./types";
export * from "./plugin";
export * from "./backlog";
export * from "./upload-steps";
```

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add packages/kdp/src/upload-steps.ts packages/kdp/test/upload-steps.test.ts packages/kdp/src/index.ts packages/kdp/package.json pnpm-lock.yaml
git commit -m "feat(kdp): pure step builders for the Amazon KDP upload wizard

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `uploadToAmazon` op on the kdp plugin

**Files:**
- Modify: `packages/kdp/src/plugin.ts`
- Modify: `packages/kdp/package.json` (add `adm-zip` + `@types/adm-zip`)
- Modify: `packages/kdp/test/kdp.test.ts`

- [ ] **Step 1: Add the `adm-zip` dependency**

In `packages/kdp/package.json`, change `"dependencies"` and `"devDependencies"` to:

```json
"dependencies": { "@atlas/core": "workspace:*", "@atlas/browser": "workspace:*", "adm-zip": "^0.5.10" },
"devDependencies": { "@atlas/guardian": "workspace:*", "@atlas/memory": "workspace:*", "@types/adm-zip": "^0.5.5" }
```

Run: `pnpm install`
Expected: Lockfile updates, no errors.

- [ ] **Step 2: Write the failing tests**

Add to `packages/kdp/test/kdp.test.ts` (keep all existing content — insert this near the top, right after the existing `fakeFetch` helper, and add the new `describe` block at the end of the file):

```typescript
import AdmZip from "adm-zip";
import type { BrowserDriver, BrowserStep, BrowserResult } from "@atlas/browser";
import type { KdpBook } from "../src/types";

function fakeZipBuffer(): Buffer {
  const zip = new AdmZip();
  zip.addFile("interior.pdf", Buffer.from("fake interior pdf bytes"));
  zip.addFile("cover.pdf", Buffer.from("fake cover pdf bytes"));
  return zip.toBuffer();
}

function fakeUploadFetcher(book: KdpBook, zipBuffer: Buffer): typeof fetch {
  return (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/kdp/status") {
      return { ok: true, status: 200, json: async () => ({ books: [book] }) } as Response;
    }
    if (path === "/api/kdp/pdf") {
      const ab = zipBuffer.buffer.slice(zipBuffer.byteOffset, zipBuffer.byteOffset + zipBuffer.byteLength);
      return { ok: true, status: 200, arrayBuffer: async () => ab, json: async () => ({}) } as Response;
    }
    throw new Error("no fake handler for " + path);
  }) as typeof fetch;
}

function fakeDriver(opts: { failCategories?: string[] } = {}): BrowserDriver {
  const failing = new Set(opts.failCategories ?? []);
  return {
    name: "fake",
    async run(steps: BrowserStep[]): Promise<BrowserResult> {
      const searchStep = steps.find((s) => s.action === "fill" && failing.has(s.value ?? ""));
      if (searchStep) throw new Error(`no category match for "${searchStep.value}"`);
      return { ok: true, stepsRun: steps.length, log: [] };
    },
  };
}

function testBook(overrides: Partial<KdpBook> = {}): KdpBook {
  return {
    id: "b1",
    niche: "gratitude",
    product_type: "journal",
    trim_size: "6x9",
    page_count: 120,
    title: "Gratitude Journal",
    categories: ["Crafts & Hobbies > Journals"],
    status: "downloaded",
    created_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}
```

Then add this `describe` block at the end of `packages/kdp/test/kdp.test.ts`:

```typescript
describe("kdp plugin downloadZip (regression after fetchBookAndZip refactor)", () => {
  it("fetches the book's PDFs and returns a base64 zip", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s3cret" }) });
    await atlas.use(createKdpPlugin({ fetcher: fakeUploadFetcher(testBook(), fakeZipBuffer()) }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:kdp"], role: "executor" },
      async register(ctx) {
        const r = (await ctx.call("kdp", { op: "downloadZip", id: "b1" })) as { filename: string; base64: string };
        expect(r.filename).toBe("Gratitude_Journal.zip");
        expect(Buffer.from(r.base64, "base64").length).toBeGreaterThan(0);
      },
    });
  });
});

describe("kdp plugin uploadToAmazon", () => {
  it("unzips the book's files, runs the wizard with SimulatedDriver by default, and matches every category", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s3cret" }) });
    await atlas.use(createKdpPlugin({ fetcher: fakeUploadFetcher(testBook(), fakeZipBuffer()) }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:kdp"], role: "executor" },
      async register(ctx) {
        const r = (await ctx.call("kdp", { op: "uploadToAmazon", id: "b1" })) as {
          ok: boolean;
          categoriesMatched: string[];
          categoriesSkipped: string[];
        };
        expect(r.ok).toBe(true);
        expect(r.categoriesMatched).toEqual(["Crafts & Hobbies > Journals"]);
        expect(r.categoriesSkipped).toEqual([]);
      },
    });
  });

  it("skips a category that never gets a search match, without failing the whole upload", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s3cret" }) });
    const book = testBook({ categories: ["Crafts & Hobbies > Journals", "Nonexistent Category"] });
    await atlas.use(
      createKdpPlugin({ fetcher: fakeUploadFetcher(book, fakeZipBuffer()), driver: fakeDriver({ failCategories: ["Nonexistent Category"] }) }),
    );
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:kdp"], role: "executor" },
      async register(ctx) {
        const r = (await ctx.call("kdp", { op: "uploadToAmazon", id: "b1" })) as { categoriesMatched: string[]; categoriesSkipped: string[] };
        expect(r.categoriesMatched).toEqual(["Crafts & Hobbies > Journals"]);
        expect(r.categoriesSkipped).toEqual(["Nonexistent Category"]);
      },
    });
  });

  it("throws a clear error when the downloaded zip is missing interior.pdf or cover.pdf", async () => {
    const emptyZip = new AdmZip().toBuffer();
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s3cret" }) });
    await atlas.use(createKdpPlugin({ fetcher: fakeUploadFetcher(testBook(), emptyZip) }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:kdp"], role: "executor" },
      async register(ctx) {
        await expect(ctx.call("kdp", { op: "uploadToAmazon", id: "b1" })).rejects.toThrow(/missing interior\.pdf or cover\.pdf/);
      },
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/kdp/test/kdp.test.ts`
Expected: FAIL — `kdp: unknown op "uploadToAmazon"` (and the downloadZip regression test may already pass since that op already exists — that's fine, it's there to protect the refactor in Step 4).

- [ ] **Step 4: Refactor `downloadZip` into a shared helper and implement `uploadToAmazon`**

Replace the full contents of `packages/kdp/src/plugin.ts` with:

```typescript
import type { Plugin } from "@atlas/core";
import { SimulatedDriver, type BrowserDriver } from "@atlas/browser";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import type { KdpBook, KdpBookStatus, KdpOpportunity } from "./types";
import { buildUploadSteps, buildCategorySteps, buildFinalConfirmationStep, DEFAULT_KDP_PRICE_POLICY, type PricePolicy } from "./upload-steps";

/**
 * KDP plugin (service "kdp") — bridges ATLAS to the REAL, already-built KDP
 * pipeline living in the separate `evervibes` Next.js app (trend scan → AI
 * scoring → metadata generation → PDF ZIP), plus a Playwright-driven
 * `uploadToAmazon` op that fills Amazon KDP's own book-creation wizard and
 * stops immediately before the Publish click — Mat reviews and clicks
 * Publish himself in the same browser window. `uploadToAmazon` uses
 * SimulatedDriver (safe, no real browser) unless a real `driver` is passed in
 * or `ATLAS_REAL_KDP_UPLOAD=true` is set (see packages/app/src/build.ts).
 *
 * Honest scope: Cover Engine v2 (real finished covers, currently spec-only —
 * see evervibes' docs/superpowers/specs/2026-07-13-kdp-cover-engine-design.md)
 * is NOT implemented yet; books ship with a placeholder cover template until
 * that gets built. Sales tracking (roadmap sub-project 4) is also not built.
 * Category selection during upload is best-effort (see upload-steps.ts) —
 * KDP's real category tree isn't validated against.
 */
export type KdpCommand =
  | { op: "scan" }
  | { op: "generate"; limit?: number }
  | { op: "status" }
  | { op: "markStatus"; id: string; status: KdpBookStatus; amazonUrl?: string; amazonAsin?: string }
  | { op: "downloadZip"; id: string }
  | { op: "uploadToAmazon"; id: string };

export function createKdpPlugin(opts: { fetcher?: typeof fetch; driver?: BrowserDriver; pricePolicy?: PricePolicy } = {}): Plugin {
  const f = opts.fetcher ?? fetch;
  const driver = opts.driver ?? new SimulatedDriver();
  const pricePolicy = opts.pricePolicy ?? DEFAULT_KDP_PRICE_POLICY;

  return {
    manifest: {
      name: "kdp",
      version: "0.1.0",
      capabilities: ["kdp"],
      permissions: ["secret:*", "call:memory"],
      role: "executor",
    },

    register(ctx) {
      async function base(): Promise<{ url: string; secret: string }> {
        const url = (await ctx.secret("EVERVIBES_APP_URL")) || "https://evervibesdigital.com";
        const secret = await ctx.secret("KDP_CRON_SECRET");
        if (!secret) throw new Error("kdp: no KDP_CRON_SECRET set — add it in API Keys (same value as evervibes' CRON_SECRET env var)");
        return { url, secret };
      }

      /** Shared by downloadZip and uploadToAmazon: looks up the book, then
       * fetches its upload-ready ZIP (interior.pdf + cover.pdf + extras). */
      async function fetchBookAndZip(id: string): Promise<{ book: KdpBook; zipBuffer: Buffer }> {
        const { url, secret } = await base();
        const statusR = await f(`${url}/api/kdp/status`, { headers: { Authorization: `Bearer ${secret}` } });
        const statusData = (await statusR.json().catch(() => ({}))) as { books?: KdpBook[] };
        const book = (statusData.books ?? []).find((b) => b.id === id);
        if (!book) throw new Error(`kdp: book "${id}" not found`);

        const zipR = await f(`${url}/api/kdp/pdf`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: book.title,
            subtitle: book.subtitle,
            description: book.description,
            keywords: book.keywords,
            coverHook: book.cover_hook,
            backCoverText: book.back_cover_text,
            trimSize: book.trim_size,
            pageCount: book.page_count,
            interiorType: book.interior_type,
            primaryColor: book.primary_color,
          }),
        });
        if (!zipR.ok) throw new Error(`kdp pdf HTTP ${zipR.status}`);
        const zipBuffer = Buffer.from(await zipR.arrayBuffer());
        return { book, zipBuffer };
      }

      ctx.provide("kdp", async (payload) => {
        const cmd = payload as KdpCommand;

        if (cmd.op === "scan") {
          const { url, secret } = await base();
          const r = await f(`${url}/api/cron/kdp-trends-scan`, { headers: { Authorization: `Bearer ${secret}` } });
          const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
          if (!r.ok) throw new Error(`kdp scan HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
          await ctx.emit("kdp.scanned", data);
          return data;
        }

        if (cmd.op === "generate") {
          const { url, secret } = await base();
          const r = await f(`${url}/api/cron/kdp-auto-generate`, {
            method: "POST",
            headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
            body: JSON.stringify({ limit: cmd.limit ?? 3 }),
          });
          const data = (await r.json().catch(() => ({}))) as { generated?: number; built?: Array<{ title?: string }> };
          if (!r.ok) throw new Error(`kdp generate HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
          try {
            if (data.generated) {
              await ctx.call("memory", {
                op: "remember",
                input: { kind: "task", content: `KDP generated ${data.generated} new book(s): ${(data.built ?? []).map((b) => b.title).filter(Boolean).join("; ")}`.slice(0, 1500) },
              });
            }
          } catch {
            /* memory optional */
          }
          await ctx.emit("kdp.generated", data);
          return data;
        }

        if (cmd.op === "status") {
          const { url, secret } = await base();
          const r = await f(`${url}/api/kdp/status`, { headers: { Authorization: `Bearer ${secret}` } });
          const data = (await r.json().catch(() => ({}))) as { opportunities?: KdpOpportunity[]; books?: KdpBook[] };
          if (!r.ok) throw new Error(`kdp status HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
          return { opportunities: data.opportunities ?? [], books: data.books ?? [] };
        }

        if (cmd.op === "markStatus") {
          const { url, secret } = await base();
          const r = await f(`${url}/api/kdp/book/${cmd.id}`, {
            method: "PATCH",
            headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
            body: JSON.stringify({ status: cmd.status, amazon_url: cmd.amazonUrl, amazon_asin: cmd.amazonAsin }),
          });
          const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
          if (!r.ok) throw new Error(`kdp markStatus HTTP ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
          return data;
        }

        if (cmd.op === "downloadZip") {
          const { book, zipBuffer } = await fetchBookAndZip(cmd.id);
          return { filename: `${(book.title ?? "book").replace(/[^a-z0-9]+/gi, "_")}.zip`, base64: zipBuffer.toString("base64") };
        }

        if (cmd.op === "uploadToAmazon") {
          const { book, zipBuffer } = await fetchBookAndZip(cmd.id);
          const zip = new AdmZip(zipBuffer);
          const interiorEntry = zip.getEntry("interior.pdf");
          const coverEntry = zip.getEntry("cover.pdf");
          if (!interiorEntry || !coverEntry) throw new Error(`kdp upload: zip for "${cmd.id}" is missing interior.pdf or cover.pdf`);

          const tmpDir = await mkdtemp(join(tmpdir(), "atlas-kdp-upload-"));
          try {
            const interiorPath = join(tmpDir, "interior.pdf");
            const coverPath = join(tmpDir, "cover.pdf");
            await writeFile(interiorPath, interiorEntry.getData());
            await writeFile(coverPath, coverEntry.getData());

            await driver.run(buildUploadSteps(book, { interiorPath, coverPath }, pricePolicy));

            const categoriesMatched: string[] = [];
            const categoriesSkipped: string[] = [];
            for (const category of book.categories ?? []) {
              try {
                await driver.run(buildCategorySteps(category));
                categoriesMatched.push(category);
              } catch {
                categoriesSkipped.push(category);
              }
            }

            await driver.run(buildFinalConfirmationStep());

            const result = { ok: true, bookId: cmd.id, categoriesMatched, categoriesSkipped };
            await ctx.emit("kdp.uploadedToAmazon", result);
            return result;
          } finally {
            await rm(tmpDir, { recursive: true, force: true });
          }
        }

        throw new Error(`kdp: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
```

- [ ] **Step 5: Run the tests again to verify they pass**

Run: `pnpm exec vitest run packages/kdp/test/kdp.test.ts`
Expected: All tests pass (4 original + 1 downloadZip regression + 3 uploadToAmazon).

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add packages/kdp/src/plugin.ts packages/kdp/test/kdp.test.ts packages/kdp/package.json pnpm-lock.yaml
git commit -m "feat(kdp): add uploadToAmazon op — fills the KDP wizard, stops before Publish

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Wire the driver into `buildAtlas` and the control panel

**Files:**
- Modify: `packages/app/src/build.ts`
- Modify: `packages/server/src/server.ts`

- [ ] **Step 1: Add `kdpDriver`/`kdpSessionFile` to `AtlasOptions`**

In `packages/app/src/build.ts`, find the `actionsDriver?: BrowserDriver;` line (end of the `actionsDriver` doc comment block) and add right after it:

```typescript
  /**
   * Driver for KDP's `uploadToAmazon` op (fills Amazon KDP's book wizard,
   * stops before Publish — see packages/kdp/src/upload-steps.ts and
   * docs/superpowers/specs/2026-07-29-kdp-upload-automation-design.md).
   * Defaults to SimulatedDriver. A SEPARATE flag from ATLAS_REAL_ACTIONS on
   * purpose — KDP touches a real paid publishing account, a materially
   * different blast radius from the existing simulated-by-default actions.
   * Set ATLAS_REAL_KDP_UPLOAD=true to flip on a real, always-headed
   * (headless: false) Chromium with a persistent session. This needs a real
   * display attached — run it on your own machine, not the headless VPS.
   */
  kdpDriver?: BrowserDriver;
  /** Where the KDP Playwright session (cookies) persists between runs, so
   * Mat only logs into KDP once. Default "data/kdp-session.json". */
  kdpSessionFile?: string;
```

- [ ] **Step 2: Wire it into `buildAtlas()`**

Find `await atlas.use(createKdpPlugin());` in `packages/app/src/build.ts` and replace it with:

```typescript
  await atlas.use(
    createKdpPlugin({
      driver:
        opts.kdpDriver ??
        (process.env.ATLAS_REAL_KDP_UPLOAD === "true"
          ? createPlaywrightDriver({ headless: false, storageState: opts.kdpSessionFile ?? "data/kdp-session.json", keepOpen: true })
          : undefined),
    }),
  );
```

- [ ] **Step 3: Run the app package's tests to check nothing broke**

Run: `pnpm exec vitest run packages/app`
Expected: All existing tests still pass (this change is additive — no existing caller passes `kdpDriver`, so behavior for everyone else is unchanged).

- [ ] **Step 4: Add the same options to the control panel**

In `packages/server/src/server.ts`, find `actionsDriver?: BrowserDriver;` inside `ControlPanelOptions` and add right after it:

```typescript
  /** Driver for KDP's uploadToAmazon op — see AtlasOptions.kdpDriver in packages/app/src/build.ts for the full explanation. Defaults to SimulatedDriver unless ATLAS_REAL_KDP_UPLOAD=true. */
  kdpDriver?: BrowserDriver;
  /** Where the KDP Playwright session persists (default "data/kdp-session.json"). */
  kdpSessionFile?: string;
```

Find `actionsDriver: opts.actionsDriver,` inside the `buildAtlas({...})` call and add right after it:

```typescript
      kdpDriver: opts.kdpDriver,
      kdpSessionFile: opts.kdpSessionFile,
```

- [ ] **Step 5: Run the server package's tests to check nothing broke**

Run: `pnpm exec vitest run packages/server`
Expected: All existing tests still pass.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add packages/app/src/build.ts packages/server/src/server.ts
git commit -m "feat(app,server): wire ATLAS_REAL_KDP_UPLOAD-gated driver into kdp plugin

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Full suite, push — no VPS deploy (documented reason), local real-run instructions

**Files:** none (verification + push only)

- [ ] **Step 1: Run the entire test suite**

Run: `pnpm test`
Expected: All tests pass (492 existing + the ~16 new tests added across Tasks 1–3 in this plan).

- [ ] **Step 2: Typecheck the whole repo**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 3: Push**

```bash
git push origin main
```

- [ ] **Step 4: Do NOT deploy this to the VPS**

Unlike every other feature shipped this session, this one has no `scp`/`docker restart` step. `ATLAS_REAL_KDP_UPLOAD=true` opens a real, visible (`headless: false`) Chromium window so Mat can watch the wizard fill in and click Publish himself — the VPS has no display attached, so a real run there would either fail outright or (worse) run invisibly with no way for Mat to finish it. `SimulatedDriver` (the VPS's default, unaffected by this change) is safe to leave running there as-is.

- [ ] **Step 5: Tell Mat how to run it for real, once he's ready**

On his own machine, from the `atlas` repo root:

```bash
pnpm add playwright -w
npx playwright install chromium
```

Then, in whatever shell runs ATLAS locally (`pnpm start`, `pnpm cycle`, or the control panel), set `ATLAS_REAL_KDP_UPLOAD=true` before starting it, and trigger the op with a real book id from `kdp.status`:

```bash
ATLAS_REAL_KDP_UPLOAD=true pnpm ui
```

Then call `kdp` with `{ "op": "uploadToAmazon", "id": "<book id from kdp.status>" }` from the control panel or chat. First run: log into KDP by hand in the window that opens (the driver waits up to 5 minutes for it); every run after that reuses the saved session in `data/kdp-session.json`. Expect selector mismatches on the very first real run — Known Limitation #2 in the design spec — and patch `packages/kdp/src/upload-steps.ts`'s selector constants as needed; that's expected, one-line-fix territory, not a redesign.

---
