/**
 * A Persona is a consistent AI-influencer identity. It drives the voice, the
 * look (a fixed image seed keeps the visual style consistent across Reels), the
 * topics, and the brand — so every video feels like the same "person".
 */
export interface Persona {
  /** @handle used on the platform and burned into captions. */
  handle: string;
  name: string;
  /** One-line niche, e.g. "AI tools & side-hustle tips". */
  niche: string;
  /** Recurring themes the persona posts about. */
  contentPillars: string[];
  /** edge-tts voice id, e.g. "en-US-AriaNeural". */
  voice: string;
  /** Fixed seed → consistent image style across all Reels. */
  imageSeed: number;
  brandColor: string;
  /** Target platforms, e.g. ["instagram-reels"]. */
  platforms: string[];
}

export type PersonaCommand = { op: "get"; handle: string } | { op: "list" };
