import type { Plugin } from "@atlas/core";
import { scanCodebase, scanBriefing, importTranscripts } from "./scan";
import { detectErrors, suggestFix, verifyFix, commitFix } from "./healer";

/**
 * Codebase plugin (service "codebase", READ-ONLY). `learn` scans a project
 * directory, has the Brain explain what it is and its current state, and files
 * the understanding into memory. It never edits code — pure learning.
 */
export function createCodebasePlugin(): Plugin {
  return {
    manifest: { name: "codebase", version: "0.1.0", capabilities: ["codebase"], permissions: ["call:brain", "call:memory"], role: "executor" },
    register(ctx) {
      ctx.provide("codebase", async (payload) => {
        const cmd = payload as { op: "learn" | "importChats" | "heal"; dir: string; name?: string };

        if (cmd.op === "heal") {
          // Self-healing: detect errors, suggest fixes, verify, commit.
          const errors = await detectErrors(cmd.dir);
          if (!errors.length) return { healed: 0, errors: [] };

          const fixed: { file: string; error: string; fixed: boolean }[] = [];
          for (const err of errors) {
            try {
              const brainCall = async (prompt: string): Promise<string> => {
                const r = (await ctx.call("brain", {
                  prompt,
                  system: "You are ATLAS's code fixer. Suggest a minimal fix for the error.",
                  needs: { coding: 0.9, reasoning: 0.7 },
                  maxTokens: 800,
                  task: "codebase.heal",
                })) as { text: string };
                return r.text;
              };
              const fixSuggestion = await suggestFix(err, brainCall);
              if (!fixSuggestion) continue;
              const verified = await verifyFix(cmd.dir);
              if (!verified) continue;
              const committed = await commitFix(cmd.dir, err, fixSuggestion);
              if (committed) {
                fixed.push({ file: err.file, error: err.message, fixed: true });
                try {
                  await ctx.call("memory", {
                    op: "remember",
                    input: {
                      kind: "event",
                      content: `ATLAS healed error in ${err.file}: ${err.message.slice(0, 100)}`,
                      metadata: { type: "self-heal", file: err.file },
                    },
                  });
                } catch {
                  /* memory optional */
                }
              }
            } catch {
              fixed.push({ file: err.file, error: err.message, fixed: false });
            }
          }
          await ctx.emit("codebase.healed", { fixed: fixed.filter((f) => f.fixed).length, total: errors.length });
          return { healed: fixed.filter((f) => f.fixed).length, errors: fixed };
        }

        if (cmd.op === "importChats") {
          const logs = await importTranscripts(cmd.dir);
          for (const log of logs) {
            try {
              await ctx.call("memory", { op: "remember", input: { kind: "conversation", content: `Chat log ${log.file}: ${log.text}`.slice(0, 2000), metadata: { file: log.file, source: "claude-history" } } });
            } catch {
              /* memory optional */
            }
          }
          await ctx.emit("codebase.history", { files: logs.length });
          return { imported: logs.length, files: logs.map((l) => l.file) };
        }

        if (cmd.op !== "learn") throw new Error(`codebase: unknown op "${(cmd as { op: string }).op}"`);

        const name = cmd.name ?? cmd.dir.split(/[\\/]/).filter(Boolean).pop() ?? "project";
        const scan = await scanCodebase(cmd.dir, name);
        const briefing = scanBriefing(scan);

        let notes = "";
        try {
          const r = (await ctx.call("brain", {
            system:
              "You are ATLAS's staff engineer. From the project briefing, explain plainly: what this codebase does, its main parts, the tech stack, the key workflows/integrations, and its apparent current state. End with what you'd want to learn next. Be concrete; do not invent details not in the briefing.",
            prompt: briefing.slice(0, 12000),
            needs: { research: 0.9, reasoning: 0.6, cost: 1 },
            maxTokens: 1500,
            task: "codebase.learn",
          })) as { text: string };
          notes = r.text;
        } catch {
          notes = `Structure: ${scan.topFolders.join(", ")}. ~${scan.fileCount} files. Workflows: ${scan.workflows.join(", ") || "none found"}.`;
        }

        try {
          await ctx.call("memory", {
            op: "remember",
            input: { kind: "project", content: `Codebase "${name}" (${cmd.dir}): ${notes}`.slice(0, 3000), metadata: { dir: cmd.dir, folders: scan.topFolders, workflows: scan.workflows } },
          });
        } catch {
          /* memory optional */
        }
        await ctx.emit("codebase.learned", { name, dir: cmd.dir, files: scan.fileCount });

        return {
          scan: { name, dir: scan.dir, topFolders: scan.topFolders, fileCount: scan.fileCount, workflows: scan.workflows, routeGroups: scan.routeGroups },
          notes,
        };
      });
    },
  };
}
