import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { DbContentRule } from '@grace/shared';

export class ContentRulesService {
  private cache: DbContentRule[] = [];
  private lastRefresh = 0;
  private readonly TTL_MS = 60_000;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private pool: Pool, private logger: Logger) {}

  /**
   * Return active rules for the given channel.
   * Refreshes from DB at most once per TTL_MS; subsequent calls within the
   * window are synchronous (pure memory, no await on the hot path).
   */
  async getActive(target: 'ai' | 'scheduler' = 'ai'): Promise<DbContentRule[]> {
    if (Date.now() - this.lastRefresh > this.TTL_MS) {
      await this.refresh();
    }
    return this.cache.filter((r) => r.applies_to === 'all' || r.applies_to === target);
  }

  async refresh(): Promise<void> {
    try {
      const { rows } = await this.pool.query<DbContentRule>(`
        SELECT id, rule_type, pattern, is_regex, flags, reason, severity, applies_to
        FROM content_rules
        WHERE is_active = TRUE
        ORDER BY CASE severity WHEN 'block' THEN 0 WHEN 'regen' THEN 1 ELSE 2 END, id
      `);
      this.cache = rows;
      this.lastRefresh = Date.now();
      this.logger.debug({ count: rows.length }, 'content_rules.loaded');
    } catch (err) {
      // Keep stale cache on transient DB error rather than wiping it.
      this.logger.error({ err }, 'content_rules.load_failed');
    }
  }

  /** Call once at server startup. Loads rules immediately then refreshes on TTL. */
  start(): void {
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, this.TTL_MS);
    if (this.timer.unref) this.timer.unref(); // don't hold the event loop open
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
