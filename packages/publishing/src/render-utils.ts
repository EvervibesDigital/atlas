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
