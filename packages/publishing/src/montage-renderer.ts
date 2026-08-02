import { exec, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import type { Renderer } from "./video-renderer";
import { buildSrt, buildConcatFileContent, ffmpegFilterPath, parseFfmpegDuration, reviewRender, kenBurnsFilter, buildMusicBedFilter } from "./render-utils";

const execAsync = promisify(exec);

export interface MontageRendererOptions {
  tempDir: string;
  /** Path to the Piper TTS binary. No default — Piper must be installed separately (Mat's call, not auto-downloaded). */
  piperBin?: string;
  /** Path to a Piper .onnx voice model. */
  piperModel?: string;
  /** Slow zoom/pan on each still instead of a hard cut. On unless set false. */
  kenBurns?: boolean;
  /** Output frame size. Defaults to 1080x1920 — the vertical Reels format
   * every consumer of this renderer targets. */
  width?: number;
  height?: number;
  /** Path to a music file to lay under the narration. No default: the track
   * has to be one Mat holds a commercial licence for, so ATLAS must never
   * pick one on its own. Omitted = narration only, exactly as before. */
  musicTrack?: string;
  /** Bed level before ducking. See buildMusicBedFilter for the default. */
  musicVolume?: number;
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
  private kenBurns: boolean;
  private width: number;
  private musicTrack?: string;
  private musicVolume?: number;
  private height: number;
  private piperModel?: string;

  constructor(opts: MontageRendererOptions) {
    this.tempDir = opts.tempDir;
    this.piperBin = opts.piperBin;
    // On by default: a hard-cut slideshow is the single most obvious "made by
    // a bot" tell on Reels, and the motion costs nothing but ffmpeg time.
    this.kenBurns = opts.kenBurns !== false;
    this.width = opts.width ?? 1080;
    this.musicTrack = opts.musicTrack;
    this.musicVolume = opts.musicVolume;
    this.height = opts.height ?? 1920;
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
        // Caption goes through the `subtitles` filter (an SRT file), NOT
        // drawtext: the Linux x64 ffmpeg-static@5.3.0 binary this repo pulls
        // compiles in subtitles/ass (via libass) but not drawtext, even with
        // libfreetype enabled — confirmed directly against `ffmpeg -filters`
        // on the VPS, not assumed. subtitles gives the same file-based
        // (not inline-text) approach that already sidesteps the Windows
        // cmd command-line-truncation/quoting bug drawtext's textfile= was
        // chosen for originally.
        const captionPath = path.join(runDir, `caption_${i}.srt`);
        await fs.writeFile(captionPath, buildSrt(scene.text, duration, 35), "utf8");
        const subtitlesFilter = `subtitles=filename='${ffmpegFilterPath(captionPath)}':force_style='FontSize=20,PrimaryColour=&H00FFFFFF,BackColour=&H66000000,BorderStyle=3,Outline=0,Shadow=0,Alignment=2,MarginV=175'`;
        // Motion first, captions second: zoompan resizes the frame, so burning
        // subtitles before it would zoom and crop the text along with the image.
        const motionFilter = this.kenBurns
          ? kenBurnsFilter({ index: i, durationSec: duration, width: this.width, height: this.height })
          : null;
        const videoFilter = motionFilter ? `${motionFilter},${subtitlesFilter}` : subtitlesFilter;
        const renderCmd = `"${ffmpegPath}" -y -loop 1 -i "${imgPath}" -i "${audioPath}" -vf "${videoFilter}" -c:v libx264 -t ${duration} -c:a aac -pix_fmt yuv420p "${segmentPath}"`;
        await execAsync(renderCmd);

        segmentFiles.push(segmentPath);
      }

      const concatListPath = path.join(runDir, "concat.txt");
      const concatContent = buildConcatFileContent(segmentFiles);
      await fs.writeFile(concatListPath, concatContent);

      const finalPath = path.join(this.tempDir, `montage_reel_${runId}.mp4`);
      const concatCmd = `"${ffmpegPath}" -y -f concat -safe 0 -i "${concatListPath}" -c copy "${finalPath}"`;
      await execAsync(concatCmd);

      // Music goes on the finished concatenation, never per segment — mixing
      // per scene restarts the track on every cut, which sounds like a
      // skipping record instead of a soundtrack.
      if (this.musicTrack) {
        const bedded = path.join(runDir, "bedded.mp4");
        const filter = buildMusicBedFilter({ durationSec: totalDuration, musicVolume: this.musicVolume });
        // -stream_loop -1 extends a short track to cover the whole reel; the
        // amix's duration=first is what stops it running forever.
        const musicCmd = `"${ffmpegPath}" -y -i "${finalPath}" -stream_loop -1 -i "${this.musicTrack}" -filter_complex "${filter}" -map 0:v -map "[aout]" -c:v copy -c:a aac -shortest "${bedded}"`;
        try {
          await execAsync(musicCmd);
          await fs.copyFile(bedded, finalPath);
        } catch (musicErr) {
          // A missing or unreadable track must not cost the whole render — the
          // narrated video is still perfectly publishable without a bed.
          console.error(`[MontageRenderer] Music bed failed, keeping the un-bedded render:`, (musicErr as Error).message);
        }
      }

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
