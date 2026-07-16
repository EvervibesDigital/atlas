import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import ffmpegPath from "ffmpeg-static";

const execAsync = promisify(exec);

/** Anything that can turn a Reel spec into a rendered video file path. */
export interface Renderer {
  render(spec: { voice: string; voiceProvider?: string; voiceId?: string; scenes: Array<{ text: string; imageUrl: string; imagePrompt?: string }> }): Promise<string>;
}

/**
 * SAFE DEFAULT for anywhere the real VideoRenderer isn't viable — tests, and
 * any environment without its Windows-specific edge-tts path + network image
 * generation (e.g. the Linux cloud deploy). Returns instantly, renders
 * nothing. Mirrors DryRunPublisher's role for the render step.
 */
export class NoOpRenderer implements Renderer {
  async render(): Promise<string> {
    return "";
  }
}

export interface VideoRendererOptions {
  tempDir: string;
  edgeTtsPath?: string;
}

export class VideoRenderer implements Renderer {
  private tempDir: string;
  private edgeTtsPath: string;

  constructor(opts: VideoRendererOptions) {
    this.tempDir = opts.tempDir;
    // Default to the installed Python virtual environment path on Mat's machine
    this.edgeTtsPath = opts.edgeTtsPath ?? "C:\\Users\\matbr\\claudecode1\\waverider-bot\\.venv\\Scripts\\edge-tts.exe";
  }

