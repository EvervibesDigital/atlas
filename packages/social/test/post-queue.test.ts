import { describe, it, expect } from "vitest";
import { enqueueStaggeredPosts, duePosts, markPublished, markFailed, type SocialPost } from "../src/post-queue";

function post(id: string, scheduledFor: string, status: SocialPost["status"] = "approved"): SocialPost {
  return { id, contentItemId: "c1", accountId: "a1", mediaType: "image", caption: "hi", mediaUrl: "https://x/1.jpg", status, scheduledFor, createdAt: "2026-01-01T00:00:00.000Z" };
}

describe("enqueueStaggeredPosts", () => {
  it("assigns each post a scheduledFor time spread across the given hours, starting now", () => {
    const now = new Date("2026-01-01T10:00:00.000Z");
    const posts = enqueueStaggeredPosts(
      [
        { contentItemId: "c1", accountId: "a1", mediaType: "image", caption: "one", mediaUrl: "https://x/1.jpg" },
        { contentItemId: "c2", accountId: "a1", mediaType: "image", caption: "two", mediaUrl: "https://x/2.jpg" },
        { contentItemId: "c3", accountId: "a1", mediaType: "image", caption: "three", mediaUrl: "https://x/3.jpg" },
      ],
      now,
      6, // spread across 6 hours
    );
    expect(posts).toHaveLength(3);
    expect(posts[0]!.scheduledFor).toBe("2026-01-01T10:00:00.000Z"); // first is immediate
    expect(new Date(posts[1]!.scheduledFor).getTime()).toBeGreaterThan(new Date(posts[0]!.scheduledFor).getTime());
    expect(new Date(posts[2]!.scheduledFor).getTime()).toBeGreaterThan(new Date(posts[1]!.scheduledFor).getTime());
    // last post lands within the 6-hour spread window
    expect(new Date(posts[2]!.scheduledFor).getTime()).toBeLessThanOrEqual(now.getTime() + 6 * 3_600_000);
    expect(posts.every((p) => p.status === "approved")).toBe(true);
  });

  it("gives a single post an immediate scheduledFor time (no unnecessary delay)", () => {
    const now = new Date("2026-01-01T10:00:00.000Z");
    const posts = enqueueStaggeredPosts([{ contentItemId: "c1", accountId: "a1", mediaType: "image", caption: "one", mediaUrl: "https://x/1.jpg" }], now, 6);
    expect(posts[0]!.scheduledFor).toBe(now.toISOString());
  });
});

describe("duePosts", () => {
  it("returns approved posts whose scheduledFor has passed, oldest first", () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const posts = [post("p1", "2026-01-01T13:00:00.000Z"), post("p2", "2026-01-01T11:00:00.000Z"), post("p3", "2026-01-01T11:30:00.000Z")];
    const due = duePosts(posts, now);
    expect(due.map((p) => p.id)).toEqual(["p2", "p3"]);
  });

  it("never returns posts that aren't in approved status", () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    const posts = [post("p1", "2026-01-01T11:00:00.000Z", "published"), post("p2", "2026-01-01T11:00:00.000Z", "failed")];
    expect(duePosts(posts, now)).toEqual([]);
  });
});

describe("markPublished / markFailed", () => {
  it("updates the matching post to published with the live post id", () => {
    const posts = [post("p1", "2026-01-01T11:00:00.000Z")];
    const updated = markPublished(posts, "p1", "live_post_999");
    expect(updated[0]).toMatchObject({ status: "published", livePostId: "live_post_999" });
    expect(updated[0]!.publishedAt).toBeTruthy();
  });

  it("updates the matching post to failed with the error message", () => {
    const posts = [post("p1", "2026-01-01T11:00:00.000Z")];
    const updated = markFailed(posts, "p1", "Invalid image URL");
    expect(updated[0]).toMatchObject({ status: "failed", error: "Invalid image URL" });
  });
});
