import { describe, it, expect } from "vitest";
import { renderSurplusLetter, renderSurplusEmail, missingOutreachFields, type SurplusOutreachInput } from "../src/outreach-templates";

const VALID: SurplusOutreachInput = {
  ownerName: "Jane Doe",
  propertyAddress: "123 Oak St, Lake City, FL 32055",
  caseNumber: "2024-CA-001234",
  county: "Columbia",
  state: "FL",
  estimatedSurplus: 42873.55,
  auctionDate: "2026-03-14",
  feePercent: 25,
  senderName: "Mat Brittingham",
  companyName: "EverVibes",
  companyAddress: "100 Main St, Tampa, FL 33601",
  contactPhone: "813-555-0100",
};

describe("missingOutreachFields", () => {
  it("accepts a complete input", () => {
    expect(missingOutreachFields(VALID)).toEqual([]);
  });

  it("flags every field whose absence would make the letter untrustworthy", () => {
    const missing = missingOutreachFields({ feePercent: 0, senderName: "", companyName: "", companyAddress: "" } as SurplusOutreachInput);
    for (const f of ["ownerName", "caseNumber", "propertyAddress", "county", "estimatedSurplus", "feePercent", "senderName", "companyName", "companyAddress"]) {
      expect(missing).toContain(f);
    }
  });

  it("requires at least one way to reach a human", () => {
    const { contactPhone: _p, contactEmail: _e, ...rest } = VALID;
    expect(missingOutreachFields(rest as SurplusOutreachInput)).toContain("contactPhone or contactEmail");
  });
});

describe("renderSurplusLetter", () => {
  it("REFUSES to render rather than sending a degraded letter", () => {
    // "You may be owed $undefined" to someone who just lost their home is
    // worse than sending nothing — unverifiable, and indistinguishable from
    // a scam. Refusing is the safety feature.
    expect(() => renderSurplusLetter({ ...VALID, estimatedSurplus: undefined })).toThrow(/estimatedSurplus/);
    expect(() => renderSurplusLetter({ ...VALID, caseNumber: "" })).toThrow(/caseNumber/);
  });

  it("tells them they can file it themselves for free — the anti-predatory disclosure", () => {
    const { body } = renderSurplusLetter(VALID);
    expect(body).toMatch(/file this claim on your own, for free/i);
    // And is explicit about what we are NOT.
    expect(body).toMatch(/not with the court/i);
    expect(body).toMatch(/not a lawyer/i);
  });

  it("gives the case number and actively invites independent verification", () => {
    const { body, subject } = renderSurplusLetter(VALID);
    expect(body).toContain("2024-CA-001234");
    expect(subject).toContain("2024-CA-001234");
    expect(body).toMatch(/Clerk of Court can confirm/i);
    expect(body).toMatch(/rather you check than take my word/i);
  });

  it("states the fee and that it is contingent on actually recovering money", () => {
    const { body } = renderSurplusLetter(VALID);
    expect(body).toContain("25%");
    expect(body).toMatch(/nothing at all if you recover nothing/i);
    expect(body).toMatch(/no upfront cost/i);
  });

  it("hedges the amount and rounds DOWN so it never reads as a promised payout", () => {
    const { body } = renderSurplusLetter(VALID);
    expect(body).toMatch(/around \$42,800/);
    expect(body).not.toContain("42,873");
    expect(body).toMatch(/appears to be/i);
  });

  it("carries the physical address and an opt-out", () => {
    const { body } = renderSurplusLetter(VALID);
    expect(body).toContain("100 Main St, Tampa, FL 33601");
    expect(body).toMatch(/rather not hear from us again/i);
  });

  it("uses NO urgency, scarcity, or pressure tactics", () => {
    // Pinning the standard in code: these are what make recovery mail look
    // predatory, and the wholesale email prompt in this same repo bans them
    // too. One standard, applied everywhere.
    const { body, subject } = renderSurplusLetter(VALID);
    const text = `${subject} ${body}`.toLowerCase();
    for (const banned of ["act now", "urgent", "immediately", "limited time", "expires soon", "don't miss", "last chance", "hurry", "final notice"]) {
      expect(text).not.toContain(banned);
    }
  });
});

describe("renderSurplusEmail", () => {
  it("keeps the same substance as the letter, including the free-filing disclosure", () => {
    const { body } = renderSurplusEmail(VALID);
    expect(body).toMatch(/claim it yourself, for free/i);
    expect(body).toMatch(/not a lawyer/i);
    expect(body).toContain("2024-CA-001234");
    expect(body).toContain("25%");
    // CAN-SPAM: commercial email must carry a physical postal address.
    expect(body).toContain("100 Main St, Tampa, FL 33601");
  });

  it("refuses on missing fields, exactly like the letter", () => {
    expect(() => renderSurplusEmail({ ...VALID, ownerName: "" })).toThrow(/ownerName/);
  });
});
