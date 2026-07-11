import { chromium, Browser, Page } from "playwright";

/**
 * Headless browser automation: navigate, scrape, click, fill forms, download.
 * Account creation + credential entry stay OWNER-GATED (never automated).
 * Single shared browser instance for efficiency; pages created/destroyed per task.
 */
export class BrowserExecutor {
  private browser: Browser | null = null;

  async start(): Promise<void> {
    if (this.browser) return;
    this.browser = await chromium.launch({ headless: true, args: ["--disable-web-resources"] });
  }

  async stop(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /** Navigate to a URL and get the rendered HTML. */
  async scrape(url: string, timeout = 30000): Promise<{ html: string; title: string; url: string }> {
    if (!this.browser) throw new Error("browser not started");
    const page = await this.browser.newPage();
    try {
      page.setDefaultTimeout(timeout);
      await page.goto(url, { waitUntil: "networkidle" });
      const html = await page.content();
      const title = await page.title();
      const finalUrl = page.url();
      return { html, title, url: finalUrl };
    } finally {
      await page.close();
    }
  }

  /** Click an element by selector. */
  async click(url: string, selector: string, timeout = 30000): Promise<{ success: boolean; newUrl: string }> {
    if (!this.browser) throw new Error("browser not started");
    const page = await this.browser.newPage();
    try {
      page.setDefaultTimeout(timeout);
      await page.goto(url, { waitUntil: "networkidle" });
      await page.click(selector);
      await page.waitForNavigation({ waitUntil: "networkidle" }).catch(() => null);
      const newUrl = page.url();
      return { success: true, newUrl };
    } finally {
      await page.close();
    }
  }

  /** Fill a form field by selector. Value MUST NOT contain passwords/secrets. */
  async fillField(url: string, selector: string, value: string, timeout = 30000): Promise<{ success: boolean }> {
    // SAFETY GATE: reject if value looks like a password or credential.
    const redFlags = ["password", "secret", "token", "key", "auth", "credential"];
    if (redFlags.some((flag) => value.toLowerCase().includes(flag))) {
      throw new Error("Credentials (passwords, tokens, keys) must be entered by the owner, not automated. Rejected for safety.");
    }

    if (!this.browser) throw new Error("browser not started");
    const page = await this.browser.newPage();
    try {
      page.setDefaultTimeout(timeout);
      await page.goto(url, { waitUntil: "networkidle" });
      await page.fill(selector, value);
      return { success: true };
    } finally {
      await page.close();
    }
  }

  /** Submit a form by clicking a submit button. Credential values are NOT accepted. */
  async submitForm(url: string, submitSelector: string, timeout = 30000): Promise<{ success: boolean; newUrl: string }> {
    if (!this.browser) throw new Error("browser not started");
    const page = await this.browser.newPage();
    try {
      page.setDefaultTimeout(timeout);
      await page.goto(url, { waitUntil: "networkidle" });
      await page.click(submitSelector);
      await page.waitForNavigation({ waitUntil: "networkidle" }).catch(() => null);
      const newUrl = page.url();
      return { success: true, newUrl };
    } finally {
      await page.close();
    }
  }

  /** Download a file from a URL. Returns the binary data. */
  async download(url: string, timeout = 30000): Promise<Buffer> {
    if (!this.browser) throw new Error("browser not started");
    const page = await this.browser.newPage();
    try {
      page.setDefaultTimeout(timeout);
      const response = await page.goto(url, { waitUntil: "networkidle" });
      if (!response) throw new Error("failed to navigate");
      const buffer = await response.body();
      return buffer || Buffer.alloc(0);
    } finally {
      await page.close();
    }
  }

  /** Extract all links from a page. */
  async getLinks(url: string, timeout = 30000): Promise<string[]> {
    if (!this.browser) throw new Error("browser not started");
    const page = await this.browser.newPage();
    try {
      page.setDefaultTimeout(timeout);
      await page.goto(url, { waitUntil: "networkidle" });
      const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("a[href]"))
          .map((a) => (a as HTMLAnchorElement).href)
          .filter((href) => href && (href.startsWith("http") || href.startsWith("/")));
      });
      return [...new Set(links)]; // dedupe
    } finally {
      await page.close();
    }
  }
}
