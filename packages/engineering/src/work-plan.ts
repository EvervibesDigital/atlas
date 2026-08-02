import type { ClassifiedTask } from "./index";

/**
 * Turns a one-line engineering request into a paste-ready brief for a coding
 * model, naming the files that actually matter.
 *
 * Modelled on gigfinder's work-package + handoff-prompt pair, which is already
 * proven on real gigs. Same posture, pointed at ATLAS's own repo instead of a
 * client's: **entirely deterministic, no AI.** That is the point — the brain's
 * free quota runs out (it did on 2026-08-01, taking every generative feature
 * with it), and an engineering intake that stops working when the quota does is
 * an engineering intake that stops working exactly when Mat needs it.
 *
 * The brief does NOT write code. It removes the expensive part of asking for
 * code: knowing which of ~300 files to look at.
 */

export interface RepoFile {
  path: string;
  content: string;
}

export interface RankedFile {
  path: string;
  score: number;
  /** Which task words hit, so a wrong ranking is diagnosable at a glance. */
  matched: string[];
}

// Words that appear in nearly every engineering sentence. Left in, they make
// every file in the repo score alike and the ranking becomes noise.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "to", "of", "in", "on", "at", "by", "with", "from",
  "is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "these", "those",
  "add", "fix", "make", "build", "create", "update", "change", "new", "should", "when", "why",
  "not", "no", "if", "so", "we", "i", "our", "my", "you", "your", "atlas", "code", "file", "files",
  "under", "over", "too", "much", "very", "per", "into", "out", "up", "down", "than", "then",
]);

/**
 * Split text into whole words, breaking camelCase as well as punctuation.
 *
 * Substring matching looked fine until it ran against the real repo: the word
 * "bed" (as in music bed) matched `embedder.ts`, putting the memory embedder
 * second on a question about audio. Splitting camelCase matters just as much in
 * the other direction — `renderComplianceOutreach` has to yield "outreach", or
 * a search for it misses the function actually named after it.
 */
export function tokenize(text: string): Set<string> {
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // renderCompliance -> render Compliance
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2"); // HTTPServer -> HTTP Server
  const out = new Set<string>();
  for (const w of spaced.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w) out.add(w);
  }
  return out;
}

/** Split a request into the words worth searching for. */
export function taskKeywords(task: { title: string; description?: string }): string[] {
  const raw = `${task.title} ${task.description ?? ""}`.toLowerCase();
  const words = raw.split(/[^a-z0-9]+/).filter(Boolean);
  const kept = new Set<string>();
  for (const w of words) {
    // Two-character words match far too much to be useful signal.
    if (w.length < 3) continue;
    if (STOPWORDS.has(w)) continue;
    kept.add(w);
  }
  return [...kept];
}

/**
 * Score files against a request.
 *
 * A path hit counts for much more than a content hit: a file *named* for the
 * thing is nearly always where the work goes, whereas the same word appearing
 * in a comment somewhere is weak evidence. Content hits are also counted once
 * per keyword rather than per occurrence — otherwise one file that mentions a
 * word forty times outranks the file actually named after it.
 */
export function rankRelevantFiles(files: RepoFile[], task: { title: string; description?: string }, limit = 8): RankedFile[] {
  const keywords = taskKeywords(task);
  if (keywords.length === 0) return [];

  const ranked: RankedFile[] = [];
  for (const f of files) {
    const pathWords = tokenize(f.path);
    const contentWords = tokenize(f.content);
    let score = 0;
    const matched: string[] = [];
    for (const kw of keywords) {
      const inPath = pathWords.has(kw);
      const inContent = contentWords.has(kw);
      if (inPath) score += 5;
      else if (inContent) score += 1;
      if (inPath || inContent) matched.push(kw);
    }
    // A test file is a companion to the work, not the target of it — surfaced,
    // but never above the source file it covers.
    if (/[\\/]test[\\/]|\.test\.ts$/.test(f.path.toLowerCase())) score = Math.floor(score * 0.6);
    if (score > 0) ranked.push({ path: f.path, score, matched });
  }

  // Path as the tiebreak keeps the output stable between runs, so the same
  // request doesn't produce a differently-ordered brief each time.
  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return ranked.slice(0, limit);
}

/** How risky work must be routed. Mirrors the classify() risk scale. */
export function approvalPosture(task: ClassifiedTask): string {
  if (task.risk >= 3) return "Security-sensitive. Do not apply anything unattended — every change goes to Mat for approval first.";
  if (task.risk >= 2) return "Touches production behaviour. Propose the diff for approval rather than applying it.";
  return "Low risk. Still land it behind the normal test + typecheck gate before proposing it.";
}

export interface EngineeringPlan {
  task: ClassifiedTask;
  keywords: string[];
  candidates: RankedFile[];
  posture: string;
  /** Paste this straight into Claude Code. */
  brief: string;
}

const bullets = (items: string[]): string => items.map((i) => `- ${i}`).join("\n");

export function buildEngineeringBrief(
  task: ClassifiedTask,
  description: string | undefined,
  candidates: RankedFile[],
  posture: string,
): string {
  const sections = [
    `Engineering task for the ATLAS repo. Work to the scope below — do not expand it.`,
    ``,
    `## Task`,
    task.title,
    ...(description?.trim() ? [``, description.trim()] : []),
    ``,
    `## Classification`,
    `Type: ${task.type}`,
    `Risk: ${task.risk}`,
    posture,
    ``,
    `## Where to look first`,
    candidates.length
      ? bullets(candidates.map((c) => `${c.path} — matched: ${c.matched.join(", ")}`))
      : `- No file matched the request. Start by searching the repo for the nouns in the task; the ranking is keyword-based and will miss anything phrased differently from the code.`,
    ``,
    `## Required before this is done`,
    bullets([
      `Every new op must be reachable — a route, a cycle step, or a call from another plugin. packages/server/test/reachability.test.ts fails otherwise.`,
      `pnpm test and pnpm typecheck both green.`,
      `Any new API key needs a real reader or a written unusedReason in KEY_SPECS.`,
    ]),
  ];

  // Stated explicitly because it is the mistake worth preventing: the ranking
  // is a starting point derived from word overlap, not an answer.
  sections.push(
    ``,
    `The file list above is a keyword ranking, not a conclusion. Read them, and go elsewhere if they turn out to be wrong.`,
  );

  return sections.join("\n");
}

export function planEngineeringWork(
  files: RepoFile[],
  task: ClassifiedTask,
  description: string | undefined,
  limit = 8,
): EngineeringPlan {
  const keywords = taskKeywords({ title: task.title, description });
  const candidates = rankRelevantFiles(files, { title: task.title, description }, limit);
  const posture = approvalPosture(task);
  return { task, keywords, candidates, posture, brief: buildEngineeringBrief(task, description, candidates, posture) };
}
