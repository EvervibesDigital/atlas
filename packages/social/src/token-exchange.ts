export interface FetchLike {
  (url: string, init?: unknown): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
}

export interface TokenExchangeResult {
  accessToken: string;
  expiresIn?: number;
}

/** Standard OAuth code-for-token exchange against Meta's Graph API.
 * Not yet verified against a real response — no Meta test account exists
 * to check it against. Watch this specific call the first time an account
 * actually connects; if the response shape differs, it's a one-function
 * fix here, not a mystery. */
export async function exchangeCodeForToken(
  code: string,
  appId: string,
  appSecret: string,
  redirectUri: string,
  fetcher: FetchLike,
): Promise<TokenExchangeResult> {
  const params = new URLSearchParams({ client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code });
  const r = await fetcher(`https://graph.facebook.com/v21.0/oauth/access_token?${params.toString()}`);
  const data = (await r.json()) as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!r.ok) throw new Error(`token exchange failed: HTTP ${r.status} ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
  if (!data.access_token) throw new Error(`token exchange returned no access_token: ${JSON.stringify(data).slice(0, 200)}`);
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}
