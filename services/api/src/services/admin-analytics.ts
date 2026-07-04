/**
 * Admin analytics — cohorts, funnel, and business/engagement overview.
 *
 * This is a READ-ONLY analytics layer used exclusively by the admin dashboard.
 * It never writes to the DB and never touches the user-facing message pipeline.
 * All queries run against `deps.pool` (the service-role connection that bypasses
 * RLS), the same pool the existing `/admin/metrics` and `/admin/business`
 * handlers already use.
 *
 * Design notes:
 *  - Grace uses `phone` as the canonical user id. Every child table
 *    (messages, food_logs, progress_photos, …) stores it in `user_id`.
 *  - Cohort membership is expressed as fixed SQL boolean predicates over an
 *    "enriched" CTE (users + aggregated per-user activity). The cohort key from
 *    the request maps to one of these fixed predicates via a lookup table, so no
 *    user input is ever interpolated into SQL — only whitelisted keys.
 *  - The module probes for optional columns/tables (progress_photos,
 *    subscription_status, onboarding_state) once per call and substitutes a
 *    constant `FALSE` predicate when they're absent, so an un-migrated DB
 *    degrades gracefully instead of throwing (mirrors the best-effort pattern
 *    used by admin_notes / flagged_responses elsewhere in admin.ts).
 */
import type { Pool } from 'pg';
import { decryptField } from '../crypto/field-encrypt.js';

// ── Schema probe ─────────────────────────────────────────────────────────────

export interface SchemaCaps {
  hasPhotos: boolean;
  hasSubStatus: boolean;
  hasOnboarding: boolean;
}

let capsCache: { at: number; caps: SchemaCaps } | null = null;
const CAPS_TTL_MS = 60_000;

async function probeSchema(pool: Pool): Promise<SchemaCaps> {
  const now = Date.now();
  if (capsCache && now - capsCache.at < CAPS_TTL_MS) return capsCache.caps;
  const { rows } = await pool.query<{
    has_photos: boolean;
    has_sub_status: boolean;
    has_onboarding: boolean;
  }>(`
    SELECT
      to_regclass('public.progress_photos') IS NOT NULL AS has_photos,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'subscription_status'
      ) AS has_sub_status,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'onboarding_state'
      ) AS has_onboarding
  `);
  const caps: SchemaCaps = {
    hasPhotos: rows[0]?.has_photos ?? false,
    hasSubStatus: rows[0]?.has_sub_status ?? false,
    hasOnboarding: rows[0]?.has_onboarding ?? false,
  };
  capsCache = { at: now, caps };
  return caps;
}

// ── Canonical status predicates ──────────────────────────────────────────────
//
// These are the single source of truth for "what counts as trial / paid /
// active / onboarded". They intentionally unify the slightly-divergent
// definitions currently duplicated across /admin/metrics and /admin/business.

export interface Preds {
  paying: string;
  trialStarted: string;
  trialActive: string;
  trialEnded: string;
  converted: string;
  onboardingComplete: string;
  onboardingInProgress: string;
  onboardingStarted: string;
  activeReminders: string;
  onboardingState: string;
  onboardingStartedAt: string;
  subStatus: string;
}

function predicates(caps: SchemaCaps): Preds {
  const onboardingState = caps.hasOnboarding ? 'onboarding_state' : 'NULL::text';
  const onboardingStartedAt = caps.hasOnboarding ? 'onboarding_started_at' : 'NULL::timestamptz';
  const subStatus = caps.hasSubStatus ? 'subscription_status' : 'NULL::text';

  const paying = '(is_paid OR is_pro)';
  const trialStarted = 'trial_start IS NOT NULL';
  const trialActive =
    "(NOT is_paid AND NOT is_pro AND trial_start IS NOT NULL AND trial_start > now() - interval '3 days')";
  const trialEnded = "(trial_start IS NOT NULL AND trial_start <= now() - interval '3 days')";
  const converted = '(trial_start IS NOT NULL AND (is_paid OR is_pro))';
  const onboardingComplete = `(${onboardingState} = 'complete' OR (${onboardingState} IS NULL AND trial_start IS NOT NULL))`;
  const onboardingInProgress = `${onboardingState} = 'in_progress'`;
  const onboardingStarted = `(${onboardingState} IS NOT NULL OR ${onboardingStartedAt} IS NOT NULL OR trial_start IS NOT NULL)`;
  const activeReminders = '(NOT paused AND active)';

  return {
    paying,
    trialStarted,
    trialActive,
    trialEnded,
    converted,
    onboardingComplete,
    onboardingInProgress,
    onboardingStarted,
    activeReminders,
    onboardingState,
    onboardingStartedAt,
    subStatus,
  };
}

