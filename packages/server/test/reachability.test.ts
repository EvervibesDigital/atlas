import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractProvidedOps,
  extractCallSites,
  extractSecretReaders,
  auditReachability,
  loadSourceFiles,
  opKey,
  type SourceFile,
} from "../src/reachability";
import { KEY_SPECS } from "../src/server";

/**
 * The guard against ATLAS's most expensive recurring bug: code that works and
 * that nothing calls. See packages/server/src/reachability.ts for why this is a
 * text scan rather than a type-graph walk.
 *
 * The unit tests below run on hand-written snippets so the extractor's own
 * behaviour is pinned. The repo audit at the bottom is the part that actually
 * fails CI.
 */

const f = (pkg: string, src: string): SourceFile => ({ pkg, path: `${pkg}/src/plugin.ts`, src });

describe("extractProvidedOps", () => {
  it("finds ops dispatched by op === comparison", () => {
    const ops = extractProvidedOps([
      f("cfo", `ctx.provide("cfo", async (payload) => {
        if (cmd.op === "forecast") return forecast(cmd.inputs);
        if (cmd.op === "roi") return roi(cmd.cost);
      });`),
    ]);
    expect(ops.map((o) => opKey(o.service, o.op)).sort()).toEqual(["cfo.forecast", "cfo.roi"]);
  });

  it("attributes ops to the RIGHT service when one file provides several", () => {
    // advisors/src/index.ts provides more than one service. Attributing every
    // op to whichever provide() came first would report phantom ops on one
    // service and hide real ones on the other.
    const ops = extractProvidedOps([
      f("advisors", `ctx.provide("legacy", async () => { if (cmd.op === "advise") return 1; });
                     ctx.provide("archaeologist", async () => { if (cmd.op === "dig") return 2; });`),
    ]);
    expect(ops.map((o) => opKey(o.service, o.op)).sort()).toEqual(["archaeologist.dig", "legacy.advise"]);
  });

  it("also finds switch-case dispatch", () => {
    const ops = extractProvidedOps([f("x", `ctx.provide("x", () => { switch (cmd.op) { case "alpha": break; } });`)]);
    expect(ops.map((o) => o.op)).toEqual(["alpha"]);
  });
});

describe("extractCallSites", () => {
  it("reads a literal op out of a multi-line payload", () => {
    // Real route bodies span many lines. A short scan window would silently
    // drop the op and manufacture a false 'unreachable' report.
    const sites = extractCallSites([
      f("server", `await a.invoke("mediaFactory", {
          op: "produce",
          creatorId: String(bodyData.creatorId),
          title: String(bodyData.title),
        });`),
    ]);
    expect(sites).toEqual([expect.objectContaining({ service: "mediaFactory", op: "produce" })]);
  });

  it("expands a union assertion into every op it allows", () => {
    // Modelled on the real approvals route, which picks the op from the URL:
    //   invoke("approvals", { op: decision[2] as "approve" | "reject", ... })
    const sites = extractCallSites([
      f("server", `await a.invoke("approvals", { op: decision[2] as "approve" | "reject", id: theId });`),
    ]);
    expect(sites.map((s) => s.op).sort()).toEqual(["approve", "reject"]);
  });

  it("reads the chat-intent table, which never calls invoke at that spot", () => {
    const sites = extractCallSites([
      f("server", `return { kind: "leadscan", service: "leadscan", payload: { op: "list", status: "new" } };`),
    ]);
    expect(sites).toContainEqual(expect.objectContaining({ service: "leadscan", op: "list" }));
  });

  it("reports a call site with no readable op as unresolved", () => {
    const sites = extractCallSites([f("web", `await ctx.call("summarizer", buildPayload(input));`)]);
    expect(sites).toEqual([expect.objectContaining({ service: "summarizer", op: null })]);
  });
});

describe("auditReachability", () => {
  it("does NOT count a plugin calling its own op as reachable", () => {
    // The question is whether anything OUTSIDE can trigger the op. A plugin
    // calling itself is an internal detail — this is exactly how `planWork`
    // looked reachable while being unreachable in practice.
    const result = auditReachability([
      f("gigfinder", `ctx.provide("gigfinder", () => { if (cmd.op === "planWork") return 1; });
                      await ctx.call("gigfinder", { op: "planWork" });`),
    ]);
    expect(result.unreachable.map((u) => opKey(u.service, u.op))).toEqual(["gigfinder.planWork"]);
  });

  it("counts a call from any other package as reachable", () => {
    const result = auditReachability([
      f("gigfinder", `ctx.provide("gigfinder", () => { if (cmd.op === "planWork") return 1; });`),
      f("server", `await a.invoke("gigfinder", { op: "planWork" });`),
    ]);
    expect(result.unreachable).toEqual([]);
  });

  it("ignores missing ops on services that take none", () => {
    // `brain` takes { prompt, system } — it has no ops, so a call without one
    // is correct. Reporting those would bury the real signal under ~20 hits.
    const result = auditReachability([
      f("brain", `ctx.provide("brain", async (req) => generate(req));`),
      f("web", `await ctx.call("brain", { prompt, system: "analyst" });`),
    ]);
    expect(result.unresolvedSites).toEqual([]);
  });
});

// ── The audit that actually guards the repo ────────────────────────────────

