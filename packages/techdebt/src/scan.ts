import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Tech-Debt Hunter core — a REAL scanner. It walks a directory's source files
 * and flags debt signals: TODO/FIXME/HACK markers and oversized files. ATLAS
 * can point this at its own repo (or Mat's other projects) to keep itself
 * honest.
 */
export type DebtKind = "todo" | "fixme" | "hack" | "large-file";

export interface DebtFinding {
  file: string;
  kind: DebtKind;
  line?: number;
  detail: string;
  severity: 1 | 2 | 3;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "data", ".vitest"]);
const CODE_EXT = /\.(ts|tsx|js|jsx)$/;

async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(join(dir, e.name), acc);
    } else {
      acc.push(join(dir, e.name));
    }
  }
  return acc;
}

export async function scanForDebt(root: string, opts: { maxLines?: number } = {}): Promise<DebtFinding[]> {
  const maxLines = opts.maxLines ?? 400;
  const files = (await walk(root)).filter((f) => CODE_EXT.test(f));
  const findings: DebtFinding[] = [];

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const m = line.match(/\b(TODO|FIXME|HACK)\b/);
      if (m) {
        const kind = m[1]!.toLowerCase() as DebtKind;
        findings.push({ file, kind, line: i + 1, detail: line.trim().slice(0, 120), severity: kind === "fixme" ? 3 : kind === "hack" ? 2 : 1 });
      }
    });
    if (lines.length > maxLines) {
      findings.push({ file, kind: "large-file", detail: `${lines.length} lines (> ${maxLines})`, severity: 1 });
    }
  }

  return findings.sort((a, b) => b.severity - a.severity);
}

export interface DebtSummary {
  total: number;
  bySeverity: Record<1 | 2 | 3, number>;
}

export function summarize(findings: DebtFinding[]): DebtSummary {
  const bySeverity: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
  for (const f of findings) bySeverity[f.severity]++;
  return { total: findings.length, bySeverity };
}