// ── Cohort registry ──────────────────────────────────────────────────────────

export type CohortGroup =
  | 'lifecycle'
  | 'onboarding'
  | 'trial'
  | 'payment'
  | 'activity'
  | 'engagement'
  | 'profile';

export interface CohortDef {
  key: string;
  label: string;
  group: CohortGroup;
  description: string;
  /** SQL boolean expression over the enriched CTE. Built from `predicates`. */
  predicate: (p: Preds) => string;
}

/**
 * The full cohort catalogue. Order within a group is the display order.
 * NOTE: "website visitors" and "opened dashboard" are intentionally absent —
 * they require event tracking Grace does not collect today (see analytics
 * overview `tracking` block for the honest surface of that limitation).
 */
export const COHORTS: CohortDef[] = [
  // lifecycle
  { key: 'all_users', label: 'All users', group: 'lifecycle', description: 'Every account in the system.', predicate: () => 'TRUE' },
  { key: 'new_users', label: 'New users (7d)', group: 'lifecycle', description: 'Accounts created in the last 7 days.', predicate: () => "created_at > now() - interval '7 days'" },
  { key: 'inactive', label: 'Inactive users', group: 'activity', description: 'No reply in 30+ days (or never replied).', predicate: () => "(last_reply_at IS NULL OR last_reply_at <= now() - interval '30 days')" },

  // onboarding
  { key: 'onboarding_started', label: 'Started onboarding', group: 'onboarding', description: 'Began SMS onboarding or completed web signup.', predicate: (p) => p.onboardingStarted },
  { key: 'onboarding_completed', label: 'Finished onboarding', group: 'onboarding', description: 'Completed onboarding (SMS complete or web trial started).', predicate: (p) => p.onboardingComplete },
  { key: 'onboarding_incomplete', label: 'Did not finish onboarding', group: 'onboarding', description: 'Still mid-onboarding (state = in_progress).', predicate: (p) => p.onboardingInProgress },
  { key: 'onboarding_stuck', label: 'Stuck in onboarding', group: 'onboarding', description: 'In progress and no activity for 24h+.', predicate: (p) => `(${p.onboardingInProgress} AND (${p.onboardingStartedAt} < now() - interval '24 hours' OR last_reply_at IS NULL OR last_reply_at < now() - interval '24 hours'))` },

  // trial
  { key: 'trial_started', label: 'Started 3-day trial', group: 'trial', description: 'Has a trial_start timestamp.', predicate: (p) => p.trialStarted },
  { key: 'trial_active', label: 'Currently in trial', group: 'trial', description: 'Unpaid, within the 3-day trial window.', predicate: (p) => p.trialActive },
  { key: 'trial_ended', label: 'Trial ended', group: 'trial', description: 'Trial window has elapsed.', predicate: (p) => p.trialEnded },
  { key: 'converted', label: 'Converted after trial', group: 'trial', description: 'Started a trial and became paid/pro.', predicate: (p) => p.converted },
  { key: 'not_converted', label: 'Did not convert', group: 'trial', description: 'Trial ended, still not paying.', predicate: (p) => `(${p.trialEnded} AND NOT ${p.paying})` },

  // payment
  { key: 'paying', label: 'Paying users', group: 'payment', description: 'is_paid or is_pro.', predicate: (p) => p.paying },
  { key: 'active_paying', label: 'Active paying users', group: 'payment', description: 'Paying and replied in the last 7 days.', predicate: (p) => `(${p.paying} AND last_reply_at > now() - interval '7 days')` },
  { key: 'inactive_paying', label: 'Paying but inactive', group: 'payment', description: 'Paying but no reply in 7+ days.', predicate: (p) => `(${p.paying} AND (last_reply_at IS NULL OR last_reply_at <= now() - interval '7 days'))` },
  // `canceled` is resolved in cohortPredicate() (needs the schema-caps guard); this placeholder is never invoked.
  { key: 'canceled', label: 'Canceled', group: 'payment', description: 'Stripe subscription status = canceled.', predicate: () => 'FALSE' },
  { key: 'expired', label: 'Expired (trial, no convert)', group: 'payment', description: 'Trial ended without converting.', predicate: (p) => `(${p.trialEnded} AND NOT ${p.paying})` },

  // engagement / activity
  { key: 'highly_active', label: 'Highly active', group: 'engagement', description: '15+ messages sent in the last 7 days.', predicate: () => 'msgs_7d >= 15' },
  { key: 'active_24h', label: 'Active (24h)', group: 'activity', description: 'Replied in the last 24 hours.', predicate: () => "last_reply_at > now() - interval '24 hours'" },
  { key: 'active_7d', label: 'Active (7d)', group: 'activity', description: 'Replied in the last 7 days.', predicate: () => "last_reply_at > now() - interval '7 days'" },
  { key: 'active_30d', label: 'Active (30d)', group: 'activity', description: 'Replied in the last 30 days.', predicate: () => "last_reply_at > now() - interval '30 days'" },

  // reminders
  { key: 'reminders_enabled', label: 'Reminders enabled', group: 'engagement', description: 'Not paused (receives proactive reminders).', predicate: (p) => p.activeReminders },
  { key: 'reminders_disabled', label: 'Reminders disabled', group: 'engagement', description: 'Paused — no proactive reminders.', predicate: () => 'paused' },

  // food
  { key: 'logged_food', label: 'Logged food', group: 'engagement', description: 'Has at least one food log.', predicate: () => 'food_total > 0' },
  { key: 'no_food', label: 'Never logged food', group: 'engagement', description: 'No food logs yet.', predicate: () => 'food_total = 0' },
  { key: 'used_image', label: 'Used image features', group: 'engagement', description: 'Uploaded a progress/food photo (voice not tracked).', predicate: () => 'photo_total > 0' },

  // profile
  { key: 'profile_complete', label: 'Complete profile', group: 'profile', description: 'Medication, both weights, timezone all set.', predicate: () => '(medication IS NOT NULL AND current_weight IS NOT NULL AND goal_weight IS NOT NULL AND timezone IS NOT NULL)' },
  { key: 'profile_incomplete', label: 'Missing profile data', group: 'profile', description: 'Any of medication / weights / timezone missing.', predicate: () => '(medication IS NULL OR current_weight IS NULL OR goal_weight IS NULL OR timezone IS NULL)' },
  { key: 'medication_saved', label: 'Medication saved', group: 'profile', description: 'Medication is recorded.', predicate: () => 'medication IS NOT NULL' },
  { key: 'medication_missing', label: 'Medication missing', group: 'profile', description: 'No medication recorded.', predicate: () => 'medication IS NULL' },
  { key: 'injection_day_saved', label: 'Injection day saved', group: 'profile', description: 'Injection day recorded (weekly dosers).', predicate: () => 'injection_day IS NOT NULL' },
  { key: 'injection_day_missing', label: 'Injection day missing', group: 'profile', description: 'Weekly doser without an injection day.', predicate: () => "(injection_day IS NULL AND coalesce(medication_frequency,'weekly') <> 'daily')" },
];

