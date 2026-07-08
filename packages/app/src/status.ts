import { buildAtlas } from "./build";

/** A plain-language readiness check: what's live, what's stubbed, what's next. */
export interface ReadinessReport {
  providers: { groq: boolean; gemini: boolean; openrouter: boolean };
  brainMode: "live" | "offline-stub";
  publisher: "dry-run" | "live";
  pluginCount: number;
  checklist: { done: boolean; item: string }[];
}

export async function checkReadiness(env: NodeJS.ProcessEnv = process.env): Promise<ReadinessReport> {
  const providers = {
    groq: !!env.GROQ_API_KEY,
    gemini: !!env.GEMINI_API_KEY,
    openrouter: !!env.OPENROUTER_API_KEY,
  };
  const anyProvider = providers.groq || providers.gemini || providers.openrouter;

  const atlas = await buildAtlas();
  const pluginCount = atlas.loaded().length;

  const checklist = [
    { done: true, item: "Kernel + 5 layers built, tested, on GitHub" },
    { done: anyProvider, item: "Add a free LLM key (Groq / Gemini / OpenRouter) to .env for real content" },
    { done: false, item: "Install the video encoder (edge-tts + ffmpeg) to produce real MP4s" },
    { done: false, item: "Add your Instagram login session to switch on the live publisher" },
  ];

  return {
    providers,
    brainMode: anyProvider ? "live" : "offline-stub",
    publisher: "dry-run",
    pluginCount,
    checklist,
  };
}
