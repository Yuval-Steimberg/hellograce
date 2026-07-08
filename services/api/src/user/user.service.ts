import type { Pool } from 'pg';
import { encryptField, decryptField, hashField, isEncryptionEnabled, isEncryptedBlob } from '../crypto/field-encrypt.js';
import type { TodayFoodCacheService } from '../cache/today-food-cache.js';
import { USER_DAY_CTE, userDayExpr, isCurrentUserDay, computeUserLoggingDay } from '../nutrition/logging-window.js';
import { deriveMissingTargets } from '../nutrition/derive-targets.js';
import { getDailyWaterHistory as getDailyWaterHistoryQuery } from '../services/water-log.js';
import { recordDoseEvent, getDoseEvents } from '../services/medication-timeline.js';
import { timezoneFromPhone } from '../services/timezone-parse.js';

export interface GraceUser {
  id: string;
  phone: string;
  first_name: string | null;
  medication: string | null;
  medication_frequency: string;
  injection_day: string | null;
  medication_time: string | null;
  sms_consent: boolean;
  injection_count: number;
  goals: string[];
  food_dislikes: string[];
  timezone: string;
  /** ISO-3166-1 alpha-2 (US, IL, GB, CA, AU, etc.). Nullable. Used by the
   *  crisis-resources lookup for localized SAFETY hotline numbers.
   *  Effective only when CRISIS_RESOURCES_REVIEWED env flag is true.
   *  Added 2026-06-06 (migration 20260606000002_user_country_code.sql). */
  country_code: string | null;
  wake_time: string;
  sleep_time: string;
  current_weight: number | null;
  goal_weight: number | null;
  /** User-provided baseline weight in lbs at start of GLP-1 journey.
   *  Nullable. Grace must NEVER fabricate or infer this value when absent.
   *  Added 2026-06-06 (migration 20260606000001_starting_weight.sql). */
  starting_weight: number | null;
  height_cm: number | null;
  age: number | null;
  sex: string | null;
  primary_goal: string | null;
  protein_goal_grams: number | null;
  calorie_goal_kcal: number | null;
  /** Durable dietary restriction detected from past messages.
   *  'vegan' | 'vegetarian' | 'pescatarian' | null. Written synchronously
   *  by ai.service.ts when detectDietaryRestriction matches; read on every
   *  request so the guard layer doesn't rely on history timing. */
  activity_level: string | null;
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
  /** Post-trial win-back sequence state (2026-07-07, migration
   *  20260707000001_post_trial_winback.sql). 0 = none sent, 1..5 = stages sent,
   *  5 = sequence complete. Undefined (pre-migration) is treated as 0. */
  winback_stage?: number | null;
  /** When the last post-trial win-back SMS went out — drives the inter-stage
   *  waits and the 36h min-gap guard. */
  winback_last_sent_at?: Date | null;
  rlhf_enabled: boolean;
  /** Per-user opt-out for the nightly end-of-day summary (SEPARATE from
   *  reminders). Default TRUE in the DB, so once DAILY_SUMMARY_ENABLED is on,
   *  every eligible user receives it unless individually disabled. Undefined
   *  (pre-migration row) is treated as enabled by the summary job.
   *  Added 2026-07-06 (migration 20260706000001_daily_summary.sql). */
  daily_summary_enabled: boolean;
  created_at: Date;
  updated_at: Date;
  // lifestyle & personalization (migration 20260524000002)
  dose_mg: number | null;
  dietary_restriction: string | null;
  biggest_challenge: string | null;
  why_started: string | null;
  support_style: string | null;
  exercise_habits: string | null;
  /** Delivery channel for proactive/outbound messages: 'whatsapp' | 'sms' |
   *  'imessage'. Null/absent → treated as 'whatsapp'. Inbound replies always
   *  go back on the channel the message arrived on (carried by the webhook),
   *  so this column only drives PROACTIVE sends (scheduler, admin manual send).
   *  Added 2026-06-17 (migration 20260617000001_user_channel.sql). */
  channel: 'whatsapp' | 'sms' | 'imessage' | null;
  /** Conversational onboarding progress (migration 20260628000001_sms_onboarding.sql).
   *  null = never started (web-onboarded or pre-feature); 'in_progress' = mid
   *  SMS onboarding; 'complete' = finished. `onboarding_last_slot` is the field
   *  Grace last asked for, so the next inbound reply is parsed into it. */
  onboarding_state?: 'in_progress' | 'complete' | null;
  onboarding_last_slot?: string | null;
  onboarding_started_at?: Date | null;
}