const COHORT_BY_KEY = new Map(COHORTS.map((c) => [c.key, c]));

// ── Enriched CTE ─────────────────────────────────────────────────────────────

function enrichedCte(caps: SchemaCaps): string {
  const photoAgg = caps.hasPhotos
    ? `photo_agg AS (
         SELECT user_id, count(*)::int AS photo_total
         FROM progress_photos GROUP BY user_id
       ),`
    : '';
  const photoJoin = caps.hasPhotos ? 'LEFT JOIN photo_agg p ON p.user_id = u.phone' : '';
  const photoSelect = caps.hasPhotos ? 'coalesce(p.photo_total, 0)' : '0';

  return `
    WITH msg_agg AS (
      SELECT user_id,
             count(*) FILTER (WHERE role = 'user')::int AS msgs_total,
             count(*) FILTER (WHERE role = 'user' AND created_at > now() - interval '7 days')::int AS msgs_7d,
             max(created_at) FILTER (WHERE role = 'user') AS last_user_msg_at
      FROM messages GROUP BY user_id
    ),
    food_agg AS (
      SELECT user_id, count(*)::int AS food_total, max(created_at) AS last_food_at
      FROM food_logs GROUP BY user_id
    ),
    ${photoAgg}
    enriched AS (
      SELECT u.*,
             coalesce(m.msgs_total, 0) AS msgs_total,
             coalesce(m.msgs_7d, 0) AS msgs_7d,
             m.last_user_msg_at AS last_user_msg_at,
             coalesce(f.food_total, 0) AS food_total,
             f.last_food_at AS last_food_at,
             ${photoSelect} AS photo_total
      FROM users u
      LEFT JOIN msg_agg m ON m.user_id = u.phone
      LEFT JOIN food_agg f ON f.user_id = u.phone
      ${photoJoin}
    )
  `;
}

