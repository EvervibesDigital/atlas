export type BrainInvoker = (service: string, payload?: unknown) => Promise<unknown>;
import { MediaFactoryDB } from "./db";
import type { VirtualCreator } from "./db";

function extractJSON<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1) {
    return JSON.parse(text.substring(start, end + 1)) as T;
  }
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd !== -1) {
    return JSON.parse(text.substring(arrayStart, arrayEnd + 1)) as T;
  }
  throw new Error("No JSON parsed from response: " + text);
}

const RANDOM_NICHES = [
  "sustainable fitness and home workouts",
  "budget travel and van life",
  "AI tools and productivity hacks",
  "plant-based cooking and meal prep",
  "personal finance for beginners",
  "minimalist home organization",
  "urban gardening and houseplants",
  "vintage fashion and thrifting",
  "mental wellness and journaling",
  "indie gaming and retro tech",
];

export class MediaFactoryAgents {
  /**
   * Persona Generator Agent — drafts a complete, ready-to-review virtual
   * creator profile (every field `createCreator` needs) so Mat doesn't have
   * to invent a name/backstory/personality from a blank prompt. He reviews
   * and edits before anything is saved — this never calls createCreator
   * itself. Picks a random niche when none is given, and asks for a
   * concrete, specific persona (not generic filler) so repeated calls
   * produce genuinely different people to choose between.
   */
  static async generateRandomCreator(invoke: BrainInvoker, niche?: string): Promise<VirtualCreator> {
    const targetNiche = niche?.trim() || RANDOM_NICHES[Math.floor(Math.random() * RANDOM_NICHES.length)] || RANDOM_NICHES[0]!;
    const seed = Math.random().toString(36).slice(2, 8); // nudges the model away from repeating its favorite answer

    const system = `You are a Virtual Creator Persona Generator. Invent ONE specific, memorable virtual social media creator — not a generic template. Give them a real-sounding name, a distinct personality, a concrete backstory with real specificity (not "loves fitness" but an actual detail that makes them feel like a real person), and a physical appearance description detailed enough to guide an image generator later.

    Return ONLY a strict JSON object with EXACTLY these fields:
    {
      "name": "string — a full real-sounding name",
      "handle": "string — lowercase, no spaces, social-media-style, derived from the name",
      "age_range": "string, e.g. \\"24-28\\"",
      "gender": "string",
      "appearance_profile": { "description": "string — detailed physical/style description for an image generator: build, hair, style, vibe" },
      "personality_traits": ["string", "string", "string"],
      "speaking_style": "string — how they talk/write",
      "humor_style": "string",
      "values_statement": "string — one sentence on what they stand for",
      "background_story": "string — 2-3 sentences, specific and concrete, not generic",
      "interests": ["string", "string", "string"],
      "content_pillars": ["string", "string", "string"],
      "target_audience": { "demographic": "string" },
      "brand_positioning": "string — one sentence"
    }`;

    const prompt = `Invent a virtual creator for this niche: "${targetNiche}". (variation seed: ${seed} — make this persona distinct from a generic default)`;

    const resp = (await invoke("brain", {
      prompt,
      system,
      maxTokens: 1024,
      task: "media_factory.generate_persona",
    })) as { text: string };

    try {
      const draft = extractJSON<Partial<VirtualCreator>>(resp.text);
      // Sanity-fill anything the model dropped so the UI never receives a
      // half-formed profile — same "never block on a bad LLM response"
      // posture as the other agents in this file.
      return {
        name: draft.name || "Unnamed Creator",
        handle: draft.handle || "creator" + seed,
        age_range: draft.age_range || "24-28",
        gender: draft.gender || "Female",
        appearance_profile: draft.appearance_profile || { description: "" },
        personality_traits: draft.personality_traits?.length ? draft.personality_traits : ["curious", "warm", "driven"],
        speaking_style: draft.speaking_style || "Conversational and direct",
        humor_style: draft.humor_style || "Dry and observational",
        values_statement: draft.values_statement || "Being genuinely helpful over chasing trends.",
        background_story: draft.background_story || `Got into ${targetNiche} after a personal turning point and never looked back.`,
        interests: draft.interests?.length ? draft.interests : [targetNiche],
        content_pillars: draft.content_pillars?.length ? draft.content_pillars : ["tips", "behind_the_scenes", "mindset"],
        target_audience: draft.target_audience || { demographic: "18-35 digital natives" },
        brand_positioning: draft.brand_positioning || `The go-to voice for ${targetNiche}.`,
      };
    } catch (err) {
      console.error("[PersonaGenerator] Failed parsing JSON:", resp.text, err);
      return {
        name: "Alex Rivera",
        handle: "alex" + seed,
        age_range: "24-28",
        gender: "Female",
        appearance_profile: { description: `A warm, approachable presence in the ${targetNiche} space.` },
        personality_traits: ["curious", "warm", "driven"],
        speaking_style: "Conversational and direct",
        humor_style: "Dry and observational",
        values_statement: "Being genuinely helpful over chasing trends.",
        background_story: `Got into ${targetNiche} after a personal turning point and never looked back.`,
        interests: [targetNiche],
        content_pillars: ["tips", "behind_the_scenes", "mindset"],
        target_audience: { demographic: "18-35 digital natives" },
        brand_positioning: `The go-to voice for ${targetNiche}.`,
      };
    }
  }

