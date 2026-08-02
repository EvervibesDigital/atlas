import { describe, it, expect } from "vitest";
import { classify } from "../src/index";
import {
  taskKeywords,
  tokenize,
  rankRelevantFiles,
  approvalPosture,
  planEngineeringWork,
  type RepoFile,
} from "../src/work-plan";

/**
 * Fixture built from REAL ATLAS paths and real content fragments, not invented
 * ones. A synthetic repo makes any ranker look good; the question that matters
 * is whether it finds the right file among files that genuinely resemble each
 * other, which this repo is full of.
 */
const REPO: RepoFile[] = [
  { path: "packages/surplus/src/outreach-templates.ts", content: "renderSurplusLetter feePercent ownerName estimatedSurplus county clerk of court" },
  { path: "packages/leadscan/src/outreach-copy.ts", content: "renderComplianceOutreach scan issues accessibility privacy CAN-SPAM companyAddress" },
  { path: "packages/leadscan/src/contact.ts", content: "extractContactEmail mailto no-reply webmaster same-domain ranking" },
  { path: "packages/wholesale/src/intro-drafts.ts", content: "storeDrafts findDraft removeDraft intro buyer" },
  { path: "packages/publishing/src/montage-renderer.ts", content: "ffmpeg piper subtitles zoompan concat render reel" },
  { path: "packages/brain/src/adapters/gemini.ts", content: "generateContent model gemini api key adapter" },
  { path: "packages/leadscan/test/outreach-copy.test.ts", content: "renderComplianceOutreach subject body companyAddress expects" },
];

describe("taskKeywords", () => {
  it("drops filler that would match every file in the repo", () => {
    const kw = taskKeywords({ title: "Add a new fix to the ATLAS code for the scan" });
    for (const filler of ["add", "new", "fix", "the", "atlas", "code"]) expect(kw).not.toContain(filler);
    expect(kw).toContain("scan");
  });

  it("drops words too short to be signal", () => {
    expect(taskKeywords({ title: "go up to id x" })).toEqual([]);
  });

  it("reads the description as well as the title", () => {
    expect(taskKeywords({ title: "Improve outreach", description: "the piper narration is too quiet" })).toContain("piper");
  });

  it("does not repeat a word that appears in both title and description", () => {
    const kw = taskKeywords({ title: "renderer bug", description: "the renderer is broken" });
    expect(kw.filter((k) => k === "renderer")).toHaveLength(1);
  });
});

describe("rankRelevantFiles", () => {
  it("puts a file NAMED for the thing above one that merely mentions it", () => {
    // "outreach" appears in both leadscan files, but only one is named for it.
    // Weighting path and content equally makes the ranking noise.
    const ranked = rankRelevantFiles(REPO, { title: "the compliance outreach email wording is wrong" });
    expect(ranked[0]!.path).toBe("packages/leadscan/src/outreach-copy.ts");
  });

  it("ranks a test below the source file it covers", () => {
    const ranked = rankRelevantFiles(REPO, { title: "outreach copy needs the address" });
    const src = ranked.findIndex((r) => r.path === "packages/leadscan/src/outreach-copy.ts");
    const test = ranked.findIndex((r) => r.path === "packages/leadscan/test/outreach-copy.test.ts");
    expect(src).toBeGreaterThanOrEqual(0);
    expect(test).toBeGreaterThan(src);
  });

  it("does not let one file's repetition outrank a better match", () => {
    // Counting every occurrence rather than every keyword lets a file that says
    // a word forty times beat the file actually named after it.
    const spammy: RepoFile[] = [
      { path: "packages/misc/src/noise.ts", content: "zoompan ".repeat(200) },
      { path: "packages/publishing/src/zoompan-helper.ts", content: "one mention of zoompan" },
    ];
    expect(rankRelevantFiles(spammy, { title: "zoompan motion" })[0]!.path).toBe("packages/publishing/src/zoompan-helper.ts");
  });

  it("returns nothing rather than everything when the task has no usable words", () => {
    expect(rankRelevantFiles(REPO, { title: "fix the code" })).toEqual([]);
  });

  it("reports which words matched, so a bad ranking is diagnosable", () => {
    const top = rankRelevantFiles(REPO, { title: "piper narration in the renderer" })[0]!;
    expect(top.path).toBe("packages/publishing/src/montage-renderer.ts");
    expect(top.matched).toContain("piper");
  });

  it("is stable across runs for the same request", () => {
    const a = rankRelevantFiles(REPO, { title: "outreach buyer intro" });
    const b = rankRelevantFiles([...REPO].reverse(), { title: "outreach buyer intro" });
    expect(a.map((r) => r.path)).toEqual(b.map((r) => r.path));
  });
});