const PACKAGES_ROOT = join(__dirname, "..", "..");
const allowlist = JSON.parse(
  readFileSync(join(__dirname, "reachability-allowlist.json"), "utf8"),
) as {
  intentional: Record<string, string>;
  backlog: { ops: string[] };
};

describe("ATLAS repo reachability", () => {
  const result = auditReachability(loadSourceFiles(PACKAGES_ROOT));
  const unreachable = new Set(result.unreachable.map((u) => opKey(u.service, u.op)));
  const intentional = Object.keys(allowlist.intentional).filter((k) => !k.startsWith("_"));
  const backlog = allowlist.backlog.ops;

  it("audits a plausible number of ops (guards against the scan silently breaking)", () => {
    // If a refactor changed how plugins declare ops, extraction could quietly
    // return nothing and every assertion below would pass vacuously.
    expect(result.provided.length).toBeGreaterThan(100);
  });

  it("has no unreachable op that is neither justified nor in the frozen backlog", () => {
    const known = new Set([...intentional, ...backlog]);
    const newlyUnreachable = [...unreachable].filter((k) => !known.has(k)).sort();
    expect(newlyUnreachable, [
      "",
      "These ops are defined but nothing outside their own package calls them.",
      "Nobody — no route, no cycle, no other plugin — can trigger this code.",
      "",
      "Fix by wiring one of:",
      "  • an HTTP route in packages/server/src/server.ts",
      "  • a step in the orchestrator cycle",
      "  • a call from another plugin",
      "",
      "If it is genuinely meant to have no external caller, add it to",
      "packages/server/test/reachability-allowlist.json under 'intentional'",
      "WITH A REASON.",
      "",
    ].join("\n")).toEqual([]);
  });

  it("ratchets: a backlog op that got wired up must be removed from the backlog", () => {
    // Without this the list would keep stale entries forever and slowly stop
    // meaning anything — and a later regression back to unreachable would be
    // silently permitted by its own leftover entry.
    const fixed = backlog.filter((k) => !unreachable.has(k)).sort();
    expect(fixed, `\nThese are reachable now — delete them from the 'backlog' list:\n  ${fixed.join("\n  ")}\n`).toEqual([]);
  });

  it("requires a real reason for every intentional entry", () => {
    const unjustified = intentional.filter((k) => (allowlist.intentional[k] ?? "").trim().length < 20);
    expect(unjustified, "\nIntentional entries need an actual explanation, not a placeholder.\n").toEqual([]);
  });

  it("has no call site on an op-taking service where the op can't be read", () => {
    const bad = result.unresolvedSites.map((s) => `${s.pkg} -> ${s.service} :: ${s.snippet}`);
    expect(bad, "\nDynamic dispatch the audit cannot follow — it would hide unreachable ops.\n").toEqual([]);
  });
});

describe("API keys ATLAS asks for", () => {
  const readers = extractSecretReaders(loadSourceFiles(PACKAGES_ROOT));

  it("credits a key resolved through a lookup table", () => {
    // connectors maps a connector name to a token name, then calls
    // secret(TOKEN_NAME[name]). A literal-only scan reports VERCEL_TOKEN as
    // dead, which is wrong and would push a real key off the UI.
    const found = extractSecretReaders([
      f("connectors", `const TOKEN_NAME = { vercel: "VERCEL_TOKEN" };
                       const tok = await ctx.secret(TOKEN_NAME[name]);`),
    ]);
    expect(found.get("VERCEL_TOKEN")).toEqual(["connectors"]);
  });

  it("does not credit key-shaped constants in files with no dynamic secret call", () => {
    const found = extractSecretReaders([f("x", `const LABEL = "SOME_CONSTANT"; const k = await ctx.secret("REAL_KEY");`)]);
    expect(found.has("SOME_CONSTANT")).toBe(false);
    expect(found.has("REAL_KEY")).toBe(true);
  });

  it("finds both vault and env readers", () => {
    // Sanity check on the extractor itself — a broken scan here would make
    // every key look dead and the assertion below would be noise.
    expect(readers.get("GEMINI_API_KEY") ?? []).toContain("brain");
    expect(readers.get("DATABASE_URL") ?? []).toContain("media-factory");
  });

  it("is only for keys something actually reads, or that say why not", () => {
    // The key-detector list is a request directed at Mat: paste this and ATLAS
    // can do more. When nothing reads the key that request is a lie, and it
    // costs him a signup, a card, and a support thread to discover it.
    const undeclared = KEY_SPECS.filter((k) => !readers.has(k.name) && !k.unusedReason).map((k) => k.name);
    expect(undeclared, [
      "",
      "These keys are detected and stored, but no ctx.secret()/process.env",
      "reader consumes them — so pasting one changes nothing.",
      "",
      "Either wire a reader, or set `unusedReason` on the KEY_SPECS entry",
      "explaining why the detector exists anyway.",
      "",
    ].join("\n")).toEqual([]);
  });

  it("ratchets: a key that got wired up must drop its unusedReason", () => {
    const nowUsed = KEY_SPECS.filter((k) => k.unusedReason && readers.has(k.name)).map((k) => k.name);
    expect(nowUsed, `\nSomething reads these now — remove unusedReason:\n  ${nowUsed.join("\n  ")}\n`).toEqual([]);
  });
});
