import { describe, it, expect, vi } from "vitest";
import { postToInstagram, postToFacebookPage } from "../src/posting";

describe("postToInstagram", () => {
  it("creates a media container then publishes it, returning the live post id", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "container123" }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: "post456" }) });

    const result = await postToInstagram({
      igBusinessAccountId: "ig111",
      imageUrl: "https://example.com/photo.jpg",
      caption: "hello world",
      pageAccessToken: "PAGE_TOKEN",
      fetcher,
    });

    expect(result).toEqual({ livePostId: "post456" });
    const containerUrl = fetcher.mock.calls[0]![0] as string;
    expect(containerUrl).toContain("/ig111/media");
    expect(containerUrl).toContain("image_url=");
    expect(containerUrl).toContain("access_token=PAGE_TOKEN");
    const publishUrl = fetcher.mock.calls[1]![0] as string;
    expect(publishUrl).toContain("/ig111/media_publish");
    expect(publishUrl).toContain("creation_id=container123");
  });

  it("throws with the real error text when container creation fails", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: "Invalid image URL" } }) });
    await expect(postToInstagram({ igBusinessAccountId: "ig1", imageUrl: "bad", caption: "c", pageAccessToken: "t", fetcher })).rejects.toThrow(/Invalid image URL/);
  });
});

describe("postToFacebookPage", () => {
  it("posts a photo with caption to the Page's /photos endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "page_post_789", post_id: "page1_789" }) });

    const result = await postToFacebookPage({
      pageId: "page1",
      imageUrl: "https://example.com/photo.jpg",
      caption: "hello world",
      pageAccessToken: "PAGE_TOKEN",
      fetcher,
    });

    expect(result).toEqual({ livePostId: "page1_789" });
    const url = fetcher.mock.calls[0]![0] as string;
    expect(url).toContain("/page1/photos");
    expect(url).toContain("access_token=PAGE_TOKEN");
  });

  it("throws with the real error text when the Page post fails", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: { message: "Page token has expired" } }) });
    await expect(postToFacebookPage({ pageId: "p1", imageUrl: "x", caption: "c", pageAccessToken: "t", fetcher })).rejects.toThrow(/expired/);
  });
});
