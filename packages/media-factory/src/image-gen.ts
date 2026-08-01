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

export interface GeneratedImageWithModel extends GeneratedImage {
  /** Which model actually produced this — never inferred from the request. */
  model: string;
  /** Set when the preferred model was unavailable and the fallback ran. */
  fellBackFrom?: string;
  fallbackReason?: string;
}

/**
 * Generate at the best quality this API key can reach.
 *
 * Nano Banana Pro (gemini-3-pro-image) is the better model, but access varies
 * per key and there is no endpoint that reports entitlement — the only honest
 * way to find out is to ask and see. So: try Pro, and on a refusal that means
 * "not you" (403) or "no such model for you" (404), quietly drop to Flash.
 *
 * Deliberately narrow. A 429 is a quota problem and a 500 is Google having a
 * bad minute; retrying either on Flash would burn a second call and, worse,
 * silently downgrade every image for the rest of a quota window. Those still
 * throw. The returned `model` says which one ran, so a caller never has to
 * assume it got the good one.
 */
export async function generateBestImage(
  prompt: string,
  apiKey: string,
  opts: { references?: ReferenceImage[]; fetcher?: FetchLike; preferred?: string; fallback?: string } = {},
): Promise<GeneratedImageWithModel> {
  const preferred = opts.preferred ?? NANO_BANANA_PRO;
  const fallback = opts.fallback ?? NANO_BANANA;
  try {
    const img = await generateImage(prompt, apiKey, { model: preferred, references: opts.references, fetcher: opts.fetcher });
    return { ...img, model: preferred };
  } catch (err) {
    const message = (err as Error).message;
    const unavailable = /HTTP (?:403|404)/.test(message);
    if (!unavailable || preferred === fallback) throw err;
    const img = await generateImage(prompt, apiKey, { model: fallback, references: opts.references, fetcher: opts.fetcher });
    return { ...img, model: fallback, fellBackFrom: preferred, fallbackReason: message.slice(0, 200) };
  }
}