/** Resolve a cohort's predicate string, handling the canceled special-case. */
function cohortPredicate(def: CohortDef, p: Preds, caps: SchemaCaps): string {
  if (def.key === 'canceled') {
    return caps.hasSubStatus ? `(${p.subStatus} IN ('canceled','cancelled'))` : 'FALSE';
  }
  return def.predicate(p);
}

// ── Cohort counts ────────────────────────────────────────────────────────────

export interface CohortCount {
  key: string;
  label: string;
  group: CohortGroup;
  description: string;
  count: number;
  pct: number;
}

export interface CohortCountsResult {
  total: number;
  generated_at: string;
  cohorts: CohortCount[];
}

export async function cohortCounts(pool: Pool): Promise<CohortCountsResult> {
  const caps = await probeSchema(pool);
  const p = predicates(caps);
  const filters = COHORTS.map(
    (c) => `count(*) FILTER (WHERE ${cohortPredicate(c, p, caps)})::int AS "${c.key}"`,
  ).join(',\n        ');

  const sql = `${enrichedCte(caps)}
    SELECT count(*)::int AS total,
        ${filters}
    FROM enriched`;

  const { rows } = await pool.query<Record<string, number>>(sql);
  const row = rows[0] ?? {};
  const total = Number(row.total ?? 0);
  const cohorts: CohortCount[] = COHORTS.map((c) => {
    const count = Number(row[c.key] ?? 0);
    return {
      key: c.key,
      label: c.label,
      group: c.group,
      description: c.description,
      count,
      pct: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    };
  });
  return { total, generated_at: new Date().toISOString(), cohorts };
}

// ── Cohort user list ─────────────────────────────────────────────────────────

export interface CohortUserRow {
  phone: string;
  first_name: string | null;
  medication: string | null;
  is_paid: boolean;
  is_pro: boolean;
  paused: boolean;
  blocked: boolean;
  injection_day: string | null;
  onboarding_state: string | null;
  trial_start: string | null;
  last_reply_at: string | null;
  created_at: string;
  msgs_total: number;
  food_total: number;
  channel: string | null;
}

export interface CohortUsersResult {
  key: string;
  label: string;
  total: number;
  users: CohortUserRow[];
}

export function isValidCohort(key: string): boolean {
  return COHORT_BY_KEY.has(key);
}

