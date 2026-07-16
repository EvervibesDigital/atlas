export interface KdpOpportunity {
  id: string;
  niche: string;
  topic: string;
  source: string;
  ai_score: number;
  ai_rationale?: string | null;
  recommended_type?: string | null;
  seasonality?: string | null;
  urgency_date?: string | null;
  status: string;
  created_at: string;
}

export interface KdpBook {
  id: string;
  niche: string;
  product_type: string;
  trim_size: string;
  page_count: number;
  title?: string | null;
  subtitle?: string | null;
  description?: string | null;
  keywords?: string[];
  categories?: string[];
  cover_hook?: string | null;
  back_cover_text?: string | null;
  primary_color?: string | null;
  interior_type?: string | null;
  status: string;
  amazon_url?: string | null;
  amazon_asin?: string | null;
  created_at: string;
}

export type KdpBookStatus = "generated" | "downloaded" | "uploaded_to_amazon" | "live" | "archived";
