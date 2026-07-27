import type { ContentItem, VirtualCreator } from "./db";

/**
 * How many posts each creator gets scripted per rolling 24h window before
 * autoCycle stops giving them more room, so one creator's backlog can't
 * starve the other nine. One shared constant for now (not per-creator DB
 * config) — simplest fix for the real bottleneck; per-creator tuning is a
 * natural follow-up if wanted later, not needed to unblock scaling.
 */
export const DAILY_POST_TARGET = 2;

/** Items for `creatorId` that have actually been scripted (not just planned)
 * within the last 24 hours — the throughput autoCycle is meant to pace. */
export function itemsScriptedInLast24h(items: ContentItem[], creatorId: string): number {
  const cutoff = Date.now() - 24 * 3_600_000;
  return items.filter(
    (i) => i.creator_id === creatorId && Boolean(i.script) && i.created_at !== undefined && new Date(i.created_at).getTime() >= cutoff,
  ).length;
}

/** Creators who haven't hit today's target yet, in the same order they were
 * given — autoCycle gives each of these one unit of work per call. */
export function creatorsWithRoom(creators: VirtualCreator[], items: ContentItem[], target: number): VirtualCreator[] {
  return creators.filter((c) => itemsScriptedInLast24h(items, c.id!) < target);
}
