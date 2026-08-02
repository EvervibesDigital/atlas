import { basename } from "node:path";

/**
 * Pure, testable helpers shared by renderers. Kept free of ffmpeg/exec calls so
 * they can be unit-tested without a real video pipeline.
 */

/** Wrap text into lines of at most ~maxLen chars (word boundaries), unescaped. */
export function wrapLines(text: string, maxLen: number): string[] {
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
  return lines;
}

/** Wrap text to `maxLen`-char lines for ffmpeg's drawtext filter, one line per array entry, newline-joined and escaped for ffmpeg's filter syntax. */
export function wrapText(text: string, maxLen: number): string {
  return wrapLines(text, maxLen).join("\n").replace(/'/g, "'\\\\''");
}

/**
 * Escape a filesystem path for use inside an ffmpeg filter option value
 * (e.g. drawtext's textfile='…'). Backslashes become forward slashes and the
 * drive colon is escaped, since ':' separates filter options.
 */
export function ffmpegFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

function formatSrtTimestamp(totalSeconds: number): string {
  const clamped = Math.max(totalSeconds, 0);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(ms, 3)}`;
}

/**
 * Build a single-cue SRT file spanning the whole clip duration, for ffmpeg's
 * `subtitles` filter. Used instead of `drawtext` — some ffmpeg-static builds
 * (confirmed: the Linux x64 5.3.0 binary this repo pulls) compile in
 * `subtitles`/`ass` (via libass) but not `drawtext`, even with libfreetype
 * enabled.
 */
export function buildSrt(text: string, durationSec: number, maxLineLen: number): string {
  const lines = wrapLines(text, maxLineLen);
  const end = formatSrtTimestamp(Math.max(durationSec, 0.1));
  return `1\n00:00:00,000 --> ${end}\n${lines.join("\n")}\n`;
}

/** Parse an ffmpeg stderr blob for `Duration: HH:MM:SS.CC`, returning seconds or null if absent. */
export function parseFfmpegDuration(stderr: string): number | null {
  const match = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
  if (!match) return null;
  const hours = parseInt(match[1]!, 10);
  const minutes = parseInt(match[2]!, 10);
  const seconds = parseInt(match[3]!, 10);
  const centiseconds = parseInt(match[4]!, 10);
  return hours * 3600 + minutes * 60 + seconds + centiseconds / 100;
}

/**
 * Builds ffmpeg concat-demuxer list-file content from segment file paths.
 * ffmpeg resolves relative paths INSIDE a concat list relative to the list
 * file's own directory, not the process's working directory — so when the
 * segment files and the list file are siblings in the same run directory
 * (always true for these renderers), entries must be bare filenames. Writing
 * the full run-directory-prefixed path doubles the directory prefix and
 * makes ffmpeg fail with "No such file or directory" on every render.
 */
export function buildConcatFileContent(segmentPaths: string[]): string {
  return segmentPaths.map((f) => `file '${basename(f).replace(/\\/g, "/")}'`).join("\n");
}

export interface KenBurnsOptions {
  /** Scene index — picks the motion so consecutive scenes don't all move alike. */
  index: number;
  durationSec: number;
  width: number;
  height: number;
  fps?: number;
  /** Peak zoom. 1.12 ≈ a 12% push over the scene: visible, not seasick. */
  maxZoom?: number;
}

/**
 * Ken Burns motion for a still image.
 *
 * A montage of hard-cut stills reads as a slideshow, and on Reels a slideshow
 * gets scrolled past. A slow push or drift is the single largest quality gain
 * available here, and it costs nothing — no API, no key, no per-clip fee, just
 * ffmpeg filters that are already in the binary.
 *
 * Two details matter and are easy to get wrong:
 *
 * 1. **Supersample first.** `zoompan` computes its crop in integer source
 *    pixels, so applied straight to a 1080-wide image the motion visibly
 *    stair-steps. Scaling up before the zoom (and letting zoompan's `s=` bring
 *    it back down) makes each step sub-pixel at the output size, which is what
 *    turns judder into a smooth glide.
 *
 * 2. **Drive the zoom off `on`, not off `zoom`.** The common form
 *    `z='min(zoom+0.0015,1.12)'` accumulates the previous frame's value, so the
 *    end point depends on frame count and drifts between scenes of different
 *    lengths. A linear function of the output frame number lands on exactly
 *    `maxZoom` at the last frame of every scene, whatever its duration.
 */
export function kenBurnsFilter(opts: KenBurnsOptions): string {
  const fps = opts.fps ?? 30;
  const maxZoom = opts.maxZoom ?? 1.12;
  // At least one frame, so a very short scene can't produce a divide-by-zero
  // in the zoom expression below.
  const frames = Math.max(1, Math.round(opts.durationSec * fps));
  const zoomSpan = (maxZoom - 1).toFixed(4);

  // Supersample by 2x. Higher is smoother but memory scales with the square,
  // and 2x is already past the point where stepping is visible at 1080p.
  const superW = opts.width * 2;
  const superH = opts.height * 2;
  // `increase` + crop fills the vertical frame from any source aspect rather
  // than letterboxing a landscape image into a Reel.
  const fill = `scale=${superW}:${superH}:force_original_aspect_ratio=increase,crop=${superW}:${superH}`;

  const centerX = `iw/2-(iw/zoom/2)`;
  const centerY = `ih/2-(ih/zoom/2)`;
  const zoomIn = `1+${zoomSpan}*on/${frames}`;
  const zoomOut = `${maxZoom}-${zoomSpan}*on/${frames}`;

  // Three motions on rotation. Cycling by index keeps a multi-scene reel from
  // pulsing in and out on a two-beat loop, which reads as a glitch.
  let z: string;
  let x = centerX;
  let y = centerY;
  switch (opts.index % 3) {
    case 0:
      z = zoomIn;
      break;
    case 1:
      z = zoomOut;
      break;
    default:
      // Slow drift down the frame while pushing in — the classic documentary move.
      z = zoomIn;
      y = `(ih-ih/zoom)*on/${frames}`;
  }

  return `${fill},zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${opts.width}x${opts.height}:fps=${fps}`;
}

export interface MusicBedOptions {
  /** Music level before ducking. 0.18 sits under speech without vanishing. */
  musicVolume?: number;
  /** How far the bed drops while narration plays. Higher ratio = harder duck. */
  duckRatio?: number;
  /** Seconds of fade at the end so the bed doesn't stop dead on the last word. */
  fadeOutSec?: number;
  /** Total video length, needed to place the fade. */
  durationSec: number;
}

/**
 * ffmpeg `-filter_complex` for laying a music bed under existing narration.
 *
 * Three decisions worth stating, because the obvious version of each is wrong:
 *
 * 1. **Applied to the finished concatenated video, not per scene.** Mixing per
 *    segment restarts the track on every cut, which sounds like a skipping
 *    record rather than a soundtrack.
 *
 * 2. **Ducked by sidechain compression, not a fixed low volume.** A bed quiet
 *    enough to never bury narration is too quiet to hear in the gaps. Sidechain
 *    ducking lets it breathe between lines and pull back under speech. Note the
 *    argument order: `[bed][voice]sidechaincompress` compresses the FIRST input
 *    using the SECOND as the trigger — reversed, it ducks the narration under
 *    the music, which is exactly backwards and still renders happily.
 *
 * 3. **`duration=first` on the amix.** The music is loop-extended by the caller
 *    (`-stream_loop -1`), so mixing to the longest input would run forever.
 *
 * 4. **`normalize=0` on the amix.** This one was caught by measuring the output
 *    rather than reading it: amix divides by the input count by default, so
 *    adding a bed made the NARRATION 6 dB quieter — measured -21.1 dB against
 *    -27.1 dB over the same window. The render succeeded, the file was valid,
 *    and the voice was simply harder to hear. `alimiter` then catches the
 *    clipping that un-normalized summing can otherwise cause.
 */
export function buildMusicBedFilter(opts: MusicBedOptions): string {
  const volume = opts.musicVolume ?? 0.18;
  const ratio = opts.duckRatio ?? 8;
  const fade = opts.fadeOutSec ?? 2;
  // Never start the fade before zero on a clip shorter than the fade itself.
  const fadeStart = Math.max(0, opts.durationSec - fade);
  return [
    `[1:a]volume=${volume},afade=t=out:st=${fadeStart.toFixed(2)}:d=${fade}[bed]`,
    `[bed][0:a]sidechaincompress=threshold=0.03:ratio=${ratio}:attack=20:release=400[ducked]`,
    `[0:a][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`,
  ].join(";");
}

export interface RenderReview {
  ok: boolean;
  issues: string[];
}

/**
 * Post-render sanity check (OpenMontage calls this "self-review": inspect the
 * output before declaring success rather than trusting the render step blindly).
 * Pure so it's testable without touching a real file — callers pass in
 * already-measured size/duration.
 */
export function reviewRender(input: {
  sizeBytes: number;
  durationSec: number;
  expectedScenes: number;
  expectedMinDurationSec: number;
}): RenderReview {
  const issues: string[] = [];
  if (input.sizeBytes <= 0) issues.push("output file is empty");
  if (input.expectedScenes > 0 && input.durationSec <= 0) issues.push("rendered duration is zero");
  if (input.durationSec > 0 && input.durationSec < input.expectedMinDurationSec) {
    issues.push(`rendered duration ${input.durationSec.toFixed(1)}s is shorter than the expected minimum ${input.expectedMinDurationSec.toFixed(1)}s`);
  }
  return { ok: issues.length === 0, issues };
}
