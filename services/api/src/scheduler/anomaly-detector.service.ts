/**
 * Nightly behavioral anomaly detector.
 *
 * Scans active users for patterns that warrant attention:
 *   - mood_drop: last 3 mood logs average < 4, or 2+ point drop from prior week
 *   - logging_silence: previously active (>= 3 logs in prior week) but 0 in last 3 days
 *   - weight_spike: > 3 lb change between two consecutive log entries inside 48h
 *   - side_effect_escalation: 2+ distinct side-effect logs in the last 7 days
 *
 * Findings are upserted into `user_anomalies` (one open row per user+kind via
 * the partial unique index in the migration). The admin dashboard reads them.
 *
 * Purely additive — no user message is sent, no existing pipeline is touched.
 */

import type { Pool } from 'pg';
import type { Logger } from 'pino';

export type AnomalyKind = 'mood_drop' | 'logging_silence' | 'weight_spike' | 'side_effect_escalation';
export type AnomalySeverity = 'low' | 'medium' | 'high';

export interface DetectedAnomaly {
  userId: string;
  kind: AnomalyKind;
  severity: AnomalySeverity;
  details: Record<string, unknown>;
}

export interface AnomalyRunReport {
  scanned: number;
  detected: number;
  byKind: Record<AnomalyKind, number>;
  durationMs: number;
}

export class AnomalyDetectorService {
  constructor(
    private pool: Pool,
    private logger: Logger,
  ) {}

  async run(): Promise<AnomalyRunReport> {
    const t0 = Date.now();
    const byKind: Record<AnomalyKind, number> = {
      mood_drop: 0,
      logging_silence: 0,
      weight_spike: 0,
      side_effect_escalation: 0,
    };

    let scanned = 0;
    let detected = 0;

    try {
      const { rows: users } = await this.pool.query<{ id: string }>(
        `SELECT id FROM users
          WHERE last_reply_at IS NOT NULL
            AND last_reply_at > now() - interval '14 days'`,
      );
      scanned = users.length;

      for (const u of users) {
        const findings = await this.scanUser(u.id);
        for (const f of findings) {
          await this.upsert(f);
          byKind[f.kind]++;
          detected++;
        }
      }
    } catch (err) {
      this.logger.warn({ err }, 'anomaly_detector.run.failed');
    }

    const durationMs = Date.now() - t0;
    const report: AnomalyRunReport = { scanned, detected, byKind, durationMs };
    this.logger.info(report, 'anomaly_detector.complete');
    return report;
  }

  private async scanUser(userId: string): Promise<DetectedAnomaly[]> {
    const out: DetectedAnomaly[] = [];

    const mood = await this.detectMoodDrop(userId);
    if (mood) out.push(mood);

    const silence = await this.detectLoggingSilence(userId);
    if (silence) out.push(silence);

    const weight = await this.detectWeightSpike(userId);
    if (weight) out.push(weight);

    const side = await this.detectSideEffectEscalation(userId);
    if (side) out.push(side);

    return out;
  }

  private async detectMoodDrop(userId: string): Promise<DetectedAnomaly | null> {
    try {
      const { rows } = await this.pool.query<{ mood_score: number; created_at: Date }>(
        `SELECT mood_score, created_at
           FROM check_ins
          WHERE user_id = $1 AND mood_score IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 10`,
        [userId],
      );
      if (rows.length < 3) return null;
      const recent3 = rows.slice(0, 3).map((r) => r.mood_score);
      const avg3 = recent3.reduce((a, b) => a + b, 0) / 3;
      if (avg3 < 4) {
        return {
          userId,
          kind: 'mood_drop',
          severity: avg3 < 3 ? 'high' : 'medium',
          details: { last_three_avg: Number(avg3.toFixed(2)), recent3 },
        };
      }
      if (rows.length >= 6) {
        const prev3 = rows.slice(3, 6).map((r) => r.mood_score);
        const prevAvg = prev3.reduce((a, b) => a + b, 0) / 3;
        if (prevAvg - avg3 >= 2) {
          return {
            userId,
            kind: 'mood_drop',
            severity: 'medium',
            details: { drop: Number((prevAvg - avg3).toFixed(2)), recent_avg: avg3, prev_avg: prevAvg },
          };
        }
      }
      return null;
    } catch (err) {
      this.logger.warn({ err, userId }, 'anomaly.mood.failed');
      return null;
    }
  }

