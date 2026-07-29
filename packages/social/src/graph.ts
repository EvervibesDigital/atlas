export interface FetchLike {
  (url: string, init?: unknown): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
}

export interface LongLivedTokenResult {
  accessToken: string;
  expiresIn?: number;
}

/** Short-lived user tokens from the initial code exchange are valid ~1-2
 * hours. Exchange for a long-lived one (~60 days) immediately, same
 * grant Meta documents for this step. */
export async function exchangeForLongLivedToken(
  shortLivedToken: string,
  appId: string,
  appSecret: string,
  fetcher: FetchLike,
): Promise<LongLivedTokenResult> {
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortLivedToken,
  });
  const r = await fetcher(`https://graph.facebook.com/v25.0/oauth/access_token?${params.toString()}`);
  const data = (await r.json()) as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!r.ok) throw new Error(`long-lived token exchange failed: HTTP ${r.status} ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
  if (!data.access_token) throw new Error(`long-lived token exchange returned no access_token: ${JSON.stringify(data).slice(0, 200)}`);
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

export interface PageWithInstagram {
  pageId: string;
  pageName: string;
  pageAccessToken: string;
  igBusinessAccountId: string | undefined;
}

/** The Pages this user manages, each with its OWN access token (not the user
 * token — posting/reading as a Page requires the Page's token) and its
 * linked Instagram Business Account id, if any. */
export async function fetchPagesWithInstagram(userAccessToken: string, fetcher: FetchLike): Promise<PageWithInstagram[]> {
  const params = new URLSearchParams({
    access_token: userAccessToken,
    fields: "id,name,access_token,instagram_business_account",
  });
  const r = await fetcher(`https://graph.facebook.com/v25.0/me/accounts?${params.toString()}`);
  const data = (await r.json()) as {
    data?: Array<{ id: string; name: string; access_token: string; instagram_business_account?: { id: string } }>;
    error?: { message?: string };
  };
  if (!r.ok) throw new Error(`fetching Pages failed: HTTP ${r.status} ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
  return (data.data ?? []).map((p) => ({
    pageId: p.id,
    pageName: p.name,
    pageAccessToken: p.access_token,
    igBusinessAccountId: p.instagram_business_account?.id,
  }));
}
