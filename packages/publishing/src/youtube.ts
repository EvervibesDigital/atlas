/**
 * YouTube uploads via the Data API v3.
 *
 * The only platform in the roster with a real, unrestricted upload API — no
 * app-review gate like TikTok, no "no API at all" like OnlyFans. Rendered
 * Reels can become published inventory without a manual step.
 *
 * ── Two things that surprise people, encoded here rather than discovered ───
 *
 * 1. **An unverified app's uploads are forced PRIVATE.** Google restricts
 *    `videos.insert` for apps that haven't passed OAuth verification: whatever
 *    `privacyStatus` you send, the video lands private. So this reports back
 *    what YouTube actually set, not what was requested — a caller that assumes
 *    "public" would otherwise sit waiting for views on an invisible video.
 *    Verification is a Google review process; until it passes, treat every
 *    upload as a draft.
 *
 * 2. **An upload costs 1600 quota units against a 10,000/day default.**
 *    That is roughly SIX uploads per day, and the failure at the limit is a
 *    403 that reads like an auth error. `isQuotaError` tells them apart so a
 *    quota problem doesn't send Mat re-doing his OAuth setup.
 *
 * Auth is OAuth 2.0, not an API key — uploads act on behalf of a channel, so
 * an API key alone cannot do it. Needs a client id, secret, and a refresh
 * token obtained once through the consent screen.
 */

export type FetchLike = typeof fetch;

export interface YouTubeCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface UploadMetadata {
  title: string;
  description: string;
  tags?: string[];
  /** 22 = People & Blogs, 27 = Education, 28 = Science & Technology. */
  categoryId?: string;
  /** What we ASK for. YouTube may override — see the note above. */
  privacyStatus?: "private" | "unlisted" | "public";
  /** Shorts are simply vertical videos under 3 minutes; no separate endpoint. */
  madeForKids?: boolean;
}

/** YouTube's own hard limits on the metadata fields. */
export const YT_MAX_TITLE = 100;
export const YT_MAX_DESCRIPTION = 5000;
/** Total characters across all tags, not per tag. */
export const YT_MAX_TAGS_CHARS = 500;

/**
 * Everything YouTube would reject about this metadata.
 *
 * Checked before a single byte is uploaded: a video is large, and failing
 * after the transfer wastes both time and quota. Titles are refused rather
 * than truncated — a title cut at 100 chars ends mid-word on a public page.
 */
export function validateMetadata(meta: UploadMetadata): string[] {
  const problems: string[] = [];
  const title = (meta.title ?? "").trim();
  if (!title) problems.push("title is required");
  if (title.length > YT_MAX_TITLE) problems.push(`title is ${title.length} chars, over YouTube's ${YT_MAX_TITLE}`);
  // YouTube rejects these outright in titles and descriptions.
  if (title.includes("<") || title.includes(">")) problems.push("title cannot contain < or >");
  if ((meta.description ?? "").length > YT_MAX_DESCRIPTION) {
    problems.push(`description is ${meta.description!.length} chars, over YouTube's ${YT_MAX_DESCRIPTION}`);
  }
  const tagChars = (meta.tags ?? []).join("").length;
  if (tagChars > YT_MAX_TAGS_CHARS) {
    problems.push(`tags total ${tagChars} chars, over YouTube's ${YT_MAX_TAGS_CHARS}`);
  }
  return problems;
}

/** A 403 that means "out of quota" rather than "bad credentials". */
export function isQuotaError(status: number, body: string): boolean {
  if (status !== 403) return false;
  return /quotaExceeded|dailyLimitExceeded|uploadLimitExceeded/i.test(body);
}

/**
 * Exchange the long-lived refresh token for a short-lived access token.
 * Refresh tokens don't expire in normal use, so this is the only auth step
 * that runs per upload.
 */
export async function getAccessToken(creds: YouTubeCredentials, fetcher: FetchLike = fetch): Promise<string> {
  const r = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const text = await r.text();
  if (!r.ok) {
    // invalid_grant almost always means the refresh token was revoked — by a
    // password change, or by Google expiring it on an app still in Testing.
    if (/invalid_grant/i.test(text)) {
      throw new Error("youtube: refresh token rejected (invalid_grant) — it was revoked or expired. Re-run the consent flow to get a new one.");
    }
    throw new Error(`youtube: token refresh failed HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = JSON.parse(text) as { access_token?: string };
  if (!data.access_token) throw new Error("youtube: token endpoint returned no access_token");
  return data.access_token;
}

export interface UploadResult {
  videoId: string;
  url: string;
  /** What YouTube ACTUALLY set — not what was requested. */
  privacyStatus: string;
  /** True when YouTube overrode the requested privacy (unverified app). */
  privacyDowngraded: boolean;
}

/**
 * Upload a video using the resumable protocol.
 *
 * Two steps by design: a metadata POST that returns an upload URL, then the
 * bytes. Resumable rather than simple upload because a dropped connection
 * mid-transfer on a multi-megabyte file is common, and simple upload has to
 * start over while still costing the same 1600 quota units.
 */
export async function uploadVideo(
  video: { bytes: Uint8Array; mimeType?: string },
  meta: UploadMetadata,
  creds: YouTubeCredentials,
  fetcher: FetchLike = fetch,
): Promise<UploadResult> {
  const problems = validateMetadata(meta);
  if (problems.length) throw new Error(`youtube: refusing to upload — ${problems.join("; ")}`);
  if (!video.bytes?.length) throw new Error("youtube: refusing to upload an empty file");

  const accessToken = await getAccessToken(creds, fetcher);
  const requested = meta.privacyStatus ?? "private";

  const body = {
    snippet: {
      title: meta.title.trim(),
      description: meta.description ?? "",
      tags: meta.tags ?? [],
      categoryId: meta.categoryId ?? "22",
    },
    status: {
      privacyStatus: requested,
      selfDeclaredMadeForKids: meta.madeForKids ?? false,
    },
  };

  const initUrl = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
  const init = await fetcher(initUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Upload-Content-Length": String(video.bytes.length),
      "X-Upload-Content-Type": video.mimeType ?? "video/mp4",
    },
    body: JSON.stringify(body),
  });

  if (!init.ok) {
    const text = await init.text().catch(() => "");
    if (isQuotaError(init.status, text)) {
      throw new Error("youtube: daily upload quota exhausted (an upload costs 1600 of 10,000 units — about six per day). This is a quota limit, not an auth problem; it resets at midnight Pacific.");
    }
    throw new Error(`youtube: upload init failed HTTP ${init.status}: ${text.slice(0, 250)}`);
  }

  const uploadUrl = init.headers.get("location") ?? init.headers.get("Location");
  if (!uploadUrl) throw new Error("youtube: upload init succeeded but returned no Location header to upload to");

  const put = await fetcher(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": video.mimeType ?? "video/mp4", "Content-Length": String(video.bytes.length) },
    // Cast through unknown: this repo's TS lib doesn't declare DOM's BodyInit,
    // but Node's fetch accepts a Uint8Array body directly.
    body: video.bytes as unknown as string,
  });

  const text = await put.text();
  if (!put.ok) throw new Error(`youtube: upload failed HTTP ${put.status}: ${text.slice(0, 250)}`);

  const data = JSON.parse(text) as { id?: string; status?: { privacyStatus?: string } };
  if (!data.id) throw new Error("youtube: upload returned no video id");

  const actual = data.status?.privacyStatus ?? requested;
  return {
    videoId: data.id,
    url: `https://www.youtube.com/watch?v=${data.id}`,
    privacyStatus: actual,
    privacyDowngraded: actual !== requested,
  };
}