export class UserService {
  // ── In-memory user cache (Phase 16 latency, 2026-06-03) ──────────────────
  // Inbound webhook calls ensureUser → handleMessage → getById. Both hit the
  // same row but go through separate SELECTs. Caching the decrypted user for
  // a few seconds removes one DB round-trip per turn (~30-80ms saved). Writes
  // (ensureUser / update) invalidate the cache key so freshness is bounded.
  // Per-user only — never shared across users.
  private userCache = new Map<string, { user: GraceUser; expiresAt: number }>();
  // Bumped 30s → 60s → 5s (2026-06-03):
  //   - 60s caused a cross-machine staleness bug. Fly runs 2 machines; admin
  //     PUT on machine A invalidates A's cache but B's cache stays stale up
  //     to 60s. If the user's next WhatsApp message routes to B, dietary
  //     filter sees null and they get chicken/fish recommended despite being
  //     vegetarian. Production failure 2026-06-03 21:47 IDT.
  //   - 5s is the safe upper bound: enough to cover the in-request duplicate
  //     read (getByPhone + getById run within ~50ms of each other) while
  //     keeping cross-machine staleness under the human-perceivable threshold.
  // Long-term fix: move user cache to Redis (shared across machines).
  private readonly USER_CACHE_TTL_MS = 5_000;

  // ── Per-method query caches (2026-06-03 latency cut) ─────────────────────
  // parallel_io was 1.3-1.7s in production telemetry, dominated by 9 parallel
  // Supabase queries from Fly/iad to Supabase/ap-northeast-1 (~150ms RTT each).
  // The two heaviest reads are getTodaysFoodSummary (multi-row sum with TZ
  // subquery) and getKnownFacts (sorted scan of user_profile_facts).
  //
  // Short TTLs ensure freshness — getTodaysFoodSummary at 10s means food logs
  // visibly land within ~10s of insertion even without explicit invalidation,
  // and getKnownFacts at 5min is comfortably under the background fact-extract
  // worker's typical update cadence.
  //
  // Cache is invalidated on:
  //   - getTodaysFoodSummary: invalidateTodaysFoodCache(userId) is called from
  //     food-log-fast.ts and the log_food tool after successful INSERT
  //   - getKnownFacts: invalidated when the fact-extract worker writes
  private todaysFoodCache = new Map<string, { value: Awaited<ReturnType<UserService['getTodaysFoodSummary']>>; expiresAt: number }>();
  private knownFactsCache = new Map<string, { value: Awaited<ReturnType<UserService['getKnownFacts']>>; expiresAt: number }>();
  private readonly TODAYS_FOOD_TTL_MS = 10_000;     // 10s — short so new logs land fast
  private readonly KNOWN_FACTS_TTL_MS = 5 * 60_000; // 5min — facts evolve slowly

  /** Public invalidator — call after writing to food_logs so the next read
   *  sees the new total. Safe to call from anywhere (tools, fast-paths). */
  invalidateTodaysFoodCache(userId: string): void {
    this.todaysFoodCache.delete(userId);
    // Also drop the L2 Redis cache (best-effort, fire-and-forget). The
    // caller doesn't need to await — next read will recompute.
    if (this.todayFoodCache) {
      void (async () => {
        const u = await this.getById(userId).catch(() => null);
        const tz = u?.timezone ?? 'UTC';
        if (this.todayFoodCache) {
          await this.todayFoodCache.invalidate(userId, tz, u?.wake_time ?? null).catch(() => undefined);
        }
      })();
    }
  }

  /** Public invalidator — call after writing to user_profile_facts. Clears
   *  all (userId, limit) variants so any subsequent read sees the new facts. */
  invalidateKnownFactsCache(userId: string): void {
    const prefix = `${userId}|`;
    for (const key of this.knownFactsCache.keys()) {
      if (key.startsWith(prefix)) this.knownFactsCache.delete(key);
    }
  }

  /** Optional Redis L2 cache for today's food summary. Set via setter so
   *  existing tests + callers that pass just the pool don't break. When
   *  unset, falls back to the existing in-memory L1 cache + DB query. */
  private todayFoodCache: TodayFoodCacheService | undefined;

  constructor(private pool: Pool) {}

  /** Wire the Redis L2 cache for `getTodaysFoodSummary`. Optional —
   *  callers that don't set this still get the in-memory L1 cache. */
  setTodayFoodCache(cache: TodayFoodCacheService): void {
    this.todayFoodCache = cache;
  }

  private invalidateUserCache(keys: Array<string | null | undefined>): void {
    for (const k of keys) {
      if (typeof k === 'string' && k.length > 0) this.userCache.delete(k);
    }
  }

