import type { Plugin } from "@atlas/core";
import { MediaFactoryDB, type VirtualCreator, type CreatorMemory, type ContentItem, type MonetizationPartnership, type AnalyticsSnapshot } from "./db";
import { MediaFactoryAgents, type BrainInvoker } from "./agents";

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
  | { op: "produce"; creatorId: string; title: string; hook: string; brief?: string; platform: string }
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
 */
export function createMediaFactoryPlugin(): Plugin {
  return {
    manifest: {
      name: "mediaFactory",
      version: "0.1.0",
      capabilities: ["mediaFactory"],
      permissions: ["call:brain", "call:memory"],
      role: "executor",
    },

    register(ctx) {
      const invoke: BrainInvoker = (s, p) => ctx.call(s, p);

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

        // Find the oldest unscripted "planned" item across all creators.
        const pending = allContent
          .filter((i) => i.status === "planned" && !i.script)
          .sort((a, b) => (a.id! < b.id! ? -1 : 1)); // stable-ish; created_at not selected in list query today
        const next = pending[0];
        if (!next) return { skipped: "every creator's queue is caught up — nothing to produce right now" };

        const creator = creators.find((c) => c.id === next.creator_id);
        if (!creator) return { skipped: `creator for content item ${next.id} not found` };

        const brief = (next.assets as { brief?: string } | undefined)?.brief ?? "";
        const draft = (await MediaFactoryAgents.produceContentDraft(invoke, creator, next.title, next.hook ?? "", brief, next.platform)) as {
          script?: string;
          caption?: string;
          hashtags?: string[];
          image_prompt?: string;
        };
        const updated = await MediaFactoryDB.updateContentItemDraft(next.id!, {
          script: draft.script,
          caption: draft.caption,
          hashtags: draft.hashtags,
          assets: { image_prompt: draft.image_prompt },
          status: "review",
        });
        await ctx.emit("mediaFactory.produced", { creatorId: creator.id, contentId: next.id });
        return { action: "produced", creator: creator.name, title: next.title, status: updated.status, draft };
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
          return MediaFactoryAgents.produceContentDraft(invoke, creator, cmd.title, cmd.hook, cmd.brief ?? "", cmd.platform);
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