  async render(spec: {
    voice: string;
    voiceProvider?: string;
    voiceId?: string;
    scenes: Array<{ text: string; imageUrl: string; imagePrompt?: string }>;
  }): Promise<string> {
    // Create a unique folder inside tempDir
    const runId = Math.random().toString(36).substring(7);
    const runDir = path.join(this.tempDir, `render-${runId}`);
    await fs.mkdir(runDir, { recursive: true });

    const segmentFiles: string[] = [];

    try {
      console.log(`[VideoRenderer] Starting render inside ${runDir}...`);

      for (let i = 0; i < spec.scenes.length; i++) {
        const scene = spec.scenes[i]!;
        console.log(`[VideoRenderer] Processing scene ${i + 1}/${spec.scenes.length}...`);

        // 1. Download the generated image
        const imgPath = path.join(runDir, `scene_${i}.jpg`);
        let imageDownloaded = false;
        const falKey = process.env.FAL_API_KEY || process.env.FAL_KEY;

        if (falKey && scene.imagePrompt) {
          try {
            console.log(`[VideoRenderer] Generating hyper-realistic image via Fal.ai Flux for scene ${i + 1}...`);
            const falRes = await fetch("https://queue.fal.run/fal-ai/flux/schnell", {
              method: "POST",
              headers: {
                "Authorization": `Key ${falKey}`,
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                prompt: scene.imagePrompt,
                image_size: { width: 1080, height: 1920 },
                sync_mode: true
              })
            });
            if (falRes.ok) {
              const falData = await falRes.json() as any;
              const falImgUrl = falData?.images?.[0]?.url;
              if (falImgUrl) {
                const imgRes = await fetch(falImgUrl);
                if (imgRes.ok) {
                  const arrayBuffer = await imgRes.arrayBuffer();
                  await fs.writeFile(imgPath, Buffer.from(arrayBuffer));
                  imageDownloaded = true;
                }
              }
            } else {
              console.warn(`[VideoRenderer] Fal.ai API failed with status ${falRes.status}, falling back to default image URL`);
            }
          } catch (e) {
            console.warn(`[VideoRenderer] Fal.ai API error: ${(e as Error).message}, falling back to default image URL`);
          }
        }

        if (!imageDownloaded) {
          const response = await fetch(scene.imageUrl);
          if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);
          const arrayBuffer = await response.arrayBuffer();
          await fs.writeFile(imgPath, Buffer.from(arrayBuffer));
        }

        // 2. Generate the scene narration audio
        const audioPath = path.join(runDir, `scene_${i}.mp3`);
        const safeText = scene.text.replace(/"/g, '\\"');
        const voice = spec.voice || "en-US-AriaNeural";

        let audioGenerated = false;
        const apiKey = process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_LABS_API_KEY;
        const elevenVoiceId = spec.voiceId || "21m00Tcm4TlvDq8ikWAM"; // Rachel fallback

        if (apiKey && spec.voiceProvider === "elevenlabs") {
          try {
            console.log(`[VideoRenderer] Using ElevenLabs API for scene ${i + 1}...`);
            const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${elevenVoiceId}`, {
              method: "POST",
              headers: {
                "xi-api-key": apiKey,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                text: scene.text,
                model_id: "eleven_monolingual_v1",
                voice_settings: { stability: 0.5, similarity_boost: 0.75 }
              })
            });
            if (res.ok) {
              const audioBuffer = await res.arrayBuffer();
              await fs.writeFile(audioPath, Buffer.from(audioBuffer));
              audioGenerated = true;
            } else {
              console.warn(`[VideoRenderer] ElevenLabs API failed with status ${res.status}, falling back to edge-tts`);
            }
          } catch (e) {
            console.warn(`[VideoRenderer] ElevenLabs API error: ${(e as Error).message}, falling back to edge-tts`);
          }
        }

        if (!audioGenerated) {
          // Execute edge-tts fallback
          const cmd = `"${this.edgeTtsPath}" --voice "${voice}" --text "${safeText}" --write-media "${audioPath}"`;
          await execAsync(cmd);
        }

        // 3. Get audio duration using FFmpeg
        const duration = await this.getAudioDuration(audioPath);
        console.log(`[VideoRenderer] Scene ${i + 1} audio duration: ${duration}s`);

        // 4. Render this segment: merge image + audio and overlay text
        const segmentPath = path.join(runDir, `segment_${i}.mp4`);
        const wrappedText = this.wrapText(scene.text, 35);
        const drawTextFilter = `drawtext=text='${wrappedText}':fontcolor=white:fontsize=40:box=1:boxcolor=black@0.6:boxborderw=12:x=(w-text_w)/2:y=h-350`;

        const renderCmd = `"${ffmpegPath}" -y -loop 1 -i "${imgPath}" -i "${audioPath}" -vf "${drawTextFilter}" -c:v libx264 -t ${duration} -c:a aac -pix_fmt yuv420p "${segmentPath}"`;
        await execAsync(renderCmd);

        segmentFiles.push(segmentPath);
      }

      // 5. Concatenate all segments into the final video
      console.log("[VideoRenderer] Concatenating all segments...");
      const concatListPath = path.join(runDir, "concat.txt");
      const concatContent = segmentFiles.map(f => `file '${f.replace(/\\/g, "/")}'`).join("\n");
      await fs.writeFile(concatListPath, concatContent);

      const finalPath = path.join(this.tempDir, `final_reel_${runId}.mp4`);
      const concatCmd = `"${ffmpegPath}" -y -f concat -safe 0 -i "${concatListPath}" -c copy "${finalPath}"`;
      await execAsync(concatCmd);

      console.log(`[VideoRenderer] Successfully rendered final video at ${finalPath}`);
      return finalPath;
    } catch (err) {
      console.error("[VideoRenderer] Failed to render video:", err);
      throw err;
    } finally {
      // Clean up temp files
      try {
        await fs.rm(runDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        console.error("[VideoRenderer] Failed to clean up temp files:", cleanupErr);
      }
    }
  }

  private async getAudioDuration(audioPath: string): Promise<number> {
    try {
      const cmd = `"${ffmpegPath}" -i "${audioPath}"`;
      const { stderr } = await execAsync(cmd).catch(err => err);
      const match = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (match) {
        const hours = parseInt(match[1]!, 10);
        const minutes = parseInt(match[2]!, 10);
        const seconds = parseInt(match[3]!, 10);
        const centiseconds = parseInt(match[4]!, 10);
        return hours * 3600 + minutes * 60 + seconds + centiseconds / 100;
      }
      return 5.0;
    } catch {
      return 5.0;
    }
  }

  private wrapText(text: string, maxLen: number): string {
    const words = text.split(" ");
    let line = "";
    const lines: string[] = [];
    for (const w of words) {
      if ((line + w).length > maxLen) {
        lines.push(line.trim());
        line = "";
      }
      line += w + " ";
    }
    if (line) lines.push(line.trim());
    return lines.join("\n").replace(/'/g, "'\\\\''");
  }
}
