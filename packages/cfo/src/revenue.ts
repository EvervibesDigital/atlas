// Bridges to evervibes' REAL revenue rollup (/api/n8n/revenue-summary) — a
// live read of the same Supabase tables its Stripe webhook already writes to
// (SaaS subscriptions, one-time module purchases, wholesale deal-unlock fees,
// wholesale investor subscriptions). This does NOT reimplement any billing
// logic; it's a read-only bridge, same CRON_SECRET-bearer pattern @atlas/kdp
// already uses against this same app.

export type FetchLike = typeof fetch;

export interface RevenueSummary {
  as_of: string;
  /** Real monthly recurring revenue, dollars: SaaS + wholesale investor subs. */
  mrr: number;
  /** One-time revenue collected so far this calendar month, dollars. */
  one_time_this_month: number;
  breakdown: {
    saas_mrr: number;
    saas_active_subscribers: number;
    wholesale_investor_mrr: number;
    wholesale_paying_investors: number;
    module_purchases_this_month: number;
    deal_unlocks_this_month: number;
  };
}

export async function fetchRevenueSummary(baseUrl: string, secret: string, fetcher: FetchLike = fetch): Promise<RevenueSummary> {
  const r = await fetcher(`${baseUrl.replace(/\/+$/, "")}/api/n8n/revenue-summary`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!r.ok) throw new Error(`cfo: revenue-summary HTTP ${r.status}`);
  return (await r.json()) as RevenueSummary;
}
