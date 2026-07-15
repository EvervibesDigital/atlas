import type { PublishInput, PublishResult } from "./types";
import { INSTAGRAM_REELS_RECIPE, validateForInstagram } from "./instagram";

/** A thing that can (eventually) post a Reel. */
export interface Publisher {
  publish(input: PublishInput): Promise<PublishResult>;
}

/**
 * DryRunPublisher — the SAFE DEFAULT. It validates the Reel and returns the
 * exact browser recipe it *would* run, but posts nothing. This is how ATLAS
 * stays "ready to post" without ever posting until Mat swaps in a live
 * publisher. Flipping to real posting is a one-line change at the composition
 * root — nothing else in the pipeline changes.
 */
export class DryRunPublisher implements Publisher {
  async publish(input: PublishInput): Promise<PublishResult> {
    const check = validateForInstagram(input);
    if (!check.ok) return { status: "rejected", detail: check.problems.join("; ") };
    if (!input.videoRef) return { status: "pending-render", detail: "no rendered MP4 yet" };
    return {
      status: "dry-run",
      detail: `validated; WOULD post Reel for ${input.personaHandle} (not posted)`,
      recipe: INSTAGRAM_REELS_RECIPE,
    };
  }
}

export interface LivePublisherOptions {
  getInstagramCreds: () => Promise<{ username?: string; password?: string; notes?: string } | null>;
}

export class LiveBrowserPublisher implements Publisher {
  constructor(private opts: LivePublisherOptions) {}

  async publish(input: PublishInput): Promise<PublishResult> {
    const check = validateForInstagram(input);
    if (!check.ok) return { status: "rejected", detail: check.problems.join("; ") };
    if (!input.videoRef) return { status: "pending-render", detail: "no rendered MP4 yet" };

    const creds = await this.opts.getInstagramCreds();
    if (!creds || !creds.username || !creds.password) {
      return { status: "rejected", detail: "no Instagram credentials saved in vault" };
    }

    let browser;
    try {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      
      console.log(`[LiveBrowserPublisher] Logging in to Instagram as ${creds.username}...`);
      await page.goto("https://www.instagram.com/");
      
      // Look for username field, fill it
      await page.waitForSelector("input[name='username']", { timeout: 15000 });
      await page.fill("input[name='username']", creds.username);
      await page.fill("input[name='password']", creds.password);
      
      // Click Log in
      await page.click("button[type='submit']");
      
      // Check for success indicator
      await page.waitForSelector("svg[aria-label='New post']", { timeout: 30000 });
      
      console.log("[LiveBrowserPublisher] Login successful. Initiating Reel creation...");
      
      // Click "New post"
      await page.click("svg[aria-label='New post']");
      
      // Wait for file chooser or file input.
      await page.waitForSelector("input[type='file']", { timeout: 10000 });
      const fileInput = await page.$("input[type='file']");
      if (!fileInput) throw new Error("Could not find file input element");
      
      console.log(`[LiveBrowserPublisher] Uploading file: ${input.videoRef}`);
      await fileInput.setInputFiles(input.videoRef);
      
      // Wait for next button
      await page.waitForSelector("div[role='dialog'] button:has-text('Next')", { timeout: 30000 });
      await page.click("div[role='dialog'] button:has-text('Next')");
      
      // Instagram shows cover page crop dialog. Click Next again.
      await page.waitForSelector("div[role='dialog'] button:has-text('Next')", { timeout: 15000 });
      await page.click("div[role='dialog'] button:has-text('Next')");
      
      // Caption field
      await page.waitForSelector("textarea[aria-label='Write a caption...']", { timeout: 15000 });
      await page.fill("textarea[aria-label='Write a caption...']", input.caption);
      
      // Share button
      console.log("[LiveBrowserPublisher] Clicking Share...");
      await page.click("div[role='dialog'] button:has-text('Share')");
      
      // Wait for share to complete
      await page.waitForSelector("text=shared, text=Your reel has been shared, text=Shared", { timeout: 60000 });
      
      console.log("[LiveBrowserPublisher] Reel posted successfully!");
      return {
        status: "posted",
        detail: `successfully published Reel to Instagram for ${input.personaHandle}`,
      };
    } catch (err) {
      console.error("[LiveBrowserPublisher] Error during automation:", err);
      return {
        status: "rejected", // Fallback to rejected/failed
        detail: `Instagram browser automation failed: ${(err as Error).message}`,
      };
    } finally {
      if (browser) await browser.close();
    }
  }
}