export async function cohortUsers(
  pool: Pool,
  key: string,
  opts: { limit?: number; offset?: number; search?: string } = {},
): Promise<CohortUsersResult> {
  const def = COHORT_BY_KEY.get(key);
  if (!def) throw new Error(`Unknown cohort: ${key}`);
  const caps = await probeSchema(pool);
  const p = predicates(caps);
  const pred = cohortPredicate(def, p, caps);

  const limit = Math.min(Math.max(Number(opts.limit ?? 100), 1), 500);
  const offset = Math.max(Number(opts.offset ?? 0), 0);
  const search = (opts.search ?? '').trim();

  const params: unknown[] = [];
  let searchClause = '';
  if (search) {
    params.push(`%${search}%`);
    // first_name/medication are encrypted at rest, so search matches phone here.
    searchClause = `AND phone ILIKE $${params.length}`;
  }

  const onboardingCol = caps.hasOnboarding ? 'onboarding_state' : 'NULL::text AS onboarding_state';

  const listSql = `${enrichedCte(caps)}
    SELECT phone, first_name, medication, is_paid, is_pro, paused, blocked,
           injection_day, ${onboardingCol}, trial_start, last_reply_at, created_at,
           msgs_total, food_total, channel
    FROM enriched
    WHERE ${pred} ${searchClause}
    ORDER BY last_reply_at DESC NULLS LAST, created_at DESC
    LIMIT ${limit} OFFSET ${offset}`;

  const countSql = `${enrichedCte(caps)}
    SELECT count(*)::int AS total FROM enriched WHERE ${pred} ${searchClause}`;

  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query<CohortUserRow>(listSql, params),
    pool.query<{ total: number }>(countSql, params),
  ]);

  const users = rows.map((r) => ({
    ...r,
    first_name: r.first_name ? decryptField(r.first_name) : null,
    medication: r.medication ? decryptField(r.medication) : null,
  }));

  return { key, label: def.label, total: Number(countRows[0]?.total ?? 0), users };
}

// ── Cohort recipients (for campaign messaging) ───────────────────────────────

export interface RecipientRow {
  phone: string;
  channel: string | null;
  paused: boolean;
  blocked: boolean;
  active: boolean;
}

/**
 * Resolve the FULL set of users in a cohort (no limit) with the fields needed
 * to decide message eligibility. Used by the campaign layer, not the dashboard
 * counts. Returns eligibility flags raw — the caller applies the opt-out policy.
 */
export async function cohortRecipients(pool: Pool, key: string): Promise<RecipientRow[]> {
  const def = COHORT_BY_KEY.get(key);
  if (!def) throw new Error(`Unknown cohort: ${key}`);
  const caps = await probeSchema(pool);
  const p = predicates(caps);
  const pred = cohortPredicate(def, p, caps);
  const { rows } = await pool.query<RecipientRow>(`${enrichedCte(caps)}
    SELECT phone, channel, paused, blocked, active
    FROM enriched WHERE ${pred}`);
  return rows;
}

// ── Funnel ───────────────────────────────────────────────────────────────────

export interface FunnelStep {
  key: string;
  label: string;
  count: number;
  /** Conversion from the previous step (%). null for the first step. */
  from_prev_pct: number | null;
  /** Drop-off from the previous step (%). null for the first step. */
  drop_pct: number | null;
  /** Share of the top-of-funnel (%). */
  of_total_pct: number;
  /** Cohort key to drill into the user list, when one exists. */
  cohort_key: string | null;
  /** True when the metric is real; false = not tracked (e.g. website visits). */
  tracked: boolean;
}

export interface FunnelResult {
  generated_at: string;
  steps: FunnelStep[];
  note: string;
}

export async function funnel(pool: Pool): Promise<FunnelResult> {
  const counts = await cohortCounts(pool);
  const get = (k: string): number => counts.cohorts.find((c) => c.key === k)?.count ?? 0;

  // Ordered conversion path. "Website visits" is not tracked and shown as such.
  const raw: Array<{ key: string; label: string; count: number; cohort: string | null; tracked: boolean }> = [
    { key: 'website_visits', label: 'Website visits', count: 0, cohort: null, tracked: false },
    { key: 'accounts_created', label: 'Accounts created', count: counts.total, cohort: 'all_users', tracked: true },
    { key: 'onboarding_started', label: 'Onboarding started', count: get('onboarding_started'), cohort: 'onboarding_started', tracked: true },
    { key: 'onboarding_completed', label: 'Onboarding completed', count: get('onboarding_completed'), cohort: 'onboarding_completed', tracked: true },
    { key: 'trial_started', label: 'Trial started', count: get('trial_started'), cohort: 'trial_started', tracked: true },
    { key: 'converted', label: 'Converted to paid', count: get('converted'), cohort: 'converted', tracked: true },
    { key: 'active_paying', label: 'Active paying', count: get('active_paying'), cohort: 'active_paying', tracked: true },
  ];

  const top = counts.total || 1;
  let prev: number | null = null;
  const steps: FunnelStep[] = raw.map((s) => {
    const fromPrev = prev != null && prev > 0 ? Math.round((s.count / prev) * 1000) / 10 : null;
    const step: FunnelStep = {
      key: s.key,
      label: s.label,
      count: s.count,
      from_prev_pct: s.tracked ? fromPrev : null,
      drop_pct: s.tracked && fromPrev != null ? Math.round((100 - fromPrev) * 10) / 10 : null,
      of_total_pct: s.tracked ? Math.round((s.count / top) * 1000) / 10 : 0,
      cohort_key: s.cohort,
      tracked: s.tracked,
    };
    if (s.tracked) prev = s.count;
    return step;
  });

  return {
    generated_at: new Date().toISOString(),
    steps,
    note: 'Website visits are not tracked (no web analytics). The funnel starts at account creation. Trial-active / trial-ended are point-in-time states shown separately in cohorts.',
  };
}

