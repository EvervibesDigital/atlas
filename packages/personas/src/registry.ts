import type { Persona } from "./types";

/** The first ATLAS influencer — Instagram Reels, AI/side-hustle niche. */
export const DEFAULT_PERSONA: Persona = {
  handle: "@everspark.ai",
  name: "Ever",
  niche: "AI tools & side-hustle tips",
  contentPillars: ["ai tools", "automation", "solopreneur", "passive income"],
  voice: "en-US-AriaNeural",
  imageSeed: 42,
  brandColor: "#7C3AED",
  platforms: ["instagram-reels"],
};

export class PersonaRegistry {
  private byHandle = new Map<string, Persona>();

  constructor(initial: Persona[] = [DEFAULT_PERSONA]) {
    for (const p of initial) this.byHandle.set(p.handle, p);
  }

  get(handle: string): Persona | undefined {
    return this.byHandle.get(handle);
  }

  list(): Persona[] {
    return [...this.byHandle.values()];
  }

  add(persona: Persona): void {
    this.byHandle.set(persona.handle, persona);
  }
}