  /** Public cache eviction by phone (and id if known). Used by the admin
   *  delete endpoint so a hard-deleted user isn't served from the in-memory
   *  cache on a subsequent read. */
  invalidate(phone: string, id?: string): void {
    this.invalidateUserCache([phone, id]);
  }

  /**
   * Hard-delete a user AND every row that references them, then evict all of
   * their caches — the SINGLE source of truth for "remove this user." Used by
   * both the admin delete and the GDPR self-serve delete so neither path can
   * leave orphaned data that keeps surfacing on the dashboard/Settings/chat.
   *
   * Why this exists: child rows are keyed by `user_id = phone` in most tables,
   * but a few subtleties bit us — `check_ins` mood rows are inserted with
   * `phone = NULL` (only `user_id`), and `symptom_episodes` / `progress_photos`
   * were never deleted at all. So after a delete, the dashboard still showed
   * mood, symptom patterns, the photo gallery, AND today's food total (served
   * from the L1/L2 caches, which were never invalidated). This purges all of it.
   *
   * Every statement is best-effort (a missing table pre-migration must not
   * abort the purge). Ordered children-before-parent for FK safety.
   */
  async purgeUserData(phone: string, id?: string): Promise<void> {
    const q = (sql: string, params: unknown[]) => this.pool.query(sql, params).catch(() => null);
    // Tables keyed by user_id = phone.
    for (const table of [
      'user_memories', 'user_profile_facts', 'tool_logs', 'injections',
      'feedback', 'messages', 'conversations', 'embeddings',
      'food_logs', 'weight_logs', 'symptom_episodes', 'progress_photos',
    ]) {
      await q(`DELETE FROM ${table} WHERE user_id = $1`, [phone]);
    }
    // check_ins: scheduler rows carry `phone`, but mood/tool logs carry only
    // `user_id` (phone is NULL) — delete on EITHER so nothing survives.
    await q('DELETE FROM check_ins WHERE user_id = $1 OR phone = $1', [phone]);
    // Finally the parent row.
    await q('DELETE FROM users WHERE phone = $1', [phone]);
    // Evict every cache layer so no surface reads stale data.
    this.invalidate(phone, id);
    this.invalidateTodaysFoodCache(phone);
    this.invalidateKnownFactsCache(phone);
  }

  private cacheUser(user: GraceUser): void {
    const expiresAt = Date.now() + this.USER_CACHE_TTL_MS;
    if (user.id) this.userCache.set(String(user.id), { user, expiresAt });
    if (user.phone) this.userCache.set(user.phone, { user, expiresAt });
  }

  private getCachedUser(key: string): GraceUser | null {
    const hit = this.userCache.get(key);
    if (!hit) return null;
    if (hit.expiresAt < Date.now()) {
      this.userCache.delete(key);
      return null;
    }
    return hit.user;
  }

  private decryptUser(row: GraceUser): GraceUser {
    const r = { ...row };
    r.first_name = this.safeDecryptField(r.first_name);
    r.medication = this.safeDecryptField(r.medication);
    return r;
  }

  /**
   * Decrypt an at-rest field, failing SAFE in every degraded case so an
   * encryption misconfiguration can never (a) crash a user fetch or (b) leak
   * ciphertext into a prompt / reply / admin view:
   *   - encryption ON, value decrypts → plaintext
   *   - encryption ON, wrong/rotated key (decrypt throws) → null if the value
   *     is an unrecoverable blob, else the original (it wasn't encrypted)
   *   - encryption OFF but the stored value is still an `enc:` blob (the key
   *     was dropped after the field was written) → null (we can't read it)
   *   - plaintext value → returned unchanged
   * Returning null means "unknown" — callers already treat a null
   * first_name / medication as absent.
   */
  private safeDecryptField(value: string | null): string | null {
    if (!value) return value;
    if (isEncryptionEnabled()) {
      try {
        return decryptField(value);
      } catch {
        return isEncryptedBlob(value) ? null : value;
      }
    }
    return isEncryptedBlob(value) ? null : value;
  }

  /** Fetch user by phone. Tries phone_hash first, falls back to plaintext. */
  async getByPhone(phone: string): Promise<GraceUser | null> {
    const cached = this.getCachedUser(phone);
    if (cached) return cached;
    if (isEncryptionEnabled()) {
      const hash = hashField(phone);
      const { rows } = await this.pool.query<GraceUser>(
        `SELECT * FROM users WHERE phone_hash = $1 LIMIT 1`,
        [hash],
      );
      if (rows[0]) {
        const u = this.decryptUser(rows[0]);
        this.cacheUser(u);
        return u;
      }
    }
    const { rows } = await this.pool.query<GraceUser>(
      `SELECT * FROM users WHERE phone = $1 LIMIT 1`,
      [phone],
    );
    if (!rows[0]) return null;
    const u = this.decryptUser(rows[0]);
    this.cacheUser(u);
    return u;
  }