// ── Business / engagement overview ───────────────────────────────────────────

export interface AnalyticsOverview {
  generated_at: string;
  users: { total: number; new_today: number; new_7d: number; new_30d: number };
  active: {
    dau: number;
    wau: number;
    mau: number;
    series: Array<{ date: string; count: number }>; // last 14 days DAU
  };
  rates: {
    onboarding_completion_pct: number;
    trial_start_pct: number;
    trial_conversion_pct: number;
    paid_conversion_pct: number;
    churn_pct: number;
    reminders_enabled_pct: number;
  };
  averages: {
    messages_per_user: number;
    food_logs_per_user: number;
  };
  missing_onboarding_fields: Array<{ field: string; count: number }>;
  dropoff_slots: Array<{ slot: string; count: number }>;
  tracking: { website_visits: boolean; dashboard_opens: boolean; voice_usage: boolean };
}

export async function analyticsOverview(pool: Pool): Promise<AnalyticsOverview> {
  const caps = await probeSchema(pool);
  const p = predicates(caps);

  const [userAgg, activeAgg, series, avgAgg, missingAgg, slotAgg] = await Promise.all([
    // user counts + rate numerators/denominators
    pool.query<Record<string, number>>(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS new_today,
        count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new_7d,
        count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS new_30d,
        count(*) FILTER (WHERE ${p.onboardingStarted})::int AS onboarding_started,
        count(*) FILTER (WHERE ${p.onboardingComplete})::int AS onboarding_completed,
        count(*) FILTER (WHERE ${p.trialStarted})::int AS trial_started,
        count(*) FILTER (WHERE ${p.trialEnded})::int AS trial_ended,
        count(*) FILTER (WHERE ${p.converted})::int AS converted,
        count(*) FILTER (WHERE ${p.paying})::int AS paying,
        count(*) FILTER (WHERE ${p.activeReminders})::int AS reminders_enabled,
        count(*) FILTER (WHERE ${caps.hasSubStatus ? `${p.subStatus} IN ('canceled','cancelled')` : 'FALSE'})::int AS canceled
      FROM users
    `),
    // DAU/WAU/MAU = distinct users who SENT a message in the window
    pool.query<{ dau: number; wau: number; mau: number }>(`
      SELECT
        count(DISTINCT user_id) FILTER (WHERE created_at > now() - interval '1 day')::int AS dau,
        count(DISTINCT user_id) FILTER (WHERE created_at > now() - interval '7 days')::int AS wau,
        count(DISTINCT user_id) FILTER (WHERE created_at > now() - interval '30 days')::int AS mau
      FROM messages WHERE role = 'user'
    `),
    // 14-day DAU series
    pool.query<{ date: string; count: number }>(`
      SELECT to_char(d.day, 'YYYY-MM-DD') AS date, coalesce(x.c, 0)::int AS count
      FROM generate_series(current_date - interval '13 days', current_date, interval '1 day') AS d(day)
      LEFT JOIN (
        SELECT date_trunc('day', created_at)::date AS day, count(DISTINCT user_id) AS c
        FROM messages WHERE role = 'user' AND created_at > now() - interval '14 days'
        GROUP BY 1
      ) x ON x.day = d.day::date
      ORDER BY d.day
    `),
    // averages
    pool.query<{ msgs: number; foods: number; users: number }>(`
      SELECT
        (SELECT count(*) FROM messages WHERE role = 'user')::float AS msgs,
        (SELECT count(*) FROM food_logs)::float AS foods,
        (SELECT count(*) FROM users)::float AS users
    `),
    // most-common missing onboarding fields (among users who started but not complete)
    pool.query<Record<string, number>>(`
      SELECT
        count(*) FILTER (WHERE medication IS NULL)::int AS medication,
        count(*) FILTER (WHERE injection_day IS NULL AND coalesce(medication_frequency,'weekly') <> 'daily')::int AS injection_day,
        count(*) FILTER (WHERE current_weight IS NULL)::int AS current_weight,
        count(*) FILTER (WHERE goal_weight IS NULL)::int AS goal_weight,
        count(*) FILTER (WHERE timezone IS NULL)::int AS timezone,
        count(*) FILTER (WHERE wake_time IS NULL)::int AS wake_time
      FROM users
      WHERE NOT (${p.onboardingComplete})
    `),
    // drop-off point = distribution of onboarding_last_slot among in-progress
    caps.hasOnboarding
      ? pool.query<{ slot: string | null; count: number }>(`
          SELECT onboarding_last_slot AS slot, count(*)::int AS count
          FROM users
          WHERE onboarding_state = 'in_progress'
          GROUP BY onboarding_last_slot
          ORDER BY count DESC
        `)
      : Promise.resolve({ rows: [] as Array<{ slot: string | null; count: number }> }),
  ]);

  const u = userAgg.rows[0] ?? {};
  const total = Number(u.total ?? 0);
  const onboardingStarted = Number(u.onboarding_started ?? 0);
  const trialStarted = Number(u.trial_started ?? 0);
  const trialEnded = Number(u.trial_ended ?? 0);
  const converted = Number(u.converted ?? 0);
  const paying = Number(u.paying ?? 0);
  const canceled = Number(u.canceled ?? 0);
  const pct = (num: number, den: number): number => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

  const a = avgAgg.rows[0] ?? { msgs: 0, foods: 0, users: 0 };
  const uCount = Number(a.users) || 1;

  const missing = missingAgg.rows[0] ?? {};
  const missingFields = ['medication', 'injection_day', 'current_weight', 'goal_weight', 'timezone', 'wake_time']
    .map((field) => ({ field, count: Number(missing[field] ?? 0) }))
    .filter((f) => f.count > 0)
    .sort((x, y) => y.count - x.count);

  return {
    generated_at: new Date().toISOString(),
    users: {
      total,
      new_today: Number(u.new_today ?? 0),
      new_7d: Number(u.new_7d ?? 0),
      new_30d: Number(u.new_30d ?? 0),
    },
    active: {
      dau: Number(activeAgg.rows[0]?.dau ?? 0),
      wau: Number(activeAgg.rows[0]?.wau ?? 0),
      mau: Number(activeAgg.rows[0]?.mau ?? 0),
      series: series.rows.map((r) => ({ date: r.date, count: Number(r.count) })),
    },
    rates: {
      onboarding_completion_pct: pct(Number(u.onboarding_completed ?? 0), onboardingStarted),
      trial_start_pct: pct(trialStarted, total),
      trial_conversion_pct: pct(converted, trialEnded + converted),
      paid_conversion_pct: pct(paying, total),
      churn_pct: pct(canceled, paying + canceled),
      reminders_enabled_pct: pct(Number(u.reminders_enabled ?? 0), total),
    },
    averages: {
      messages_per_user: Math.round((Number(a.msgs) / uCount) * 10) / 10,
      food_logs_per_user: Math.round((Number(a.foods) / uCount) * 10) / 10,
    },
    missing_onboarding_fields: missingFields,
    dropoff_slots: slotAgg.rows.map((r) => ({ slot: r.slot ?? '(unknown)', count: Number(r.count) })),
    tracking: { website_visits: false, dashboard_opens: false, voice_usage: false },
  };
}
