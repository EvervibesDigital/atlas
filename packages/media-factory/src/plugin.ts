import type { Plugin, AtlasContext } from "@atlas/core";
import { MediaFactoryDB, type VirtualCreator, type CreatorMemory, type ContentItem, type MonetizationPartnership, type AnalyticsSnapshot } from "./db";
import { MediaFactoryAgents, buildImagePrompt, type BrainInvoker } from "./agents";
import { creatorsWithRoom, DAILY_POST_TARGET } from "./throughput";
import { generateImage, type FetchLike } from "./image-gen";
import { saveGeneratedImage } from "./images";

export type MediaFactoryCommand =
  | { op: "listCreators" }
  | { op: "createCreator"; creator: VirtualCreator }
  | { op: "generateRandomCreator"; niche?: string }
  | { op: "updateCreator"; id: string; patch: Partial<VirtualCreator> }
  | { op: "deleteCreator"; id: string }
  | { op: "listMemories"; creatorId: string }
  | { op: "addMemory"; memory: CreatorMemory }
  | { op: "listContent"; creatorId?: string }
  | { op: "createContent"; item: ContentItem }
  | { op: "updateContentStatus"; id: string; status: string; publishedAt?: string }
  | { op: "scout"; niche: string }
  | { op: "plan"; creatorId: string; trendsSummary?: string }
  // contentId is optional (kept for callers that only want the drafted
  // text); when supplied, the plugin also generates + saves a real image and
  // includes its path in the response.
  | { op: "produce"; creatorId: string; title: string; hook: string; brief?: string; platform: string; contentId?: string }
  | { op: "produceVideo"; contentId: string }
  | { op: "listPartnerships"; creatorId: string }
  | { op: "addPartnership"; partnership: MonetizationPartnership }
  | { op: "getAnalytics"; creatorId: string }
  | { op: "saveAnalytics"; snapshot: AnalyticsSnapshot }
  | { op: "autoCycle" };

/**
 * Media Factory (service "mediaFactory") — the AI-influencer/affiliate
 * factory. Manages virtual creator personas, plans content calendars, and
 * drafts scripts/captions in each creator's voice (real DB + real brain
 * calls, promoted from server-only HTTP handlers so the orchestrator can
 * drive it automatically).
 *
 * `autoCycle` is the "constantly creating" step: each call advances ONE
 * creator by one step — either filling an empty content queue with a fresh
 * 5-post calendar, or writing the next planned post's script/caption. It
 * never posts anything; content lands in "review" status for Mat to approve,
 * same posture as every other action-taking capability in ATLAS.
 *
 * Requires DATABASE_URL (Supabase) — gracefully reports itself unavailable
 * if unset, same pattern as kdp needing KDP_CRON_SECRET.
 *
 * Real image generation (ported from Twin's "Influencer Persona Generator"
 * agent): every produced draft's image_prompt is prefixed with the creator's
 * locked character-sheet description (buildImagePrompt) and sent to Gemini's
 * image model, so the SAME face shows up across every post — not a new
 * random face each time. Best-effort: a missing GEMINI_API_KEY or a failed
 * generation never blocks the text draft from saving; the item just lands in
 * review without an image, same as it did before this existed.
 */
