/**
 * Medication / dose timeline (Feature gap 8).
 *
 * Persistence (dose_events) + a pure builder that turns recorded dose starts into
 * dose PERIODS, each enriched — at read time — with GLP-1 week span, weight change
 * over the period (from weight_logs), and the most common symptom in the period
 * (from symptom_episodes). No dosing advice is ever produced here; this only
 * DISPLAYS recorded history.
 *
 * Best-effort throughout: the store no-ops/[] when dose_events isn't migrated, and
 * the builder synthesizes a single "current dose" period from the user's current
 * dose_mg + glp1_start_date so existing users see a timeline immediately.
 */
import type { Pool } from 'pg';

export interface DoseEvent {
  medication: string | null;
  dose_mg: number;
  effective_date: string; // 'YYYY-MM-DD'
}

export interface WeightEntry {
  weight: number;
  created_at: Date | string;
}

export interface SymptomEntry {
  symptom: string;
  created_at: Date | string;
}

export interface TimelineUser {
  medication?: string | null;
  dose_mg?: number | null;
  glp1_start_date?: string | Date | null;
}

export interface DosePeriod {
  doseMg: number;
  medication: string | null;
  from: string; // 'YYYY-MM-DD'
  to: string | null; // 'YYYY-MM-DD' or null when current
  current: boolean;
  glp1WeekStart: number | null;
  glp1WeekEnd: number | null;
  weightDeltaLbs: number | null;
  topSymptom: string | null;
}

// ── Store ──────────────────────────────────────────────────────────────────────

/** Idempotently record a dose start. No-ops on a non-positive dose or DB error. */
export async function recordDoseEvent(
  pool: Pool,
  userId: string,
  opts: { medication?: string | null; doseMg: number; effectiveDate: string; source?: string; note?: string },
): Promise<void> {
  if (!(opts.doseMg > 0)) return;
  try {
    await pool.query(
      `INSERT INTO dose_events (user_id, medication, dose_mg, effective_date, source, note)
       VALUES ($1, $2, $3, $4::date, $5, $6)
       ON CONFLICT (user_id, dose_mg, effective_date) DO NOTHING`,
      [userId, opts.medication ?? null, opts.doseMg, opts.effectiveDate, opts.source ?? null, opts.note ?? null],
    );
  } catch {
    /* best-effort — table may not be migrated */
  }
}

/** All recorded dose events, oldest first. [] on any error. */
export async function getDoseEvents(pool: Pool, userId: string): Promise<DoseEvent[]> {
  try {
    const { rows } = await pool.query<{ medication: string | null; dose_mg: number; effective_date: string }>(
      `SELECT medication, dose_mg::float8 AS dose_mg, effective_date::text AS effective_date
       FROM dose_events WHERE user_id = $1
       ORDER BY effective_date ASC, created_at ASC`,
      [userId],
    );
    return rows.map((r) => ({ medication: r.medication, dose_mg: Number(r.dose_mg), effective_date: r.effective_date }));
  } catch {
    return [];
  }
}

// ── Pure builder ────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 3_600_000;

function toISODate(d: string | Date | null | undefined): string | null {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const t = d.getTime?.();
  if (t == null || Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function dayStart(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

/** Whole GLP-1 weeks (1-indexed) between the start date and a target date. */
function weekAt(startISO: string | null, targetISO: string): number | null {
  if (!startISO) return null;
  const diff = dayStart(targetISO) - dayStart(startISO);
  if (diff < 0) return null;
  return Math.floor(diff / (7 * DAY_MS)) + 1;
}

/**
 * Build the dose timeline. When there are no recorded events, synthesizes a
 * single current-dose period from the user's dose_mg + glp1_start_date (falling
 * back to the earliest weigh-in, then today) so the card is never empty for a
 * user who already has a dose set.
 */
export function buildDoseTimeline(
  events: DoseEvent[],
  weights: WeightEntry[],
  symptoms: SymptomEntry[],
  user: TimelineUser,
  now: Date = new Date(),
): DosePeriod[] {
  const nowISO = now.toISOString().slice(0, 10);
  const startISO = toISODate(user.glp1_start_date ?? null);

  let evts = [...events].sort((a, b) => dayStart(a.effective_date) - dayStart(b.effective_date));

  // Synthesize a starting period when nothing is recorded yet.
  if (evts.length === 0) {
    if (!user.dose_mg || user.dose_mg <= 0) return [];
    const earliestWeight = weights
      .map((w) => toISODate(w.created_at))
      .filter((d): d is string => !!d)
      .sort()[0];
    const from = startISO ?? earliestWeight ?? nowISO;
    evts = [{ medication: user.medication ?? null, dose_mg: user.dose_mg, effective_date: from }];
  }

  return evts.map((e, i) => {
    const from = e.effective_date;
    const next = evts[i + 1];
    const to = next ? next.effective_date : null;
    const current = !next;
    const windowEnd = to ?? nowISO;

    // Weight change over [from, windowEnd): earliest vs latest weigh-in in window.
    const inWindow = weights
      .map((w) => ({ iso: toISODate(w.created_at), weight: w.weight }))
      .filter((w): w is { iso: string; weight: number } => !!w.iso && Number.isFinite(w.weight))
      .filter((w) => dayStart(w.iso) >= dayStart(from) && dayStart(w.iso) < dayStart(windowEnd) + DAY_MS)
      .sort((a, b) => dayStart(a.iso) - dayStart(b.iso));
    const weightDeltaLbs =
      inWindow.length >= 2
        ? Math.round((inWindow[inWindow.length - 1]!.weight - inWindow[0]!.weight) * 10) / 10
        : null;

    // Most common symptom in the window.
    const symCounts = new Map<string, number>();
    for (const s of symptoms) {
      const iso = toISODate(s.created_at);
      if (!iso) continue;
      if (dayStart(iso) >= dayStart(from) && dayStart(iso) < dayStart(windowEnd) + DAY_MS) {
        symCounts.set(s.symptom, (symCounts.get(s.symptom) ?? 0) + 1);
      }
    }
    const topSymptom =
      [...symCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    return {
      doseMg: e.dose_mg,
      medication: e.medication ?? user.medication ?? null,
      from,
      to,
      current,
      glp1WeekStart: weekAt(startISO, from),
      glp1WeekEnd: to ? weekAt(startISO, to) : weekAt(startISO, nowISO),
      weightDeltaLbs,
      topSymptom,
    };
  });
}
