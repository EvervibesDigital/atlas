import { exec, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import type { Renderer } from "./video-renderer";
import { wrapLines, ffmpegFilterPath, parseFfmpegDuration, reviewRender } from "./render-utils";

const execAsync = promisify(exec);

export interface MontageRendererOptions {
  tempDir: string;
  /** Path to the Piper TTS binary. No default — Piper must be installed separately (Mat's call, not auto-downloaded). */
  piperBin?: string;
  /** Path to a Piper .onnx voice model. */
  piperModel?: string;
}

/**
 * Cross-platform reel renderer — the OpenMontage-inspired replacement for
 * VideoRenderer's Windows-only edge-tts dependency. Two ideas borrowed from
 * OpenMontage: (1) Piper TTS for fully offline, cross-platform narration
 * (no hardcoded Windows exe path, no cloud key needed), and (2) a post-render
 * self-review step that checks the output before calling the render a success,
 * instead of trusting ffmpeg's exit code alone.
 *
 * If Piper isn't configured (no piperBin/piperModel), this behaves like
 * NoOpRenderer — same safe-default philosophy as VideoRenderer's sibling —
 * rather than silently falling back to a platform-specific TTS path.
 */
export class MontageRenderer implements Renderer {
  private tempDir: string;
  private piperBin?: string;
  private piperModel?: string;

  constructor(opts: MontageRendererOptions) {
    this.tempDir = opts.tempDir;
    this.piperBin = opts.piperBin;
    this.piperModel = opts.piperModel;
  }

  /** True once Piper is actually configured — callers/tests use this instead of guessing from render() behavior. */
  get piperReady(): boolean {
    return Boolean(this.piperBin && this.piperModel);
  }

  async render(spec: {
    voice: string;
    voiceProvider?: string;
    voiceId?: string;
    scenes: Array<{ text: string; imageUrl: string; imagePrompt?: string }>;
  }): Promise<string> {
    if (!this.piperReady) {
      console.warn("[MontageRenderer] Piper not configured (piperBin/piperModel missing) — skipping render, same as NoOpRenderer.");
      return "";
    }

    const runId = Math.random().toString(36).substring(7);
    const runDir = path.join(this.tempDir, `montage-${runId}`);
    await fs.mkdir(runDir, { recursive: true });

    const segmentFiles: string[] = [];
    let totalDuration = 0;

    try {
      console.log(`[MontageRenderer] Starting render inside ${runDir}...`);

      for (let i = 0; i < spec.scenes.length; i++) {
        const scene = spec.scenes[i]!;

        const imgPath = path.join(runDir, `scene_${i}.jpg`);
        const response = await fetch(scene.imageUrl);
        if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);
        await fs.writeFile(imgPath, Buffer.from(await response.arrayBuffer()));

        const audioPath = path.join(runDir, `scene_${i}.wav`);
        await this.synthesize(scene.text, audioPath);

        const duration = await this.getAudioDuration(audioPath);
        totalDuration += duration;

        const segmentPath = path.join(runDir, `segment_${i}.mp4`);
        // Caption goes through drawtext's textfile= option, NOT inline text=:
        // inline captions with newlines truncate the command line on Windows
        // cmd (the old VideoRenderer's latent render-killing bug) and need
        // per-shell quote escaping. A file sidesteps all of it.
        const captionPath = path.join(runDir, `caption_${i}.txt`);
        await fs.writeFile(captionPath, wrapLines(scene.text, 35).join("\n"), "utf8");
        const drawTextFilter = `drawtext=textfile='${ffmpegFilterPath(captionPath)}':fontcolor=white:fontsize=40:box=1:boxcolor=black@0.6:boxborderw=12:x=(w-text_w)/2:y=h-350`;
        const renderCmd = `"${ffmpegPath}" -y -loop 1 -i "${imgPath}" -i "${audioPath}" -vf "${drawTextFilter}" -c:v libx264 -t ${duration} -c:a aac -pix_fmt yuv420p "${segmentPath}"`;
        await execAsync(renderCmd);

        segmentFiles.push(segmentPath);
      }

      const concatListPath = path.join(runDir, "concat.txt");
      const concatContent = segmentFiles.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n");
      await fs.writeFile(concatListPath, concatContent);

      const finalPath = path.join(this.tempDir, `montage_reel_${runId}.mp4`);
      const concatCmd = `"${ffmpegPath}" -y -f concat -safe 0 -i "${concatListPath}" -c copy "${finalPath}"`;
      await execAsync(concatCmd);

      const stat = await fs.stat(finalPath);
      const review = reviewRender({
        sizeBytes: stat.size,
        durationSec: totalDuration,
        expectedScenes: spec.scenes.length,
        expectedMinDurationSec: spec.scenes.length * 1.5,
      });
      if (!review.ok) {
        throw new Error(`[MontageRenderer] self-review failed: ${review.issues.join("; ")}`);
      }

      console.log(`[MontageRenderer] Successfully rendered + self-reviewed final video at ${finalPath}`);
      return finalPath;
    } finally {
      try {
        await fs.rm(runDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        console.error("[MontageRenderer] Failed to clean up temp files:", cleanupErr);
      }
    }
  }

  private synthesize(text: string, outPath: string): Promise<void> {
    // Feed the narration through stdin rather than a shell pipe: no cmd-vs-sh
    // quoting differences, and quotes/apostrophes in the script can't break
    // (or inject into) the command line.
    return new Promise((resolve, reject) => {
      const child = spawn(this.piperBin!, ["--model", this.piperModel!, "--output_file", outPath], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`piper exited ${code}: ${stderr.slice(-300)}`));
      });
      child.stdin.write(text);
      child.stdin.end();
    });
  }

  private async getAudioDuration(audioPath: string): Promise<number> {
    try {
      const cmd = `"${ffmpegPath}" -i "${audioPath}"`;
      const { stderr } = await execAsync(cmd).catch((err) => err);
      return parseFfmpegDuration(stderr) ?? 5.0;
    } catch {
      return 5.0;
    }
  }
}
