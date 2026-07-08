/**
 * Pollinations image URLs — free, unlimited, no API key. The image is generated
 * on-demand by simply requesting the URL, so we can build a real, usable image
 * link deterministically (no network call needed to construct it). A fixed
 * `seed` per persona keeps the visual style consistent across Reels.
 */
export function pollinationsUrl(prompt: string, opts: { width: number; height: number; seed: number }): string {
  const encoded = encodeURIComponent(prompt);
  return `https://image.pollinations.ai/prompt/${encoded}?width=${opts.width}&height=${opts.height}&seed=${opts.seed}&nologo=true&model=flux`;
}
