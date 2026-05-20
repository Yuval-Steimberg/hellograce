import type { Pool } from 'pg';

export interface GraceUser {
  id: string;
  phone: string;
  first_name: string | null;
  medication: string | null;
  medication_frequency: string;
  injection_day: string | null;
  injection_count: number;
  goals: string[];
  food_dislikes: string[];
  timezone: string;
  wake_time: string;
  sleep_time: string;
  current_weight: number | null;
  goal_weight: number | null;
  height_cm: number | null;
  age: number | null;
  sex: string | null;
  primary_goal: string | null;
  protein_goal_grams: number | null;
  /** Durable dietary restriction detected from past messages.
   *  'vegan' | 'vegetarian' | 'pescatarian' | null. Written synchronously
   *  by ai.service.ts when detectDietaryRestriction matches; read on every
   *  request so the guard layer doesn't rely on history timing. */
  dietary_pattern: string | null;
  // behavioural flags
  protein_focus_boost: boolean;
  hydration_struggle: boolean;
  low_mood_mode: boolean;
  midday_skip: boolean;
  // injection flow
  injection_flow_stage: string | null;
  injection_flow_started_at: Date | null;
  injection_done_at: Date | null;
  injection_side_effect_free: boolean;
  injection_evening_followup_due: boolean;
  // side-effect flow
  side_effect_flow: string | null;
  side_effect_flow_started_at: Date | null;
  side_effect_followup_sent: boolean;
  // scheduling
  last_morning_sent_at: Date | null;
  last_midday_sent_at: Date | null;
  last_evening_sent_at: Date | null;
  last_reply_at: Date | null;
  messages_sent_today: number;
  messages_sent_today_date: Date | null;
  checkin_frequency: string;
  checkin_count_per_day: number;
  checkin_days_interval: number;
  glp1_start_date: Date | null;
  grace_notes: string | null;
  // account
  active: boolean;
  paused: boolean;
  blocked: boolean;
  is_paid: boolean;
  is_pro: boolean;
  trial_start: Date | null;
  rlhf_enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export class UserService {
  constructor(private pool: Pool) {}

  /** Fetch user by phone. Returns null if not found. */
  async getByPhone(phone: string): Promise<GraceUser | null> {
    const { rows } = await this.pool.query<GraceUser>(
      `SELECT * FROM users WHERE phone = $1 LIMIT 1`,
      [phone],
    );
    return rows[0] ?? null;
  }

  /** Fetch user by userId (text). */
  async getById(userId: string): Promise<GraceUser | null> {
    const { rows } = await this.pool.query<GraceUser>(
      `SELECT * FROM users WHERE id::text = $1 OR phone = $1 LIMIT 1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  /** Upsert user — creates if new, updates last_reply_at + updated_at. */
  async ensureUser(phone: string): Promise<GraceUser> {
    const { rows } = await this.pool.query<GraceUser>(
      `INSERT INTO users (phone, last_reply_at)
       VALUES ($1, now())
       ON CONFLICT (phone) DO UPDATE
         SET last_reply_at = now(), updated_at = now()
       RETURNING *`,
      [phone],
    );
    return rows[0]!;
  }

  /** Check if user has sent any messages before (first-time detection). */
  async isNewUser(userId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text FROM messages WHERE user_id = $1 LIMIT 2`,
      [userId],
    );
    return Number(rows[0]?.count ?? 0) === 0;
  }

  /** Update arbitrary user fields. */
  async update(phone: string, fields: Partial<Omit<GraceUser, 'id' | 'phone' | 'created_at' | 'updated_at'>>): Promise<void> {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (keys.length === 0) return;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = keys.map((k) => fields[k]);
    await this.pool.query(
      `UPDATE users SET ${sets}, updated_at = now() WHERE phone = $1`,
      [phone, ...values],
    );
  }

  /** Update injection flow stage. */
  async setInjectionStage(phone: string, stage: string | null, extra: Record<string, unknown> = {}): Promise<void> {
    await this.update(phone, { injection_flow_stage: stage ?? undefined, ...extra } as Partial<GraceUser>);
  }

  /** Fetch last N check-ins for a user. */
  async getRecentCheckIns(userId: string, limit = 5): Promise<Array<{
    type: string;
    message_sent: string;
    user_reply: string | null;
    mood_score: number | null;
    created_at: Date;
  }>> {
    const { rows } = await this.pool.query(
      `SELECT type, message_sent, user_reply, mood_score, created_at
       FROM check_ins
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return rows;
  }

  /** Record a sent check-in. */
  async recordCheckIn(data: {
    userId: string;
    phone: string;
    type: string;
    messageSent: string;
  }): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO check_ins (user_id, phone, type, message_sent)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [data.userId, data.phone, data.type, data.messageSent],
    );
    return rows[0]!.id;
  }

  /** Get weight history for a user. */
  async getWeightHistory(userId: string, limit = 10): Promise<Array<{
    weight: number;
    created_at: Date;
  }>> {
    const { rows } = await this.pool.query(
      `SELECT weight, created_at FROM weight_logs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return rows;
  }

  /**
   * Get today's food logs summary in the USER'S calendar day (not UTC, not a
   * rolling 24h window). Boundary is computed from the user's timezone column,
   * so the total resets at the user's local midnight and never mixes days.
   */
  async getTodaysFoodSummary(userId: string): Promise<{ protein_g: number; calories: number; items: string[] }> {
    const { rows } = await this.pool.query<{ food: string; protein_g: number; calories: number }>(
      `WITH user_tz AS (
         SELECT COALESCE(NULLIF(timezone, ''), 'UTC') AS tz
         FROM users WHERE phone = $1
       )
       SELECT food,
              COALESCE(protein_g, 0) AS protein_g,
              COALESCE(calories, 0) AS calories
       FROM food_logs, user_tz
       WHERE user_id = $1
         AND (created_at AT TIME ZONE user_tz.tz - INTERVAL '5 hours')::date
             = (now()       AT TIME ZONE user_tz.tz - INTERVAL '5 hours')::date
       ORDER BY created_at DESC`,
      [userId],
    );
    return {
      protein_g: rows.reduce((s, r) => s + r.protein_g, 0),
      calories: rows.reduce((s, r) => s + r.calories, 0),
      items: rows.map((r) => r.food),
    };
  }

  /**
   * Load the durable profile facts extracted by the fact-extractor worker
   * (e.g. "vegetarian", "works night shifts", "protein shakes cause nausea").
   * Returned grouped by category, most recent first, capped to keep the
   * system prompt compact. Used by buildPersonalisedPrompt so Grace
   * remembers things users mentioned in previous conversations.
   *
   * Returns empty array if migration 20260516000003 hasn't been applied —
   * tolerant fallback so the table-missing case doesn't break message
   * handling.
   */
  async getKnownFacts(
    userId: string,
    limit = 30,
  ): Promise<Array<{ fact: string; category: string; confidence: string }>> {
    try {
      const { rows } = await this.pool.query<{ fact: string; category: string; confidence: string }>(
        `SELECT fact, category, confidence
         FROM user_profile_facts
         WHERE user_id = $1
         ORDER BY
           CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
           created_at DESC
         LIMIT $2`,
        [userId, limit],
      );
      return rows;
    } catch {
      return [];
    }
  }

  /**
   * Record a user-submitted rating/comment for the last assistant message.
   * Finds the most recent assistant message, writes to feedback, and adjusts
   * the embedding feedback_score so future RAG retrieval reflects the signal.
   */
  async recordUserFeedback(phone: string, rating: number, comment?: string): Promise<void> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM messages WHERE user_id = $1 AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
      [phone],
    );
    const messageId = rows[0]?.id ?? null;
    await this.pool.query(
      `INSERT INTO feedback (message_id, user_id, signal_type, rating, comment)
       VALUES ($1, $2, $3, $4, $5)`,
      [messageId, phone, comment ? 'comment' : 'rating', rating, comment ?? null],
    );
    if (messageId) {
      await this.pool.query(
        `UPDATE embeddings
         SET feedback_score = COALESCE(feedback_score, 0) + $1
         WHERE metadata->>'message_id' = $2`,
        [rating, messageId],
      );
    }
  }

  /**
   * Persist a detected dietary pattern (vegan/vegetarian/pescatarian) onto
   * the user record. Tolerant of the migration not being applied — if the
   * column doesn't exist yet, swallows the error and logs nothing (this
   * runs in the hot path of every reactive message).
   *
   * Only writes when the pattern actually changes, so we don't churn the
   * row on every request.
   */
  async setDietaryPattern(phone: string, pattern: string | null): Promise<void> {
    try {
      await this.pool.query(
        `UPDATE users
         SET dietary_pattern = $2, updated_at = now()
         WHERE phone = $1
           AND (dietary_pattern IS DISTINCT FROM $2)`,
        [phone, pattern],
      );
    } catch {
      // Migration 20260516000004 not applied yet — ignore.
    }
  }

  /** List all active users (for scheduler). */
  async listActiveUsers(): Promise<GraceUser[]> {
    const { rows } = await this.pool.query<GraceUser>(
      `SELECT * FROM users WHERE active = TRUE AND paused = FALSE AND blocked = FALSE`,
    );
    return rows;
  }
}