  private async detectLoggingSilence(userId: string): Promise<DetectedAnomaly | null> {
    try {
      const { rows } = await this.pool.query<{ prev_week: string; last_three: string }>(
        `SELECT
           (SELECT COUNT(*) FROM food_logs
              WHERE user_id = $1
                AND created_at BETWEEN now() - interval '10 days' AND now() - interval '3 days') AS prev_week,
           (SELECT COUNT(*) FROM food_logs
              WHERE user_id = $1
                AND created_at > now() - interval '3 days') AS last_three`,
        [userId],
      );
      const prev = parseInt(rows[0]?.prev_week ?? '0', 10);
      const recent = parseInt(rows[0]?.last_three ?? '0', 10);
      if (prev >= 3 && recent === 0) {
        return {
          userId,
          kind: 'logging_silence',
          severity: prev >= 7 ? 'high' : 'medium',
          details: { prev_week_logs: prev, last_three_days_logs: recent },
        };
      }
      return null;
    } catch (err) {
      this.logger.warn({ err, userId }, 'anomaly.silence.failed');
      return null;
    }
  }

  private async detectWeightSpike(userId: string): Promise<DetectedAnomaly | null> {
    try {
      const { rows } = await this.pool.query<{ weight: string; created_at: Date }>(
        `SELECT weight, created_at
           FROM weight_logs
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 2`,
        [userId],
      );
      if (rows.length < 2) return null;
      const w1 = parseFloat(rows[0]!.weight);
      const w2 = parseFloat(rows[1]!.weight);
      const gapMs = new Date(rows[0]!.created_at).getTime() - new Date(rows[1]!.created_at).getTime();
      if (gapMs > 48 * 3600 * 1000) return null;
      const diff = Math.abs(w1 - w2);
      if (diff > 3) {
        return {
          userId,
          kind: 'weight_spike',
          severity: diff > 5 ? 'high' : 'medium',
          details: { diff_lbs: Number(diff.toFixed(2)), gap_hours: Math.round(gapMs / 3600000) },
        };
      }
      return null;
    } catch (err) {
      this.logger.warn({ err, userId }, 'anomaly.weight.failed');
      return null;
    }
  }

  private async detectSideEffectEscalation(userId: string): Promise<DetectedAnomaly | null> {
    try {
      const { rows } = await this.pool.query<{ side_effect: string; created_at: Date }>(
        `SELECT side_effect, created_at
           FROM check_ins
          WHERE user_id = $1
            AND side_effect IS NOT NULL
            AND created_at > now() - interval '7 days'`,
        [userId],
      );
      const uniqueEffects = new Set(rows.map((r) => r.side_effect.toLowerCase().trim()));
      if (uniqueEffects.size >= 2) {
        return {
          userId,
          kind: 'side_effect_escalation',
          severity: uniqueEffects.size >= 4 ? 'high' : 'medium',
          details: { distinct_effects: Array.from(uniqueEffects), count: rows.length },
        };
      }
      return null;
    } catch (err) {
      this.logger.warn({ err, userId }, 'anomaly.side_effect.failed');
      return null;
    }
  }

  private async upsert(a: DetectedAnomaly): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO user_anomalies (user_id, kind, severity, details)
              VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, kind) WHERE resolved = FALSE
         DO UPDATE SET severity = EXCLUDED.severity, details = EXCLUDED.details, created_at = now()`,
        [a.userId, a.kind, a.severity, JSON.stringify(a.details)],
      );
    } catch (err) {
      this.logger.warn({ err, anomaly: a }, 'anomaly.upsert.failed');
    }
  }
}
