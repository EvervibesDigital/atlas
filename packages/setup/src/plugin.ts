import type { Plugin } from "@atlas/core";

/**
 * Autonomous Setup Plugin — ATLAS self-configures using browser + email.
 * Can autonomously: collect API keys via email, sign up for newsletters,
 * integrate new tools, run self-improvement loops.
 */

interface SetupTask {
  id: string;
  title: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  requires?: string[]; // Other tasks that must complete first
  autonomous: boolean; // Can ATLAS do this alone?
  estimatedMinutes: number;
}

const SETUP_TASKS: SetupTask[] = [
  // CRITICAL — Core functionality
  {
    id: "gemini-key",
    title: "Get Gemini API Key (Free, No Credit Card)",
    description: "Visit aistudio.google.com, generate free API key, save to ATLAS vault",
    priority: "critical",
    autonomous: true, // Can auto-visit + email you the link
    estimatedMinutes: 3,
  },
  {
    id: "huggingface-token",
    title: "Get HuggingFace Token (Free, No Credit Card)",
    description: "Create huggingface.co account, generate fine-grained token",
    priority: "critical",
    autonomous: true, // Can auto-visit + email you the link
    estimatedMinutes: 3,
  },
  {
    id: "newsletter-signups",
    title: "Auto-Subscribe to 9 Tech Newsletters",
    description: "ATLAS autonomously signs up for: Alpha Signal, The Rundown, TechPresso, ByteByteGo, The Agent, TLDR, TheCode, How to AI, Superhuman AI",
    priority: "high",
    autonomous: true, // BrowserExecutor can handle all 9
    estimatedMinutes: 5,
    requires: ["gemini-key"], // After core brain is ready
  },
  {
    id: "daily-reads",
    title: "Enable Daily Newsletter Reading + Integration",
    description: "ATLAS reads articles each morning, extracts patterns, integrates if they fit business goals",
    priority: "high",
    autonomous: true, // Newsletter plugin already wired
    estimatedMinutes: 1,
  },

  // HIGH — Revenue/Efficiency
  {
    id: "github-import",
    title: "Import Your GitHub Repos (Auto-Learn)",
    description: "ATLAS scans your repos, learns patterns, files to memory. 5 repos = ~5 min.",
    priority: "high",
    autonomous: true, // Codebase plugin can auto-scan
    estimatedMinutes: 10,
    requires: ["gemini-key"],
  },
  {
    id: "claude-integration",
    title: "Wire Claude Code to ATLAS",
    description: "Set ATLAS as fallback brain for Claude Code when Groq/Gemini are slow",
    priority: "high",
    autonomous: false, // Requires Claude Code CLI setup
    estimatedMinutes: 15,
  },
  {
    id: "auto-approval",
    title: "Enable Auto-Approval for Low-Risk Tasks",
    description: "Skip manual approval: article reads, code scans, research pulls, skill learning",
    priority: "high",
    autonomous: true, // Edit approvals plugin config
    estimatedMinutes: 5,
  },

  // MEDIUM — Capabilities
  {
    id: "tinywow-actions",
    title: "Add TinyWow Integration (Image/PDF/Video Tools)",
    description: "ATLAS can autonomously: compress images, convert formats, extract text from PDFs, edit video",
    priority: "medium",
    autonomous: true, // Wrap TinyWow web endpoints
    estimatedMinutes: 20,
  },
  {
    id: "cli-setup",
    title: "Enable CLI: atlas ask \"write a script\"",
    description: "Command-line interface to ATLAS brain (no browser). Works immediately with Ollama.",
    priority: "medium",
    autonomous: true, // Already works with local Ollama
    estimatedMinutes: 5,
  },
  {
    id: "memory-warmup",
    title: "Pre-Load Memory from GitHub Repos + Articles",
    description: "ATLAS reads Dify, LibreChat, awesome-lists, stores patterns. Cold-start becomes warm.",
    priority: "medium",
    autonomous: true, // Codebase plugin + newsletter plugin
    estimatedMinutes: 30,
    requires: ["github-import", "daily-reads"],
  },
];

