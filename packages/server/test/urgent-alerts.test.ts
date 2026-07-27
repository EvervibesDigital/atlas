import { describe, it, expect } from "vitest";
import { alertKey, findNewUrgentItems, buildUrgentAlertEmail, type AlertableItem } from "../src/urgent-alerts";

describe("alertKey", () => {
  it("combines source and id so the same id from different sources doesn't collide", () => {
    expect(alertKey({ source: "kdp", id: "abc" })).toBe("kdp:abc");
    expect(alertKey({ source: "kdp", id: "abc" })).not.toBe(alertKey({ source: "wholesale", id: "abc" }));
  });
});

describe("findNewUrgentItems", () => {
  const items: AlertableItem[] = [
    { source: "kdp", id: "1", title: "Book ready", tier: "ask" },
    { source: "leadscan", id: "2", title: "Cold email batch", tier: "bulk" },
    { source: "wholesale", id: "3", title: "Bland verification call", tier: "ask" },
  ];

  it("keeps only ask-tier items", () => {
    const result = findNewUrgentItems(items, new Set());
    expect(result.map((i) => i.id)).toEqual(["1", "3"]);
  });

  it("excludes items already alerted on", () => {
    const result = findNewUrgentItems(items, new Set([alertKey({ source: "kdp", id: "1" })]));
    expect(result.map((i) => i.id)).toEqual(["3"]);
  });

  it("returns nothing when every ask-tier item was already alerted", () => {
    const alerted = new Set([alertKey({ source: "kdp", id: "1" }), alertKey({ source: "wholesale", id: "3" })]);
    expect(findNewUrgentItems(items, alerted)).toEqual([]);
  });
});

describe("buildUrgentAlertEmail", () => {
  it("uses a single-item subject line naming the item when there's exactly one", () => {
    const { subject } = buildUrgentAlertEmail([{ source: "kdp", id: "1", title: "Book ready", tier: "ask" }]);
    expect(subject).toContain("Book ready");
  });

  it("uses a count-based subject line for multiple items", () => {
    const { subject } = buildUrgentAlertEmail([
      { source: "kdp", id: "1", title: "Book ready", tier: "ask" },
      { source: "wholesale", id: "3", title: "Bland call", tier: "ask" },
    ]);
    expect(subject).toContain("2");
  });

  it("lists every item's source and title in the body", () => {
    const { body } = buildUrgentAlertEmail([
      { source: "kdp", id: "1", title: "Book ready", detail: "Fantasy novel", tier: "ask" },
    ]);
    expect(body).toContain("[kdp] Book ready");
    expect(body).toContain("Fantasy novel");
  });

  it("mentions this is separate from the daily digest", () => {
    const { body } = buildUrgentAlertEmail([{ source: "kdp", id: "1", title: "x", tier: "ask" }]);
    expect(body.toLowerCase()).toContain("morning brief");
  });
});
