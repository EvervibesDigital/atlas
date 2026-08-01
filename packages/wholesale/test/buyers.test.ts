import { describe, it, expect } from "vitest";
import { Atlas, ConfigVault, type GuardianLike } from "@atlas/core";
import { parseCsv, toBuyerRows, buyerStats } from "../src/buyers";
import { createWholesalePlugin } from "../src/plugin";

function permissiveGuardian(): GuardianLike {
  return { grant: () => {}, check: () => ({ decision: "allow", reason: "test" }) };
}

/** Header matches the real /api/wholesale/buyers/export CSV (verified live
 * 2026-08-01). Rows are synthetic — never real buyer PII. */
const CSV = [
  "Name,Company,Email,Phone,Mailing Address,States,Strategy,Min Price,Max Price,Cities,Properties Owned,Source",
  'Alice Adams,Acme LLC,alice@example.com,8135550100,"12 Oak St, Tampa, FL 33601",FL,buy-hold,50000,200000,Tampa,3,roster',
  "Bob Brown,,,,,FL,flip,,,,,craigslist_buyer",
  '"Carter, Dana & Co",Carter LLC,,8135550111,,GA,wholesale,,,,,roster',
].join("\n");

describe("parseCsv", () => {
  it("keeps quoted fields containing commas intact", () => {
    // A naive split(",") shifts every later column and silently corrupts the
    // fill-rate counts this module exists to report.
    const rows = parseCsv(CSV);
    expect(rows).toHaveLength(4);
    expect(rows[1]![4]).toBe("12 Oak St, Tampa, FL 33601");
    expect(rows[3]![0]).toBe("Carter, Dana & Co");
  });

  it("handles escaped double-quotes", () => {
    expect(parseCsv('a,"say ""hi""",c')[0]).toEqual(["a", 'say "hi"', "c"]);
  });
});

describe("toBuyerRows + buyerStats", () => {
  it("reads columns by header name, not position", () => {
    const rows = toBuyerRows(CSV);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.email).toBe("alice@example.com");
    expect(rows[0]!.mailingAddress).toBe("12 Oak St, Tampa, FL 33601");
    expect(rows[2]!.name).toBe("Carter, Dana & Co");
  });

  it("reports what each downstream action can actually reach", () => {
    const s = buyerStats(toBuyerRows(CSV));
    expect(s.total).toBe(3);
    // send-intro needs an email; find-and-trace-top needs a mailing address.
    expect(s.emailable).toBe(1);
    expect(s.traceable).toBe(1);
    expect(s.withPhone).toBe(2);
    expect(s.bySource.roster).toBe(2);
  });
});

describe("wholesale spend/send gates", () => {
  const forbiddenFetch = (() => {
    throw new Error("network must not be touched without confirmation");
  }) as unknown as typeof fetch;

  it("REFUSES to send intro emails without confirmSend:true", async () => {
    const atlas = new Atlas({ guardian: permissiveGuardian() });
    await atlas.use(createWholesalePlugin({ fetcher: forbiddenFetch }));
    await expect(atlas.invoke("wholesale", { op: "sendIntros" })).rejects.toThrow(/confirmSend/);
  });

  it("refuses when confirmSend is truthy-ish rather than exactly true", async () => {
    const atlas = new Atlas({ guardian: permissiveGuardian() });
    await atlas.use(createWholesalePlugin({ fetcher: forbiddenFetch }));
    await expect(
      atlas.invoke("wholesale", { op: "sendIntros", confirmSend: "yes" as unknown as boolean }),
    ).rejects.toThrow(/confirmSend/);
  });

  it("REFUSES a real (non-dry-run) trace without confirmSpend:true", async () => {
    const atlas = new Atlas({ guardian: permissiveGuardian() });
    await atlas.use(createWholesalePlugin({ fetcher: forbiddenFetch }));
    await expect(atlas.invoke("wholesale", { op: "traceTopBuyers", dryRun: false })).rejects.toThrow(/confirmSpend/);
  });

  it("defaults traceTopBuyers to dryRun, so omitting the flag cannot spend", async () => {
    let sentBody: unknown;
    const fake = (async (_u: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const atlas = new Atlas({ guardian: permissiveGuardian(), config: new ConfigVault({ KDP_CRON_SECRET: "s3cret" }) });
    await atlas.use(createWholesalePlugin({ fetcher: fake }));
    // No dryRun passed at all — must still send dry_run: true upstream.
    const r = (await atlas.invoke("wholesale", { op: "traceTopBuyers" })) as { dryRun: boolean };
    expect((sentBody as { dry_run: boolean }).dry_run).toBe(true);
    expect(r.dryRun).toBe(true);
  });
});
