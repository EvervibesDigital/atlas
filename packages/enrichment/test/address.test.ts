import { describe, it, expect } from "vitest";
import { parseUsAddress } from "../src/address";

/**
 * Every shape below was MEASURED against the 59 real owner mailing addresses
 * in the surplus leads sheet on 2026-08-01 (counts in the design doc). The
 * addresses themselves are synthetic — real owner PII never belongs in a test
 * fixture — but the STRUCTURES are the real distribution:
 *   31 rows: no commas at all, ends in STATE ZIP
 *   13 rows: one comma
 *    8 rows: two commas
 *    7 rows: no trailing STATE ZIP (unusable)
 * Only 8 of 59 split cleanly on commas, so comma-splitting alone would mangle
 * 86% of the data. The trailing STATE ZIP is the reliable anchor.
 */
describe("parseUsAddress", () => {
  it("parses the most common real shape: no commas at all", () => {
    expect(parseUsAddress("1234 MAIN ST TAMPA FL 33601")).toEqual({
      street: "1234 MAIN ST",
      city: "TAMPA",
      state: "FL",
      zip: "33601",
      confidence: "high",
    });
  });

  it("parses a single-comma address", () => {
    expect(parseUsAddress("1234 MAIN ST, TAMPA FL 33601")).toEqual({
      street: "1234 MAIN ST",
      city: "TAMPA",
      state: "FL",
      zip: "33601",
      confidence: "high",
    });
  });

  it("parses a two-comma address", () => {
    expect(parseUsAddress("1234 MAIN ST, TAMPA, FL 33601")).toEqual({
      street: "1234 MAIN ST",
      city: "TAMPA",
      state: "FL",
      zip: "33601",
      confidence: "high",
    });
  });

  it("handles a multi-word city with no commas", () => {
    expect(parseUsAddress("55 OAK AVE ST PETERSBURG FL 33701")).toEqual({
      street: "55 OAK AVE",
      city: "ST PETERSBURG",
      state: "FL",
      zip: "33701",
      confidence: "high",
    });
  });

  it("accepts ZIP+4", () => {
    const r = parseUsAddress("1234 MAIN ST TAMPA FL 33601-1234");
    expect(r?.zip).toBe("33601");
    expect(r?.confidence).toBe("high");
  });

  it("degrades to low confidence when there's no street suffix to split on", () => {
    // PO boxes have no ST/AVE/RD token, so the street/city boundary is a
    // guess — still worth sending (Twin's agent re-parses), but flagged.
    const r = parseUsAddress("PO BOX 123 TAMPA FL 33601");
    expect(r?.confidence).toBe("low");
    expect(r?.state).toBe("FL");
    expect(r?.zip).toBe("33601");
  });

  it("returns null when there is no STATE ZIP anchor (the 7 unusable rows)", () => {
    expect(parseUsAddress("1234 MAIN ST TAMPA FL")).toBeNull();
    expect(parseUsAddress("SOME NOTE, NOT AN ADDRESS")).toBeNull();
    expect(parseUsAddress("")).toBeNull();
  });

  it("is case- and whitespace-tolerant", () => {
    expect(parseUsAddress("  1234 main st  tampa  fl 33601 ")).toEqual({
      street: "1234 MAIN ST",
      city: "TAMPA",
      state: "FL",
      zip: "33601",
      confidence: "high",
    });
  });
});
