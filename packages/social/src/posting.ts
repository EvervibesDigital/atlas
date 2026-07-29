import type { FetchLike } from "./token-exchange";

export interface PostResult {
  livePostId: string;
}

/**
 * Instagram Content Publishing API — a two-step flow: create a media
 * container from the image URL, then publish that container. Verified
 * against Meta's current documented shape; not yet run against a real
 * account (no account connected yet as of this plan).
 */
export async function postToInstagram(input: {
  igBusinessAccountId: string;
  imageUrl: string;
  caption: string;
  pageAccessToken: string;
  fetcher: FetchLike;
}): Promise<PostResult> {
  const createParams = new URLSearchParams({ image_url: input.imageUrl, caption: input.caption, access_token: input.pageAccessToken });
  const createRes = await input.fetcher(`https://graph.facebook.com/v25.0/${input.igBusinessAccountId}/media?${createParams.toString()}`, { method: "POST" });
  const createData = (await createRes.json()) as { id?: string; error?: { message?: string } };
  if (!createRes.ok) throw new Error(`Instagram media container failed: HTTP ${createRes.status} ${createData.error?.message ?? JSON.stringify(createData).slice(0, 200)}`);
  if (!createData.id) throw new Error(`Instagram media container returned no id: ${JSON.stringify(createData).slice(0, 200)}`);

  const publishParams = new URLSearchParams({ creation_id: createData.id, access_token: input.pageAccessToken });
  const publishRes = await input.fetcher(`https://graph.facebook.com/v25.0/${input.igBusinessAccountId}/media_publish?${publishParams.toString()}`, { method: "POST" });
  const publishData = (await publishRes.json()) as { id?: string; error?: { message?: string } };
  if (!publishRes.ok) throw new Error(`Instagram publish failed: HTTP ${publishRes.status} ${publishData.error?.message ?? JSON.stringify(publishData).slice(0, 200)}`);
  if (!publishData.id) throw new Error(`Instagram publish returned no id: ${JSON.stringify(publishData).slice(0, 200)}`);
  return { livePostId: publishData.id };
}

/** Facebook Page photo post — single call, no container step. */
export async function postToFacebookPage(input: {
  pageId: string;
  imageUrl: string;
  caption: string;
  pageAccessToken: string;
  fetcher: FetchLike;
}): Promise<PostResult> {
  const params = new URLSearchParams({ url: input.imageUrl, caption: input.caption, access_token: input.pageAccessToken });
  const res = await input.fetcher(`https://graph.facebook.com/v25.0/${input.pageId}/photos?${params.toString()}`, { method: "POST" });
  const data = (await res.json()) as { id?: string; post_id?: string; error?: { message?: string } };
  if (!res.ok) throw new Error(`Facebook Page post failed: HTTP ${res.status} ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
  const livePostId = data.post_id ?? data.id;
  if (!livePostId) throw new Error(`Facebook Page post returned no id: ${JSON.stringify(data).slice(0, 200)}`);
  return { livePostId };
}
