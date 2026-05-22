/**
 * Contextual multi-armed bandit over response strategies.
 *
 * Treats Grace's response style as a per-user choice between 4 arms (tone ×
 * length), picks one using Thompson Sampling on a Beta(α=successes+1,
 * β=failures+1) prior, and updates each user's Beta parameters from RLHF
 * thumbs-up/down feedback.
 *
 * Why per-user: some users want a warm friend; some want concise facts. A
 * single global system prompt can't satisfy both. The bandit learns the
 * individual preference within ~10-20 rated turns.
 *
 * Integration: AIService selects an arm before generation, injects a soft
 * "STRATEGY HINT" line into the runtime context, and stores the chosen arm
 * in Redis under `bandit:last:{userId}`. When the webhook receives a 👍/👎,
 * it reads the cached arm and calls `recordReward()`.
 *
 * Strategy hint is SOFT — the system prompt's hard rules (length caps, format
 * enforcement, dietary restrictions, safety) always override.
 */

import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

export const BANDIT_ARMS = ['warm_brief', 'warm_detailed', 'factual_brief', 'factual_detailed'] as const;
export type BanditArm = (typeof BANDIT_ARMS)[number];

const BANDIT_LAST_KEY = (userId: string): string => `bandit:last:${userId}`;
const BANDIT_LAST_TTL = 60 * 60 * 24; // 24h — we never get feedback later than that
// Force ~10% exploration when the bandit is otherwise locked onto one arm.
// Thompson Sampling already explores, but with very lopsided arms it can get
// stuck — epsilon-greedy override guarantees we keep gathering signal.
const EPSILON = 0.1;

const ARM_HINTS: Record<BanditArm, string> = {
  warm_brief:
    'STRATEGY HINT: Lead with warmth. Keep your reply concise — 1-2 sentences. Validate the feeling before any information.',
  warm_detailed:
    'STRATEGY HINT: Lead with warmth and validation, then add detail (3-4 sentences total). Acknowledge the feeling first.',
  factual_brief:
    'STRATEGY HINT: Lead with the factual answer in 1-2 sentences. Brief, clear, conversational.',
  factual_detailed:
    'STRATEGY HINT: Provide a clear, factual answer with brief reasoning (3-4 sentences). Stay conversational, not clinical.',
};

interface ArmState {
  arm: BanditArm;
  pulls: number;
  successes: number;
  failures: number;
}

export class BanditService {
  constructor(
    private pool: Pool,
    private redis: Redis,
    private logger: Logger,
  ) {}

  /**
   * Pick an arm for this turn via Thompson Sampling. Returns the arm + the
   * runtime hint to inject into the system prompt.
   *
   * Returns null when DB is unavailable or all arms fail to sample — the
   * caller falls back to no strategy hint (current behavior).
   */
  async selectArm(userId: string): Promise<{ arm: BanditArm; hint: string } | null> {
    try {
      // 10% epsilon-greedy exploration override.
      if (Math.random() < EPSILON) {
        const arm = BANDIT_ARMS[Math.floor(Math.random() * BANDIT_ARMS.length)]!;
        await this.cacheAssignment(userId, arm);
        return { arm, hint: ARM_HINTS[arm] };
      }

      const states = await this.loadStates(userId);
      let bestArm: BanditArm = BANDIT_ARMS[0];
      let bestSample = -Infinity;
      for (const arm of BANDIT_ARMS) {
        const s = states[arm] ?? { arm, pulls: 0, successes: 0, failures: 0 };
        const alpha = s.successes + 1;
        const beta = s.failures + 1;
        const sample = sampleBeta(alpha, beta);
        if (sample > bestSample) {
          bestSample = sample;
          bestArm = arm;
        }
      }
      await this.cacheAssignment(userId, bestArm);
      return { arm: bestArm, hint: ARM_HINTS[bestArm] };
    } catch (err) {
      this.logger.warn({ err, userId }, 'bandit.select.failed');
      return null;
    }
  }

  /**
   * Record reward (+1 for 👍, 0 for 👎) for the most-recently-selected arm
   * for this user. Looks up the cached assignment from Redis. Fire-and-forget.
   * No-op when no recent assignment is found (user gave feedback without a
   * prior turn — possible after a server restart that flushed Redis).
   */
  async recordReward(userId: string, isSuccess: boolean): Promise<void> {
    try {
      const arm = (await this.redis.get(BANDIT_LAST_KEY(userId))) as BanditArm | null;
      if (!arm || !BANDIT_ARMS.includes(arm)) return;

      const successCol = isSuccess ? 'successes' : 'failures';
      await this.pool.query(
        `INSERT INTO user_bandit_state (user_id, arm, pulls, ${successCol})
              VALUES ($1, $2, 1, 1)
         ON CONFLICT (user_id, arm) DO UPDATE
                SET pulls        = user_bandit_state.pulls + 1,
                    ${successCol} = user_bandit_state.${successCol} + 1,
                    last_updated = now()`,
        [userId, arm],
      );
      // Clear the cached assignment so we don't double-count if the user
      // rates the same message twice.
      await this.redis.del(BANDIT_LAST_KEY(userId)).catch(() => 0);
      this.logger.info({ userId, arm, isSuccess }, 'bandit.reward.recorded');
    } catch (err) {
      this.logger.warn({ err, userId }, 'bandit.reward.failed');
    }
  }

  /** Read-only state dump used by admin endpoint. */
  async getStates(userId: string): Promise<ArmState[]> {
    try {
      const states = await this.loadStates(userId);
      return BANDIT_ARMS.map((arm) => states[arm] ?? { arm, pulls: 0, successes: 0, failures: 0 });
    } catch {
      return [];
    }
  }

  private async cacheAssignment(userId: string, arm: BanditArm): Promise<void> {
    try {
      await this.redis.set(BANDIT_LAST_KEY(userId), arm, 'EX', BANDIT_LAST_TTL);
    } catch (err) {
      this.logger.warn({ err, userId, arm }, 'bandit.cache_assignment.failed');
    }
  }

  private async loadStates(userId: string): Promise<Partial<Record<BanditArm, ArmState>>> {
    const { rows } = await this.pool.query<{ arm: BanditArm; pulls: number; successes: number; failures: number }>(
      `SELECT arm, pulls, successes, failures FROM user_bandit_state WHERE user_id = $1`,
      [userId],
    );
    const out: Partial<Record<BanditArm, ArmState>> = {};
    for (const r of rows) {
      if (BANDIT_ARMS.includes(r.arm)) {
        out[r.arm] = { arm: r.arm, pulls: r.pulls, successes: r.successes, failures: r.failures };
      }
    }
    return out;
  }
}

// ─── Beta sampler ─────────────────────────────────────────────────────────────
//
// Beta(α, β) via two Gamma samples: X = Gamma(α,1), Y = Gamma(β,1) ⇒ X/(X+Y) ~ Beta(α,β).
// Gamma sampler uses Marsaglia & Tsang (2000) for shape >= 1, plus a Johnk
// boost for shape < 1 (alpha can be 1 for a fresh arm — handled directly by
// using exponential).

function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  return x / (x + y);
}

function sampleGamma(shape: number): number {
  if (shape < 1) {
    // Boost: sample Gamma(shape+1) and multiply by U^(1/shape).
    const g = sampleGamma(shape + 1);
    const u = Math.random();
    return g * Math.pow(u, 1 / shape);
  }
  // Marsaglia-Tsang.
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number;
    let v: number;
    do {
      x = normalRandom();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normalRandom(): number {
  // Box-Muller. Good enough for sampling — we don't need cryptographic quality.
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
