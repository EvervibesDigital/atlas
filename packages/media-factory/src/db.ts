import pg from "pg";

let pool: pg.Pool | null = null;

/**
 * DATABASE_URL is required from the environment — no hardcoded fallback.
 * (A previous commit shipped a live Supabase password as a literal fallback
 * string here; it's been rotated and removed. Never hardcode credentials —
 * set DATABASE_URL via the vault/env instead.)
 */
function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("media-factory-db: DATABASE_URL not set");
    pool = new pg.Pool({
      connectionString,
      ssl: { rejectUnauthorized: false }
    });
  }
  return pool;
}

export interface VirtualCreator {
  id?: string;
  name: string;
  handle: string;
  age_range: string;
  gender: string;
  appearance_profile: any;
  personality_traits: string[];
  speaking_style: string;
  humor_style: string;
  values_statement: string;
  background_story: string;
  interests: string[];
  content_pillars: string[];
  target_audience: any;
  brand_positioning: string;
}

export interface CreatorMemory {
  id?: string;
  creator_id: string;
  kind: string;
  content: string;
  metadata?: any;
}

export interface ContentItem {
  id?: string;
  creator_id: string;
  platform: string;
  status: string;
  title: string;
  hook?: string;
  script?: string;
  caption?: string;
  hashtags?: string[];
  assets?: any;
  publish_schedule?: string;
  published_at?: string;
  approval_id?: string;
}

export interface MonetizationPartnership {
  id?: string;
  creator_id: string;
  name: string;
  kind: string;
  destination_url: string;
  promotional_scripts: string[];
  active?: boolean;
}

export interface AnalyticsSnapshot {
  id?: string;
  creator_id: string;
  content_id?: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
  revenue: number;
}

export class MediaFactoryDB {
  static async listCreators(): Promise<VirtualCreator[]> {
    const db = getPool();
    const res = await db.query("SELECT * FROM public.virtual_creators ORDER BY name ASC");
    return res.rows;
  }

  static async getCreator(id: string): Promise<VirtualCreator | null> {
    const db = getPool();
    const res = await db.query("SELECT * FROM public.virtual_creators WHERE id = $1", [id]);
    return res.rows[0] || null;
  }

  static async getCreatorByHandle(handle: string): Promise<VirtualCreator | null> {
    const db = getPool();
    const res = await db.query("SELECT * FROM public.virtual_creators WHERE handle = $1", [handle]);
    return res.rows[0] || null;
  }

  static async createCreator(c: VirtualCreator): Promise<VirtualCreator> {
    const db = getPool();
    const query = `
      INSERT INTO public.virtual_creators (
        name, handle, age_range, gender, appearance_profile, personality_traits,
        speaking_style, humor_style, values_statement, background_story,
        interests, content_pillars, target_audience, brand_positioning
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `;
    const res = await db.query(query, [
      c.name, c.handle, c.age_range, c.gender, JSON.stringify(c.appearance_profile),
      c.personality_traits, c.speaking_style, c.humor_style, c.values_statement,
      c.background_story, c.interests, c.content_pillars, JSON.stringify(c.target_audience),
      c.brand_positioning
    ]);
    return res.rows[0];
  }

  static async updateCreator(id: string, c: Partial<VirtualCreator>): Promise<VirtualCreator> {
    const db = getPool();
    const current = await this.getCreator(id);
    if (!current) throw new Error("Creator not found");

    const merged = { ...current, ...c };
    const query = `
      UPDATE public.virtual_creators SET
        name = $1, handle = $2, age_range = $3, gender = $4, appearance_profile = $5,
        personality_traits = $6, speaking_style = $7, humor_style = $8, values_statement = $9,
        background_story = $10, interests = $11, content_pillars = $12, target_audience = $13,
        brand_positioning = $14, updated_at = NOW()
      WHERE id = $15
      RETURNING *
    `;
    const res = await db.query(query, [
      merged.name, merged.handle, merged.age_range, merged.gender, JSON.stringify(merged.appearance_profile),
      merged.personality_traits, merged.speaking_style, merged.humor_style, merged.values_statement,
      merged.background_story, merged.interests, merged.content_pillars, JSON.stringify(merged.target_audience),
      merged.brand_positioning, id
    ]);
    return res.rows[0];
  }

  static async deleteCreator(id: string): Promise<boolean> {
    const db = getPool();
    const res = await db.query("DELETE FROM public.virtual_creators WHERE id = $1", [id]);
    return (res.rowCount ?? 0) > 0;
  }

  static async listMemories(creatorId: string): Promise<CreatorMemory[]> {
    const db = getPool();
    const res = await db.query("SELECT * FROM public.creator_memories WHERE creator_id = $1 ORDER BY created_at DESC", [creatorId]);
    return res.rows;
  }

