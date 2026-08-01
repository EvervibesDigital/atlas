import { describe, it, expect } from "vitest";
import { renderComplianceOutreach, missingOutreachFields, type ComplianceOutreachInput } from "../src/outreach-copy";
import type { Lead } from "../src/types";

/** Modelled on a REAL production lead (Nashville dentistry, score 30). */
const LEAD: Lead = {
  id: "l1",
  businessName: "Smiles Up Dentistry",
  website: "https://smilesupdentistry.com/",
  email: "info@smilesupdentistry.com",
  phone: "615-555-0100",
  niche: "dentists",
  city: "Nashville, TN",
  foundAt: "2026-08-01T00:00:00.000Z",
  status: "new",
  dedupeKey: "k1",
  scan: {
    url: "https://smilesupdentistry.com/",
    overallScore: 30,
    issues: [
      { category: "accessibility", issue: "12 image(s) missing alt text" },
      { category: "privacy", issue: "No privacy policy found" },
      { category: "seo", issue: "Missing meta description" },
      { category: "mobile", issue: "Not mobile responsive" },
    ],
  },
};

const INPUT: ComplianceOutreachInput = {
  lead: LEAD,
  senderName: "Mat Brittingham",
  companyName: "EverVibes",
  companyAddress: "100 Main St, Tampa, FL 33601",
  startingPrice: "$400",
};

describe("missingOutreachFields", () => {
  it("accepts a complete input", () => {
    expect(missingOutreachFields(INPUT)).toEqual([]);
  });

  it("requires an email, a scan, and actual findings", () => {
    expect(missingOutreachFields({ ...INPUT, lead: { ...LEAD, email: undefined } })).toContain("lead.email");
    expect(missingOutreachFields({ ...INPUT, lead: { ...LEAD, scan: undefined } })).toContain("lead.scan");
    const noIssues = { ...LEAD, scan: { ...LEAD.scan!, issues: [] } };
    expect(missingOutreachFields({ ...INPUT, lead: noIssues }).join(" ")).toMatch(/nothing to point at/);
  });
});

describe("renderComplianceOutreach", () => {
  it("REFUSES rather than sending a generic pitch with nothing behind it", () => {
    // The entire advantage is naming real, checkable problems. Without them
    // this is indistinguishable from the agency spam it's meant to beat.
    expect(() => renderComplianceOutreach({ ...INPUT, lead: { ...LEAD, scan: { ...LEAD.scan!, issues: [] } } })).toThrow(/nothing to point at/);
    expect(() => renderComplianceOutreach({ ...INPUT, lead: { ...LEAD, email: undefined } })).toThrow(/lead\.email/);
  });

  it("names the actual audit findings, worst first, in plain language", () => {
    const { body } = renderComplianceOutreach(INPUT);
    expect(body).toContain("12 image(s) missing alt text");
    expect(body).toContain("No privacy policy found");
    expect(body).toContain("(accessibility)");
    expect(body).toContain("(privacy/legal)");
    // Only the top 3 are listed; the rest are summarised.
    expect(body).toContain("plus 1 more");
    expect(body).not.toContain("Not mobile responsive");
  });

  it("uses a specific, checkable subject rather than a template blast", () => {
    const { subject } = renderComplianceOutreach(INPUT);
    expect(subject).toBe("4 issues on smilesupdentistry.com");
  });

  it("singularises the subject for a single finding", () => {
    const one = { ...LEAD, scan: { ...LEAD.scan!, issues: [LEAD.scan!.issues[0]!] } };
    expect(renderComplianceOutreach({ ...INPUT, lead: one }).subject).toBe("1 issue on smilesupdentistry.com");
  });

  it("carries the price, an easy out, and the postal address CAN-SPAM requires", () => {
    const { body, to } = renderComplianceOutreach(INPUT);
    expect(to).toBe("info@smilesupdentistry.com");
    expect(body).toContain("$400");
    expect(body).toMatch(/just say so and I won't follow up/i);
    expect(body).toContain("100 Main St, Tampa, FL 33601");
  });

  it("offers to quote when no starting price is configured", () => {
    const { body } = renderComplianceOutreach({ ...INPUT, startingPrice: undefined });
    expect(body).toMatch(/happy to quote/i);
    expect(body).not.toContain("starts around");
  });

  it("uses NO urgency, scarcity, or flattery — one standard across every business", () => {
    const { subject, body } = renderComplianceOutreach(INPUT);
    const text = `${subject} ${body}`.toLowerCase();
    for (const banned of ["act now", "urgent", "limited time", "hope this finds you well", "last chance", "expires", "don't miss", "amazing", "incredible"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("produces clean paragraph breaks, never mangled runs", () => {
    const { body } = renderComplianceOutreach(INPUT);
    expect(body).not.toMatch(/\n{3,}/);
    expect(body.split("\n\n").length).toBeGreaterThanOrEqual(6);
  });
});
