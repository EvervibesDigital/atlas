import { describe, it, expect } from "vitest";
import { Atlas, type Plugin } from "@atlas/core";
import { Guardian } from "@atlas/guardian";
import { createMemoryPlugin, InMemoryStore } from "@atlas/memory";
import { createBrainPlugin, StubAdapter } from "@atlas/brain";
import { stripHtml, fetchReadable, isBlockedHost, createWebPlugin, type FetchLike } from "../src/index";

const fakeFetcher =
  (html: string, ok = true, status = 200): FetchLike =>
  async () => ({ ok, status, text: async () => html });

describe("stripHtml", () => {
  it("extracts title and drops scripts/styles/tags", () => {
    const { title, text } = stripHtml("<title>Hi &amp; Bye</title><style>x{}</style><script>1</script><p>Hello <b>world</b></p>");
    expect(title).toBe("Hi & Bye");
    expect(text).toBe("Hello world");
  });
});

describe("isBlockedHost", () => {
  it("blocks loopback/private hosts, allows public", () => {
    expect(isBlockedHost("http://localhost/x")).toBe(true);
    expect(isBlockedHost("http://127.0.0.1")).toBe(true);
    expect(isBlockedHost("http://192.168.1.5")).toBe(true);
    expect(isBlockedHost("https://example.com")).toBe(false);
  });
});

describe("fetchReadable", () => {
  it("rejects non-http and private URLs", async () => {
    await expect(fetchReadable("file:///etc/passwd")).rejects.toThrow(/http/);
    await expect(fetchReadable("http://127.0.0.1")).rejects.toThrow(/private/);
  });
  it("returns readable text from a public page", async () => {
    const page = await fetchReadable("https://example.com", { fetcher: fakeFetcher("<title>T</title><p>Body text here</p>") });
    expect(page.title).toBe("T");
    expect(page.text).toContain("Body text here");
  });
});

describe("web plugin (learn)", () => {
  it("fetches, analyzes, and stores notes to memory", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createMemoryPlugin({ store: new InMemoryStore() }));
    await atlas.use(createBrainPlugin({ adapters: [new StubAdapter()] })); // offline stub brain
    await atlas.use(createWebPlugin({ fetcher: fakeFetcher("<title>Acme AI</title><p>Acme sells AI tools for creators.</p>") }));

    let result: { url: string; title: string; notes: string } | undefined;
    let recalled: unknown[] = [];
    await atlas.use({
      manifest: { name: "scout", version: "1", capabilities: [], permissions: ["call:web", "call:memory"], role: "executor" },
      async register(ctx) {
        result = (await ctx.call("web", { op: "learn", url: "https://acme.example" })) as typeof result;
        recalled = (await ctx.call("memory", { op: "search", query: "Acme AI tools" })) as unknown[];
      },
    } satisfies Plugin);

    expect(result?.title).toBe("Acme AI");
    expect(result?.notes.length).toBeGreaterThan(0);
    expect(recalled.length).toBeGreaterThan(0);
  });

  it("blocks a consumer without call:web permission", async () => {
    const atlas = new Atlas({ guardian: new Guardian() });
    await atlas.use(createWebPlugin({ fetcher: fakeFetcher("<p>x</p>") }));
    await expect(
      atlas.use({
        manifest: { name: "sneaky", version: "1", capabilities: [], permissions: [], role: "executor" },
        async register(ctx) {
          await ctx.call("web", { op: "read", url: "https://x.example" });
        },
      }),
    ).rejects.toThrow(/Guardian deny/);
  });
});
