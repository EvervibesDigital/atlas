// Real image generation for Media Factory content, via Gemini's image model
// ("Nano Banana" family). Verified against Google's own current docs
// (ai.google.dev/gemini-api/docs/models, July 2026) — same generateContent
// REST shape @atlas/leadscan's findLeads already uses successfully against
// this exact endpoint, just with an image-capable model id.
//
// Defaults to gemini-2.5-flash-image ("Nano Banana") rather than the newer
// gemini-3-pro-image ("Nano Banana Pro") — the flash model is the
// longer-established, more widely available one on a normal API key. Pro is
// selectable via `model` once Mat confirms his key has access to it.

export type FetchLike = typeof fetch;

export const NANO_BANANA = "gemini-2.5-flash-image";
export const NANO_BANANA_PRO = "gemini-3-pro-image";

export interface GeneratedImage {
  mimeType: string;
  /** Raw base64 image data (no data: prefix). */
  base64: string;
}

/** One prior image to pass as a reference — how the SAME face is kept
 * consistent across a persona's headshot/lifestyle/branded shots. */
export interface ReferenceImage {
  mimeType: string;
  base64: string;
}

/**
 * Generate one image from a text prompt, optionally grounded on reference
 * image(s) for character consistency. Throws with the API's own error text
 * on failure — callers decide whether that's fatal (never silently returns a
 * placeholder image).
 */
export async function generateImage(
  prompt: string,
  apiKey: string,
  opts: { model?: string; references?: ReferenceImage[]; fetcher?: FetchLike } = {},
): Promise<GeneratedImage> {
  const model = opts.model ?? NANO_BANANA;
  const parts: unknown[] = [
    ...(opts.references ?? []).map((r) => ({ inlineData: { mimeType: r.mimeType, data: r.base64 } })),
    { text: prompt },
  ];
  const f = opts.fetcher ?? fetch;
  const r = await f(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }] }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`image-gen: ${model} returned HTTP ${r.status}: ${body.slice(0, 300)}`);
  }
  const data = (await r.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
    promptFeedback?: { blockReason?: string };
  };
  if (data.promptFeedback?.blockReason) {
    throw new Error(`image-gen: prompt blocked (${data.promptFeedback.blockReason})`);
  }
  const imagePart = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!imagePart?.inlineData?.data) {
    throw new Error("image-gen: response contained no image data");
  }
  return { mimeType: imagePart.inlineData.mimeType ?? "image/png", base64: imagePart.inlineData.data };
}
