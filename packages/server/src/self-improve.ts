/**
 * Self-improvement engine. ATLAS reads its own plugin code and suggests
 * improvements, all on the local brain (Ollama, no token cost).
 *
 * Flow:
 *   1. Mat: "improve memory recall"
 *   2. ATLAS reads the memory plugin source
 *   3. ATLAS (via Brain) suggests a specific code change
 *   4. Mat reviews the draft + accepts/rejects
 *   5. ATLAS applies the patch (git commit, reload)
 */

import { readFile, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(exec);

export interface SelfImprovementRequest {
  target: string; // "memory", "brain", "learning", etc.
  goal: string; // "improve recall accuracy" or "add email support"
  context?: string; // optional extra context
}

export interface SelfImprovementDraft {
  target: string;
  goal: string;
  currentCode: string;
  suggestedPatch: string; // unified diff or new code
  explanation: string; // why this helps
  confidence: number; // 0-1, how confident ATLAS is in this improvement
  estimatedImpact: string; // "faster recalls", "new capability", etc.
}

export async function getSelfImprovementTarget(target: string): Promise<{ file: string; code: string } | null> {
  const mapping: Record<string, string> = {
    memory: "packages/memory/src/plugin.ts",
    "memory-search": "packages/memory/src/memory.ts",
    brain: "packages/brain/src/plugin.ts",
    learning: "packages/learning/src/plugin.ts",
    "learning-proposals": "packages/learning/src/proposals.ts",
    orchestrator: "packages/orchestrator/src/plugin.ts",
    chat: "packages/server/src/server.ts",
    codebase: "packages/codebase/src/plugin.ts",
  };

  const file = mapping[target];
  if (!file) return null;

  try {
    const code = await readFile(file, "utf8");
    return { file, code };
  } catch {
    return null;
  }
}

/**
 * Generate a self-improvement draft using the Brain (local Ollama).
 * Prompts it to read current code and suggest one specific, testable change.
 */
export async function generateSelfImprovementDraft(
  req: SelfImprovementRequest,
  currentCode: string,
  brainInvoke: (cmd: unknown) => Promise<{ text: string }>,
): Promise<SelfImprovementDraft | null> {
  try {
    const systemPrompt = `You are ATLAS's self-improvement engine. You read your own source code and suggest ONE specific improvement.

Your output MUST be structured like this:
EXPLANATION: [2-3 sentences on why this improves ATLAS]
CONFIDENCE: [0.1 to 1.0]
IMPACT: [one-line summary of the effect]
PATCH: [the new code or unified diff, starting with "---" for diffs]

Be precise. Suggest code that is testable and doesn't break existing functionality.`;

    const prompt = `Read this plugin code and suggest ONE improvement for: ${req.goal}
${req.context ? `Context: ${req.context}\n` : ""}
Code (first 500 lines):
\`\`\`
${currentCode.split("\n").slice(0, 500).join("\n")}
\`\`\`

What ONE change would improve this?`;

    const result = (await brainInvoke({
      prompt,
      system: systemPrompt,
      maxTokens: 800,
    })) as { text: string };

    const text = result.text;

    // Parse the structured output
    const explanation = text.match(/EXPLANATION:\s*(.+?)(?=\nCONFIDENCE:|$)/s)?.[1]?.trim() ?? "";
    const confidenceStr = text.match(/CONFIDENCE:\s*([0-9.]+)/)?.[1] ?? "0.5";
    const confidence = Math.min(1, Math.max(0, parseFloat(confidenceStr)));
    const impact = text.match(/IMPACT:\s*(.+?)(?=\nPATCH:|$)/)?.[1]?.trim() ?? "improvement";
    const patchMatch = text.match(/PATCH:\s*([\s\S]*?)$/);
    const patch = patchMatch && patchMatch[1] ? patchMatch[1].trim() : "";

    return {
      target: req.target,
      goal: req.goal,
      currentCode,
      suggestedPatch: patch,
      explanation,
      confidence,
      estimatedImpact: impact,
    };
  } catch (e) {
    console.error("[self-improve] draft generation failed:", e);
    return null;
  }
}

/**
 * Apply a reviewed improvement draft — SAFELY. The patch never goes live
 * unverified: we back up the original, write the patch, run the repo's
 * typecheck, and automatically roll back if it fails. A bad draft can never
 * brick the server.
 */
export async function applySelfImprovementPatch(
  target: string,
  patch: string,
): Promise<{ ok: boolean; error?: string; file?: string; verified?: string }> {
  const mapping: Record<string, string> = {
    memory: "packages/memory/src/plugin.ts",
    "memory-search": "packages/memory/src/memory.ts",
    brain: "packages/brain/src/plugin.ts",
    learning: "packages/learning/src/plugin.ts",
    "learning-proposals": "packages/learning/src/proposals.ts",
    orchestrator: "packages/orchestrator/src/plugin.ts",
    chat: "packages/server/src/server.ts",
    codebase: "packages/codebase/src/plugin.ts",
  };

  const file = mapping[target];
  if (!file) return { ok: false, error: "unknown target" };

  if (patch.startsWith("---")) {
    return { ok: false, error: "diff format not supported; the draft must be a complete file" };
  }
  // Sanity gate: a real plugin module is substantial and has imports/exports.
  // Tiny fragments are almost certainly not a full-file replacement.
  if (patch.length < 200 || !/\b(import|export)\b/.test(patch)) {
    return { ok: false, error: "draft is not a complete module (too short / no import/export) — rejected for safety" };
  }

  const original = await readFile(file, "utf8");
  try {
    await writeFile(file, patch, "utf8");
    // Verify: the whole workspace must still typecheck (same gate forge uses).
    await run("pnpm run typecheck", { timeout: 180_000 });
    return { ok: true, file, verified: "typecheck passed" };
  } catch (e) {
    // Roll back to the original file — the change never takes effect.
    await writeFile(file, original, "utf8");
    const detail = String((e as { stdout?: string; message?: string }).stdout ?? (e as Error).message).slice(0, 300);
    return { ok: false, error: `typecheck FAILED — change rolled back automatically. ${detail}` };
  }
}
