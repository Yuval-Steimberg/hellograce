import type { Pool } from 'pg';
import type { Logger } from 'pino';

export interface MessageTemplate {
  id: number;
  key: string;
  template: string;
  description: string | null;
  variables: string[];
  is_active: boolean;
  updated_at: Date;
}

/**
 * In-memory cache of admin-editable subscription message templates. Same
 * pattern as ContentRulesService: 60 s TTL, never wipes on transient DB
 * failure so a Postgres blip can't strip the paywall message out from
 * under us mid-request.
 *
 * Variable substitution uses literal {name} replacement — keep it simple.
 * The sender's outbound sanitizer strips any unfilled placeholders that
 * survive (defense in depth).
 */
export class MessageTemplatesService {
  private cache: Map<string, MessageTemplate> = new Map();
  private lastLoaded = 0;
  private readonly TTL_MS = 60_000;

  constructor(private pool: Pool, private logger: Logger) {}

  /** Look up a template by key. Returns null if not found or table missing. */
  async get(key: string): Promise<MessageTemplate | null> {
    await this.ensureFresh();
    return this.cache.get(key) ?? null;
  }

  /**
   * Render a template by key, substituting {var} placeholders. Returns
   * `fallback` if the template is missing or the table doesn't exist —
   * never throws. Hard-coded callers should always pass a fallback so
   * subscription messages never become silent on DB failure.
   */
  async render(
    key: string,
    vars: Record<string, string>,
    fallback: string,
  ): Promise<string> {
    const tpl = await this.get(key);
    if (!tpl) return fallback;
    let out = tpl.template;
    for (const [k, v] of Object.entries(vars)) {
      out = out.split(`{${k}}`).join(v);
    }
    return out;
  }

  /** List all templates (active and inactive) — used by the admin UI. */
  async list(): Promise<MessageTemplate[]> {
    try {
      const { rows } = await this.pool.query<MessageTemplate>(
        `SELECT id, key, template, description, variables, is_active, updated_at
         FROM message_templates
         ORDER BY key`,
      );
      return rows;
    } catch (err) {
      this.logger.warn({ err }, 'message_templates.list.failed');
      return [];
    }
  }

  /** Update a template's body. Invalidates the cache so next read reloads. */
  async update(key: string, template: string): Promise<void> {
    await this.pool.query(
      `UPDATE message_templates SET template = $2 WHERE key = $1`,
      [key, template],
    );
    this.cache.clear();
    this.lastLoaded = 0;
  }

  private async ensureFresh(): Promise<void> {
    const isStale = Date.now() - this.lastLoaded > this.TTL_MS;
    if (!isStale && this.cache.size > 0) return;
    try {
      const { rows } = await this.pool.query<MessageTemplate>(
        `SELECT id, key, template, description, variables, is_active, updated_at
         FROM message_templates
         WHERE is_active = TRUE`,
      );
      const next = new Map<string, MessageTemplate>();
      for (const row of rows) next.set(row.key, row);
      this.cache = next;
      this.lastLoaded = Date.now();
    } catch (err) {
      // Keep stale cache rather than wipe — migrations may not yet be applied,
      // and a transient DB error shouldn't take subscription messages offline.
      this.logger.warn({ err }, 'message_templates.load.failed');
    }
  }
}
