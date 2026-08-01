import { describe, it, expect } from "vitest";
import { generateImage, generateBestImage, NANO_BANANA, NANO_BANANA_PRO, type FetchLike } from "../src/image-gen";

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

describe("generateBestImage", () => {
  /** Records every model requested, and answers per-model. */
  function tracking(reply: (model: string) => { status: number; body?: unknown }): { fetcher: FetchLike; seen: string[] } {
    const seen: string[] = [];
    const fetcher = (async (url: string) => {
      const model = String(url).includes(NANO_BANANA_PRO) ? NANO_BANANA_PRO : NANO_BANANA;
      seen.push(model);
      const r = reply(model);
      return {
        ok: r.status === 200,
        status: r.status,
        text: async () => "denied",
        json: async () => r.body ?? { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aW1n" } }] } }] },
      } as Response;
    }) as unknown as FetchLike;
    return { fetcher, seen };
  }

  it("uses Pro when the key can reach it, and says so", async () => {
    const { fetcher, seen } = tracking(() => ({ status: 200 }));
    const img = await generateBestImage("prompt", "key", { fetcher });
    expect(seen).toEqual([NANO_BANANA_PRO]);
    expect(img.model).toBe(NANO_BANANA_PRO);
    expect(img.fellBackFrom).toBeUndefined();
  });

  it("falls back to Flash when the key has no Pro access", async () => {
    // 403/404 is the only signal Google gives for "not entitled" — there is no
    // endpoint that reports it up front.
    for (const status of [403, 404]) {
      const { fetcher, seen } = tracking((m) => (m === NANO_BANANA_PRO ? { status } : { status: 200 }));
      const img = await generateBestImage("prompt", "key", { fetcher });
      expect(seen).toEqual([NANO_BANANA_PRO, NANO_BANANA]);
      expect(img.model).toBe(NANO_BANANA);
      expect(img.fellBackFrom).toBe(NANO_BANANA_PRO);
      expect(img.base64).toBe("aW1n");
    }
  });

  it("does NOT silently downgrade on a quota or server error", async () => {
    // Retrying a 429 on Flash burns a second call and quietly makes every
    // image worse for the rest of the quota window, with nothing in the
    // output saying it happened.
    for (const status of [429, 500]) {
      const { fetcher, seen } = tracking(() => ({ status }));
      await expect(generateBestImage("prompt", "key", { fetcher })).rejects.toThrow(String(status));
      expect(seen).toEqual([NANO_BANANA_PRO]);
    }
  });

  it("does not retry when preferred and fallback are the same model", async () => {
    const { fetcher, seen } = tracking(() => ({ status: 403 }));
    await expect(
      generateBestImage("p", "k", { fetcher, preferred: NANO_BANANA, fallback: NANO_BANANA }),
    ).rejects.toThrow(/403/);
    expect(seen).toEqual([NANO_BANANA]);
  });
});
