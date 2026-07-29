import { randomUUID } from "node:crypto";

export interface SocialPost {
  id: string;
  contentItemId: string;
  accountId: string;
  mediaType: "image" | "video";
  caption: string;
  mediaUrl: string;
  status: "approved" | "published" | "failed";
  scheduledFor: string;
  publishedAt?: string;
  livePostId?: string;
  error?: string;
  createdAt: string;
}

export type NewSocialPost = Pick<SocialPost, "contentItemId" | "accountId" | "mediaType" | "caption" | "mediaUrl">;

/**
 * Spread a batch of posts across `spreadHours` starting at `now` — posting
 * everything in a batch in the same instant reads as automated and risks
 * Meta's own abuse heuristics even through the official API. The first post
 * fires immediately; the rest are evenly spaced up to the spread window.
 */
export function enqueueStaggeredPosts(newPosts: NewSocialPost[], now: Date, spreadHours: number): SocialPost[] {
  const stepMs = newPosts.length > 1 ? (spreadHours * 3_600_000) / (newPosts.length - 1) : 0;
  return newPosts.map((p, i) => ({
    ...p,
    id: randomUUID(),
    status: "approved" as const,
    scheduledFor: new Date(now.getTime() + i * stepMs).toISOString(),
    createdAt: now.toISOString(),
  }));
}

/** Approved posts whose time has arrived, oldest scheduledFor first. */
export function duePosts(posts: SocialPost[], now: Date): SocialPost[] {
  return posts
    .filter((p) => p.status === "approved" && new Date(p.scheduledFor).getTime() <= now.getTime())
    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
}

export function markPublished(posts: SocialPost[], id: string, livePostId: string): SocialPost[] {
  return posts.map((p) => (p.id === id ? { ...p, status: "published" as const, livePostId, publishedAt: new Date().toISOString() } : p));
}

export function markFailed(posts: SocialPost[], id: string, error: string): SocialPost[] {
  return posts.map((p) => (p.id === id ? { ...p, status: "failed" as const, error } : p));
}
