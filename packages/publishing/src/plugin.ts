import type { Plugin } from "@atlas/core";
import type { Approval } from "@atlas/approvals";
import type { PublishCommand, PublishInput, PublishResult } from "./types";
import { validateForInstagram } from "./instagram";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DryRunPublisher, type Publisher } from "./publisher";
import { VideoRenderer, NoOpRenderer, type Renderer } from "./video-renderer";
import { MontageRenderer } from "./montage-renderer";

/**
 * Locate a Piper install. Precedence: PIPER_BIN/PIPER_MODEL env vars, then the
 * repo-relative `tools/piper/` convention (piper binary + any .onnx voice in
 * the same folder) — the same path works on Mat's laptop and inside the Linux
 * cloud container, so installing Piper there lights up rendering on both with
 * zero further config.
 */
function findPiper(): { bin: string; model: string } | null {
  const envBin = process.env.PIPER_BIN;
  const envModel = process.env.PIPER_MODEL;
  if (envBin && envModel && existsSync(envBin) && existsSync(envModel)) return { bin: envBin, model: envModel };

  const dir = join(process.cwd(), "tools", "piper");
  for (const bin of [join(dir, "piper.exe"), join(dir, "piper")]) {
    if (!existsSync(bin)) continue;
    try {
      const voice = readdirSync(dir).find((f) => f.endsWith(".onnx"));
      if (voice) return { bin, model: join(dir, voice) };
    } catch {
      /* unreadable dir — treat as not installed */
    }
  }
  return null;
}

/**
 * Renderer selection, best-first:
 *  1. MontageRenderer — cross-platform (Piper TTS + post-render self-review);
 *     picked whenever a Piper install is found (env vars or tools/piper/).
 *  2. VideoRenderer — legacy Windows-only edge-tts path, kept as fallback so
 *     nothing regresses if Piper is removed.
 *  3. NoOpRenderer — safe default everywhere else; the cloud deploy degrades
 *     safely with zero config instead of hanging every automated cycle.
 */
function defaultRenderer(): Renderer {
  const piper = findPiper();
  if (piper) {
    console.log(`[publishing] Piper found at ${piper.bin} — using MontageRenderer (cross-platform).`);
    return new MontageRenderer({ tempDir: "./data/temp", piperBin: piper.bin, piperModel: piper.model });
  }
  const edgeTtsPath = "C:\\Users\\matbr\\claudecode1\\waverider-bot\\.venv\\Scripts\\edge-tts.exe";
  if (!existsSync(edgeTtsPath)) {
    console.warn("[publishing] Neither Piper (tools/piper/) nor edge-tts found — using NoOpRenderer (no video will be rendered).");
    return new NoOpRenderer();
  }
  return new VideoRenderer({ tempDir: "./data/temp" });
}

/**
 * Publishing plugin — exposes the "publishing" service for Instagram Reels.
 *
 * Flow (nothing posts without human approval):
 *   publish → validate → request approval (risk L2) → returns pending-approval
 *   ...later... approval.granted → run the Publisher (dry-run by default)
 *                                → emit reel.published
 *
 * The default Publisher is DryRunPublisher, so ATLAS is fully wired to post but
 * posts nothing until a live publisher is injected here.
 */
export function createPublishingPlugin(opts: { publisher?: Publisher; renderer?: Renderer } = {}): Plugin {
  const publisher = opts.publisher ?? new DryRunPublisher();

  return {
    manifest: {
      name: "publishing",
      version: "0.1.0",
      capabilities: ["publishing"],
      permissions: ["call:approvals"],
      role: "executor",
    },

    register(ctx) {
      // Pending posts, keyed by the approval they're waiting on.
      const jobs = new Map<string, PublishInput>();
      const renderer = opts.renderer ?? defaultRenderer();

      // When Mat approves, run the publisher for the matching job.
      ctx.on("approval.granted", async (payload) => {
        const approval = payload as Approval;
        const job = jobs.get(approval.id);
        if (!job) return;
        jobs.delete(approval.id);
        const result = await publisher.publish(job);
        await ctx.emit("reel.published", { approvalId: approval.id, result, personaHandle: job.personaHandle });
      });

      ctx.provide("publishing", async (payload) => {
        const cmd = payload as PublishCommand;

        if (cmd.op === "render") {
          const videoPath = await renderer.render(cmd.spec);
          return { videoPath };
        }

        if (cmd.op === "validate") {
          const check = validateForInstagram(cmd.input);
          return { status: check.ok ? "dry-run" : "rejected", detail: check.problems.join("; ") || "valid" } satisfies PublishResult;
        }

        if (cmd.op === "publish") {
          const check = validateForInstagram(cmd.input);
          if (!check.ok) return { status: "rejected", detail: check.problems.join("; ") } satisfies PublishResult;
          if (!cmd.input.videoRef) return { status: "pending-render", detail: "no rendered MP4 yet" } satisfies PublishResult;

          const approval = (await ctx.call("approvals", {
            op: "request",
            action: `Post Reel to Instagram (${cmd.input.personaHandle})`,
            detail: cmd.input.caption.slice(0, 120),
            risk: 2,
          })) as Approval;

          jobs.set(approval.id, cmd.input);
          return { status: "pending-approval", detail: `awaiting approval ${approval.id}`, approvalId: approval.id } satisfies PublishResult;
        }

        throw new Error(`publishing: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
