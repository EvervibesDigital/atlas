import { describe, it, expect, vi } from "vitest";
import { fetchComments, replyToComment, fetchConversationMessages, sendDirectMessage } from "../src/inbox-graph";

describe("fetchComments", () => {
  it("returns each comment's id, text, and timestamp", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ data: [{ id: "c1", text: "love this!", timestamp: "2026-01-01T00:00:00+0000" }] }),
    });
    const comments = await fetchComments("ig_media_1", "PAGE_TOKEN", fetcher);
    expect(comments).toEqual([{ id: "c1", text: "love this!", timestamp: "2026-01-01T00:00:00+0000" }]);
    expect(fetcher.mock.calls[0]![0] as string).toContain("/ig_media_1/comments");
  });

  it("throws with the real error text on failure", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: "Unsupported request" } }) });
    await expect(fetchComments("bad", "t", fetcher)).rejects.toThrow(/Unsupported request/);
  });
});

describe("replyToComment", () => {
  it("posts to the comment's /replies edge", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "reply1" }) });
    const result = await replyToComment("c1", "thank you!", "PAGE_TOKEN", fetcher);
    expect(result).toEqual({ replyId: "reply1" });
    expect(fetcher.mock.calls[0]![0] as string).toContain("/c1/replies");
  });
});

describe("fetchConversationMessages", () => {
  it("returns each conversation's latest message with sender id and text", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        data: [
          { id: "conv1", messages: { data: [{ id: "m1", message: "hi there", from: { id: "igsid1" }, created_time: "2026-01-01T00:00:00+0000" }] } },
        ],
      }),
    });
    const messages = await fetchConversationMessages("page1", "PAGE_TOKEN", fetcher);
    expect(messages).toEqual([{ id: "m1", text: "hi there", fromId: "igsid1", timestamp: "2026-01-01T00:00:00+0000" }]);
    expect(fetcher.mock.calls[0]![0] as string).toContain("/page1/conversations");
    expect(fetcher.mock.calls[0]![0] as string).toContain("platform=INSTAGRAM");
  });
});

describe("sendDirectMessage", () => {
  it("posts to /messages with the recipient igsid and text", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ recipient_id: "igsid1", message_id: "msg1" }) });
    const result = await sendDirectMessage("page1", "igsid1", "hello!", "PAGE_TOKEN", fetcher);
    expect(result).toEqual({ messageId: "msg1" });
    expect(fetcher.mock.calls[0]![0] as string).toContain("/page1/messages");
  });
});