  /**
   * Audience Intelligence Agent
   * researches trends, competitor hooks, and recommends growth niches
   */
  static async scoutAudience(invoke: BrainInvoker, niche: string): Promise<any> {
    const system = `You are an expert Audience Intelligence Agent. Your job is to research growth opportunities and niches for a digital creator brand. Analyze target demographics, pain points, competitor styles, and recommend the highest-growth angles.
    
    Return ONLY a strict JSON object:
    {
      "niche": "string",
      "target_demographics": "string",
      "competitor_hooks": ["string"],
      "pain_points": ["string"],
      "viral_topics": ["string"],
      "monetization_potential": "high|medium|low",
      "recommended_creator_concept": {
        "name": "string",
        "positioning": "string",
        "pillars": ["string"]
      }
    }`;

    const prompt = `Research and analyze the following niche area for high-growth digital creator opportunities: "${niche}".`;

    const resp = (await invoke("brain", {
      prompt,
      system,
      maxTokens: 1024,
      task: "media_factory.scout",
    })) as { text: string };

    try {
      return extractJSON<any>(resp.text);
    } catch (err) {
      console.error("[AudienceScout] Failed parsing JSON:", resp.text, err);
      return {
        niche,
        target_demographics: "Gen Z & Millennials interested in " + niche,
        competitor_hooks: ["10 secrets about " + niche, "Why everyone is wrong about " + niche],
        pain_points: ["Lack of clear guides", "Too much high-level jargon"],
        viral_topics: ["trending " + niche],
        monetization_potential: "medium",
        recommended_creator_concept: {
          name: "Virtual " + niche + " Guide",
          positioning: "Simple, visual breakdowns of " + niche,
          pillars: ["tips", "reviews"]
        }
      };
    }
  }

  /**
   * Content Strategy Agent
   * generates content calendars, platform-specific plans, and titles
   * weaving a continuous personal storyline based on past posts
   */
  static async generateContentCalendar(invoke: BrainInvoker, creator: VirtualCreator, trendsSummary: string): Promise<any[]> {
    let memoryPrompt = "";
    if (creator.id) {
      const memories = await MediaFactoryDB.listMemories(creator.id);
      const successes = memories.filter(m => m.kind === "success").map(m => m.content);
      const failures = memories.filter(m => m.kind === "failure").map(m => m.content);
      if (successes.length) memoryPrompt += `\nPAST SUCCESSFUL TOPICS (DO MORE OF THESE):\n- ${successes.join("\n- ")}`;
      if (failures.length) memoryPrompt += `\nPAST FAILED TOPICS (AVOID THESE):\n- ${failures.join("\n- ")}`;
    }

    // Fetch last 3 posts to build continuous storyline memory
    let historyPrompt = "";
    if (creator.id) {
      try {
        const historyItems = await MediaFactoryDB.listContentItems(creator.id);
        const recentPosts = (historyItems || [])
          .filter(item => item.status === "published" || item.status === "approved" || item.status === "review")
          .slice(0, 3);
        
        if (recentPosts.length) {
          historyPrompt += "\nRECENT POST HISTORY (BUILD CONTINUOUS STORYLINE FROM THESE):\n";
          recentPosts.forEach((p, idx) => {
            historyPrompt += `- Post ${idx + 1} (${p.platform}): Title: "${p.title}", Hook: "${p.hook}"`;
            if (p.script) historyPrompt += `, Script Summary: "${p.script.slice(0, 120)}..."`;
            historyPrompt += "\n";
          });
        }
      } catch (err) {
        console.warn("[ContentPlanner] Failed fetching recent posts history:", err);
      }
    }

    const system = `You are a Content Strategy Agent. Your task is to plan a weekly content calendar for a virtual creator brand. 
    Review the creator persona, content pillars, past memory notes, trends, and recent post history.
    You MUST ensure the content calendar builds a continuous personal life story or character arc based on what the creator has recently posted. Ensure posts naturally connect or build on previous stories, making the creator feel like a real person with a living narrative.
    
    Return ONLY a strict JSON array of 5 items:
    [
      {
        "title": "string",
        "platform": "instagram|tiktok|youtube_shorts|x|pinterest",
        "hook": "strong attention grabbing hook",
        "brief": "brief visual idea / visual composition",
        "pillars": ["string"]
      }
    ]`;

    const prompt = `
    CREATOR PROFILE:
    - Name: ${creator.name}
    - Persona: ${creator.brand_positioning}
    - Style: ${creator.speaking_style}
    - pillars: ${creator.content_pillars.join(", ")}
    ${memoryPrompt}
    ${historyPrompt}

    TRENDS SUMMARY:
    ${trendsSummary}

    Generate a 5-item content calendar matching this creator's profile and target audience. Keep the narrative fluid and connected to previous posts.`;

    const resp = (await invoke("brain", {
      prompt,
      system,
      maxTokens: 1536,
      task: "media_factory.plan",
    })) as { text: string };

    try {
      return extractJSON<any[]>(resp.text);
    } catch (err) {
      console.error("[ContentPlanner] Failed parsing JSON:", resp.text, err);
      return [
        {
          title: "My background story",
          platform: "instagram",
          hook: "Here's what they don't tell you about starting out...",
          brief: "Close-up portrait of the avatar presenting their values.",
          pillars: [creator.content_pillars[0] || "lifestyle"]
        }
      ];
    }
  }