  /** Fetch user by userId (text). */
  async getById(userId: string): Promise<GraceUser | null> {
    const cached = this.getCachedUser(userId);
    if (cached) return cached;
    const { rows } = await this.pool.query<GraceUser>(
      `SELECT * FROM users WHERE id::text = $1 OR phone = $1 LIMIT 1`,
      [userId],
    );
    if (!rows[0]) return null;
    const u = this.decryptUser(rows[0]);
    this.cacheUser(u);
    return u;
  }

  /** Upsert user — creates if new, updates last_reply_at + updated_at.
   *  Writes the fresh decrypted user into the in-memory cache so the
   *  immediately-following getById() in the AI pipeline hits cache. */
  async ensureUser(phone: string): Promise<GraceUser> {
    const hash = isEncryptionEnabled() ? hashField(phone) : null;

    if (hash) {
      const { rows } = await this.pool.query<GraceUser>(
        `INSERT INTO users (phone, phone_hash, last_reply_at)
         VALUES ($1, $2, now())
         ON CONFLICT (phone) DO UPDATE
           SET last_reply_at = now(), updated_at = now(),
               phone_hash = COALESCE(users.phone_hash, EXCLUDED.phone_hash)
         RETURNING *`,
        [phone, hash],
      );
      const u = this.decryptUser(rows[0]!);
      this.cacheUser(u);
      return this.correctTimezoneFromPhone(u);
    }

    const { rows } = await this.pool.query<GraceUser>(
      `INSERT INTO users (phone, last_reply_at)
       VALUES ($1, now())
       ON CONFLICT (phone) DO UPDATE
         SET last_reply_at = now(), updated_at = now()
       RETURNING *`,
      [phone],
    );
    const u = this.decryptUser(rows[0]!);
    this.cacheUser(u);
    return this.correctTimezoneFromPhone(u);
  }

  /**
   * The DB default timezone is a blind 'America/New_York'. Derive the REAL zone
   * from the phone's country/area code (e.g. +972 → Asia/Jerusalem, +44 →
   * Europe/London) so local time, the diary's midnight reset, reminders, and the
   * daily summary are all on the user's actual clock — including DST/summer time,
   * which the IANA zone handles automatically. Self-healing: runs only while the
   * timezone is still the default, so it corrects existing users on their next
   * message and NEVER overrides a real (non-default) setting. One UPDATE at most.
   */
  private async correctTimezoneFromPhone(u: GraceUser): Promise<GraceUser> {
    if (u.timezone && u.timezone !== 'America/New_York') return u; // real setting → leave it
    const tz = timezoneFromPhone(u.phone);
    if (!tz || tz === u.timezone) return u; // no better guess (or already NY-from-NY-number)
    try {
      await this.pool.query(`UPDATE users SET timezone = $2, updated_at = now() WHERE phone = $1`, [u.phone, tz]);
      const next = { ...u, timezone: tz };
      this.cacheUser(next);
      return next;
    } catch {
      return u; // best-effort — never block a message on this
    }
  }

