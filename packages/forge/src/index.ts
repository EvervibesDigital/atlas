import type { Atlas, Plugin } from "@atlas/core";
import { readdir, rename, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(exec);

/**
 * Forge — how ATLAS writes its OWN new capabilities as real, loadable plugins,
 * safely. A forged plugin is generated from a FIXED template where only text is
 * injected (name, capability, and a Brain-written system prompt) — so it always
 * compiles and can't smuggle arbitrary code. Drafts land in forge/drafts; going
 * live (moving to forge/active, which buildAtlas auto-loads) is gated behind
 * Mat's approval and preceded by a repo backup. This lets ATLAS grow itself
 * without Claude Code, while staying reversible and human-checked.
 */

const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "skill";
const capify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.]+/g, "") || "custom";

/** Render a guaranteed-compilable plugin whose behaviour is driven by a prompt. */
export function renderPluginCode(name: string, capability: string, systemPrompt: string): string {
  const cap = capify(capability);
  const nm = slugify(name);
  return `import type { Plugin } from "@atlas/core";

// Forged by ATLAS. Behaviour is driven entirely by the system prompt below;
// it can only think and produce text (call:brain). No world-actions.
export const plugin: Plugin = {
  manifest: { name: ${JSON.stringify(nm)}, version: "0.1.0", capabilities: [${JSON.stringify(cap)}], permissions: ["call:brain"], role: "executor" },
  register(ctx) {
    ctx.provide(${JSON.stringify(cap)}, async (payload) => {
      const { input } = (payload ?? {}) as { input?: string };
      const r = (await ctx.call("brain", {
        system: ${JSON.stringify(systemPrompt)},
        prompt: String(input ?? ""),
        needs: { reasoning: 0.6, cost: 1 },
        maxTokens: 1200,
        task: ${JSON.stringify("forged." + nm)},
      })) as { text: string };
      return { output: r.text };
    });
  },
};

export default plugin;
`;
}

/** Auto-load every approved (active) forged plugin. Best-effort — a broken one
 * is skipped, never crashing boot. Called by buildAtlas. */
export async function loadActivePlugins(atlas: Atlas, dir: string): Promise<string[]> {
  const loaded: string[] = [];
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    return loaded;
  }
  for (const f of files.filter((f) => f.endsWith(".plugin.ts") || f.endsWith(".plugin.js"))) {
    try {
      const mod = (await import(pathToFileURL(join(dir, f)).href)) as { plugin?: Plugin; default?: Plugin };
      const p = mod.plugin ?? mod.default;
      if (p && p.manifest) {
        await atlas.use(p);
        loaded.push(p.manifest.name);
      }
    } catch {
      /* skip a broken forged plugin — never block startup */
    }
  }
  return loaded;
}

interface Approval {
  id: string;
}

export type ForgeCommand =
  | { op: "draft"; name: string; capability?: string; purpose: string }
  | { op: "verify" }
  | { op: "list" }
  | { op: "activate"; name: string };

/** Forge plugin (service "forge"). */
export function createForgePlugin(opts: { forgeDir?: string; repoRoot?: string } = {}): Plugin {
  const forgeDir = opts.forgeDir ?? "./forge";
  const draftsDir = join(forgeDir, "drafts");
  const activeDir = join(forgeDir, "active");
  const repoRoot = opts.repoRoot ?? ".";

  return {
    manifest: { name: "forge", version: "0.1.0", capabilities: ["forge"], permissions: ["call:brain", "call:approvals", "call:backup"], role: "executor" },
    register(ctx) {
      const pending = new Map<string, string>(); // approvalId -> draft filename

      ctx.on("approval.granted", async (payload) => {
        const file = pending.get((payload as Approval).id);
        if (!file) return;
        pending.delete((payload as Approval).id);
        try {
          await mkdir(activeDir, { recursive: true });
          await rename(join(draftsDir, file), join(activeDir, file));
          await ctx.emit("forge.activated", { file });
        } catch {
          /* activation failed — draft stays put */
        }
      });

      ctx.provide("forge", async (payload) => {
        const cmd = payload as ForgeCommand;

        if (cmd.op === "draft") {
          const design = (await ctx.call("brain", {
            system: "You are ATLAS's capability designer. Write ONE excellent SYSTEM PROMPT that makes a model an expert at the requested capability. Output only the system prompt text.",
            prompt: `Capability: ${cmd.purpose}`,
            needs: { reasoning: 0.7, cost: 1 },
            maxTokens: 700,
            task: "forge.design",
          })) as { text: string };
          const code = renderPluginCode(cmd.name, cmd.capability ?? cmd.name, design.text.trim());
          const file = `${slugify(cmd.name)}.plugin.ts`;
          await mkdir(draftsDir, { recursive: true });
          await writeFile(join(draftsDir, file), code, "utf8");
          await ctx.emit("forge.drafted", { file });
          return { file, code };
        }

        if (cmd.op === "verify") {
          try {
            await run("pnpm run typecheck", { cwd: repoRoot });
            return { ok: true, output: "typecheck passed" };
          } catch (e) {
            return { ok: false, output: String((e as { stdout?: string }).stdout ?? (e as Error).message).slice(0, 2000) };
          }
        }

        if (cmd.op === "list") {
          const drafts = await readdir(draftsDir).catch(() => [] as string[]);
          const active = await readdir(activeDir).catch(() => [] as string[]);
          return { drafts, active };
        }

        if (cmd.op === "activate") {
          const file = `${slugify(cmd.name)}.plugin.ts`;
          // Back up the repo first so a bad activation is reversible.
          await ctx.call("backup", { op: "snapshot", dir: repoRoot }).catch(() => undefined);
          const approval = (await ctx.call("approvals", { op: "request", action: `Activate forged capability: ${cmd.name}`, detail: file, risk: 2 })) as Approval;
          pending.set(approval.id, file);
          return { status: "pending-approval", approvalId: approval.id, file };
        }

        throw new Error(`forge: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
