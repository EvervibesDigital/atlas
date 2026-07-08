/** One on-screen beat of a Reel: a line of narration + its background image. */
export interface ReelScene {
  text: string;
  imagePrompt: string;
  /** A ready-to-use Pollinations image URL (free, no key). */
  imageUrl: string;
}

/**
 * A complete, render-ready Reel specification. Everything needed to encode the
 * final vertical MP4 (voice text + images + captions + timings) and to post it
 * (caption + hashtags), except the encode itself and the login session.
 */
export interface ReelSpec {
  personaHandle: string;
  topic: string;
  hook: string;
  scenes: ReelScene[];
  cta: string;
  /** Full narration for text-to-speech. */
  voiceText: string;
  /** edge-tts voice id. */
  voice: string;
  /** Instagram caption (already includes hook, cta, and hashtags). */
  caption: string;
  hashtags: string[];
  width: number;
  height: number;
  estDurationSec: number;
}

export interface ValidationResult {
  ok: boolean;
  problems: string[];
}

export type CreativeCommand = { op: "writeReel"; personaHandle: string; topic: string };
