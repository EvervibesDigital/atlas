import { describe, it, expect } from "vitest";
import { Atlas, ConfigVault } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { createKdpPlugin } from "../src/plugin";
import AdmZip from "adm-zip";
import type { BrowserDriver, BrowserStep, BrowserResult } from "@atlas/browser";
import type { KdpBook } from "../src/types";

function fakeFetch(handlers: Record<string, (init?: RequestInit) => unknown>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const handler = handlers[path];
    if (!handler) throw new Error(`no fake handler for ${path}`);
    const body = handler(init);
    return { ok: true, status: 200, json: async () => body, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer } as Response;
  }) as typeof fetch;
}

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

describe("kdp plugin", () => {
  it("scan calls the trends-scan endpoint with the bearer secret", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s3cret" }) });
    let sawAuth = "";
    const f = fakeFetch({
      "/api/cron/kdp-trends-scan": (init) => {
        sawAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
        return { ok: true, scanned: 12, inserted: 3 };
      },
    });
    await atlas.use(createKdpPlugin({ fetcher: f }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:kdp"], role: "executor" },
      async register(ctx) {
        const r = (await ctx.call("kdp", { op: "scan" })) as { inserted: number };
        expect(r.inserted).toBe(3);
      },
    });
    expect(sawAuth).toBe("Bearer s3cret");
  });

  it("generate posts a limit and files a memory note about what was built", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s3cret" }) });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    const f = fakeFetch({
      "/api/cron/kdp-auto-generate": () => ({ ok: true, generated: 2, built: [{ title: "Gratitude Journal" }, { title: "2027 Planner" }] }),
    });
    await atlas.use(createKdpPlugin({ fetcher: f }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:kdp", "call:memory"], role: "executor" },
      async register(ctx) {
        const r = (await ctx.call("kdp", { op: "generate", limit: 2 })) as { generated: number };
        expect(r.generated).toBe(2);
        const found = (await ctx.call("memory", { op: "search", query: "Gratitude Journal", options: { limit: 5 } })) as unknown[];
        expect(found.length).toBeGreaterThan(0);
      },
    });
  });

  it("throws a clear error when KDP_CRON_SECRET is missing", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({}) });
    await atlas.use(createKdpPlugin({ fetcher: fakeFetch({}) }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:kdp"], role: "executor" },
      async register(ctx) {
        await expect(ctx.call("kdp", { op: "scan" })).rejects.toThrow(/KDP_CRON_SECRET/);
      },
    });
  });

  it("status returns opportunities and books from the bridge", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s3cret" }) });
    const f = fakeFetch({
      "/api/kdp/status": () => ({ ok: true, opportunities: [{ id: "o1" }], books: [{ id: "b1", title: "Test Book" }] }),
    });
    await atlas.use(createKdpPlugin({ fetcher: f }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:kdp"], role: "executor" },
      async register(ctx) {
        const r = (await ctx.call("kdp", { op: "status" })) as { opportunities: unknown[]; books: unknown[] };
        expect(r.opportunities.length).toBe(1);
        expect(r.books.length).toBe(1);
      },
    });
  });
});

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
          driver: string;
          stepsRun: number;
          filled: { title: string; price: number };
          categoriesMatched: string[];
          categoriesSkipped: Array<{ category: string; reason: string }>;
          log: string[];
        };
        expect(r.ok).toBe(true);
        expect(r.driver).toBe("simulated");
        expect(r.stepsRun).toBeGreaterThan(0);
        expect(r.filled).toEqual({ title: "Gratitude Journal", price: 7.49 });
        expect(r.categoriesMatched).toEqual(["Crafts & Hobbies > Journals"]);
        expect(r.categoriesSkipped).toEqual([]);
        expect(r.log.length).toBeGreaterThan(0);
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
        const r = (await ctx.call("kdp", { op: "uploadToAmazon", id: "b1" })) as {
          categoriesMatched: string[];
          categoriesSkipped: Array<{ category: string; reason: string }>;
        };
        expect(r.categoriesMatched).toEqual(["Crafts & Hobbies > Journals"]);
        expect(r.categoriesSkipped).toEqual([{ category: "Nonexistent Category", reason: expect.stringContaining("no category match") }]);
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

  it("propagates the original error when the core wizard steps fail (not swallowed by cleanup)", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s3cret" }) });
    const failingDriver: BrowserDriver = { name: "failing", async run() { throw new Error("wizard blew up"); } };
    await atlas.use(createKdpPlugin({ fetcher: fakeUploadFetcher(testBook(), fakeZipBuffer()), driver: failingDriver }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:kdp"], role: "executor" },
      async register(ctx) {
        await expect(ctx.call("kdp", { op: "uploadToAmazon", id: "b1" })).rejects.toThrow(/wizard blew up/);
      },
    });
  });

  it("rejects a second uploadToAmazon call while the first is still in flight", async () => {
    const atlas = new Atlas({ guardian: new Guardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s3cret" }) });
    let releaseFirstCall: () => void = () => {};
    // Sync on the driver actually being reached (not a fixed setTimeout) —
    // fetchBookAndZip + real mkdtemp/writeFile before driver.run() can take
    // longer than a short timer on a loaded machine, which would let the
    // "release" fire before driver.run ever reassigns it and hang the test.
    let driverStarted: () => void = () => {};
    const driverStartedPromise = new Promise<void>((resolve) => { driverStarted = resolve; });
    // uploadToAmazon calls driver.run() multiple times (core steps, each
    // category, final confirmation) — only block on the FIRST call so
    // releasing it once lets the whole upload finish instead of hanging on
    // the second driver.run() invocation.
    let driverCalls = 0;
    const slowDriver: BrowserDriver = {
      name: "slow",
      async run(steps) {
        driverCalls++;
        if (driverCalls === 1) {
          driverStarted();
          await new Promise<void>((resolve) => { releaseFirstCall = resolve; });
        }
        return { ok: true, stepsRun: steps.length, log: [] };
      },
    };
    await atlas.use(createKdpPlugin({ fetcher: fakeUploadFetcher(testBook(), fakeZipBuffer()), driver: slowDriver }));
    await atlas.use({
      manifest: { name: "caller", version: "1", capabilities: [], permissions: ["call:kdp"], role: "executor" },
      async register(ctx) {
        const firstCall = ctx.call("kdp", { op: "uploadToAmazon", id: "b1" });
        await driverStartedPromise; // first call has reached driver.run — uploadInFlight is guaranteed set by now
        await expect(ctx.call("kdp", { op: "uploadToAmazon", id: "b1" })).rejects.toThrow(/already in progress/);
        releaseFirstCall();
        await firstCall; // let the first call finish cleanly so the test doesn't leave a dangling promise
      },
    });
  });
});
