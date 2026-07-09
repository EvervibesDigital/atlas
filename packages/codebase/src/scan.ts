import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Codebase scanner — READ-ONLY. Walks a project directory and gathers just
 * enough to understand it: top-level structure, key config/docs, workflow
 * files, and API route groups. It never writes or changes anything. This is how
 * ATLAS learns the code Mat has already built (evervibes, wholesale, …).
 */
const SKIP = new Set(["node_modules", ".git", "dist", "coverage", "data", ".next", "build", ".vitest", ".turbo", ".vercel", "out"]);
const ROOT_KEY_FILES = ["package.json", "README.md", "readme.md", "docker-compose.yml", "docker-compose.yaml", ".env.example", "tsconfig.json"];

export interface CodebaseScan {
  name: string;
  dir: string;
  topFolders: string[];
  fileCount: number;
  keyFiles: { path: string; excerpt: string }[];
  workflows: string[];
  routeGroups: string[];
}

async function walk(dir: string, depth: number, acc: { files: string[]; cap: number }): Promise<void> {
  if (depth < 0 || acc.files.length >= acc.cap) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (acc.files.length >= acc.cap) return;
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) await walk(join(dir, e.name), depth - 1, acc);
    } else {
      acc.files.push(join(dir, e.name));
    }
  }
}

export async function scanCodebase(dir: string, name: string, opts: { maxKeyFileChars?: number; fileCap?: number } = {}): Promise<CodebaseScan> {
  const maxChars = opts.maxKeyFileChars ?? 2500;

  let topFolders: string[] = [];
  try {
    topFolders = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !SKIP.has(e.name)).map((e) => e.name);
  } catch {
    throw new Error(`cannot read directory: ${dir}`);
  }

  const keyFiles: { path: string; excerpt: string }[] = [];
  for (const f of ROOT_KEY_FILES) {
    try {
      const txt = await readFile(join(dir, f), "utf8");
      keyFiles.push({ path: f, excerpt: txt.slice(0, maxChars) });
    } catch {
      /* not present */
    }
  }

  const acc = { files: [] as string[], cap: opts.fileCap ?? 4000 };
  await walk(dir, 6, acc);

  const rel = acc.files.map((f) => f.slice(dir.length + 1).replace(/\\/g, "/"));
  const workflows = [...new Set(rel.filter((p) => /\.json$/i.test(p) && /(workflow|n8n)/i.test(p)))].slice(0, 40);
  const routeGroups = [
    ...new Set(
      rel
        .map((p) => p.match(/(?:^|\/)api\/([^/]+)/i)?.[1])
        .filter((x): x is string => !!x && !x.includes(".")),
    ),
  ]
    .sort()
    .slice(0, 60);

  return { name, dir, topFolders, fileCount: acc.files.length, keyFiles, workflows, routeGroups };
}

/** Build a compact briefing string from a scan, for the Brain to summarize. */
export function scanBriefing(scan: CodebaseScan): string {
  const parts = [
    `Project: ${scan.name}`,
    `Location: ${scan.dir}`,
    `Top-level folders: ${scan.topFolders.join(", ") || "(none)"}`,
    `Approx file count: ${scan.fileCount}${scan.fileCount >= 4000 ? "+ (capped)" : ""}`,
  ];
  if (scan.routeGroups.length) parts.push(`API route groups: ${scan.routeGroups.join(", ")}`);
  if (scan.workflows.length) parts.push(`Workflow files: ${scan.workflows.join(", ")}`);
  for (const kf of scan.keyFiles) parts.push(`\n--- ${kf.path} ---\n${kf.excerpt}`);
  return parts.join("\n");
}
