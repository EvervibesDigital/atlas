import { describe, it, expect } from "vitest";
import { buildMorningBrief, type MorningBriefInput } from "../src/morning-brief";

const BASE: MorningBriefInput = {
  items: [],
  digest: { sent: 0, skipped: 0, failed: 0, bySource: {} },
  manual: { gigsToSubmit: 0, kdpToPublish: 0 },
  reviewLink: "https://atlas.example/m?t=abc",
};

describe("buildMorningBrief", () => {
  it("leads with what ATLAS already did, by source", () => {
    const e = buildMorningBrief({ ...BASE, digest: { sent: 12, skipped: 2, failed: 0, bySource: { leadscan: 8, wholesale: 4 } } });
    expect(e.body).toMatch(/Sent 12 email\(s\) overnight, no review needed/);
    expect(e.body).toMatch(/8 leadscan.*4 wholesale|4 wholesale.*8 leadscan/);
    expect(e.body).toMatch(/Skipped 2/);
  });

  it("says plainly when nothing was sent, rather than a blank section", () => {
    const e = buildMorningBrief(BASE);
    expect(e.body).toMatch(/Nothing sent itself overnight/);
  });

  it("flags a failure count distinctly from a skip — one is a signal to fix something", () => {
    const e = buildMorningBrief({ ...BASE, digest: { sent: 5, skipped: 0, failed: 3, bySource: { leadscan: 5 } } });
    expect(e.body).toMatch(/3 failed to send.*worth a look/is);
  });

  it("gives a concrete instruction for gigs, not just a count", () => {
    const e = buildMorningBrief({ ...BASE, manual: { gigsToSubmit: 4, kdpToPublish: 0 } });
    expect(e.body).toMatch(/4 gig bid\(s\) ready to submit.*Gig Finder tab.*copy \+ open \+ submit/is);
  });

  it("gives a concrete instruction for KDP, not just a count", () => {
    const e = buildMorningBrief({ ...BASE, manual: { gigsToSubmit: 0, kdpToPublish: 2 } });
    expect(e.body).toMatch(/2 KDP book\(s\) built and waiting on the Publish click/);
  });

  it("says nothing needs you when the manual queues are empty and there are no asks", () => {
    const e = buildMorningBrief(BASE);
    expect(e.body).toMatch(/Nothing needs you right now/);
  });

  it("counts only ask-tier items toward 'needs a decision', not bulk ones", () => {
    const e = buildMorningBrief({
      ...BASE,
      items: [
        { source: "gigfinder", title: "x", tier: "ask" },
        { source: "leadscan", title: "y", tier: "bulk" },
      ],
    });
    expect(e.body).toMatch(/1 item\(s\) need an actual decision/);
    expect(e.subject).toMatch(/1 need you/);
  });

  it("subject reflects zero asks as 'nothing urgent', not '0 need you'", () => {
    const e = buildMorningBrief(BASE);
    expect(e.subject).toMatch(/nothing urgent/);
    expect(e.subject).not.toMatch(/0 need you/);
  });

  it("always includes the tap-to-review link", () => {
    const e = buildMorningBrief(BASE);
    expect(e.body).toContain(BASE.reviewLink);
  });
});
