/**
 * Meta's app for this project uses "Facebook Login for Business" (a
 * business-type app), not plain consumer Facebook Login. Confirmed live
 * against Meta's current docs after a real connection attempt failed with
 * "Invalid Scopes": business-type apps can't request permissions like
 * pages_manage_posts/instagram_content_publish/instagram_manage_comments via
 * a raw `scope=` parameter — Meta requires a `config_id` referencing a saved
 * Login Configuration created in the App Dashboard instead. `scope` is
 * explicitly documented as "should not be used" once config_id is in play.
 */
export function buildConnectUrl(appId: string, configId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: appId,
    config_id: configId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
  });
  return `https://www.facebook.com/v25.0/dialog/oauth?${params.toString()}`;
}