  /**
   * Content Production Pipeline Agent
   * writes full scripts and captions matching the creator's voice
   * links the current post script back to previous storylines
   */
  static async produceContentDraft(invoke: BrainInvoker, creator: VirtualCreator, title: string, hook: string, brief: string, platform: string): Promise<any> {
    // Fetch last 3 posts to build continuous storyline memory
    let historyPrompt = "";
    if (creator.id) {
      try {
        const historyItems = await MediaFactoryDB.listContentItems(creator.id);
        const recentPosts = (historyItems || [])
          .filter(item => item.status === "published" || item.status === "approved" || item.status === "review")
          .slice(0, 3);
        
        if (recentPosts.length) {
          historyPrompt += "\nRECENT POST HISTORY (LINK BACK TO THESE FOR STORY CONTINUITY):\n";
          recentPosts.forEach((p, idx) => {
            historyPrompt += `- Post ${idx + 1} (${p.platform}): Title: "${p.title}", Hook: "${p.hook}"`;
            if (p.script) historyPrompt += `, Script: "${p.script.slice(0, 150)}..."`;
            historyPrompt += "\n";
          });
        }
      } catch (err) {
        console.warn("[ContentProduction] Failed fetching recent posts history:", err);
      }
    }

    const system = `You are a Content Production Agent. Your job is to draft the final script and social media copy (caption, hashtags) for a virtual creator.
    You MUST speak in the creator's voice, adopting their humor, speaking style, values, and personality.
    
    Return ONLY a strict JSON object:
    {
      "script": "spoken voiceover transcript or post body, matched to speaking style",
      "caption": "engaging social media caption with emojis",
      "hashtags": ["string"],
      "image_prompt": "high-detail photorealistic image generation prompt to generate visual assets for this post (suitable for DALL-E/Midjourney/Pollinations)"
    }`;

    const prompt = `
    CREATOR VOICE DATA:
    - Name: ${creator.name}
    - Speaking Style: ${creator.speaking_style}
    - Humor style: ${creator.humor_style}
    - Personality traits: ${creator.personality_traits.join(", ")}
    - Target audience: ${JSON.stringify(creator.target_audience)}
    - Background: ${creator.background_story}
    ${historyPrompt}

    POST DETAILS:
    - Title: ${title}
    - Hook: ${hook}
    - Brief/Visual idea: ${brief}
    - Platform: ${platform}

    Draft the final copy and visual prompt matching this creator's identity. 
    CRITICAL: You MUST link this post script back to the recent history or make a subtle, natural callback to the previous events/topics in their 'life' to maintain a continuous narrative storyline. The visuals must look hyperrealistic.`;

    const resp = (await invoke("brain", {
      prompt,
      system,
      maxTokens: 1024,
      task: "media_factory.production",
    })) as { text: string };

    try {
      return extractJSON<any>(resp.text);
    } catch (err) {
      console.error("[ContentProduction] Failed parsing JSON:", resp.text, err);
      return {
        script: hook + " Let's talk about " + title + ". This is essential for our journey.",
        caption: `✨ Quick thoughts on ${title}! Hooked? Let's discuss in comments.`,
        hashtags: ["AIInfluencer", "VirtualCreator"],
        image_prompt: `A beautiful portrait photography of ${creator.name}, standard portrait, high quality, photorealistic`
      };
    }
  }
}
