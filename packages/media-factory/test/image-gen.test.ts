import { describe, it, expect } from "vitest";
import { generateImage, NANO_BANANA, NANO_BANANA_PRO, type FetchLike } from "../src/image-gen";

function fakeSuccess(mimeType = "image/png", data = "ZmFrZS1pbWFnZS1ieXRlcw=="): FetchLike {
  return (async (url: string) => {
    expect(String(url)).toContain(NANO_BANANA);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] } }] }) } as Response;
  }) as unknown as FetchLike;
}

describe("generateImage", () => {
  it("extracts the base64 image from a successful response", async () => {
    const img = await generateImage("a photo of a cat", "test-key", { fetcher: fakeSuccess() });
    expect(img.mimeType).toBe("image/png");
    expect(img.base64).toBe("ZmFrZS1pbWFnZS1ieXRlcw==");
  });

  it("defaults to the Nano Banana (flash) model, not Pro", async () => {
    let seenUrl = "";
    const f: FetchLike = (async (url: string) => {
      seenUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "x" } }] } }] }) } as Response;
    }) as unknown as FetchLike;
    await generateImage("prompt", "key", { fetcher: f });
    expect(seenUrl).toContain(NANO_BANANA);
    expect(seenUrl).not.toContain(NANO_BANANA_PRO);
  });

  it("uses the Pro model when explicitly requested", async () => {
    let seenUrl = "";
    const f: FetchLike = (async (url: string) => {
      seenUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "x" } }] } }] }) } as Response;
    }) as unknown as FetchLike;
    await generateImage("prompt", "key", { model: NANO_BANANA_PRO, fetcher: f });
    expect(seenUrl).toContain(NANO_BANANA_PRO);
  });

  it("includes reference images in the request for character consistency", async () => {
    let seenBody: any;
    const f: FetchLike = (async (_url: string, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "x" } }] } }] }) } as Response;
    }) as unknown as FetchLike;
    await generateImage("scene prompt", "key", { fetcher: f, references: [{ mimeType: "image/jpeg", base64: "ref-bytes" }] });
    const parts = seenBody.contents[0].parts;
    expect(parts[0].inlineData).toEqual({ mimeType: "image/jpeg", data: "ref-bytes" });
    expect(parts[1].text).toBe("scene prompt");
  });

  it("throws with the API's error body on a non-OK response", async () => {
    const f: FetchLike = (async () => ({ ok: false, status: 429, text: async () => "quota exceeded" })) as unknown as FetchLike;
    await expect(generateImage("p", "key", { fetcher: f })).rejects.toThrow(/429/);
  });

  it("throws when the prompt is blocked", async () => {
    const f: FetchLike = (async () => ({ ok: true, status: 200, json: async () => ({ promptFeedback: { blockReason: "SAFETY" } }) })) as unknown as FetchLike;
    await expect(generateImage("p", "key", { fetcher: f })).rejects.toThrow(/blocked/);
  });

  it("throws when the response has no image data", async () => {
    const f: FetchLike = (async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "sorry, no image" }] } }] }) })) as unknown as FetchLike;
    await expect(generateImage("p", "key", { fetcher: f })).rejects.toThrow(/no image data/);
  });
});
