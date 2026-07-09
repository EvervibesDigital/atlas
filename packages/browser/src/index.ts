/**
 * Browser driver — how ATLAS drives a website like a human (login, fill forms,
 * upload, click). Two drivers implement one interface:
 *   - SimulatedDriver (default, SAFE): logs exactly what it WOULD do, runs no
 *     real browser, touches nothing. This is how the action pipeline is proven
 *     end-to-end without risk.
 *   - PlaywrightDriver (real): lazily loads Playwright so it's not a hard
 *     dependency. Enable with: pnpm add playwright && npx playwright install chromium
 *
 * Credential values are pulled by reference from the run context so real
 * passwords never sit inside a step definition or a log line.
 */
export interface BrowserStep {
  action: "goto" | "click" | "fill" | "upload" | "waitFor" | "press";
  selector?: string;
  url?: string;
  value?: string;
  /** Pull the value from a named credential provided in the run context. */
  valueFromCred?: string;
  note?: string;
}

export interface RunContext {
  /** Resolved credential values, e.g. { "instagram.password": "..." }. */
  secrets?: Record<string, string>;
}

export interface BrowserResult {
  ok: boolean;
  stepsRun: number;
  log: string[];
}

export interface BrowserDriver {
  name: string;
  run(steps: BrowserStep[], ctx?: RunContext): Promise<BrowserResult>;
}

/** Safe default — records what it would do, never opens a browser. */
export class SimulatedDriver implements BrowserDriver {
  name = "simulated";
  async run(steps: BrowserStep[], ctx: RunContext = {}): Promise<BrowserResult> {
    const log: string[] = [];
    for (const s of steps) {
      const val = s.valueFromCred ? (ctx.secrets?.[s.valueFromCred] ? "•••(from vault)" : "(missing credential)") : (s.value ?? "");
      log.push(
        `${s.action}` +
          (s.url ? ` ${s.url}` : "") +
          (s.selector ? ` @ ${s.selector}` : "") +
          (val ? ` = ${val}` : "") +
          (s.note ? ` — ${s.note}` : ""),
      );
    }
    return { ok: true, stepsRun: steps.length, log };
  }
}

/** Real browser via Playwright, loaded lazily so it stays optional. */
export function createPlaywrightDriver(opts: { headless?: boolean } = {}): BrowserDriver {
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
        newPage: () => Promise<Record<string, (...a: unknown[]) => Promise<unknown>>>;
        close: () => Promise<void>;
      };
      const log: string[] = [];
      try {
        const page = await browser.newPage();
        for (const s of steps) {
          const val = s.valueFromCred ? (ctx.secrets?.[s.valueFromCred] ?? "") : (s.value ?? "");
          if (s.action === "goto" && s.url) await page.goto!(s.url);
          else if (s.action === "click" && s.selector) await page.click!(s.selector);
          else if (s.action === "fill" && s.selector) await page.fill!(s.selector, val);
          else if (s.action === "waitFor" && s.selector) await page.waitForSelector!(s.selector);
          else if (s.action === "press" && s.selector && s.value) await page.press!(s.selector, s.value);
          else if (s.action === "upload" && s.selector && val) await page.setInputFiles!(s.selector, val);
          log.push(`${s.action}${s.selector ? " @ " + s.selector : ""}${s.url ? " " + s.url : ""}`);
        }
        return { ok: true, stepsRun: steps.length, log };
      } finally {
        await browser.close();
      }
    },
  };
}