describe("approvalPosture", () => {
  it("forbids unattended application for security work", () => {
    expect(approvalPosture(classify({ title: "rotate the leaked API token" }))).toMatch(/Do not apply anything unattended/);
  });

  it("requires a proposed diff for production-touching work", () => {
    expect(approvalPosture(classify({ title: "fix the crash in the payment webhook" }))).toMatch(/Propose the diff/);
  });

  it("still gates low-risk work behind tests", () => {
    expect(approvalPosture({ title: "tidy a comment", type: "chore", risk: 0 })).toMatch(/test \+ typecheck/);
  });
});

describe("planEngineeringWork", () => {
  it("produces a brief that names real files and the reachability requirement", () => {
    const plan = planEngineeringWork(REPO, classify({ title: "the compliance outreach email is missing the address" }), undefined);
    expect(plan.brief).toContain("packages/leadscan/src/outreach-copy.ts");
    expect(plan.brief).toContain("reachability.test.ts");
    expect(plan.brief).toContain("pnpm test");
  });

  it("says so plainly when nothing matched, instead of implying a confident answer", () => {
    const plan = planEngineeringWork(REPO, classify({ title: "quantum flux capacitor alignment" }), undefined);
    expect(plan.candidates).toEqual([]);
    expect(plan.brief).toMatch(/No file matched/);
  });

  it("marks the ranking as a starting point, not a conclusion", () => {
    const plan = planEngineeringWork(REPO, classify({ title: "outreach wording" }), undefined);
    expect(plan.brief).toMatch(/not a conclusion/);
  });

  it("carries the risk posture into the brief", () => {
    const plan = planEngineeringWork(REPO, classify({ title: "fix the credential leak in the vault" }), undefined);
    expect(plan.task.type).toBe("security");
    expect(plan.brief).toMatch(/Do not apply anything unattended/);
  });

  it("works with no AI at all", () => {
    // Nothing in this path calls the brain — an intake that dies with the free
    // quota is useless exactly when the quota dies, which it did on 2026-08-01.
    const plan = planEngineeringWork(REPO, classify({ title: "piper narration too quiet" }), "in the montage renderer");
    expect(plan.brief.length).toBeGreaterThan(200);
    expect(plan.candidates[0]!.path).toBe("packages/publishing/src/montage-renderer.ts");
  });
});

describe("tokenize", () => {
  it("does not let a short word match inside a longer one", () => {
    // Found on the real repo: "bed" (music bed) matched embedder.ts, putting
    // the memory embedder second on a question about audio.
    expect(tokenize("hfEmbedder.ts").has("bed")).toBe(false);
    expect(tokenize("the music bed").has("bed")).toBe(true);
  });

  it("splits camelCase, so a search finds the function named after it", () => {
    const t = tokenize("renderComplianceOutreach");
    expect(t.has("render")).toBe(true);
    expect(t.has("compliance")).toBe(true);
    expect(t.has("outreach")).toBe(true);
  });

  it("splits an acronym off the word that follows it", () => {
    const t = tokenize("HTTPServerConfig");
    expect(t.has("http")).toBe(true);
    expect(t.has("server")).toBe(true);
    expect(t.has("config")).toBe(true);
  });
});