  static async addMemory(m: CreatorMemory): Promise<CreatorMemory> {
    const db = getPool();
    const query = `
      INSERT INTO public.creator_memories (creator_id, kind, content, metadata)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `;
    const res = await db.query(query, [m.creator_id, m.kind, m.content, JSON.stringify(m.metadata || {})]);
    return res.rows[0];
  }

  static async deleteMemory(id: string): Promise<boolean> {
    const db = getPool();
    const res = await db.query("DELETE FROM public.creator_memories WHERE id = $1", [id]);
    return (res.rowCount ?? 0) > 0;
  }

  static async listContentItems(creatorId?: string): Promise<ContentItem[]> {
    const db = getPool();
    if (creatorId) {
      const res = await db.query("SELECT * FROM public.content_items WHERE creator_id = $1 ORDER BY publish_schedule DESC, created_at DESC", [creatorId]);
      return res.rows;
    } else {
      const res = await db.query("SELECT * FROM public.content_items ORDER BY created_at DESC");
      return res.rows;
    }
  }

  static async getContentItem(id: string): Promise<ContentItem | null> {
    const db = getPool();
    const res = await db.query("SELECT * FROM public.content_items WHERE id = $1", [id]);
    return res.rows[0] || null;
  }

  static async createContentItem(item: ContentItem): Promise<ContentItem> {
    const db = getPool();
    const query = `
      INSERT INTO public.content_items (
        creator_id, platform, status, title, hook, script, caption, hashtags, assets, publish_schedule, approval_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;
    const res = await db.query(query, [
      item.creator_id, item.platform, item.status || "draft", item.title, item.hook, item.script,
      item.caption, item.hashtags || [], JSON.stringify(item.assets || {}), item.publish_schedule, item.approval_id
    ]);
    return res.rows[0];
  }

  static async updateContentItemStatus(id: string, status: string, publishedAt?: string): Promise<ContentItem> {
    const db = getPool();
    const query = publishedAt
      ? "UPDATE public.content_items SET status = $1, published_at = $2, updated_at = NOW() WHERE id = $3 RETURNING *"
      : "UPDATE public.content_items SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *";
    const params = publishedAt ? [status, publishedAt, id] : [status, id];
    const res = await db.query(query, params);
    return res.rows[0];
  }

  /** Persist a produced draft's script/caption/hashtags/assets and advance its status in one write. */
  static async updateContentItemDraft(id: string, draft: { script?: string; caption?: string; hashtags?: string[]; assets?: any; status?: string }): Promise<ContentItem> {
    const db = getPool();
    const current = await this.getContentItem(id);
    if (!current) throw new Error("Content item not found");
    const merged = { ...current, ...draft, assets: { ...(current.assets || {}), ...(draft.assets || {}) } };
    const query = `
      UPDATE public.content_items SET
        script = $1, caption = $2, hashtags = $3, assets = $4, status = $5, updated_at = NOW()
      WHERE id = $6
      RETURNING *
    `;
    const res = await db.query(query, [
      merged.script, merged.caption, merged.hashtags || [], JSON.stringify(merged.assets || {}), merged.status || current.status, id,
    ]);
    return res.rows[0];
  }

  static async listPartnerships(creatorId: string): Promise<MonetizationPartnership[]> {
    const db = getPool();
    const res = await db.query("SELECT * FROM public.monetization_partnerships WHERE creator_id = $1 ORDER BY name ASC", [creatorId]);
    return res.rows;
  }

  static async addPartnership(p: MonetizationPartnership): Promise<MonetizationPartnership> {
    const db = getPool();
    const query = `
      INSERT INTO public.monetization_partnerships (creator_id, name, kind, destination_url, promotional_scripts, active)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const res = await db.query(query, [
      p.creator_id, p.name, p.kind, p.destination_url, p.promotional_scripts, p.active !== false
    ]);
    return res.rows[0];
  }

  static async saveAnalyticsSnapshot(s: AnalyticsSnapshot): Promise<AnalyticsSnapshot> {
    const db = getPool();
    const query = `
      INSERT INTO public.analytics_snapshots (creator_id, content_id, views, likes, comments, shares, clicks, revenue)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    const res = await db.query(query, [
      s.creator_id, s.content_id, s.views, s.likes, s.comments, s.shares, s.clicks, s.revenue
    ]);
    return res.rows[0];
  }

  static async getAnalytics(creatorId: string): Promise<AnalyticsSnapshot[]> {
    const db = getPool();
    const res = await db.query("SELECT * FROM public.analytics_snapshots WHERE creator_id = $1 ORDER BY recorded_at DESC", [creatorId]);
    return res.rows;
  }
}