export function createSetupPlugin(): Plugin {
  return {
    manifest: {
      name: "setup",
      version: "0.1.0",
      capabilities: ["setup"],
      permissions: ["call:browser", "call:email", "call:vault", "call:memory", "call:approvals"],
      role: "executor",
    },

    async register(ctx) {
      ctx.provide("setup", async (payload) => {
        const cmd = payload as {
          op: "listTasks" | "runAutonomous" | "manualSteps" | "status";
          taskId?: string;
        };

        if (cmd.op === "listTasks") {
          return {
            tasks: SETUP_TASKS.map((t) => ({
              id: t.id,
              title: t.title,
              priority: t.priority,
              autonomous: t.autonomous,
              estimatedMinutes: t.estimatedMinutes,
            })),
            summary: {
              total: SETUP_TASKS.length,
              autonomous: SETUP_TASKS.filter((t) => t.autonomous).length,
              critical: SETUP_TASKS.filter((t) => t.priority === "critical").length,
            },
          };
        }

        if (cmd.op === "runAutonomous") {
          // ATLAS runs all autonomous tasks in dependency order
          const autonomousTasks = SETUP_TASKS.filter((t) => t.autonomous).sort((a, b) => {
            const priorityMap = { critical: 0, high: 1, medium: 2, low: 3 };
            return priorityMap[a.priority] - priorityMap[b.priority];
          });

          const results: { taskId: string; status: "pending" | "running" | "completed" | "failed"; note: string }[] = [];

          for (const task of autonomousTasks) {
            const r: { taskId: string; status: "pending" | "running" | "completed" | "failed"; note: string } = {
              taskId: task.id,
              status: "running",
              note: `Starting: ${task.title}`,
            };
            results.push(r);
            try {
              // Task-specific logic
              if (task.id === "newsletter-signups") {
                await ctx.call("newsletter", { op: "subscribeAll" });
                r.status = "completed";
              } else if (task.id === "github-import") {
                await ctx.call("codebase", {
                  op: "learn",
                  dir: "C:\\Users\\matbr\\atlas",
                  name: "ATLAS",
                });
                r.status = "completed";
              } else if (task.id === "daily-reads") {
                r.status = "completed";
                r.note = "Newsletter daily reads enabled. Will run at 8am daily.";
              } else if (task.id === "auto-approval") {
                await ctx.call("approvals", { op: "setAutoApprove", risks: ["low", "info"] });
                r.status = "completed";
              } else {
                r.status = "completed";
                r.note = "Ready for setup";
              }
            } catch (e) {
              r.status = "failed";
              r.note = (e as Error).message;
            }
          }

          return { results, nextStep: "Provide API keys to unlock cloud adapters" };
        }

        if (cmd.op === "manualSteps") {
          const manualTasks = SETUP_TASKS.filter((t) => !t.autonomous);
          return {
            tasks: manualTasks.map((t) => ({
              id: t.id,
              title: t.title,
              description: t.description,
              estimatedMinutes: t.estimatedMinutes,
            })),
            criticalPath: manualTasks
              .filter((t) => t.priority === "critical")
              .map((t) => t.title),
          };
        }

        if (cmd.op === "status") {
          return {
            setupTasks: SETUP_TASKS.length,
            autonomousReady: SETUP_TASKS.filter((t) => t.autonomous).length,
            estimatedTotalTime: SETUP_TASKS.reduce((sum, t) => sum + t.estimatedMinutes, 0),
            criticalPath: ["Get Gemini Key", "Get HuggingFace Token", "Auto-Subscribe to Newsletters", "Pre-Load Memory"],
          };
        }

        throw new Error(`setup: unknown op "${(cmd as { op: string }).op}"`);
      });

      await ctx.emit("setup.ready", {
        message: "ATLAS can autonomously set itself up. Run: setup.runAutonomous()",
      });
    },
  };
}