export function createMediaFactoryPlugin(opts: { imagesDir?: string; imageFetcher?: FetchLike } = {}): Plugin {
  return {
    manifest: {
      name: "mediaFactory",
      version: "0.1.0",
      capabilities: ["mediaFactory"],
      permissions: ["call:brain", "call:memory", "call:publishing", "secret:GEMINI_API_KEY"],
      role: "executor",
    },

    register(ctx: AtlasContext) {
      const invoke: BrainInvoker = (s, p) => ctx.call(s, p);
      const imagesDir = opts.imagesDir ?? "./data/media-factory-images";

      /** Generate + save an image for a content item, best-effort. Returns
       * the {image_prompt, image_path} to merge into `assets`, or just
       * {image_prompt} if generation isn't available/fails. */
      async function attachGeneratedImage(creator: VirtualCreator, contentId: string, imagePrompt: string | undefined): Promise<Record<string, unknown>> {
        if (!imagePrompt) return {};
        const assets: Record<string, unknown> = { image_prompt: imagePrompt };
        try {
          const apiKey = await ctx.secret("GEMINI_API_KEY");
          if (!apiKey) return assets; // not configured — text draft still saves fine
          const fullPrompt = buildImagePrompt(creator, imagePrompt);
          const image = await generateImage(fullPrompt, apiKey, { fetcher: opts.imageFetcher });
          assets.image_path = await saveGeneratedImage(imagesDir, creator.id!, contentId, image);
        } catch (err) {
          console.error(`[mediaFactory] Image generation failed for content ${contentId} — draft still saved without it:`, (err as Error).message);
        }
        return assets;
      }

      async function autoCycle(): Promise<Record<string, unknown>> {
        const creators = await MediaFactoryDB.listCreators();
        if (creators.length === 0) return { skipped: "no creators yet — add one in the Media Factory tab" };

        const allContent = await MediaFactoryDB.listContentItems();
        const byCreator = new Map<string, ContentItem[]>();
        for (const c of creators) byCreator.set(c.id!, []);
        for (const item of allContent) byCreator.get(item.creator_id)?.push(item);

        // Prefer a creator with no "planned" queue (needs a fresh calendar);
        // otherwise the creator whose oldest unscripted "planned" item is
        // oldest overall (keeps every creator's queue moving, not just one).
        const needsPlan = creators.find((c) => !(byCreator.get(c.id!) ?? []).some((i) => i.status === "planned" && !i.script));
        if (needsPlan) {
          const trendsSummary = `Focus on: ${needsPlan.content_pillars.join(", ")}. Keep it fresh and platform-native.`;
          const calendar = await MediaFactoryAgents.generateContentCalendar(invoke, needsPlan, trendsSummary);
          const created: ContentItem[] = [];
          for (const item of calendar) {
            const row = await MediaFactoryDB.createContentItem({
              creator_id: needsPlan.id!,
              platform: item.platform,
              status: "planned",
              title: item.title,
              hook: item.hook,
              assets: { brief: item.brief, pillars: item.pillars },
            });
            created.push(row);
          }
          await ctx.emit("mediaFactory.planned", { creatorId: needsPlan.id, count: created.length });
          return { action: "planned", creator: needsPlan.name, itemsCreated: created.length };
        }

        // Give every creator with room under today's target one item per
        // call, instead of always picking the single globally-oldest item —
        // the actual fix for the "1 item/hour system-wide" bottleneck that
        // starved every creator but whichever had the oldest queue entry.
        const eligible = creatorsWithRoom(creators, allContent, DAILY_POST_TARGET);
        const MAX_PER_CALL = 10; // sane upper bound so one call can't run unboundedly long
        const toProcess = eligible.slice(0, MAX_PER_CALL);
        if (toProcess.length === 0) return { skipped: "every creator is caught up or at today's target" };

        const items: Array<{ creator: string; title: string; status: string }> = [];
        for (const creator of toProcess) {
          const next = allContent
            .filter((i) => i.creator_id === creator.id && i.status === "planned" && !i.script)
            .sort((a, b) => (a.id! < b.id! ? -1 : 1))[0];
          if (!next) continue; // room under target, but this creator's queue happens to be empty

          const brief = (next.assets as { brief?: string } | undefined)?.brief ?? "";
          const draft = (await MediaFactoryAgents.produceContentDraft(invoke, creator, next.title, next.hook ?? "", brief, next.platform)) as {
            script?: string;
            caption?: string;
            hashtags?: string[];
            image_prompt?: string;
          };
          const imageAssets = await attachGeneratedImage(creator, next.id!, draft.image_prompt);
          const updated = await MediaFactoryDB.updateContentItemDraft(next.id!, {
            script: draft.script,
            caption: draft.caption,
            hashtags: draft.hashtags,
            assets: imageAssets,
            status: "review",
          });
          await ctx.emit("mediaFactory.produced", { creatorId: creator.id, contentId: next.id });
          items.push({ creator: creator.name, title: next.title, status: updated.status });
        }
        if (items.length === 0) return { skipped: "every eligible creator's queue is empty" };
        return { action: "produced", itemsProcessed: items.length, items };
      }

      ctx.provide("mediaFactory", async (payload) => {
        const cmd = payload as MediaFactoryCommand;

        if (cmd.op === "listCreators") return MediaFactoryDB.listCreators();
        if (cmd.op === "createCreator") return MediaFactoryDB.createCreator(cmd.creator);
        if (cmd.op === "generateRandomCreator") return MediaFactoryAgents.generateRandomCreator(invoke, cmd.niche);
        if (cmd.op === "updateCreator") return MediaFactoryDB.updateCreator(cmd.id, cmd.patch);
        if (cmd.op === "deleteCreator") return { ok: await MediaFactoryDB.deleteCreator(cmd.id) };
        if (cmd.op === "listMemories") return MediaFactoryDB.listMemories(cmd.creatorId);
        if (cmd.op === "addMemory") return MediaFactoryDB.addMemory(cmd.memory);
        if (cmd.op === "listContent") return MediaFactoryDB.listContentItems(cmd.creatorId);
        if (cmd.op === "createContent") return MediaFactoryDB.createContentItem(cmd.item);
        if (cmd.op === "updateContentStatus") return MediaFactoryDB.updateContentItemStatus(cmd.id, cmd.status, cmd.publishedAt);
        if (cmd.op === "scout") return MediaFactoryAgents.scoutAudience(invoke, cmd.niche);
        if (cmd.op === "plan") {
          const creator = await MediaFactoryDB.getCreator(cmd.creatorId);
          if (!creator) throw new Error("creator not found");
          return MediaFactoryAgents.generateContentCalendar(invoke, creator, cmd.trendsSummary ?? "");
        }
        if (cmd.op === "produce") {
          const creator = await MediaFactoryDB.getCreator(cmd.creatorId);
          if (!creator) throw new Error("creator not found");
          const draft = (await MediaFactoryAgents.produceContentDraft(invoke, creator, cmd.title, cmd.hook, cmd.brief ?? "", cmd.platform)) as { image_prompt?: string };
          if (!cmd.contentId) return draft;
          const imageAssets = await attachGeneratedImage(creator, cmd.contentId, draft.image_prompt);
          return { ...draft, imagePath: imageAssets.image_path };
        }
        if (cmd.op === "produceVideo") {
          const item = await MediaFactoryDB.getContentItem(cmd.contentId);
          if (!item) throw new Error(`mediaFactory: content item "${cmd.contentId}" not found`);
          if (!item.script) throw new Error(`mediaFactory: content item "${cmd.contentId}" has no script yet — run "produce" first`);
          const creator = await MediaFactoryDB.getCreator(item.creator_id);
          if (!creator) throw new Error(`mediaFactory: creator for content item "${cmd.contentId}" not found`);

          const SCENE_COUNT = 4;
          const scenes = await MediaFactoryAgents.breakScriptIntoScenes(invoke, item.script, SCENE_COUNT);

          const renderScenes: Array<{ text: string; imageUrl: string }> = [];
          for (const scene of scenes) {
            const assets = await attachGeneratedImage(creator, `${cmd.contentId}-scene-${renderScenes.length}`, scene.imagePrompt);
            const imageUrl = (assets as { image_path?: string }).image_path;
            if (imageUrl) renderScenes.push({ text: scene.text, imageUrl });
          }
          if (renderScenes.length === 0) throw new Error(`mediaFactory: no scene images generated for "${cmd.contentId}" — check GEMINI_API_KEY`);

          const { jobId } = (await ctx.call("publishing", {
            op: "enqueueRender",
            spec: { voice: creator.name, scenes: renderScenes },
            contentId: cmd.contentId,
          })) as { jobId: string };

          await MediaFactoryDB.updateContentItemDraft(cmd.contentId, { assets: { video_job_id: jobId } });
          return { jobId, sceneCount: renderScenes.length };
        }
        if (cmd.op === "listPartnerships") return MediaFactoryDB.listPartnerships(cmd.creatorId);
        if (cmd.op === "addPartnership") return MediaFactoryDB.addPartnership(cmd.partnership);
        if (cmd.op === "getAnalytics") return MediaFactoryDB.getAnalytics(cmd.creatorId);
        if (cmd.op === "saveAnalytics") return MediaFactoryDB.saveAnalyticsSnapshot(cmd.snapshot);
        if (cmd.op === "autoCycle") return autoCycle();

        throw new Error(`mediaFactory: unknown op "${(cmd as { op: string }).op}"`);
      });
    },
  };
}
