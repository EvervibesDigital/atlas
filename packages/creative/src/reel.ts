import type { Persona } from "@atlas/personas";
import type { ReelScene, ReelSpec, ValidationResult } from "./types";
import { pollinationsUrl } from "./pollinations";

const REEL_WIDTH = 1080;
const REEL_HEIGHT = 1920;
const IG_CAPTION_MAX = 2200;
const IG_HASHTAG_MAX = 30;
const REEL_MAX_SEC = 90;
const REEL_MIN_SEC = 3;

/** Minimal text-generating dependency (the Brain, or a fake in tests). */
export interface TextGenerator {
  generate(req: {
    prompt: string;
    system?: string;
    needs?: Record<string, number>;
    task?: string;
  }): Promise<{ text: string }>;
}

const STOP = new Set(["the", "a", "an", "to", "of", "and", "or", "for", "with", "your", "you", "that", "this", "in", "on", "is", "are", "how", "why", "what"]);

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function keywords(text: string, n = 4): string {
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w));
  return [...new Set(words)].slice(0, n).join(" ");
}

function buildHashtags(persona: Persona, topic: string): string[] {
  const raw = [...persona.contentPillars, ...topic.split(/\s+/), "reels", "fyp"];
  const tags = raw
    .map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length >= 3);
  return [...new Set(tags)].slice(0, 8);
}

/**
 * Build a complete, render-ready Reel for a persona + topic. The narration body
 * comes from the Brain; the hook/CTA/scenes/caption/hashtags are assembled
 * deterministically, so this works offline (stub Brain) and better with a real
 * LLM. No network, no encode — it produces the spec.
 */
/** True when the generator returned no real content (e.g. the offline stub). */
function looksUnusable(text: string): boolean {
  const t = text.trim();
  return t.length < 15 || /^\[stub/i.test(t) || /write only|narration/i.test(t);
}

/** Clean, persona-driven fallback narration so offline runs still read well. */
function templateNarration(persona: Persona, topic: string): string {
  return [
    `Here's the truth about ${topic}.`,
    `Most people make it way harder than it needs to be.`,
    `Pick one tool, automate the repetitive part, and stay consistent for thirty days.`,
    `That's how ${persona.niche} actually starts paying off.`,
    `Save this so you don't forget.`,
  ].join(" ");
}

export async function buildReel(gen: TextGenerator, persona: Persona, topic: string): Promise<ReelSpec> {
  const system = `You are ${persona.name}, an Instagram Reels creator in the niche "${persona.niche}". Write a punchy 30-45 second vertical-video narration. Start with a scroll-stopping hook. Short sentences. No emojis.`;
  const prompt = `Topic: ${topic}\nWrite ONLY the narration, 4-6 short sentences.`;
  const { text } = await gen.generate({ prompt, system, needs: { creativity: 0.9, speed: 0.5 }, task: "reel.script" });

  // If no real model answered (offline stub), use a clean template instead of
  // echoing the prompt back at the viewer.
  const narration = looksUnusable(text) ? templateNarration(persona, topic) : text;
  const sentences = splitSentences(narration);
  const hook = sentences[0] ?? `Here's what nobody tells you about ${topic}.`;
  const body = sentences.slice(1);
  const cta = `Follow ${persona.handle} for more.`;

  const sceneTexts = [hook, ...body].filter(Boolean);
  const scenes: ReelScene[] = sceneTexts.map((line) => {
    const imagePrompt = `${persona.niche}, ${keywords(line)}, cinematic vertical, high detail`;
    return { text: line, imagePrompt, imageUrl: pollinationsUrl(imagePrompt, { width: REEL_WIDTH, height: REEL_HEIGHT, seed: persona.imageSeed }) };
  });

  const hashtags = buildHashtags(persona, topic);
  const voiceText = [hook, ...body, cta].join(" ");
  const caption = `${hook}\n\n${cta}\n\n${hashtags.map((h) => `#${h}`).join(" ")}`;
  const estDurationSec = Math.max(REEL_MIN_SEC, Math.min(REEL_MAX_SEC, Math.ceil(voiceText.split(/\s+/).length / 2.5)));

  return {
    personaHandle: persona.handle,
    topic,
    hook,
    scenes,
    cta,
    voiceText,
    voice: persona.voice,
    caption,
    hashtags,
    width: REEL_WIDTH,
    height: REEL_HEIGHT,
    estDurationSec,
  };
}

/** Validate a Reel spec against Instagram Reels constraints. */
export function validateReel(spec: ReelSpec): ValidationResult {
  const problems: string[] = [];
  if (spec.width / spec.height < 0.55 || spec.width / spec.height > 0.58) {
    problems.push(`aspect ratio must be ~9:16 (got ${spec.width}x${spec.height})`);
  }
  if (spec.estDurationSec < REEL_MIN_SEC || spec.estDurationSec > REEL_MAX_SEC) {
    problems.push(`duration must be ${REEL_MIN_SEC}-${REEL_MAX_SEC}s (got ${spec.estDurationSec}s)`);
  }
  if (spec.caption.length > IG_CAPTION_MAX) problems.push(`caption too long (${spec.caption.length}/${IG_CAPTION_MAX})`);
  if (spec.hashtags.length > IG_HASHTAG_MAX) problems.push(`too many hashtags (${spec.hashtags.length}/${IG_HASHTAG_MAX})`);
  if (spec.scenes.length === 0) problems.push("no scenes");
  if (!spec.voiceText.trim()) problems.push("empty narration");
  return { ok: problems.length === 0, problems };
}