  /**
   * Check if user is genuinely new (first interaction ever).
   *
   * Uses BOTH message count AND account age so a reset-memory operation on
   * an established user doesn't make Grace treat them like a stranger and
   * greet them with "really glad to connect, Yuval!" — that's a name + welcome
   * combo that violates the ZERO TOLERANCE rules. Account >24h old = NOT new
   * regardless of message count.
   */
  async isNewUser(userId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ msg_count: string; account_age_hours: number | null }>(
      `SELECT
         (SELECT count(*)::text FROM messages WHERE user_id = $1) AS msg_count,
         EXTRACT(EPOCH FROM (now() - created_at)) / 3600 AS account_age_hours
       FROM users
       WHERE phone = $1 OR id::text = $1
       LIMIT 1`,
      [userId],
    );
    const msgCount = Number(rows[0]?.msg_count ?? 0);
    const accountAgeHours = rows[0]?.account_age_hours ?? null;
    // Truly new = no messages AND account is less than 24h old.
    return msgCount === 0 && (accountAgeHours === null || accountAgeHours < 24);
  }

  /** Update arbitrary user fields. Encrypts sensitive fields when encryption is enabled. */
  async update(phone: string, fields: Partial<Omit<GraceUser, 'id' | 'phone' | 'created_at' | 'updated_at'>>): Promise<void> {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (keys.length === 0) return;
    // Capture a dose change to append to the timeline AFTER the update succeeds
    // (read the raw number before the encryption pass mutates `fields`).
    const doseChange =
      'dose_mg' in fields && typeof (fields as Record<string, unknown>).dose_mg === 'number'
        ? ((fields as Record<string, unknown>).dose_mg as number)
        : null;
    if (isEncryptionEnabled()) {
      const f = fields as Record<string, unknown>;
      if (f.first_name && typeof f.first_name === 'string') f.first_name = encryptField(f.first_name);
      if (f.medication && typeof f.medication === 'string') f.medication = encryptField(f.medication);
    }
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = keys.map((k) => fields[k]);
    await this.pool.query(
      `UPDATE users SET ${sets}, updated_at = now() WHERE phone = $1`,
      [phone, ...values],
    );
    // Invalidate the user cache so the very next read picks up the change.
    this.invalidateUserCache([phone]);
    // Append to the dose timeline when the dose actually changed. Best-effort +
    // fire-and-forget so it never affects the update itself.
    if (doseChange != null && doseChange > 0) {
      void this.syncDoseEvent(phone, doseChange).catch(() => undefined);
    }
  }

  /** Record a dose_event when the user's dose transitions to a new value. Reads
   *  the latest recorded event and skips when unchanged; seeds the first event at
   *  glp1_start_date when known. Best-effort — never throws. */
  async syncDoseEvent(phone: string, newDoseMg: number): Promise<void> {
    const events = await getDoseEvents(this.pool, phone).catch(() => []);
    const latest = events[events.length - 1];
    if (latest && Number(latest.dose_mg) === newDoseMg) return; // no real change
    const user = await this.getByPhone(phone).catch(() => null);
    const seedDate =
      events.length === 0 && user?.glp1_start_date
        ? new Date(user.glp1_start_date).toISOString().slice(0, 10)
        : computeUserLoggingDay(user?.timezone, user?.wake_time, new Date());
    await recordDoseEvent(this.pool, phone, {
      medication: user?.medication ?? null,
      doseMg: newDoseMg,
      effectiveDate: seedDate,
      source: 'update',
    });
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

  /** Record a symptom episode (side effect + injection timing + dose at the time).
   *  Powers the personal side-effect pattern intelligence. Best-effort. */
  async recordSymptomEpisode(userId: string, data: {
    symptom: string;
    days_since_injection: number | null;
    dose_mg: number | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO symptom_episodes (user_id, symptom, days_since_injection, dose_mg)
       VALUES ($1, $2, $3, $4)`,
      [userId, data.symptom, data.days_since_injection, data.dose_mg],
    );
  }

  /** Prior episodes of a symptom (most recent first), for pattern analysis. */
  async getSymptomEpisodes(userId: string, symptom: string, limit = 12): Promise<Array<{
    symptom: string;
    days_since_injection: number | null;
    dose_mg: number | null;
    remedy_helped: string | null;
    created_at: Date;
  }>> {
    const { rows } = await this.pool.query(
      `SELECT symptom, days_since_injection, dose_mg, remedy_helped, created_at
       FROM symptom_episodes
       WHERE user_id = $1 AND symptom = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [userId, symptom, limit],
    );
    return rows;
  }

  /** All recent episodes across symptoms (for the injection-day proactive note). */
  async getRecentSymptomEpisodes(userId: string, limit = 40): Promise<Array<{
    symptom: string;
    days_since_injection: number | null;
    dose_mg: number | null;
    remedy_helped: string | null;
    created_at: Date;
  }>> {
    const { rows } = await this.pool.query(
      `SELECT symptom, days_since_injection, dose_mg, remedy_helped, created_at
       FROM symptom_episodes
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return rows;
  }

  /** Attribute a remedy that worked to the user's most recent open episode of a
   *  symptom within the last `withinHours` (default 72h). Best-effort. */
  async setLastEpisodeRemedy(userId: string, symptom: string, remedy: string, withinHours = 72): Promise<void> {
    await this.pool.query(
      `UPDATE symptom_episodes SET remedy_helped = $3
       WHERE id = (
         SELECT id FROM symptom_episodes
         WHERE user_id = $1 AND symptom = $2 AND remedy_helped IS NULL
           AND created_at > now() - ($4 || ' hours')::interval
         ORDER BY created_at DESC LIMIT 1
       )`,
      [userId, symptom, remedy, String(withinHours)],
    );
  }

  /** Save a progress-gallery photo (downscaled data URLs from the browser).
   *  Best-effort — returns the new row's id + metadata, or throws on a real DB
   *  error so the route can report it. */
  async saveProgressPhoto(userId: string, data: {
    kind: string;
    image_data: string;
    thumb_data: string | null;
    content_type: string;
    note: string | null;
    weight_lbs: number | null;
  }): Promise<{ id: string; kind: string; note: string | null; weight_lbs: number | null; thumb_data: string | null; taken_at: Date }> {
    const { rows } = await this.pool.query(
      `INSERT INTO progress_photos (user_id, kind, image_data, thumb_data, content_type, note, weight_lbs)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, kind, note, weight_lbs, thumb_data, taken_at`,
      [userId, data.kind, data.image_data, data.thumb_data, data.content_type, data.note, data.weight_lbs],
    );
    return rows[0]!;
  }

  /** List a user's progress photos (most recent first) — metadata + thumbnail
   *  only, so the grid payload stays light. The full image is fetched per-photo. */
  async listProgressPhotos(userId: string, limit = 60): Promise<Array<{
    id: string; kind: string; note: string | null; weight_lbs: number | null; thumb_data: string | null; taken_at: Date;
  }>> {
    const { rows } = await this.pool.query(
      `SELECT id, kind, note, weight_lbs, thumb_data, taken_at
       FROM progress_photos WHERE user_id = $1
       ORDER BY taken_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows;
  }

  /** The full image for one photo (owner-scoped). Null when not found / not theirs. */
  async getProgressPhoto(userId: string, id: string): Promise<{ image_data: string; content_type: string } | null> {
    const { rows } = await this.pool.query(
      `SELECT image_data, content_type FROM progress_photos WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return rows[0] ?? null;
  }

  /** Delete a photo (owner-scoped). Returns true when a row was removed. */
  async deleteProgressPhoto(userId: string, id: string): Promise<boolean> {
    const res = await this.pool.query(`DELETE FROM progress_photos WHERE id = $1 AND user_id = $2`, [id, userId]);
    return (res.rowCount ?? 0) > 0;
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

  /** Log a weight entry (lbs) from the dashboard, keep users.current_weight in
   *  sync, and invalidate the user cache so chat/prompt context sees it next turn. */
  async logWeightEntry(userId: string, weight: number): Promise<void> {
    await this.pool.query(`INSERT INTO weight_logs (user_id, weight) VALUES ($1, $2)`, [userId, weight]);
    await this.pool.query(`UPDATE users SET current_weight = $2 WHERE phone = $1`, [userId, weight]).catch(() => undefined);
    this.invalidate(userId);
    // NOTE: we deliberately do NOT derive+store a protein/calorie target here.
    // Grace never writes a settings NUMBER on the user's behalf (2026-07-08 user
    // directive) — a missing target is SUGGESTED on demand (tryPersonalStats) with
    // the number + reasoning + "set it in Settings yourself", never auto-stored.
  }

  /** Sync users.current_weight from a chat weight log (the fast path + log_weight
   *  tool only write weight_logs), invalidate the cache so the next turn sees it.
   *  Best-effort — this is how a weight the user EXPLICITLY STATED in chat is
   *  remembered in the profile, not just the log. */
  async syncCurrentWeight(userId: string, weightLbs: number): Promise<void> {
    if (!(weightLbs > 0)) return;
    await this.pool
      .query(`UPDATE users SET current_weight = $2 WHERE phone = $1`, [userId, weightLbs])
      .catch(() => undefined);
    this.invalidate(userId);
    // No auto-derive of the protein/calorie target — see logWeightEntry. Storing
    // the weight the user STATED is fine; inventing+storing a DERIVED target is not.
  }

  /**
   * Fill-if-missing personalized protein/calorie targets from the user's current
   * profile. RETAINED for the onboarding setup flow only — it is intentionally NOT
   * called from passive chat/dashboard weight capture, because Grace must never
   * auto-store a derived settings number (it suggests instead). Never overwrites a
   * target the user already has. Best-effort.
   */
  async ensureNutritionTargets(userId: string): Promise<void> {
    const user = await this.getByPhone(userId);
    if (!user) return;
    const targets = deriveMissingTargets(user);
    if (Object.keys(targets).length === 0) return;
    await this.update(userId, targets);
  }

  /** Per-user-day water totals (oz) for the last N days — thin wrapper over the
   *  water-log query so callers with a UserService (e.g. the weekly summary) can
   *  read hydration history without plumbing the pool. Best-effort ([] on error). */
  async getDailyWaterHistory(userId: string, days = 7): Promise<Array<{ day: string; oz: number }>> {
    return getDailyWaterHistoryQuery(this.pool, userId, days);
  }

  /** Log a mood score (1-10) from the dashboard (stored like the log_mood tool). */
  async logMoodEntry(userId: string, score: number): Promise<void> {
    // Store `phone` too (userId IS the phone) so mood rows are deletable by
    // phone like scheduler rows — keeps deletes/purges consistent.
    await this.pool.query(
      `INSERT INTO check_ins (user_id, phone, type, message_sent, mood_score) VALUES ($1, $1, 'mood_log', '', $2)`,
      [userId, score],
    );
  }

  /** Recent mood scores (most recent first) for the dashboard's mood chart. */
  async getMoodHistory(userId: string, limit = 30): Promise<Array<{ mood_score: number; created_at: Date }>> {
    const { rows } = await this.pool.query(
      `SELECT mood_score, created_at FROM check_ins
       WHERE user_id = $1 AND mood_score IS NOT NULL
       ORDER BY created_at DESC LIMIT $2`,
      [userId, limit],
    );
    return rows;
  }

  /**
   * Get today's food logs summary in the USER'S personal logging day — the
   * window from their wake_time to the next wake_time, in their timezone (see
   * nutrition/logging-window.ts). Resets at wake_time, not midnight, so a late
   * snack before bed still counts toward the day that began that morning.
   *
   * `items_detailed` carries the per-item protein/calorie breakdown so Grace
   * can answer "How did I reach 40g?" with item-level accuracy ("Eggs were
   * 14g, your protein shake was 24g, yogurt was 2g") instead of only knowing
   * the running total. Production failure 2026-05-31 — fixed here.
   */
  async getTodaysFoodSummary(userId: string): Promise<{
    protein_g: number;
    calories: number;
    items: string[];
    items_detailed: Array<{ food: string; protein_g: number; calories: number; logged_at: string }>;
  }> {
    // L1: in-memory 10s cache — handles tight back-to-back reads within
    // a single user's burst. Invalidation runs after every insert.
    const cached = this.todaysFoodCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    // L2: Redis cache (Phase A2, 2026-06-07) — shared across machines,
    // 36h TTL keyed by user's local date. Catches "what's my protein
    // today?" after 30+s of silence when the L1 cache has expired.
    // Best-effort: any Redis error falls through to L3 (DB).
    if (this.todayFoodCache) {
      // We need the user's timezone to compute the date key. Fetch the
      // user row (cheap, has its own 5s cache).
      const u = await this.getById(userId).catch(() => null);
      const tz = u?.timezone ?? 'UTC';
      const redisHit = await this.todayFoodCache.get(userId, tz, u?.wake_time ?? null);
      if (redisHit) {
        // Re-warm L1 from L2 so the next read in the same burst doesn't
        // pay even the Redis round-trip.
        this.todaysFoodCache.set(userId, {
          value: redisHit,
          expiresAt: Date.now() + this.TODAYS_FOOD_TTL_MS,
        });
        return redisHit;
      }
    }

    // L3: source of truth — Postgres CTE.
    const { rows } = await this.pool.query<{ food: string; protein_g: number; calories: number; created_at: Date }>(
      `${USER_DAY_CTE}
       SELECT food,
              COALESCE(protein_g, 0) AS protein_g,
              COALESCE(calories, 0) AS calories,
              created_at
       FROM food_logs, user_tz
       WHERE user_id = $1
         AND ${isCurrentUserDay('created_at')}
       ORDER BY created_at DESC`,
      [userId],
    );
    const value = {
      protein_g: rows.reduce((s, r) => s + r.protein_g, 0),
      calories: rows.reduce((s, r) => s + r.calories, 0),
      items: rows.map((r) => r.food),
      items_detailed: rows.map((r) => ({
        food: r.food,
        protein_g: r.protein_g,
        calories: r.calories,
        logged_at: new Date(r.created_at).toISOString(),
      })),
    };

    // Write-through to both L1 and L2 so the next read of any flavor
    // catches the fresh aggregate.
    this.todaysFoodCache.set(userId, { value, expiresAt: Date.now() + this.TODAYS_FOOD_TTL_MS });
    if (this.todayFoodCache) {
      // Best-effort — never block the response on the L2 write.
      const u = await this.getById(userId).catch(() => null);
      const tz = u?.timezone ?? 'UTC';
      void this.todayFoodCache.set(userId, tz, value, u?.wake_time ?? null).catch(() => undefined);
    }
    return value;
  }

  /**
   * Delete every food_logs row in the user's CURRENT logging day (local
   * calendar day). Used by the "reset today's food" chat command so a user can
   * zero out today's totals — e.g. after a wrong estimate or accumulated
   * mis-logs — and start clean. Only today's rows are removed; prior days are
   * untouched. Returns the number of rows deleted. Invalidates the today-food
   * cache so the next read reflects the empty day immediately.
   */
  async clearTodaysFood(userId: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `${USER_DAY_CTE}
       DELETE FROM food_logs fl
       USING user_tz
       WHERE fl.user_id = $1
         AND ${isCurrentUserDay('fl.created_at')}`,
      [userId],
    );
    this.invalidateTodaysFoodCache(userId);
    if (this.todayFoodCache) {
      const u = await this.getById(userId).catch(() => null);
      const tz = u?.timezone ?? 'UTC';
      void this.todayFoodCache.set(userId, tz, { protein_g: 0, calories: 0, items: [], items_detailed: [] }, u?.wake_time ?? null).catch(() => undefined);
    }
    return rowCount ?? 0;
  }

  /**
   * Get per-day protein/calorie totals for the last N days, including TODAY
   * as the rightmost entry. Each "day" is the user's personal logging day —
   * wake_time to the next wake_time (see nutrition/logging-window.ts), the same
   * window as today's summary. Used to answer queries
   * like "How much protein did I have yesterday?" or "Show me this week's
   * protein" — without this, Grace would have to guess or refuse.
   */
  async getDailyProteinHistory(userId: string, days: number = 7): Promise<Array<{
    day: string;
    protein_g: number;
    calories: number;
    item_count: number;
  }>> {
    const safeDays = Math.max(1, Math.min(30, Math.floor(days)));
    const { rows } = await this.pool.query<{ day: string; protein_g: number; calories: number; item_count: string }>(
      `${USER_DAY_CTE}
       SELECT ${userDayExpr('created_at')}::text AS day,
              COALESCE(SUM(protein_g), 0)::int AS protein_g,
              COALESCE(SUM(calories), 0)::int AS calories,
              COUNT(*)::int AS item_count
       FROM food_logs, user_tz
       WHERE user_id = $1
         AND ${userDayExpr('created_at')}
             >= ${userDayExpr('now()')} - ($2::int - 1)
       GROUP BY day
       ORDER BY day DESC`,
      [userId, safeDays],
    );
    return rows.map((r) => ({
      day: r.day,
      protein_g: Number(r.protein_g),
      calories: Number(r.calories),
      item_count: Number(r.item_count),
    }));
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
    // Cache hit fast-path — facts change slowly (background extraction worker
    // updates them at most every few turns), so a 5-min TTL is safe. Calls
    // from the fact-extract worker invalidate via invalidateKnownFactsCache().
    const cacheKey = `${userId}|${limit}`;
    const cached = this.knownFactsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
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
      this.knownFactsCache.set(cacheKey, { value: rows, expiresAt: Date.now() + this.KNOWN_FACTS_TTL_MS });
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

  /**
   * Flip the `paused` flag. Scheduler's listActiveUsers() already excludes
   * paused users so proactive messages stop firing immediately.
   *
   * Inbound user messages auto-resume (handled in webhook.ts) so a paused
   * user just texting Grace naturally un-pauses themselves.
   */
  async setPaused(phone: string, paused: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE users
       SET paused = $2, updated_at = now()
       WHERE phone = $1
         AND (paused IS DISTINCT FROM $2)`,
      [phone, paused],
    );
  }

  /** List all active users (for scheduler). */
  async listActiveUsers(): Promise<GraceUser[]> {
    const { rows } = await this.pool.query<GraceUser>(
      `SELECT * FROM users WHERE active = TRUE AND paused = FALSE AND blocked = FALSE`,
    );
    return rows.map((r) => this.decryptUser(r));
  }

  /** Users who opted OUT of reminders (paused = TRUE) but are still active +
   *  not blocked. listActiveUsers excludes them, so this is the ONLY way the
   *  scheduler can reach a paused user — used solely for the heavily-throttled
   *  "I'm still here" quiet re-engagement after a long silence. */
  async listPausedUsers(): Promise<GraceUser[]> {
    const { rows } = await this.pool.query<GraceUser>(
      `SELECT * FROM users WHERE active = TRUE AND paused = TRUE AND blocked = FALSE`,
    );
    return rows.map((r) => this.decryptUser(r));
  }

  /** Users who STARTED conversational onboarding but haven't finished — used by
   *  the scheduler to nudge abandoned signups. They may not be `active` yet (no
   *  trial until completion), so this is a separate query from listActiveUsers.
   *  Uses the partial index users_onboarding_in_progress_idx. */
  async listOnboardingInProgress(): Promise<GraceUser[]> {
    const { rows } = await this.pool.query<GraceUser>(
      `SELECT * FROM users WHERE onboarding_state = 'in_progress' AND blocked = FALSE`,
    );
    return rows.map((r) => this.decryptUser(r));
  }
}
