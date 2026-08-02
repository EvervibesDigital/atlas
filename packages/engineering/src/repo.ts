import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepoFile } from "./work-plan";

/**
 * Read ATLAS's own source for the work planner.
 *
 * Only `packages/<name>/src` and `test` — a full-tree walk would pull in
 * node_modules and drown the ranking in dependency code that Mat will never
 * edit. Content is truncated per file because the ranker asks "does this word
 * appear at all", so holding whole files in memory buys nothing.
 */
const MAX_CONTENT_CHARS = 20_000;

export async function loadRepoFiles(repoRoot: string): Promise<RepoFile[]> {
  const packagesDir = join(repoRoot, "packages");
  const out: RepoFile[] = [];

  let pkgs: string[];
  try {
    pkgs = await readdir(packagesDir);
  } catch {
    return out; // not a checkout — the planner reports "no file matched", honestly
  }

  for (const pkg of pkgs) {
    for (const sub of ["src", "test"]) {
      await walk(join(packagesDir, pkg, sub), `packages/${pkg}/${sub}`, out);
    }
  }
  return out;
}

async function walk(absDir: string, relDir: string, out: RepoFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return; // package has no src/ or no test/ — normal, not an error
  }
  for (const e of entries) {
    const abs = join(absDir, e.name);
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) {
      await walk(abs, rel, out);
    } else if (e.name.endsWith(".ts")) {
      try {
        const content = await readFile(abs, "utf8");
        out.push({ path: rel, content: content.slice(0, MAX_CONTENT_CHARS) });
      } catch {
        /* unreadable file must not abort the whole scan */
      }
    }
  }
}
