import { describe, it, expect } from "vitest";
import { Atlas, type GuardianLike } from "@atlas/core";
import { createEnrichmentPlugin, buildPreview, buildRunMessage, type EnrichmentTarget } from "../src/plugin";
import { parseEnrichmentResults } from "../src/results";

function permissiveGuardian(): GuardianLike {
  return { grant: () => {}, check: () => ({ decision: "allow", reason: "test" }) };
}

/** Synthetic addresses matching the SHAPES measured in the real surplus sheet.
 * Real owner PII never belongs in a fixture. */
const TARGETS: EnrichmentTarget[] = [
  { id: "a", address: "1234 MAIN ST TAMPA FL 33601", firstName: "Jane", lastName: "Doe" }, // high
  { id: "b", address: "55 OAK AVE, LAKE CITY, FL 32055" }, // high
  { id: "c", address: "PO BOX 9 WEBSTER FL 33597" }, // low (no street suffix)
  { id: "d", address: "SOME NOTE WITH NO STATE OR ZIP" }, // unusable
];

describe("buildPreview", () => {
  it("classifies by parse confidence and prices only what's traceable", () => {
    const p = buildPreview(TARGETS);
    expect(p.total).toBe(4);
    expect(p.highConfidence).toBe(2);
    expect(p.lowConfidence).toBe(1);
    expect(p.unusable).toBe(1);
    expect(p.traceable).toBe(3);
    // Unusable rows must NOT be billed for.
    expect(p.estimatedCostUsd).toBeCloseTo(0.21, 2);
  });
});

describe("buildRunMessage", () => {
  it("sends parsed fields plus the id, and includes the name when known", () => {
    const msg = buildRunMessage([TARGETS[0]!]);
    expect(msg).toContain("id=a");
    expect(msg).toContain("street=1234 MAIN ST");
    expect(msg).toContain("city=TAMPA");
    expect(msg).toContain("zip=33601");
    expect(msg).toContain("name=Jane Doe");
  });
});

describe("enrichment cost gate", () => {
  /** A fetch that fails the test if it is ever called — proves no network,
   * and therefore no spend, happened. */
  const forbiddenFetch = (() => {
    throw new Error("network must not be touched without confirmCost");
  }) as unknown as typeof fetch;

  it("REFUSES to spend without an explicit confirmCost:true", async () => {
    const atlas = new Atlas({ guardian: permissiveGuardian() });
    await atlas.use(createEnrichmentPlugin({ fetcher: forbiddenFetch }));

    await expect(atlas.invoke("enrichment", { op: "enrich", targets: TARGETS })).rejects.toThrow(/confirmCost/);
  });

  it("also refuses when confirmCost is merely truthy-ish, not exactly true", async () => {
    const atlas = new Atlas({ guardian: permissiveGuardian() });
    await atlas.use(createEnrichmentPlugin({ fetcher: forbiddenFetch }));

    // A stray string/1 from a JSON body must not be enough to spend money.
    await expect(atlas.invoke("enrichment", { op: "enrich", targets: TARGETS, confirmCost: "yes" as unknown as boolean })).rejects.toThrow(/confirmCost/);
  });

  it("preview is always free and never touches the network", async () => {
    const atlas = new Atlas({ guardian: permissiveGuardian() });
    await atlas.use(createEnrichmentPlugin({ fetcher: forbiddenFetch }));

    const p = (await atlas.invoke("enrichment", { op: "preview", targets: TARGETS })) as { traceable: number };
    expect(p.traceable).toBe(3);
  });

  it("with confirmCost:true, returns early (no spend) when nothing is traceable", async () => {
    const atlas = new Atlas({ guardian: permissiveGuardian() });
    await atlas.use(createEnrichmentPlugin({ fetcher: forbiddenFetch }));

    const r = (await atlas.invoke("enrichment", {
      op: "enrich",
      targets: [{ id: "x", address: "NOT AN ADDRESS" }],
      confirmCost: true,
    })) as { results: unknown[]; note?: string };
    expect(r.results).toEqual([]);
    expect(r.note).toMatch(/nothing traceable/);
  });
});

describe("parseEnrichmentResults (provisional — contract not yet observed)", () => {
  it("pulls ids with phones/emails out of nested run events", () => {
    const events = [
      { event: { data: { results: [{ id: "a", owner_email: "jane@example.com", owner_phone: "(813) 555-0100" }] } } },
      { event: { data: { results: [{ id: "b", emails: ["bob@example.com"] }] } } },
    ];
    const out = parseEnrichmentResults(events);
    const a = out.find((r) => r.id === "a")!;
    expect(a.emails).toContain("jane@example.com");
    expect(a.phones.length).toBe(1);
    expect(a.matched).toBe(true);
    expect(out.find((r) => r.id === "b")!.emails).toContain("bob@example.com");
  });

  it("returns nothing rather than throwing when the shape is unrecognised", () => {
    expect(parseEnrichmentResults([{ event: { note: "no contacts here" } }])).toEqual([]);
    expect(parseEnrichmentResults([])).toEqual([]);
  });
});
