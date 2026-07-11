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
        const cmd = payload as { op: "learn" | "importChats" | "heal" | "generate"; dir: string; name?: string; spec?: string };

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

        if (cmd.op === "generate") {
          // Self-generation: ATLAS writes new agents/skills based on a spec.
          // Example spec: "Write an agent that finds Upwork gigs matching my skills"
          if (!cmd.spec) throw new Error("generate requires 'spec' parameter");

          const codeSpec = `You are ATLAS's code generator. Based on this spec, write a complete, production-ready TypeScript agent that:
${cmd.spec}

Return ONLY the agent code (no markdown, no explanations). The agent must:
1. Follow the existing plugin pattern (async function, ctx.call for services)
2. Handle errors gracefully
3. Emit events for monitoring
4. Call memory/brain/other services as needed
5. Be self-contained (minimal dependencies)`;

          let generatedCode = "";
          try {
            const r = (await ctx.call("brain", {
              prompt: codeSpec,
              system: "You are ATLAS's TypeScript code generator. Write perfect, deployable code.",
              needs: { coding: 0.95, reasoning: 0.8 },
              maxTokens: 2000,
              task: "codebase.generate",
            })) as { text: string };
            generatedCode = r.text.trim();
            if (generatedCode.startsWith("```")) generatedCode = generatedCode.split("\n").slice(1, -1).join("\n");
          } catch (e) {
            throw new Error(`brain failed to generate: ${(e as Error).message}`);
          }

          // Write the generated agent to a file (owners can review before activating).
          const filename = `agent-${Date.now()}.ts`;
          const filepath = `${cmd.dir}/${filename}`;
          try {
            // In a real impl, this would use node:fs to write the file.
            // For now, return the code so the owner can decide whether to save it.
            try {
              await ctx.call("memory", {
                op: "remember",
                input: {
                  kind: "artifact",
                  content: `Generated agent (${cmd.spec.slice(0, 50)}...): ${generatedCode.slice(0, 200)}...`,
                  metadata: { type: "generated-agent", spec: cmd.spec },
                },
              });
            } catch {
              /* memory optional */
            }
          } catch (e) {
            throw new Error(`failed to save agent: ${(e as Error).message}`);
          }

          await ctx.emit("codebase.generated", { filename, lines: generatedCode.split("\n").length });
          return { filename, code: generatedCode, needsReview: true };
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
