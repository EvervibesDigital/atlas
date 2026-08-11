import type { Plugin } from "@atlas/core";
import type { Approval } from "@atlas/approvals";
import type { PublishCommand, PublishInput, PublishResult } from "./types";
import { validateForInstagram } from "./instagram";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DryRunPublisher, type Publisher } from "./publisher";
import { VideoRenderer, NoOpRenderer, type Renderer } from "./video-renderer";
import { MontageRenderer } from "./montage-renderer";
import { enqueueJob, type VideoRenderJob } from "./video-queue";
import { captionProblem, duplicateOf, previewCaption, hookKey, captionHook } from "./caption";

/**
 * Locate a Piper install. Precedence: PIPER_BIN/PIPER_MODEL env vars, then the
 * repo-relative `tools/piper/` convention (piper binary + any .onnx voice in
 * the same folder) — the same path works on Mat's laptop and inside the Linux
 * cloud container, so installing Piper there lights up rendering on both with
 * zero further config.
 */
function findPiper(): { bin: string; model: string } | null {
  // @atlas-optional-secret PIPER_BIN — auto-detected under tools/piper/ when unset.
  // @atlas-optional-secret PIPER_MODEL — auto-detected alongside the binary.
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
export function createPublishingPlugin(opts: { publisher?: Publisher; renderer?: Renderer; videoJobsFile?: string } = {}): Plugin {
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
      const videoJobsPath = opts.videoJobsFile ?? "data/video-jobs.json";

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

        if (cmd.op === "enqueueRender") {
          const raw = await readFile(videoJobsPath, "utf8").catch(() => "[]");
          const existing = JSON.parse(raw) as VideoRenderJob[];
          const updated = enqueueJob(existing, cmd.spec, cmd.contentId, cmd.publishInput);
          await writeFile(videoJobsPath, JSON.stringify(updated), "utf8");
          const job = updated[updated.length - 1]!;
          return { jobId: job.id };
        }

        if (cmd.op === "renderQueuedJob") {
          const videoPath = await renderer.render(cmd.spec as Parameters<typeof renderer.render>[0]);
          return { videoPath };
        }

        if (cmd.op === "getVideoJob") {
          const raw = await readFile(videoJobsPath, "utf8").catch(() => "[]");
          const jobs = JSON.parse(raw) as VideoRenderJob[];
          const job = jobs.find((j) => j.id === cmd.jobId);
          return { job: job ?? null };
        }

        /**
         * Clear duplicate Reels already sitting in the approval queue.
         *
         * The gate in `publish` stops NEW duplicates; this clears the backlog
         * that accumulated before it existed — 50 pending Reels carrying 15
         * distinct hooks on 2026-08-02.
         *
         * Keeps the OLDEST of each hook and rejects the rest: the first one
         * queued is the one whose rendered video has been sitting ready
         * longest, and rejecting an approval is reversible in a way that
         * deleting a render is not.
         *
         * `dryRun` defaults to true — this rejects real queued work, so seeing
         * the list has to be the default and acting on it the explicit choice.
         */
        if (cmd.op === "dedupePending") {
          const dryRun = cmd.dryRun !== false;
          const listed = (await ctx.call("approvals", { op: "list", status: "pending" })) as
            | Array<{ id: string; action?: string; detail?: string; createdAt?: string }>
            | { approvals?: Array<{ id: string; action?: string; detail?: string; createdAt?: string }> };
          const rows = Array.isArray(listed) ? listed : (listed.approvals ?? []);
          const reels = rows
            .filter((r) => (r.action ?? "").startsWith("Post Reel"))
            .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

          const seen = new Map<string, string>();
          const duplicates: Array<{ id: string; hook: string; keptId: string }> = [];
          for (const r of reels) {
            const key = hookKey(r.detail ?? "");
            if (!key) continue;
            const keptId = seen.get(key);
            if (keptId) duplicates.push({ id: r.id, hook: captionHook(r.detail ?? ""), keptId });
            else seen.set(key, r.id);
          }

          let rejected = 0;
          if (!dryRun) {
            for (const d of duplicates) {
              try {
                await ctx.call("approvals", { op: "reject", id: d.id });
                rejected++;
              } catch {
                /* one failure must not strand the rest of the cleanup */
              }
            }
          }
          return { dryRun, pendingReels: reels.length, uniqueHooks: seen.size, duplicates: duplicates.length, rejected, examples: duplicates.slice(0, 5) };
        }

        /**
         * Upload a rendered video to YouTube.
         *
         * `confirmUpload: true` is a required literal, same shape as
         * sender's confirmSend and enrichment's confirmCost: this publishes
         * under Mat's channel, so an autonomous cycle must not be able to do
         * it by forgetting a flag.
         *
         * Reports the privacy YouTube ACTUALLY set. An unverified app has
         * every upload forced private regardless of what was asked for, and a
         * caller that assumed "public" would wait for views on an invisible
         * video.
         */
        if (cmd.op === "uploadYouTube") {
          if (cmd.confirmUpload !== true) {
            throw new Error(
              `publishing: refusing to upload to YouTube without confirmUpload:true — this publishes to Mat's channel.`,
            );
          }
          const { uploadVideo, validateMetadata } = await import("./youtube");
          const creds = {
            clientId: (await ctx.secret("YOUTUBE_CLIENT_ID")) ?? "",
            clientSecret: (await ctx.secret("YOUTUBE_CLIENT_SECRET")) ?? "",
            refreshToken: (await ctx.secret("YOUTUBE_REFRESH_TOKEN")) ?? "",
          };
          const missing = Object.entries(creds).filter(([, v]) => !v).map(([k]) => k);
          if (missing.length) {
            throw new Error(`publishing: YouTube not configured — missing ${missing.map((m) => "YOUTUBE_" + m.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()).join(", ")}. Uploads need OAuth, not an API key.`);
          }

          const problems = validateMetadata(cmd.metadata);
          if (problems.length) return { status: "rejected", detail: problems.join("; ") } satisfies PublishResult;

          // Keep the read inside the working directory: the path can come
          // from a queued job, and a traversal would read arbitrary files.
          const full = resolve(process.cwd(), cmd.videoPath);
          if (!full.startsWith(resolve(process.cwd()))) {
            throw new Error("publishing: video path escapes the working directory");
          }
          const bytes = new Uint8Array(await readFile(full));

          const result = await uploadVideo({ bytes }, cmd.metadata, creds);
          await ctx.emit("youtube.uploaded", result);
          return {
            status: "posted",
            detail: result.privacyDowngraded
              ? `uploaded as ${result.privacyStatus} — YouTube overrode the requested privacy (the app is not OAuth-verified, so uploads are forced private). ${result.url}`
              : `uploaded ${result.privacyStatus}: ${result.url}`,
          } satisfies PublishResult;
        }

        if (cmd.op === "validate") {
          const check = validateForInstagram(cmd.input);
          return { status: check.ok ? "dry-run" : "rejected", detail: check.problems.join("; ") || "valid" } satisfies PublishResult;
        }

        if (cmd.op === "publish") {
          const check = validateForInstagram(cmd.input);
          if (!check.ok) return { status: "rejected", detail: check.problems.join("; ") } satisfies PublishResult;
          if (!cmd.input.videoRef) return { status: "pending-render", detail: "no rendered MP4 yet" } satisfies PublishResult;

          const captionIssue = captionProblem(cmd.input.caption);
          if (captionIssue) return { status: "rejected", detail: captionIssue } satisfies PublishResult;

          // Refuse a hook already waiting in the queue. On 2026-08-02 this
          // check would have stopped 35 of 50 pending Reels: the generator had
          // looped on 15 distinct hooks for two days, one of them 19 times.
          // Nothing caught it because each approval looks fine on its own.
          try {
            const pending = (await ctx.call("approvals", { op: "list", status: "pending" })) as
              | Array<{ action?: string; detail?: string }>
              | { approvals?: Array<{ action?: string; detail?: string }> };
            const rows = Array.isArray(pending) ? pending : (pending.approvals ?? []);
            const reelCaptions = rows
              .filter((r) => (r.action ?? "").startsWith("Post Reel"))
              .map((r) => r.detail ?? "");
            const dupe = duplicateOf(cmd.input.caption, reelCaptions);
            if (dupe) {
              return {
                status: "rejected",
                detail: `duplicate hook — "${dupe}" is already waiting for approval. Vary the hook before queueing another.`,
              } satisfies PublishResult;
            }
          } catch {
            // If the queue can't be read, queue the Reel anyway: a duplicate is
            // a quality problem, but silently dropping content because a list
            // call failed is a worse one.
          }

          const approval = (await ctx.call("approvals", {
            op: "request",
            action: `Post Reel to Instagram (${cmd.input.personaHandle})`,
            // previewCaption, not slice(): a hard cut lands mid-hashtag and
            // makes a healthy caption look like a failed generation.
            detail: previewCaption(cmd.input.caption, 120),
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
